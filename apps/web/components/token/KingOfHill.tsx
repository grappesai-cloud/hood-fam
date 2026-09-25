"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { zeroAddress, type Address } from "viem";
import { useAccount, useReadContracts, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { BAG_KEYS, big, isMissing, useKing, type KingRound } from "@/lib/bag";
import { hoodKingAbi } from "@/lib/bagAbi";
import { useLive, type LiveKing } from "@/lib/live";
import { ago, fmt, shortAddress } from "@/lib/format";
import { Prov } from "@/components/Provenance";

/// King of the hill. A slice of every penalty's holder share fills a pot; every buy crowns the
/// buyer and resets a 60 second timer; when the timer runs out the king takes the pot. The
/// splitter is the clock and the vault, so its reads win over the indexer's; the indexer supplies
/// the history and the stream tells the page the moment a crown changes hands.

const ROUND_SECONDS = 60;

function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function unix(value: string | number | null | undefined): number {
  if (value == null) return 0;
  if (typeof value === "number") return value > 1e12 ? value / 1000 : value;
  const n = Number(value);
  if (Number.isFinite(n) && value.trim() !== "") return n > 1e12 ? n / 1000 : n;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t / 1000 : 0;
}

export function KingOfHill({ token, splitter, kingBps, decimals, symbol }: {
  token: string;
  splitter?: string | null;
  kingBps: number;
  decimals: number;
  symbol: string;
}) {
  const { address } = useAccount();
  const queryClient = useQueryClient();
  const indexed = useKing(token);
  const [pushed, setPushed] = useState<LiveKing | null>(null);
  const [now, setNow] = useState(() => Date.now() / 1000);
  const [error, setError] = useState<string>();
  const [hash, setHash] = useState<`0x${string}` | undefined>();
  const { writeContractAsync, isPending } = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash });

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() / 1000), 500);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!receipt.isSuccess) return;
    void queryClient.invalidateQueries({ queryKey: BAG_KEYS.king(token) });
    void queryClient.invalidateQueries({ queryKey: BAG_KEYS.pot(token) });
  }, [receipt.isSuccess, queryClient, token]);

  useLive({
    tokens: [token],
    onKing: (event) => {
      setPushed(event);
      void queryClient.invalidateQueries({ queryKey: BAG_KEYS.king(token) });
    },
  });

  const contract = splitter && splitter !== zeroAddress ? (splitter as Address) : undefined;
  const { data: onChain } = useReadContracts({
    contracts: [
      { address: contract, abi: hoodKingAbi, functionName: "king" },
      { address: contract, abi: hoodKingAbi, functionName: "kingPot" },
      { address: contract, abi: hoodKingAbi, functionName: "kingEndsAt" },
    ],
    query: { enabled: Boolean(contract), refetchInterval: 4_000 },
  });
  const chain = (onChain ?? []) as { result?: unknown; status?: string }[];
  const chainOk = chain.length === 3 && chain.every((c) => c.status === "success");

  // The chain's word first, then the stream's, then the indexer's, then nothing.
  const king: string | null = chainOk
    ? ((chain[0]!.result as Address) === zeroAddress ? null : (chain[0]!.result as string))
    : pushed?.king ?? indexed.data?.king ?? null;
  const pot: bigint = chainOk ? (chain[1]!.result as bigint) : big(pushed?.pot ?? indexed.data?.pot);
  const endsAt: number = chainOk ? Number(chain[2]!.result as bigint) : unix(pushed?.ends_at ?? indexed.data?.ends_at);
  const remaining = endsAt - now;
  const running = endsAt > 0 && remaining > 0;
  const over = endsAt > 0 && remaining <= 0 && pot > 0n;
  const rounds: KingRound[] = (indexed.data?.rounds ?? []).filter((r) => r.won_at).slice(0, 3);

  async function settle() {
    if (!contract) return;
    setError(undefined);
    try {
      setHash(await writeContractAsync({ address: contract, abi: hoodKingAbi, functionName: "settleKing" }));
    } catch (e) {
      const err = e as { shortMessage?: string; message?: string };
      setError(err.shortMessage ?? err.message ?? String(e));
    }
  }

  return (
    <div className={`panel king-panel p-4${running ? " running" : ""}`}>
      <div className="flex items-baseline justify-between">
        <h3 className="font-semibold">King of the hill</h3>
        <span className="mono dim text-xs">{(kingBps / 100).toFixed(kingBps % 100 === 0 ? 0 : 1)}% of every penalty</span>
      </div>
      <p className="mt-1 text-xs dim">
        Every buy crowns the buyer and resets a {ROUND_SECONDS} second timer. When it runs out, the king takes the pot.
      </p>

      <div className="king-figures">
        <div className="king-timer-wrap">
          <div className={`king-timer mono${over ? " over" : running ? " live" : ""}`}>
            {running ? clock(remaining) : over ? "00:00" : "--:--"}
          </div>
          <div className="dim text-xs">
            {running ? "until the crown pays" : over ? "the timer has run out" : "no timer running"}
          </div>
        </div>
        <div>
          <div className="mono text-sm">{fmt(pot, decimals, 4)} {symbol}</div>
          <div className="dim text-xs">in the pot <Prov kind="measured" /></div>
        </div>
        <div>
          <div className="mono text-sm">
            {king ? <Link href={`/portfolio?address=${king}`}>{shortAddress(king)}</Link> : <span className="figure-dash">—</span>}
          </div>
          <div className="dim text-xs">{king ? "wears the crown" : "nobody crowned yet"}</div>
        </div>
      </div>

      {!king && !indexed.isError && (
        <p className="text-xs dim">You buy, you wear the crown for {ROUND_SECONDS} seconds. Nobody outbuys you in that time, you take the pot.</p>
      )}
      {indexed.isError && !chainOk && (
        <p className="text-xs dim">
          {isMissing(indexed.error) ? "The king pot is not indexed on this deployment yet." : "The indexer did not answer; the splitter holds the truth."}
        </p>
      )}

      {over && (
        <button className="btn mt-3 w-full text-sm" disabled={!address || !contract || isPending || receipt.isLoading} onClick={settle}>
          {isPending || receipt.isLoading ? "paying the king" : `pay the pot to ${king ? shortAddress(king) : "the king"} (anyone can)`}
        </button>
      )}
      {over && !contract && <p className="mt-1 text-xs dim">This launch's splitter is not on the row yet, so the page cannot settle it from here.</p>}
      {error && <p className="mt-2 break-words text-xs text-[var(--color-red)]">{error}</p>}
      {receipt.isSuccess && <p className="mt-2 text-xs text-[var(--color-lime)]">The pot was paid. The next buy starts a new round.</p>}

      {rounds.length > 0 && (
        <ul className="king-rounds" aria-label="Past crowns">
          {rounds.map((r) => (
            <li key={r.id}>
              <span className="mono">{shortAddress(r.king)}</span> took <b className="mono">{fmt(big(r.won_amount), decimals, 4)} {symbol}</b>
              <span className="dim"> {ago(r.won_at!)} ago</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
