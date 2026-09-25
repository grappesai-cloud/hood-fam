"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { type Address } from "viem";
import { useAccount, useReadContracts, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { hoodRevenueSplitterAbi } from "@hood/sdk";
import { compact, pairDecimals, pairSymbol } from "@/lib/format";

export interface EarningSource {
  token: string;
  symbol: string;
  name: string;
  mode: "curve" | "direct";
  pair_token: string;
  pair_symbol: string | null;
  pair_decimals: number | null;
  creator: string;
  fee_recipient: string;
  splitter: string | null;
  creator_distributed: string;
  creator_claimed: string;
  dividends_claimed: string;
}

export function PortfolioEarnings({ address, sources }: { address: string; sources: EarningSource[] }) {
  const { address: connected } = useAccount();
  const [error, setError] = useState<string>();
  const [hash, setHash] = useState<`0x${string}`>();
  const { writeContractAsync, isPending } = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash });
  const direct = useMemo(() => sources.filter((s) => s.mode === "direct" && s.splitter), [sources]);
  const { data: reads, refetch } = useReadContracts({
    contracts: direct.flatMap((source) => [
      { address: source.splitter as Address, abi: hoodRevenueSplitterAbi, functionName: "creator" as const },
      { address: source.splitter as Address, abi: hoodRevenueSplitterAbi, functionName: "creatorClaimable" as const },
      { address: source.splitter as Address, abi: hoodRevenueSplitterAbi, functionName: "pendingDividends" as const, args: [address as Address] },
    ]) as never,
    query: { enabled: direct.length > 0, refetchInterval: 30_000 },
  });
  const live = new Map(direct.map((source, index) => {
    const records = (reads ?? []) as { result?: unknown }[];
    const owner = records[index * 3]?.result as string | undefined;
    return [source.token, {
      creator: owner?.toLowerCase() === address.toLowerCase() ? (records[index * 3 + 1]?.result as bigint | undefined) ?? 0n : 0n,
      holder: (records[index * 3 + 2]?.result as bigint | undefined) ?? 0n,
    }] as const;
  }));
  const canClaim = connected?.toLowerCase() === address.toLowerCase();

  async function claim(source: EarningSource, kind: "creator" | "holder") {
    if (!canClaim || !source.splitter || !connected) return;
    setError(undefined);
    try {
      const tx = await writeContractAsync({
        address: source.splitter as Address,
        abi: hoodRevenueSplitterAbi,
        functionName: kind === "creator" ? "claim" : "claimDividends",
        args: [connected],
      });
      setHash(tx);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  if (!sources.length) return null;
  return <section className="panel portfolio-section p-5">
    <div className="panel-head"><span className="n">02 / EARNINGS</span><h2>Fees and claimable balances</h2><span className="hatch" aria-hidden="true" /></div>
    <p className="mb-4 text-sm dim">&quot;Claimable now&quot; is yours, read live from each token&apos;s splitter. The creator leg waits for you to claim it. The holder leg is pushed to your wallet by the keeper and listed under &quot;Paid to you&quot; below; the claim button here is the fallback for what is booked and not yet pushed. Historical fee flows are token-wide and may include other recipients. Amounts in different quote assets are never added together.</p>
    <div className="rows">
      {sources.map((source) => {
        const dec = pairDecimals(source.pair_token, source);
        const unit = pairSymbol(source.pair_token, source);
        const pending = live.get(source.token);
        const creatorPending = pending?.creator ?? 0n;
        const holderPending = pending?.holder ?? 0n;
        const creatorHistory = BigInt(source.creator_distributed || "0");
        const creatorClaimed = BigInt(source.creator_claimed || "0");
        const holderClaimed = BigInt(source.dividends_claimed || "0");
        return <div className="row earnings-row" key={source.token}>
          <span className="row-name"><Link href={`/token/${source.token}`}><strong>${source.symbol}</strong></Link><span>{source.mode === "direct" ? "Direct pool" : "Bonding curve"} · {unit} quote</span></span>
          <span className="row-num"><strong>{compact(creatorPending + holderPending, dec)} {unit}</strong><span>claimable now</span></span>
          <div className="min-w-0 text-xs dim">
            {creatorHistory > 0n && <div>Token-wide creator share: {compact(creatorHistory, dec)} {unit}</div>}
            {creatorClaimed > 0n && <div>Creator claims (all recipients): {compact(creatorClaimed, dec)} {unit}</div>}
            {holderClaimed > 0n && <div>Holder claimed: {compact(holderClaimed, dec)} {unit}</div>}
            {creatorPending > 0n && <button type="button" className="underline" disabled={!canClaim || isPending || receipt.isLoading} onClick={() => void claim(source, "creator")}>Claim creator fees</button>}
            {holderPending > 0n && <button type="button" className="ml-3 underline" disabled={!canClaim || isPending || receipt.isLoading} onClick={() => void claim(source, "holder")}>Claim holder share now (the keeper pushes it otherwise)</button>}
            {source.mode === "curve" && <Link className="underline" href={`/token/${source.token}`}>See fee flow</Link>}
          </div>
        </div>;
      })}
    </div>
    {receipt.isSuccess && <button type="button" className="mt-3 text-xs underline" onClick={() => void refetch()}>Transaction confirmed · refresh balances</button>}
    {error && <p className="mt-3 break-words text-xs text-[var(--color-red)]">{error}</p>}
    <p className="mt-3 text-xs dim">Historical rows reflect indexed events. A live claimable amount can differ while the indexer catches up.</p>
  </section>;
}
