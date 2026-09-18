"use client";

import { useEffect, useState } from "react";
import { zeroAddress, type Address } from "viem";
import { useAccount, usePublicClient, useReadContract, useReadContracts, useWriteContract } from "wagmi";
import { hoodLaunchHookAbi, hoodRevenueSplitterAbi, hoodLockerAbi, hoodBuybackModuleAbi, minOutFromQuote, quoteBuybackRun } from "@hood/sdk";
import { fmt, pairDecimals, pairSymbol } from "@/lib/format";
import { snipeCountdown } from "@/lib/direct";

/// A run is permissionless and swaps a real pool, so it gets the same floor the keeper sends:
/// one percent under a quote of the run itself.
const BUYBACK_SLIPPAGE_BPS = 100;

/// What the tax does with itself, live. Every number here is read from the launch's own contracts
/// rather than from our database, because these are the ones a buyer is trusting.
export function DirectPanels({ token, hook, splitter, locker, quote, launchedAt, buybackModule }: {
  token: Address; hook: Address; splitter: Address; locker: Address; quote: Address;
  launchedAt: number; buybackModule?: Address;
}) {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const dec = pairDecimals(quote);
  const sym = pairSymbol(quote);
  const [now, setNow] = useState(Date.now() / 1000);
  const [buybackError, setBuybackError] = useState<string>();

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() / 1000), 500);
    return () => clearInterval(t);
  }, []);

  const { data: hookData } = useReadContracts({
    contracts: [
      { address: hook, abi: hoodLaunchHookAbi, functionName: "buyTaxBps" },
      { address: hook, abi: hoodLaunchHookAbi, functionName: "sellTaxBps" },
      { address: hook, abi: hoodLaunchHookAbi, functionName: "snipeTaxBps" },
      { address: hook, abi: hoodLaunchHookAbi, functionName: "snipeDecaySeconds" },
      { address: hook, abi: hoodLaunchHookAbi, functionName: "bonded" },
    ] as never,
    query: { refetchInterval: 4_000 },
  });
  const h = (hookData ?? []) as { result?: unknown }[];
  const buyTax = Number((h[0]?.result as number | undefined) ?? 0);
  const sellTax = Number((h[1]?.result as number | undefined) ?? 0);
  const snipeTax = Number((h[2]?.result as number | undefined) ?? 0);
  const decay = Number((h[3]?.result as number | undefined) ?? 0);
  const bonded = Boolean(h[4]?.result);

  const { data: splitterData } = useReadContracts({
    contracts: [
      { address: splitter, abi: hoodRevenueSplitterAbi, functionName: "allocations" },
      { address: splitter, abi: hoodRevenueSplitterAbi, functionName: "creatorClaimable" },
      { address: splitter, abi: hoodRevenueSplitterAbi, functionName: "buybackPot" },
      { address: splitter, abi: hoodRevenueSplitterAbi, functionName: "liquidityPot" },
      { address: splitter, abi: hoodRevenueSplitterAbi, functionName: "dividendsHeld" },
      { address: splitter, abi: hoodRevenueSplitterAbi, functionName: "creator" },
    ] as never,
    query: { refetchInterval: 8_000 },
  });
  const s = (splitterData ?? []) as { result?: unknown }[];
  const allocations = (s[0]?.result as readonly number[] | undefined) ?? [0, 0, 0, 0];
  const creatorClaimable = (s[1]?.result as bigint | undefined) ?? 0n;
  const buybackPot = (s[2]?.result as bigint | undefined) ?? 0n;
  const liquidityPot = (s[3]?.result as bigint | undefined) ?? 0n;
  const dividendsHeld = (s[4]?.result as bigint | undefined) ?? 0n;
  const creator = (s[5]?.result as Address | undefined) ?? zeroAddress;

  // What the last run could not spend under the impact limit, waiting in the module for the next.
  const { data: carriedRaw } = useReadContract({
    address: buybackModule ?? zeroAddress, abi: hoodBuybackModuleAbi, functionName: "carried", args: [token],
    query: { enabled: Boolean(buybackModule), refetchInterval: 8_000 },
  });
  const carried = (carriedRaw as bigint | undefined) ?? 0n;

  const { data: pending } = useReadContract({
    address: splitter, abi: hoodRevenueSplitterAbi, functionName: "pendingDividends",
    args: [address ?? zeroAddress], query: { enabled: Boolean(address), refetchInterval: 8_000 },
  });

  // The hook is the clock: what it charges this second is what a trade pays this second. The
  // wall-clock estimate only animates the bar between reads.
  const { data: liveSnipe } = useReadContract({
    address: hook, abi: hoodLaunchHookAbi, functionName: "currentSnipeBps", query: { refetchInterval: 1_000 },
  });
  const chainSnipeBps = Number((liveSnipe as bigint | undefined) ?? 0n);
  const estimate = snipeCountdown(launchedAt, decay, now);
  const countdown = chainSnipeBps === 0
    ? { active: false, remaining: 0, fraction: 0 }
    : { active: true, remaining: estimate.remaining, fraction: snipeTax === 0 ? 0 : chainSnipeBps / snipeTax };
  const isCreator = address?.toLowerCase() === creator.toLowerCase();

  /// Quote the run by running it, then send it with a floor. Nothing to buy means nothing is sent.
  async function runBuyback() {
    setBuybackError(undefined);
    try {
      const expected = await quoteBuybackRun({ publicClient: publicClient as never, buybackModule: buybackModule!, token });
      if (expected === 0n) throw new Error("the buyback would buy nothing right now");
      await writeContractAsync({
        address: buybackModule!, abi: hoodBuybackModuleAbi, functionName: "run",
        args: [token, minOutFromQuote(expected, BUYBACK_SLIPPAGE_BPS)],
      });
    } catch (e) {
      const err = e as { shortMessage?: string; message?: string };
      setBuybackError(err.shortMessage ?? err.message ?? String(e));
    }
  }

  return (
    <>
      {countdown.active && (
        <div className="panel border-[var(--color-red)] p-4">
          <h3 className="font-semibold text-[var(--color-red)]">Opening surcharge</h3>
          <p className="mt-1 text-xs dim">
            An extra {(chainSnipeBps / 100).toFixed(1)}% on top of the tax right now, falling to nothing
            within {decay}s of the open. It exists so the first block belongs to people rather than to
            whoever has the fastest bot.
          </p>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--color-ink)]">
            <div className="h-full bg-[var(--color-red)]" style={{ width: `${countdown.fraction * 100}%` }} />
          </div>
        </div>
      )}

      <div className="panel space-y-3 p-4">
        <div className="flex items-baseline justify-between">
          <h3 className="font-semibold">The tax, and where it goes</h3>
          <span className={`text-xs ${bonded ? "text-[var(--color-lime)]" : "dim"}`}>
            {bonded ? "graduated" : "graduating"}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <Fact label="buy" value={`${(buyTax / 100).toFixed(2)}%`} />
          <Fact label="sell" value={`${(sellTax / 100).toFixed(2)}%`} />
        </div>

        <div className="space-y-1.5 text-xs">
          <Road label="creator" bps={Number(allocations[0])} amount={creatorClaimable} dec={dec} sym={sym} />
          <Road label="buy back and burn" bps={Number(allocations[1])} amount={buybackPot} dec={dec} sym={sym} />
          <Road label="holders" bps={Number(allocations[2])} amount={dividendsHeld} dec={dec} sym={sym} />
          <Road label="liquidity" bps={Number(allocations[3])} amount={liquidityPot} dec={dec} sym={sym} />
          <p className="dim">A tenth goes to the protocol before any of this, and none of it can be changed.</p>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <button className="btn btn-ghost text-xs" disabled={!address || (buybackPot === 0n && carried === 0n) || !buybackModule}
            onClick={runBuyback}>
            run the buyback
          </button>
          <button className="btn btn-ghost text-xs" disabled={!address}
            onClick={() => writeContractAsync({ address: locker, abi: hoodLockerAbi, functionName: "harvestFees", args: [] })}>
            harvest pool fees
          </button>
          <button className="btn btn-ghost text-xs" disabled={!address || liquidityPot === 0n}
            onClick={() => writeContractAsync({ address: splitter, abi: hoodRevenueSplitterAbi, functionName: "pushLiquidity", args: [] })}>
            deepen liquidity
          </button>
          <button className="btn btn-ghost text-xs" disabled={!address}
            onClick={() => writeContractAsync({ address: splitter, abi: hoodRevenueSplitterAbi, functionName: "sweep", args: [] })}>
            split what arrived
          </button>
        </div>
        {carried > 0n && (
          <p className="text-xs dim">
            The last run stopped at its impact limit; {fmt(carried, dec, 4)} {sym} is carried to the next one.
          </p>
        )}
        {buybackError && <p className="break-words text-xs text-[var(--color-red)]">{buybackError}</p>}
        <p className="text-xs dim">Every one of those is permissionless. Anybody can make them happen.</p>
      </div>

      {Number(allocations[2]) === 0 ? (
        <div className="panel p-4 text-xs dim">
          This launch sends no tax to holders. The creator's share goes to the roads above instead.
        </div>
      ) : (
      <div className="panel space-y-2 p-4">
        <h3 className="font-semibold">Your dividends</h3>
        <div className="flex items-baseline justify-between text-sm">
          <span className="dim">claimable</span>
          <span className="mono">{fmt((pending as bigint | undefined) ?? 0n, dec, 6)} {sym}</span>
        </div>
        <p className="text-xs dim">
          Paid out of the tax to whoever holds the token, by balance. Nothing is pushed on a transfer,
          so holding costs no gas until you claim.
        </p>
        <button className="btn w-full text-sm" disabled={!address || ((pending as bigint | undefined) ?? 0n) === 0n}
          onClick={() => writeContractAsync({
            address: splitter, abi: hoodRevenueSplitterAbi, functionName: "claimDividends", args: [address!],
          })}>
          claim
        </button>
      </div>
      )}

      {isCreator && (
        <div className="panel space-y-2 p-4">
          <h3 className="font-semibold">Your share</h3>
          <div className="flex items-baseline justify-between text-sm">
            <span className="dim">claimable</span>
            <span className="mono">{fmt(creatorClaimable, dec, 6)} {sym}</span>
          </div>
          <button className="btn w-full text-sm" disabled={creatorClaimable === 0n}
            onClick={() => writeContractAsync({
              address: splitter, abi: hoodRevenueSplitterAbi, functionName: "claim", args: [address!],
            })}>
            claim to my wallet
          </button>
        </div>
      )}
    </>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[var(--color-line)] p-2">
      <div className="mono text-sm">{value}</div>
      <div className="dim">{label}</div>
    </div>
  );
}

function Road({ label, bps, amount, dec, sym }: { label: string; bps: number; amount: bigint; dec: number; sym: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-32 dim">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--color-ink)]">
        <div className="h-full bg-[var(--color-lime)]" style={{ width: `${bps / 100}%` }} />
      </div>
      <span className="mono w-12 text-right">{(bps / 100).toFixed(0)}%</span>
      <span className="mono w-24 text-right dim">{fmt(amount, dec, 4)} {sym}</span>
    </div>
  );
}
