import { type Address, isAddress, zeroAddress } from "viem";
import { paydayAbi } from "../abi.js";
import type { PaydayEpoch } from "../api.js";
import type { Ctx, Job } from "../context.js";
import { log } from "../log.js";
import { message } from "../queue.js";

/// The hourly distributor. Every minute: the epoch before the current one, per asset, is paid
/// once. Whether it was paid already is read from the contract (`paid(epoch, asset) > 0`), never
/// from memory alone, so a restart in the middle of an hour does not pay twice and a keeper that
/// was down does not skip an hour: money that was not paid carries into the next epoch on chain.
///
/// Amounts: a launch slice of PAYDAY_LAUNCH_SLICE_BPS (10%) of the pot, split equally over the
/// last ten launches' pots whose asset matches; the rest to the hour's wallets by points, integer
/// math, so the sum is never above the pot. A wallet whose share is under the dust floor is left
/// out and its share carries forward with the remainder.

const SLICE_BPS = 1000n;
const BPS = 10_000n;
/// Points are numeric(20,2) in the indexer; two decimals become integer units for the division.
const POINT_SCALE = 100n;

function pointsToUnits(p: string | number): bigint {
  const s = typeof p === "number" ? p.toFixed(2) : String(p);
  const [whole, frac = ""] = s.split(".");
  const cents = (frac + "00").slice(0, 2);
  const units = BigInt(whole || "0") * POINT_SCALE + BigInt(cents);
  return units < 0n ? 0n : units;
}

export function paydayJob(ctx: Ctx): Job {
  const done = new Set<string>();
  let lastNotAppointed = 0;

  return async () => {
    if (!ctx.payday) return { off: 1 };
    const counts: Record<string, number | string> = { epoch: 0, assets: 0, alreadyPaid: 0, sent: 0, skipped: 0, waiting: 0 };
    const [current, keeper] = (await ctx.publicClient.multicall({
      allowFailure: false,
      contracts: [
        { address: ctx.payday, abi: paydayAbi, functionName: "epoch" },
        { address: ctx.payday, abi: paydayAbi, functionName: "keeper" },
      ],
    })) as unknown as [bigint, Address];
    const epoch = current - 1n;
    counts.epoch = epoch.toString();
    if (keeper.toLowerCase() !== ctx.account.address.toLowerCase()) {
      // once an hour, not once a minute: the fix is a Safe transaction, not a restart
      if (Date.now() - lastNotAppointed > 3_600_000) {
        log("payday", `wallet ${ctx.account.address} is not the payday keeper (${keeper}); pay() would revert, waiting for setKeeper`);
        lastNotAppointed = Date.now();
      }
      return { ...counts, notAppointed: 1 };
    }

    let hour: PaydayEpoch | null | undefined;
    for (const asset of await ctx.assets()) {
      const key = `${epoch}:${asset.toLowerCase()}`;
      if (done.has(key)) { counts.alreadyPaid = Number(counts.alreadyPaid) + 1; continue; }
      const [funded, paid, carried] = (await ctx.publicClient.multicall({
        allowFailure: false,
        contracts: [
          { address: ctx.payday, abi: paydayAbi, functionName: "funded", args: [epoch, asset] },
          { address: ctx.payday, abi: paydayAbi, functionName: "paid", args: [epoch, asset] },
          { address: ctx.payday, abi: paydayAbi, functionName: "carried", args: [asset] },
        ],
      })) as unknown as [bigint, bigint, bigint];
      if (paid > 0n) { done.add(key); counts.alreadyPaid = Number(counts.alreadyPaid) + 1; continue; }
      const pot = funded + carried;
      if (pot === 0n) continue;
      counts.assets = Number(counts.assets) + 1;

      if (hour === undefined) {
        hour = await ctx.api.get<PaydayEpoch>(`/payday/${epoch}`);
        if (hour === null) ctx.api.noteMissing("payday", `/payday/${epoch}`);
      }
      if (!hour) { counts.waiting = Number(counts.waiting) + 1; continue; }
      if (!hour.closed) { counts.waiting = Number(counts.waiting) + 1; continue; }

      try {
        const plan = planEpoch(pot, hour, asset, ctx.knobs.paydayDustWei);
        if (plan.wallets.length === 0 && plan.pots.length === 0) {
          log("payday", `epoch ${epoch} ${ctx.symbol(asset)}: pot ${pot} but nobody above dust and no pots, it carries`);
          counts.skipped = Number(counts.skipped) + 1;
          continue;
        }
        const sent = await ctx.queue.send(`payday ${epoch} ${ctx.symbol(asset)}`, {
          address: ctx.payday,
          abi: paydayAbi,
          functionName: "pay",
          args: [epoch, asset, plan.wallets, plan.amounts, plan.pots, plan.potAmounts],
        });
        log("payday", `epoch ${epoch} ${ctx.symbol(asset)}: pot ${pot}, ${plan.wallets.length} wallets get ${plan.toWallets}, ${plan.pots.length} pots get ${plan.toPots}, ${plan.dusted} wallets under dust, ${pot - plan.toWallets - plan.toPots} carries`);
        counts.sent = Number(counts.sent) + 1;
        if (!sent.dry) done.add(key);
      } catch (e) {
        log("payday", `epoch ${epoch} ${ctx.symbol(asset)}: ${message(e)}`);
        counts.skipped = Number(counts.skipped) + 1;
      }
    }
    return counts;
  };
}

interface Plan {
  wallets: Address[];
  amounts: bigint[];
  pots: Address[];
  potAmounts: bigint[];
  toWallets: bigint;
  toPots: bigint;
  dusted: number;
}

export function planEpoch(pot: bigint, hour: PaydayEpoch, asset: Address, dust: bigint): Plan {
  const same = (a: string | null | undefined) => (a ?? zeroAddress).toLowerCase() === asset.toLowerCase();
  const pots = (hour.lastTen ?? [])
    .filter((l) => l.pot && isAddress(l.pot) && same(l.asset))
    .map((l) => l.pot as Address)
    .slice(0, 10);
  const slice = pots.length ? (pot * SLICE_BPS) / BPS : 0n;
  const per = pots.length ? slice / BigInt(pots.length) : 0n;
  const potAmounts = pots.map(() => per);
  const toPots = per * BigInt(pots.length);
  const walletPot = pot - toPots;

  const holders = (hour.wallets ?? [])
    .filter((w) => isAddress(w.address))
    .map((w) => ({ address: w.address as Address, units: pointsToUnits(w.points) }))
    .filter((w) => w.units > 0n);
  const totalUnits = holders.reduce((s, w) => s + w.units, 0n);
  const wallets: Address[] = [];
  const amounts: bigint[] = [];
  let toWallets = 0n;
  let dusted = 0;
  if (totalUnits > 0n && walletPot > 0n) {
    for (const w of holders) {
      const amount = (walletPot * w.units) / totalUnits;
      if (amount < dust) { dusted++; continue; }
      wallets.push(w.address);
      amounts.push(amount);
      toWallets += amount;
    }
  }
  // an hour with nobody above dust still pays its slice to the launches; the wallets' part
  // carries into the next epoch on chain, which is where a share too small to send belongs
  return { wallets, amounts, pots, potAmounts, toWallets, toPots, dusted };
}
