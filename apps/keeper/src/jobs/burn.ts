import { type Address, getAbiItem, zeroAddress } from "viem";
import { burnClockAbi } from "../abi.js";
import type { Ctx, Job } from "../context.js";
import { log } from "../log.js";
import { message } from "../queue.js";

/// The burn clock. Every minute: if the house coin is set, for every asset the clock holds and
/// has not spent this hour, simulate `burn(asset, balance, 0)` to learn what the swap returns
/// right now, then send it with a floor of that minus KEEPER_BURN_SLIPPAGE_BPS. "Not this hour"
/// comes from the chain: a `Burned` event for this asset and epoch in the last hour of blocks, and
/// failing that the contract's own once-per-hour revert in the simulation. Memory only saves reads.

const BPS = 10_000n;
/// 100 ms blocks: an hour is 36,000 blocks. A little more so a slow hour is still covered.
const HOUR_OF_BLOCKS = 40_000n;

export function burnJob(ctx: Ctx): Job {
  const burnedAt = new Map<string, bigint>();
  let lastNotAppointed = 0;
  let lastUnset = 0;

  return async () => {
    if (!ctx.burnClock) return { off: 1 };
    const counts: Record<string, number | string> = { houseCoin: "unset", funded: 0, sent: 0, doneThisHour: 0, blocked: 0 };
    const [houseCoin, keeper] = (await ctx.publicClient.multicall({
      allowFailure: false,
      contracts: [
        { address: ctx.burnClock, abi: burnClockAbi, functionName: "houseCoin" },
        { address: ctx.burnClock, abi: burnClockAbi, functionName: "keeper" },
      ],
    })) as unknown as [Address, Address];
    if (houseCoin === zeroAddress) {
      if (Date.now() - lastUnset > 3_600_000) {
        log("burn", "the house coin is not set on the burn clock; the shares accrue, nothing burns yet");
        lastUnset = Date.now();
      }
      return counts;
    }
    counts.houseCoin = houseCoin;
    if (keeper.toLowerCase() !== ctx.account.address.toLowerCase()) {
      if (Date.now() - lastNotAppointed > 3_600_000) {
        log("burn", `wallet ${ctx.account.address} is not the burn clock keeper (${keeper}); burn() would revert, waiting for setKeeper`);
        lastNotAppointed = Date.now();
      }
      return { ...counts, notAppointed: 1 };
    }

    const epoch = BigInt(Math.floor(Date.now() / 1000 / 3600));
    const head = await ctx.publicClient.getBlockNumber();
    for (const asset of await ctx.assets()) {
      const key = asset.toLowerCase();
      if (burnedAt.get(key) === epoch) { counts.doneThisHour = Number(counts.doneThisHour) + 1; continue; }
      const balance = (await ctx.publicClient.readContract({
        address: ctx.burnClock, abi: burnClockAbi, functionName: "balanceOf", args: [asset],
      })) as bigint;
      if (balance === 0n) continue;
      counts.funded = Number(counts.funded) + 1;

      // the chain remembers what this process may have forgotten across a restart
      if (await burnedThisHour(ctx, asset, epoch, head)) {
        burnedAt.set(key, epoch);
        counts.doneThisHour = Number(counts.doneThisHour) + 1;
        continue;
      }

      let expected: readonly [bigint, bigint];
      try {
        const { result } = await ctx.publicClient.simulateContract({
          address: ctx.burnClock, abi: burnClockAbi, functionName: "burn", args: [asset, balance, 0n], account: ctx.account,
        });
        expected = result;
      } catch (e) {
        // already burned this hour, or the pool cannot take it without passing the impact cap
        log("burn", `${ctx.symbol(asset)}: burn(${balance}) would revert (${message(e)}); waiting`);
        counts.blocked = Number(counts.blocked) + 1;
        continue;
      }
      const [spent, burned] = expected;
      if (burned === 0n) {
        log("burn", `${ctx.symbol(asset)}: the swap would burn nothing right now, skipped`);
        counts.blocked = Number(counts.blocked) + 1;
        continue;
      }
      const minOut = (burned * (BPS - BigInt(ctx.knobs.burnSlippageBps))) / BPS;
      try {
        const sent = await ctx.queue.send(`burn ${ctx.symbol(asset)}`, {
          address: ctx.burnClock, abi: burnClockAbi, functionName: "burn", args: [asset, balance, minOut],
        });
        log("burn", `${ctx.symbol(asset)}: spend up to ${balance} (quote spends ${spent}, burns ${burned}), floor ${minOut}`);
        counts.sent = Number(counts.sent) + 1;
        if (!sent.dry) burnedAt.set(key, epoch);
      } catch (e) {
        log("burn", `${ctx.symbol(asset)}: ${message(e)}`);
        counts.blocked = Number(counts.blocked) + 1;
      }
    }
    return counts;
  };
}

async function burnedThisHour(ctx: Ctx, asset: Address, epoch: bigint, head: bigint): Promise<boolean> {
  try {
    const logs = await ctx.publicClient.getLogs({
      address: ctx.burnClock!,
      event: getAbiItem({ abi: burnClockAbi, name: "Burned" }),
      args: { asset, epoch },
      fromBlock: head > HOUR_OF_BLOCKS ? head - HOUR_OF_BLOCKS : 0n,
      toBlock: head,
    });
    return logs.length > 0;
  } catch {
    // an RPC that refuses the range is not a reason to skip; the simulation is the second guard
    return false;
  }
}
