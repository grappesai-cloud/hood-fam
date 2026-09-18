"use client";

import { useQuery } from "@tanstack/react-query";
import { useAccount } from "wagmi";
import { api } from "@/lib/api";
import { fmt, shortAddress } from "@/lib/format";
import {
  getOrNull,
  points,
  ratioPercent,
  sharePercent,
  usd,
  weiOf,
  when,
  type SeasonAirdrop,
  type WalletPoints,
} from "./data";
import { Broken, Fact, Headline, Quiet, Row } from "./ui";

/// What the season is worth so far and who it is split between. Every number is read from the
/// API, so a season the API has never heard of prints a line rather than a zero that looks real.
export function useSeasonAirdrop(season: number) {
  return useQuery({
    queryKey: ["airdrop", "season", season],
    queryFn: () => getOrNull<SeasonAirdrop>(`/airdrop/season/${season}`),
    refetchInterval: 30_000,
  });
}

const pct = (bps: number) => `${Number((bps / 100).toFixed(2))}%`;

export function SeasonFacts({ season, current }: { season: number; current: number }) {
  const { address } = useAccount();
  const pool = useSeasonAirdrop(season);
  const wallet = useQuery({
    queryKey: ["airdrop", "points", address],
    queryFn: () => api<WalletPoints>(`/points/${address}`),
    enabled: Boolean(address),
    refetchInterval: 30_000,
  });

  const d = pool.data ?? null;
  const w = wallet.data;
  const share =
    d && w && season === current && d.points.total > 0
      ? sharePercent((w.points / d.points.total) * 1_000_000)
      : null;

  return (
    <>
      <section className="panel space-y-3 p-4">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="font-semibold">the pool so far</h2>
          <span className="text-xs dim">
            season {season}
            {season === current ? " · live" : " · closed"}
          </span>
        </div>

        {pool.isLoading && <Quiet>reading</Quiet>}
        {pool.isError && <Broken>the season numbers are not answering right now.</Broken>}
        {!pool.isLoading && !pool.isError && d === null && <Quiet>this season has no pool yet.</Quiet>}

        {d && (
          <>
            <Headline
              value={usd(d.pool.poolUsd)}
              note={`${pct(d.pool.poolBps)} of the ${usd(d.pool.take.usd)} the protocol took in between ${when(
                d.pool.take.windowStart,
              )} and ${when(d.pool.take.windowEnd)}. it grows while people trade.`}
            />
            <div className="space-y-1">
              {d.pool.take.byAsset.length === 0 && <Quiet>nothing has landed in the pool yet.</Quiet>}
              {d.pool.take.byAsset.map((a) => (
                <Row
                  key={a.asset}
                  label={a.symbol || shortAddress(a.asset)}
                  value={`${fmt(weiOf(a.amountWei), a.decimals, 4)} · ${usd(a.usd)}`}
                />
              ))}
            </div>
          </>
        )}
      </section>

      <section className="panel space-y-3 p-4">
        <h2 className="font-semibold">the points it splits between</h2>

        {pool.isError && <Broken>the points for this season are not answering right now.</Broken>}
        {d === null && !pool.isError && <Quiet>no points have been counted for this season.</Quiet>}

        {d && (
          <>
            <div className="grid grid-cols-2 gap-2">
              <Fact label="points in the season" value={points(d.points.total)} />
              <Fact label="wallets holding them" value={d.points.participants.toLocaleString("en-US")} />
            </div>
            <div className="space-y-1">
              <Row label="median wallet" value={points(d.points.median)} />
              <Row label="p90 wallet" value={points(d.points.p90)} />
              <Row label="top ten wallets hold" value={ratioPercent(d.points.top10Share)} />
            </div>
            <Quiet>Half the wallets sit under the median, a tenth of them sit over p90.</Quiet>
          </>
        )}

        <div className="space-y-1 border-t border-[var(--color-line)] pt-3">
          <div className="text-sm font-semibold">your side</div>
          {!address && <Quiet>Connect a wallet to see your points, your rank and your share.</Quiet>}
          {address && wallet.isError && <Broken>could not read your points.</Broken>}
          {address && wallet.isLoading && <Quiet>reading</Quiet>}
          {address && w && (
            <>
              <Row label="your points" value={points(w.points)} />
              <Row label="your rank" value={`${w.rank} · ${w.multiplier}x`} />
              <Row label="your place" value={`#${w.position}`} />
              {share && <Row label="your share of the pool so far" value={share} />}
              {season !== current && (
                <Quiet>These are your numbers in season {current}, the one running now.</Quiet>
              )}
            </>
          )}
        </div>
      </section>
    </>
  );
}
