"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { erc20Abi, isAddress, zeroAddress, type Address } from "viem";
import { useAccount, usePublicClient, useReadContract, useReadContracts, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { hoodBlockZeroAbi, hoodFactoryAbi, hoodStakingAbi, curveBuy } from "@hood/sdk";
import { addresses, blockZeroAddress } from "@/lib/config";
import { fmt, pairDecimals, pairSymbol } from "@/lib/format";
import { detectFactoryGeneration, encodePenalties, factoryTakesGuard, PENALTY_FORM_DEFAULTS } from "@/lib/launchAbi";
import { Field, Step } from "@/components/LaunchUI";
import { CURVE_GUARD_DEFAULTS, CurveGuardOptions, encodeGuard, guardProblem, type CurveGuardForm } from "@/components/CurveGuardOptions";
import { EMPTY_LEG, legsProblem, TeamLegsEditor, units, type LegForm } from "@/components/TeamLegsEditor";
import { TeamWatch } from "@/components/TeamWatch";
import { useQuery } from "@tanstack/react-query";

/// Block zero: a curve launch where every team wallet buys in the launch transaction itself.
///
/// The launch and the legs are one transaction through HoodBlockZero, so nothing can trade between
/// them, and the periphery writes every wallet, what it paid, what it got and its lock on chain. The
/// token page reads that back and labels the team on the holder map. After the launch this page
/// turns into the watch: who got in from outside, and a second wave that stands down on its own
/// when too many did. The direct machine has the same team option inside its own launch form.

interface CurvePreset {
  pairToken: `0x${string}`;
  totalSupply: bigint; curveSupplyBps: number; startCap: bigint; graduationCap: bigint;
  liquidityBps: number; protocolFeeBps: number; creatorFeeBps: number; enabled: boolean;
  poolFee: number; tickSpacing: number;
}

const ZERO32 = `0x${"0".repeat(64)}` as `0x${string}`;

function pct(part: bigint, whole: bigint): string {
  if (whole <= 0n) return "–";
  const v = Number((part * 1_000_000n) / whole) / 10_000;
  return v >= 10 ? `${v.toFixed(1)}%` : `${v.toFixed(2)}%`;
}

export default function TeamLaunchPage() {
  return (
    <Suspense fallback={null}>
      <TeamLaunch />
    </Suspense>
  );
}

function TeamLaunch() {
  const params = useSearchParams();
  const watching = params.get("token");
  if (watching && isAddress(watching)) return <TeamWatch token={watching.toLowerCase() as Address} />;
  return <TeamLaunchForm />;
}

function TeamLaunchForm() {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const router = useRouter();
  const { writeContractAsync, isPending } = useWriteContract();
  const [hash, setHash] = useState<`0x${string}` | undefined>();
  const [error, setError] = useState<string | null>(null);
  const receipt = useWaitForTransactionReceipt({ hash });

  const [form, setForm] = useState({
    name: "", symbol: "", description: "", image: "", website: "", twitter: "", telegram: "",
    configId: 0, stakers: 0, buyback: 30, liquidity: 20, creator: 50, feeRecipient: "", gas: "0.0005",
  });
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));
  const [legs, setLegs] = useState<LegForm[]>([{ ...EMPTY_LEG }]);
  const [guard, setGuard] = useState<CurveGuardForm>(CURVE_GUARD_DEFAULTS);

  const generation = useQuery({
    queryKey: ["factory-generation", addresses.factory],
    queryFn: async () => detectFactoryGeneration(await publicClient!.getCode({ address: addresses.factory })) ?? null,
    enabled: Boolean(publicClient) && addresses.factory !== zeroAddress,
    staleTime: Infinity,
  });
  const takesGuard = factoryTakesGuard(generation.data ?? undefined);

  const { data: configCount } = useReadContract({ address: addresses.factory, abi: hoodFactoryAbi, functionName: "configCount" });
  const { data: configs } = useReadContracts({
    contracts: Array.from({ length: Number(configCount ?? 0n) }, (_, i) => ({
      address: addresses.factory, abi: hoodFactoryAbi, functionName: "getConfig", args: [BigInt(i)],
    })) as never,
    query: { enabled: Boolean(configCount) },
  });
  const presets = ((configs ?? []) as { result?: CurvePreset }[])
    .map((c, id) => ({ id, preset: c.result }))
    .filter((c): c is { id: number; preset: CurvePreset } => Boolean(c.preset?.enabled));
  const chosen = presets.find((p) => p.id === form.configId)?.preset;
  useEffect(() => {
    if (presets.length && !presets.some((p) => p.id === form.configId)) set("configId", presets[0]!.id);
  }, [presets.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const { data: houseToken } = useReadContract({ address: addresses.staking, abi: hoodStakingAbi, functionName: "houseToken" });
  const canPayStakers = typeof houseToken === "string" && houseToken !== zeroAddress;
  const { data: launchFee } = useReadContract({ address: addresses.factory, abi: hoodFactoryAbi, functionName: "launchFee" });
  const { data: symbolFree } = useReadContract({
    address: addresses.factory, abi: hoodFactoryAbi, functionName: "isSymbolAvailable",
    args: [form.symbol], query: { enabled: form.symbol.length > 0 },
  });
  const { data: econ } = useReadContract({
    address: addresses.factory, abi: hoodFactoryAbi, functionName: "previewLaunchEconomics",
    args: [BigInt(form.configId), chosen?.pairToken ?? zeroAddress], query: { enabled: Boolean(chosen), refetchInterval: 15_000 },
  });

  const pair = chosen?.pairToken ?? zeroAddress;
  const isNative = pair === zeroAddress;
  const dec = pairDecimals(pair);
  const sym = pairSymbol(pair);
  const gasEach = units(form.gas, 18);

  // The legs as the chain will run them: in order, each at the price the one before it left. The
  // team's legs are inside the launch transaction, so the opening tax and the cap do not apply.
  const plan = useMemo(() => {
    const rows = legs.map((l) => ({ ...l, wei: units(l.amount, dec) }));
    if (!chosen) return { rows: rows.map((r) => ({ ...r, tokens: 0n })), total: 0n, tokens: 0n, overflow: false };
    const p0 = (chosen.startCap * 10n ** 18n) / chosen.totalSupply;
    const p1 = (chosen.graduationCap * 10n ** 18n) / chosen.totalSupply;
    const supply = (chosen.totalSupply * BigInt(chosen.curveSupplyBps)) / 10_000n;
    const feeBps = Number(chosen.protocolFeeBps) + Number(chosen.creatorFeeBps);
    let sold = 0n;
    let overflow = false;
    const out = rows.map((r) => {
      if (r.wei === 0n || sold >= supply) {
        if (r.wei > 0n) overflow = true;
        return { ...r, tokens: 0n };
      }
      const shot = curveBuy({ p0, p1, supply, sold, pairIn: r.wei, feeBps });
      sold += shot.tokensOut;
      return { ...r, tokens: shot.tokensOut };
    });
    return { rows: out, total: rows.reduce((s, r) => s + r.wei, 0n), tokens: sold, overflow };
  }, [legs, chosen, dec]);

  const splitTotal = form.stakers + form.buyback + form.liquidity + form.creator;
  const recipientOk = !form.feeRecipient.trim() || isAddress(form.feeRecipient.trim());
  const gasTotal = gasEach * BigInt(legs.length);
  const value = ((launchFee as bigint | undefined) ?? 0n) + (isNative ? plan.total : 0n) + gasTotal;

  const { data: allowance } = useReadContract({
    address: pair, abi: erc20Abi, functionName: "allowance",
    args: [address ?? zeroAddress, blockZeroAddress ?? zeroAddress],
    query: { enabled: !isNative && Boolean(address) && Boolean(blockZeroAddress) },
  });
  const needsApproval = !isNative && ((allowance as bigint | undefined) ?? 0n) < plan.total;

  const blocked = !blockZeroAddress ? "Block zero is not deployed on this build (NEXT_PUBLIC_BLOCK_ZERO is empty)."
    : !address ? "Connect the wallet that pays for the launch and every leg."
    : !form.name ? "Enter a token name."
    : !form.symbol ? "Enter a ticker."
    : symbolFree === false ? "That ticker is locked by a launch trading right now."
    : !chosen ? "Choose a preset."
    : generation.isLoading ? "Checking the factory version."
    : generation.data !== "v4" ? "The live factory is not the version block zero was built against."
    : legsProblem(legs, dec)
    ?? (plan.overflow ? "The curve sells out before the last wallets. Lower the amounts."
    : form.stakers > 0 && !canPayStakers ? "The stakers leg needs the house coin to be named first."
    : splitTotal !== 100 ? `The fee split adds up to ${splitTotal}%, it must be 100%.`
    : !recipientOk ? "The fee recipient is not an address."
    : guardProblem(guard) ? guardProblem(guard)
    : launchFee === undefined ? "Reading the launch fee."
    : undefined);

  useEffect(() => {
    if (!receipt.isSuccess || !receipt.data || !blockZeroAddress) return;
    // TeamLaunched: topic 1 is the token, and it is the only event of the periphery with four topics.
    const periphery = blockZeroAddress.toLowerCase();
    const log = receipt.data.logs.find((l) => l.address.toLowerCase() === periphery && l.topics.length === 4);
    if (log) router.push(`/launch/team?token=0x${log.topics[1]!.slice(26)}`);
    else setHash(undefined); // that was the approval; the launch is next
  }, [receipt.isSuccess, receipt.data, router]);

  async function go() {
    if (blocked || !address || !blockZeroAddress || !chosen) return;
    setError(null);
    try {
      if (needsApproval) {
        setHash(await writeContractAsync({ address: pair, abi: erc20Abi, functionName: "approve", args: [blockZeroAddress, plan.total] }));
        return;
      }
      const salt = `0x${Array.from(crypto.getRandomValues(new Uint8Array(32))).map((b) => b.toString(16).padStart(2, "0")).join("")}` as `0x${string}`;
      const launchParams = {
        name: form.name, symbol: form.symbol, image: form.image, description: form.description,
        website: form.website, twitter: form.twitter, telegram: form.telegram,
        pairToken: pair, configId: BigInt(form.configId),
        feeSplit: {
          stakersBps: form.stakers * 100, buybackBps: form.buyback * 100,
          liquidityBps: form.liquidity * 100, creatorBps: form.creator * 100,
        },
        creatorFeeRecipient: (form.feeRecipient.trim() || zeroAddress) as Address,
        firstBuy: 0n, firstBuyLock: 0n, salt,
        econ: (econ as `0x${string}` | undefined) ?? ZERO32,
        penalties: encodePenalties(PENALTY_FORM_DEFAULTS),
        guard: encodeGuard(guard),
      };
      const legArgs = plan.rows.map((r) => ({
        wallet: r.wallet.trim() as Address,
        pairIn: r.wei,
        // The price inside the launch transaction is known; the floor only catches a preset or a
        // fee that moved between this screen and the block, with half a percent of room.
        minTokensOut: (r.tokens * 995n) / 1000n,
        lock: BigInt(r.lock),
        gas: gasEach,
      }));
      // Simulated first, so a refusal shows its reason here instead of as a failed transaction.
      await publicClient!.simulateContract({
        account: address, address: blockZeroAddress, abi: hoodBlockZeroAbi, functionName: "launch",
        args: [launchParams, legArgs] as never, value,
      });
      setHash(await writeContractAsync({
        address: blockZeroAddress, abi: hoodBlockZeroAbi, functionName: "launch",
        args: [launchParams, legArgs] as never, value,
      }));
    } catch (e) {
      setError(e instanceof Error ? (e as { shortMessage?: string }).shortMessage ?? e.message : String(e));
    }
  }

  const supply = chosen?.totalSupply ?? 0n;

  return (
    <div className="launch-content">
      <div className="launch-guide">
        <div className="launch-form-stack">
          <Step n={1} title="Block zero" purpose="The token launches and every team wallet buys in the same transaction. Nobody can trade in between. Every wallet is recorded on chain and labelled as the team on the token page.">
            <p className="field-note">
              This console launches on the bonding curve. For the direct pool, add team wallets in the
              {" "}<Link className="hover:text-[var(--color-lime)]" href="/launch">direct launch form</Link>. Fresh wallets and what they do after the launch live on the{" "}
              <Link className="hover:text-[var(--color-lime)]" href="/launch/team/desk">team desk</Link>.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name"><input className="input" value={form.name} onChange={(e) => set("name", e.target.value)} /></Field>
              <Field label="Ticker" error={form.symbol && symbolFree === false ? "Taken right now." : undefined}>
                <input className="input" value={form.symbol} onChange={(e) => set("symbol", e.target.value.replace(/^\$/, ""))} />
              </Field>
              <Field label="Image URL"><input className="input" value={form.image} onChange={(e) => set("image", e.target.value)} placeholder="ipfs:// or https://" /></Field>
              <Field label="Description"><input className="input" value={form.description} onChange={(e) => set("description", e.target.value)} /></Field>
              <Field label="Website"><input className="input" value={form.website} onChange={(e) => set("website", e.target.value)} /></Field>
              <Field label="X"><input className="input" value={form.twitter} onChange={(e) => set("twitter", e.target.value)} /></Field>
              <Field label="Telegram"><input className="input" value={form.telegram} onChange={(e) => set("telegram", e.target.value)} /></Field>
              <Field label="Preset" help={chosen ? `Opens at ${fmt(chosen.startCap, dec, 4)} ${sym}, graduates at ${fmt(chosen.graduationCap, dec, 4)} ${sym}.` : "Reading presets from the factory."}>
                <select className="input" value={form.configId} onChange={(e) => set("configId", Number(e.target.value))}>
                  {presets.map(({ id, preset }) => (
                    <option key={id} value={id}>
                      #{id} · {pairSymbol(preset.pairToken)} · {fmt(preset.startCap, pairDecimals(preset.pairToken), 2)} → {fmt(preset.graduationCap, pairDecimals(preset.pairToken), 2)}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          </Step>

          <Step n={2} title="Fee split" purpose="Where the creator leg of every trade goes. The four must add up to 100.">
            <div className="grid gap-4 sm:grid-cols-4">
              {(["stakers", "buyback", "liquidity", "creator"] as const).map((k) => (
                <Field key={k} label={`${k} %`}>
                  <input className="input" type="number" min={0} max={100} value={form[k]} onChange={(e) => set(k, Math.max(0, Math.min(100, Number(e.target.value) || 0)))} />
                </Field>
              ))}
            </div>
            <Field label="Creator fee recipient" help="Empty means the wallet that launches.">
              <input className="input" value={form.feeRecipient} onChange={(e) => set("feeRecipient", e.target.value)} placeholder="0x…" />
            </Field>
          </Step>

          <Step n={3} title="Sniper protection" purpose="Everyone after the launch transaction pays the opening tax and meets the wallet cap. The team's own wallets buy inside it, so neither applies to them.">
            <CurveGuardOptions value={guard} onChange={setGuard} />
          </Step>

          <Step n={4} title="Team wallets" purpose="They buy in this order, each at the price the one before it left. A locked wallet's tokens sit in the token lock until the date, and only that wallet can take them out.">
            <TeamLegsEditor legs={legs} onChange={setLegs} symbol={sym} decimals={dec} estimates={plan.rows.map((r) => r.tokens || undefined)} supply={supply} />
            <Field label="Gas per wallet, in ETH" help="Sent to every team wallet with its tokens, so it can later withdraw a lock, sell or send. 0 for none.">
              <input className="input mono" value={form.gas} onChange={(e) => set("gas", e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" />
            </Field>
          </Step>

          <Step n={5} title="Review and launch" purpose="One transaction. The token, the curve and every team buy land together.">
            <ul className="text-sm space-y-1">
              <li>{legs.length} team wallets pay <b className="mono">{fmt(plan.total, dec, 6)} {sym}</b> and get <b className="mono">{fmt(plan.tokens, 18, 0)}</b> tokens, <b>{pct(plan.tokens, supply)}</b> of the supply.</li>
              {gasTotal > 0n && <li>Each wallet also gets <span className="mono">{form.gas} ETH</span> of gas, <span className="mono">{fmt(gasTotal, 18, 6)} ETH</span> in all.</li>}
              <li>Launch fee <span className="mono">{fmt((launchFee as bigint | undefined) ?? 0n, 18, 6)} ETH</span>. The transaction carries <span className="mono">{fmt(value, 18, 6)} ETH</span>{!isNative && ` and pulls ${fmt(plan.total, dec, 6)} ${sym} from your wallet`}.</li>
              <li>The team wallets and their locks are public: the token page shows them as the team, on the holder map and in the team panel.</li>
            </ul>
            {blocked && <p className="field-note bad mt-3">{blocked}</p>}
            {error && <p className="field-note bad mt-3">{error}</p>}
            <button type="button" className="btn mt-4" disabled={Boolean(blocked) || isPending || receipt.isLoading} onClick={go}>
              {isPending || receipt.isLoading ? "Waiting for the chain…" : needsApproval ? `Approve ${sym}` : "Launch with the team"}
            </button>
          </Step>
        </div>
      </div>
    </div>
  );
}
