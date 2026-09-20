"use client";

import { useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { compact, fmt, shortAddress } from "@/lib/format";
import { Broken, Fact, Quiet, Row } from "@/components/airdrop/ui";
import {
  getOrNull,
  points as asPoints,
  ratioPercent,
  usd,
  weiOf,
  type SeasonAirdrop,
  type SeasonList,
} from "@/components/airdrop/data";

/// What the protocol has actually done, read from our own indexer and from nothing else. Every
/// panel fetches on its own, so a route that is down prints one line in its own box and the rest
/// of the page still answers. Nothing here is modelled or projected: if the indexer does not store
/// a number, the page says so instead of inventing it.

interface Stats {
  launches: string;
  graduated: string;
  volume_total: string;
  volume_24h: string;
  trades: string;
  traders: string;
}

/// The leaderboard route is the only thing that knows whether a season was snapshotted, and a
/// snapshot is what "frozen" means: the board for that season stopped moving. One row is enough
/// to read the flag.
interface BoardHead {
  season: number;
  frozen: boolean;
  takenAt?: string;
}

type Window = "24h" | "all";

/// Seasons are minutes apart on a fresh chain, so a date alone reads as four identical rows.
function stamp(value: string | null | undefined): string {
  if (!value) return "open";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function count(value: string | undefined): string {
  if (value === undefined) return "-";
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString("en-US") : value;
}

/// Volume is summed over every launch in the pair asset's own units. The board reads it at
/// eighteen decimals and so does this, so the two pages never disagree.
function volume(value: string | undefined): string {
  if (value === undefined) return "-";
  try {
    return compact(BigInt(value || "0"));
  } catch {
    return "-";
  }
}

const TABLE_LIMIT = 24;

export default function Analytics() {
  const [window, setWindow] = useState<Window>("all");
  const [picked, setPicked] = useState<number | null>(null);

  const stats = useQuery({
    queryKey: ["analytics", "stats"],
    queryFn: () => api<Stats>("/stats"),
    refetchInterval: 30_000,
  });
  const seasons = useQuery({
    queryKey: ["analytics", "seasons"],
    queryFn: () => api<SeasonList>("/seasons"),
  });

  const current = seasons.data?.current ?? 1;
  const season = picked ?? current;
  const rows = useMemo(
    () => [...(seasons.data?.seasons ?? [])].sort((a, b) => b.id - a.id).slice(0, TABLE_LIMIT),
    [seasons.data],
  );

  const pool = useQuery({
    queryKey: ["analytics", "season", season],
    queryFn: () => getOrNull<SeasonAirdrop>(`/airdrop/season/${season}`),
    refetchInterval: 30_000,
  });

  const boards = useQueries({
    queries: rows.map((s) => ({
      queryKey: ["analytics", "frozen", s.id],
      queryFn: () => api<BoardHead>(`/leaderboard?season=${s.id}&limit=1`),
      staleTime: 60_000,
    })),
  });
  const frozen = useMemo(() => {
    const map = new Map<number, boolean>();
    rows.forEach((s, i) => {
      const d = boards[i]?.data;
      if (d) map.set(s.id, Boolean(d.frozen));
    });
    return map;
  }, [rows, boards]);

  const d = pool.data ?? null;
  // Nobody has scored a point in this season: no trade, no launch, no stake. Every figure the
  // points distribution is made of is zero because there is nothing in it, not because it measured
  // zero.
  const scored = Boolean(d && d.points.participants > 0 && d.points.total > 0);

  return (
    <div className="space-y-4">
      <header className="page-intro">
        <div className="section-kicker">NUMBERS</div>
        <h1>analytics</h1>
        <p>
          What the protocol has done so far, counted by our own indexer from the chain. Volume is the
          only figure with a twenty four hour window; everything else on this page is all time.
        </p>
      </header>

      <section className="panel space-y-3 p-4" aria-labelledby="analytics-headline">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="analytics-headline" className="font-semibold">
            the protocol so far
          </h2>
          <div className="sort-tabs" role="tablist" aria-label="Volume window">
            {(["24h", "all"] as const).map((w) => (
              <button
                key={w}
                role="tab"
                aria-selected={window === w}
                className={window === w ? "sort-tab active" : "sort-tab"}
                onClick={() => setWindow(w)}
              >
                {w === "24h" ? "24 hours" : "all time"}
              </button>
            ))}
          </div>
        </div>

        {stats.isError && <Broken>the indexer is not answering, so there are no totals to show.</Broken>}
        {stats.isLoading && <Quiet>reading</Quiet>}

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          <Big value={count(stats.data?.launches)} label="launches" note="all time" />
          <Big value={count(stats.data?.graduated)} label="graduated" note="all time" />
          <Big
            value={volume(window === "24h" ? stats.data?.volume_24h : stats.data?.volume_total)}
            label="volume"
            note={window === "24h" ? "last 24 hours" : "all time"}
          />
          <Big value={count(stats.data?.trades)} label="trades" note="all time" />
          <Big value={count(stats.data?.traders)} label="wallets that traded" note="all time" />
        </div>

        <Quiet>
          The toggle only moves volume, because volume is the only number the indexer keeps a
          twenty four hour figure for. Launches, graduations, trades and wallets are all time
          whichever side it is on. Volume is summed over every launch in its pair asset and read at
          eighteen decimals, the same way the board reads it. Our own contracts trade, and they are
          left out of the wallet count.
        </Quiet>
      </section>

      <section className="panel space-y-3 p-4" aria-labelledby="analytics-season">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 id="analytics-season" className="font-semibold">
            {season === current ? "this season" : `season ${season}`}
          </h2>
          <span className="text-xs dim">
            season {season}
            {season === current ? " · live" : " · closed"}
            {picked !== null && picked !== current && (
              <button className="ml-2 underline" onClick={() => setPicked(null)}>
                back to the live one
              </button>
            )}
          </span>
        </div>

        {pool.isLoading && <Quiet>reading</Quiet>}
        {pool.isError && <Broken>the season numbers are not answering right now.</Broken>}
        {!pool.isLoading && !pool.isError && d === null && <Quiet>this season has no pool yet.</Quiet>}

        {d && (
          <>
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
              <Fact label="the take, this season" value={usd(d.pool.take.usd)} />
              <Fact label="the pool so far" value={usd(d.pool.poolUsd)} />
              <Fact label="points in the season" value={asPoints(d.points.total)} />
              <Fact label="wallets holding them" value={d.points.participants.toLocaleString("en-US")} />
            </div>
            <div className="space-y-1">
              <Row label="the cut the pool takes" value={`${Number((d.pool.poolBps / 100).toFixed(2))}%`} />
              <Row label="window" value={`${stamp(d.pool.take.windowStart)} to ${stamp(d.pool.take.windowEnd)}`} />
              {/* A distribution of nothing is not a distribution of zero. With no wallet holding a
                  point, the median, the ninetieth percentile and the top ten share are all printed
                  as 0 by the arithmetic behind them, and a zero on this page reads as a measurement
                  somebody took. These three say there was nothing to measure instead. */}
              <Row label="median wallet" value={scored ? asPoints(d.points.median) : nothing} />
              <Row label="p90 wallet" value={scored ? asPoints(d.points.p90) : nothing} />
              <Row
                label="top ten wallets hold"
                value={scored ? ratioPercent(d.points.top10Share) : nothing}
              />
              <Row
                label="published split"
                value={
                  d.drop
                    ? `${fmt(weiOf(d.drop.total), 18, 4)} · ${shortAddress(d.drop.root)}`
                    : "not published yet"
                }
              />
            </div>
            <Quiet>
              The take is what the protocol earned inside the season window. The pool is the slice of
              that take the treasury set aside for this season, and it is a decision, not a rate
              anybody is owed. Graduation fees paid straight to the treasury are not counted here,
              because the indexer does not store them.
            </Quiet>
          </>
        )}
      </section>

      <section className="panel space-y-3 p-4" aria-labelledby="analytics-seasons">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 id="analytics-seasons" className="font-semibold">
            seasons
          </h2>
          <span className="text-xs dim">pick one to read its economics above</span>
        </div>

        {seasons.isError && <Broken>the season list is not answering right now.</Broken>}
        {seasons.isLoading && <Quiet>reading</Quiet>}

        {rows.length > 0 && (
          <div className="table-scroll">
            <table className="w-full text-sm">
              <thead className="text-xs dim">
                <tr>
                  <th className="pb-2 text-left">#</th>
                  <th className="pb-2 text-left">name</th>
                  <th className="pb-2 text-left">opened</th>
                  <th className="pb-2 text-left">closed</th>
                  <th className="pb-2 text-right">state</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => {
                  const state = s.id === current ? "live" : frozen.get(s.id) ? "frozen" : s.ends ? "closed" : "open";
                  return (
                    <tr
                      key={s.id}
                      className={`border-t border-[var(--color-line)] ${s.id === season ? "text-[var(--color-lime)]" : ""}`}
                    >
                      <td className="py-1.5">
                        <button className="mono" onClick={() => setPicked(s.id)}>
                          {s.id}
                        </button>
                      </td>
                      <td className="text-xs">{s.name}</td>
                      <td className="mono text-xs dim">{stamp(s.starts)}</td>
                      <td className="mono text-xs dim">{stamp(s.ends)}</td>
                      <td className="text-right">
                        <span className="rounded-full border border-[var(--color-line)] px-2 py-0.5 text-xs dim">
                          {state}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {!seasons.isLoading && !seasons.isError && rows.length === 0 && <Quiet>no seasons yet.</Quiet>}

        <Quiet>
          Live is the season running now. Frozen means a snapshot was taken, so its board stopped
          moving even if late points land. Closed means the window ended with no snapshot yet.
        </Quiet>
      </section>
    </div>
  );
}

/// The absence of a measurement, said the same way in all three places it can happen.
const nothing = <span className="dim">nothing has traded yet</span>;

function Big({ value, label, note }: { value: string; label: string; note: string }) {
  return (
    <div className="rounded-lg border border-[var(--color-line)] p-3">
      <div className="mono text-2xl leading-none font-bold break-words">{value}</div>
      <div className="mt-2 text-xs dim">{label}</div>
      <div className="mono text-[10px] dim">{note}</div>
    </div>
  );
}
