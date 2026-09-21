"use client";

import { useQuery } from "@tanstack/react-query";
import { Empty } from "@/components/Empty";
import { useAccount } from "wagmi";
import Link from "next/link";
import { api } from "@/lib/api";
import { shortAddress } from "@/lib/format";

interface Board {
  season: number;
  rules: {
    POINTS: { launch: number; perDollarBuy: number; perDollarSell: number; perDollarStakedPerMonth: number };
    RANKS: { name: string; minVolumeUsd: number; multiplier: number }[];
  };
  rows: { position: number; address: string; points: number; volumeUsd: number; launches: number; rank: string }[];
}

export default function Leaderboard() {
  const { address } = useAccount();
  const { data } = useQuery({ queryKey: ["leaderboard"], queryFn: () => api<Board>("/leaderboard?limit=100") });

  const rows = data?.rows ?? [];
  const top = rows[0]?.points ?? 0;
  const total = rows.reduce((n, r) => n + r.points, 0);

  // A ranking is a vanity object. What these points actually are is a claim on the season's pool,
  // so the board reads the pool and says what each line is owed, which is the only reason to score.
  const season = data?.season;
  const { data: drop } = useQuery({
    queryKey: ["airdrop", "season", season],
    queryFn: () => api<{ pool: { poolUsd: number } }>(`/airdrop/season/${season}`).catch(() => null),
    enabled: Boolean(season),
    refetchInterval: 60_000,
  });
  const pool = drop?.pool?.poolUsd ?? 0;
  /// Every wallet's share, from the same arithmetic the tree uses at settlement: points over points.
  const owed = (points: number) => (total > 0 && pool > 0 ? (points / total) * pool : 0);
  const money = (usd: number) => (usd >= 1 ? `$${usd.toFixed(usd >= 100 ? 0 : 2)}` : usd > 0 ? "under $1" : "nothing yet");
  const mine = rows.find((r) => r.address === address?.toLowerCase());

  return (
    <div className="leaderboard-shell">
      <div className="page-head">
        <header className="page-intro">
          <div className="section-kicker">The cut</div>
          <h1>What the season owes</h1>
          <p>
            Points are not a ranking. They are a claim on what the protocol earned this season, and
            the pool is a share of that, paid to whoever earned it. Every launch, trade and lock scores.
          </p>
        </header>
        <div className="head-figure">
          <strong>{pool > 0 ? money(pool) : "·"}</strong>
          <span>in the pool so far</span>
        </div>
      </div>

      <div className="market-summary" aria-label="The season so far">
        <div className="stat"><strong>{data?.season ?? "·"}</strong><span>season</span></div>
        <div className="stat"><strong>{rows.length}</strong><span>wallets scoring</span></div>
        <div className="stat"><strong>{Math.round(total).toLocaleString()}</strong><span>points earned</span></div>
        <div className="stat"><strong>{data?.rules.RANKS.length ?? "·"}</strong><span>ranks to climb</span></div>
      </div>

      {/* Three ways to score, one card each, with the number that matters given the room. A
          paragraph nobody reads was doing this job before. */}
      <section className="panel p-5">
        <div className="panel-head"><span className="n">01 / THE RULES</span><h2>Three ways to score</h2><span className="hatch" aria-hidden="true" /></div>
        <div className="score-ways">
          <div className="way">
            <strong>{data?.rules.POINTS.launch ?? 500}</strong>
            <span>printing a token</span>
          </div>
          <div className="way">
            <strong>{data?.rules.POINTS.perDollarBuy ?? 2} / {data?.rules.POINTS.perDollarSell ?? 1}</strong>
            <span>per dollar bought / sold</span>
          </div>
          <div className="way">
            <strong>{data?.rules.POINTS.perDollarStakedPerMonth ?? 10}</strong>
            <span>per dollar locked, per 30 days</span>
          </div>
        </div>
        <div className="ladder">
          <span className="ladder-label">Rank multiplies all of it, bought with thirty day volume</span>
          <div className="ladder-steps">
            {data?.rules.RANKS.map((r) => (
              <span key={r.name} className="ladder-step">
                <b>{r.multiplier}x</b>
                <i>{r.name}</i>
              </span>
            ))}
          </div>
        </div>
        <details className="fineprint">
          <summary>The catches</summary>
          <ul>
            <li>Printing pays once the launch actually trades.</li>
            <li>Trading against yourself scores nothing.</li>
            <li>Locking is credited as it is earned, so opening and closing a lock is worth the time it was kept.</li>
          </ul>
        </details>
      </section>

      {mine && (
        <section className="panel p-5">
          <div className="panel-head"><span className="n">YOUR SIDE</span><h2>What you are owed</h2><span className="hatch" aria-hidden="true" /></div>
          <p className="text-sm">
            {Math.round(mine.points).toLocaleString()} points, {mine.rank}, position {mine.position}.
            {pool > 0
              ? ` That is ${money(owed(mine.points))} of the pool as it stands, and it moves with every trade anybody makes.`
              : " The pool fills as the protocol earns, and nothing has been earned yet this season."}
          </p>
        </section>
      )}

      <section className="panel p-5">
        <div className="panel-head"><span className="n">02 / WHO IS OWED WHAT</span><h2>Top of the fam</h2><span className="hatch" aria-hidden="true" /><span className="aside">{rows.length} wallet{rows.length === 1 ? "" : "s"}</span></div>
        {rows.length === 0 ? (
          <Empty title="The season is open."
            body="Nobody has scored yet. Print a token, trade one, or lock what you hold: the first wallet to score takes the top of the board." />
        ) : (
          <div className="rows">
            {rows.map((r) => (
              <Link key={r.address} href={`/portfolio?address=${r.address}`}
                className={r.address === address?.toLowerCase() ? "row row-you" : "row"}>
                <span className={`rank${r.position <= 3 ? ` r${r.position}` : ""}`}>{r.position}</span>
                <span className="row-name">
                  <strong className="mono">{shortAddress(r.address)}</strong>
                  <span>{r.rank} · ${Math.round(r.volumeUsd).toLocaleString()} traded · {r.launches} launch{r.launches === 1 ? "" : "es"}</span>
                </span>
                <span className="row-num">
                  <strong>{pool > 0 ? money(owed(r.points)) : Math.round(r.points).toLocaleString()}</strong>
                  <span>{pool > 0 ? `${Math.round(r.points).toLocaleString()} points` : "points"}</span>
                </span>
                <span className="row-meter"><i style={{ width: `${top > 0 ? Math.max(2, (r.points / top) * 100) : 0}%` }} /></span>
              </Link>
            ))}
          </div>
        )}
      </section>

    </div>
  );
}
