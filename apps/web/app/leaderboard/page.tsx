"use client";

import { useQuery } from "@tanstack/react-query";
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

  return (
    <div className="leaderboard-shell space-y-4">
      <header className="page-intro leaderboard-intro">
        <div className="section-kicker">POINTS</div>
        <h1>Leaderboard</h1>
        <p>Season {data?.season ?? 1} · Every launch, trade and lock counts.</p>
      </header>
      <section className="panel leaderboard-rules p-4">
        <div className="leaderboard-rules-head"><span>01 / THE RULES</span><strong>Make moves. Earn points.</strong></div>
        <p className="text-sm dim">
          Points for printing, for trading and for locking. Trading against yourself does not count:
          a trade by the wallet a launch pays its fee to earns nothing. Locking pays for the time it stays locked,
          credited as it is earned, so a lock that is opened and closed again is worth what it was kept
          for. Your rank multiplies everything you earn, and rank is bought with volume over the last
          thirty days, not with what sits in your wallet.
        </p>
        {data && (
          <div className="rule-chips mt-3 flex flex-wrap gap-4 text-xs dim">
            <span>print a token · {data.rules.POINTS.launch}</span>
            <span>buy · {data.rules.POINTS.perDollarBuy} per $1</span>
            <span>sell · {data.rules.POINTS.perDollarSell} per $1</span>
            <span>lock · {data.rules.POINTS.perDollarStakedPerMonth} per $1 per 30 days locked × lock multiplier</span>
          </div>
        )}
        {data && (
          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            {data.rules.RANKS.map((r) => (
              <span key={r.name} className="rounded-full border border-[var(--color-line)] px-2 py-0.5 dim">
                {r.name} {r.multiplier}x
              </span>
            ))}
          </div>
        )}
      </section>

      <section className="panel leaderboard-table p-4">
        <div className="leaderboard-table-title"><span>02 / THE BOARD</span><h2>Top of the fam.</h2></div>
        <div className="table-scroll"><table className="w-full text-sm">
          <thead className="text-xs dim">
            <tr><th className="pb-2 text-left">#</th><th className="text-left">wallet</th><th className="text-left">rank</th>
              <th className="text-right">volume</th><th className="text-right">launches</th><th className="text-right">points</th></tr>
          </thead>
          <tbody>
            {data?.rows.map((r) => (
              <tr key={r.address}
                className={`border-t border-[var(--color-line)] ${r.address === address?.toLowerCase() ? "text-[var(--color-lime)]" : ""}`}>
                <td className="py-1.5">{r.position}</td>
                <td className="mono text-xs">
                  <Link href={`/portfolio?address=${r.address}`}>{shortAddress(r.address)}</Link>
                </td>
                <td className="text-xs dim">{r.rank}</td>
                <td className="mono text-right text-xs">${Math.round(r.volumeUsd).toLocaleString()}</td>
                <td className="text-right text-xs">{r.launches}</td>
                <td className="mono text-right">{Math.round(r.points).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
        {data?.rows.length === 0 && <p className="py-6 text-center text-sm dim">Nobody has scored yet.</p>}
      </section>
    </div>
  );
}
