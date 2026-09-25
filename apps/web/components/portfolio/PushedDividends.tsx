"use client";

import Link from "next/link";
import { useState } from "react";
import { parseAbi, type Address } from "viem";
import { useAccount, useReadContracts, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { useQueries } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { ago, fmt } from "@/lib/format";
import { Figure } from "@/components/Provenance";
import { assetDecimals, assetSymbol, type AssetRef } from "./VaultEarnings";

/// `GET /portfolio/:address` -> `pushed`: what a token's pot has paid this wallet, per token, in
/// that token's quote. The keeper pushes it; nobody had to claim.
export interface PushedRow extends AssetRef {
  token: string;
  symbol: string;
  amount: string;
  last_ts: string | null;
  /// The pot's address when the API sends it. Otherwise it is looked up per token.
  pot?: string | null;
}

/// The pot's fallback, straight from IHoodPot. `claim` is permissionless and only ever pays the
/// account itself, so this is safe to expose as a button.
const potAbi = parseAbi([
  "function pending(address account) view returns (uint256)",
  "function claim(address account) returns (uint256)",
]);

export function PushedDividends({ address, rows }: { address: string; rows: PushedRow[] | undefined }) {
  const { address: connected } = useAccount();
  const { writeContractAsync, isPending } = useWriteContract();
  const [hash, setHash] = useState<`0x${string}`>();
  const [error, setError] = useState<string>();
  const receipt = useWaitForTransactionReceipt({ hash });
  const list = rows ?? [];

  // The pot behind each token. A row from a newer API names it; otherwise the token's pot route
  // does, and a token without a pot (a curve launch on the old contracts) simply has no fallback.
  const lookups = useQueries({
    queries: list.filter((r) => !r.pot).map((r) => ({
      queryKey: ["pot", r.token],
      queryFn: () => api<{ pot: string | null }>(`/tokens/${r.token}/pot`),
      staleTime: 60_000,
      retry: false,
    })),
  });
  const pots = new Map<string, Address>();
  let i = 0;
  for (const r of list) {
    const pot = r.pot ?? (lookups[i++]?.data?.pot ?? null);
    if (pot) pots.set(r.token, pot as Address);
  }
  const withPot = list.filter((r) => pots.has(r.token));
  const { data: pendingReads, refetch } = useReadContracts({
    contracts: withPot.map((r) => ({
      address: pots.get(r.token)!, abi: potAbi, functionName: "pending" as const, args: [address as Address],
    })) as never,
    query: { enabled: withPot.length > 0, refetchInterval: 30_000 },
  });
  const pending = new Map(withPot.map((r, k) => [r.token, ((pendingReads ?? []) as { result?: unknown }[])[k]?.result as bigint | undefined] as const));
  const canClaim = connected?.toLowerCase() === address.toLowerCase();

  async function claim(token: string) {
    const pot = pots.get(token);
    if (!pot || !canClaim || !connected) return;
    setError(undefined);
    try {
      setHash(await writeContractAsync({ address: pot, abi: potAbi, functionName: "claim", args: [connected] }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <section className="panel portfolio-section p-5">
      <div className="panel-head"><span className="n">03 / PAID TO YOU</span><h2>Dividends pushed to this wallet</h2><span className="hatch" aria-hidden="true" /></div>
      <p className="mb-4 text-sm dim">
        You hold a token, its pot books your share every block, and a keeper pays it to your wallet every five minutes, gas on the house. Paid to your wallet, no claim needed.
      </p>
      {rows === undefined ? (
        <div className="earn-grid">
          <Figure label="pushed to you" kind="measured" value={null} reason="the indexer does not report pushed dividends yet" />
        </div>
      ) : list.length === 0 ? (
        <p className="empty-inline">Nothing pushed yet. Hold a token whose holders get paid and the next push has your name on it.</p>
      ) : (
        <div className="rows">
          {list.map((r) => {
            const owed = pending.get(r.token);
            return (
              <div className="row earnings-row" key={r.token}>
                <span className="row-name">
                  <Link href={`/token/${r.token}`}><strong>${r.symbol}</strong></Link>
                  <span>{r.last_ts ? `last push ${ago(r.last_ts)} ago` : "no push yet"}</span>
                </span>
                <span className="row-num">
                  <strong>{fmt(BigInt(r.amount || "0"), assetDecimals(r), 6)} {assetSymbol(r)}</strong>
                  <span>paid to your wallet</span>
                </span>
                {owed !== undefined && owed > 0n && (
                  <div className="min-w-0 text-xs dim">
                    {fmt(owed, assetDecimals(r), 6)} {assetSymbol(r)} booked and not yet pushed.{" "}
                    <button type="button" className="underline" disabled={!canClaim || isPending || receipt.isLoading} onClick={() => void claim(r.token)}>
                      claim now
                    </button>
                    {" "}instead of waiting for the keeper.
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {receipt.isSuccess && <button type="button" className="mt-3 text-xs underline" onClick={() => void refetch()}>Transaction confirmed. Refresh balances</button>}
      {error && <p className="mt-3 break-words text-xs text-[var(--color-red)]">{error}</p>}
    </section>
  );
}
