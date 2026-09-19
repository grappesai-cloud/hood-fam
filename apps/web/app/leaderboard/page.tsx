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

  return (
    <div className="leaderboard-shell">
      <div className="page-head">
        <header className="page-intro">
          <div className="section-kicker">Points</div>
          <h1>Leaderboard</h1>
          <p>Every launch, trade and lock scores. The board decides how the drop splits.</p>
        </header>
        <div className="head-figure">
          <strong>{Math.round(total).toLocaleString()}</strong>
          <span>points in the season</span>
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

      <section className="panel p-5">
        <div className="panel-head"><span className="n">02 / THE BOARD</span><h2>Top of the fam</h2><span className="hatch" aria-hidden="true" /><span className="aside">{rows.length} wallet{rows.length === 1 ? "" : "s"}</span></div>
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
                <span className="row-num"><strong>{Math.round(r.points).toLocaleString()}</strong><span>points</span></span>
                <span className="row-meter"><i style={{ width: `${top > 0 ? Math.max(2, (r.points / top) * 100) : 0}%` }} /></span>
              </Link>
            ))}
          </div>
        )}
      </section>

    </div>
  );
}
