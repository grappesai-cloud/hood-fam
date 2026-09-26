"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Calculator } from "@/components/airdrop/Calculator";
import { ClaimPanel } from "@/components/airdrop/ClaimPanel";
import { SeasonFacts, useSeasonAirdrop } from "@/components/airdrop/SeasonFacts";
import { WhatThisIsNot } from "@/components/airdrop/WhatThisIsNot";
import { usd, type SeasonList } from "@/components/airdrop/data";
import { brand } from "@/brands";

/// The season pool, end to end: what it is worth so far, what your points are worth of it, what
/// more activity would add, and the button that takes it once the season is split. Nothing on this
/// page promises anything; every number comes from the API and says where it came from.
export default function AirdropPage() {
  const seasons = useQuery({ queryKey: ["airdrop", "seasons"], queryFn: () => api<SeasonList>("/seasons") });
  const [picked, setPicked] = useState<number | null>(null);

  const current = seasons.data?.current ?? 1;
  const season = picked ?? current;
  const list = seasons.data?.seasons ?? [];
  // The page head shows the figure the page is about, rather than making somebody find it in the
  // first panel below the fold.
  const pool = useSeasonAirdrop(season).data ?? null;

  return (
    <div className="space-y-4">
      <div className="page-head">
        <header className="page-intro">
          <div className="section-kicker">{brand.copy.dropTitle ?? "The drop"}</div>
          <h1>{brand.copy.dropTitle ?? "The drop"}</h1>
          <p>A cut of what the protocol earned. Points decide how it splits.</p>
        </header>
        <div className="head-side">
          <div className="head-figure">
            <strong>{pool ? usd(pool.pool.poolUsd) : "·"}</strong>
            <span>in the pool, season {season}</span>
          </div>
          {list.length > 0 && (
            <label className="season-pick">
              <span>Season</span>
              <select className="input mono" value={season} onChange={(e) => setPicked(Number(e.target.value))}>
                {list.map((s) => (
                  <option key={s.id} value={s.id}>{s.id} · {s.name}{s.id === current ? " · live" : ""}</option>
                ))}
              </select>
            </label>
          )}
        </div>
      </div>

      <div className="market-summary" aria-label="This season">
        <div className="stat"><strong>{pool ? `${Number(pool.pool.poolBps / 100)}%` : "·"}</strong><span>of the take, this season</span></div>
        <div className="stat"><strong>{pool ? Math.round(pool.points.total).toLocaleString() : "·"}</strong><span>points in the season</span></div>
        <div className="stat"><strong>{pool ? pool.points.participants.toLocaleString() : "·"}</strong><span>wallets holding them</span></div>
        <div className="stat"><strong>{season === current ? "live" : "closed"}</strong><span>season {season}</span></div>
      </div>

      {seasons.isError && <p className="panel p-4 text-xs dim">The season list is not answering, so this is season {season}.</p>}

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <SeasonFacts season={season} current={current} />
          <ClaimPanel season={season} />
          <WhatThisIsNot />
        </div>
        <div className="space-y-4">
          <Calculator season={season} />
        </div>
      </div>
    </div>
  );
}
