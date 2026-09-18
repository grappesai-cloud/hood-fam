"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Calculator } from "@/components/airdrop/Calculator";
import { ClaimPanel } from "@/components/airdrop/ClaimPanel";
import { SeasonFacts } from "@/components/airdrop/SeasonFacts";
import { WhatThisIsNot } from "@/components/airdrop/WhatThisIsNot";
import type { SeasonList } from "@/components/airdrop/data";

/// The season pool, end to end: what it is worth so far, what your points are worth of it, what
/// more activity would add, and the button that takes it once the season is split. Nothing on this
/// page promises anything; every number comes from the API and says where it came from.
export default function AirdropPage() {
  const seasons = useQuery({ queryKey: ["airdrop", "seasons"], queryFn: () => api<SeasonList>("/seasons") });
  const [picked, setPicked] = useState<number | null>(null);

  const current = seasons.data?.current ?? 1;
  const season = picked ?? current;
  const list = seasons.data?.seasons ?? [];

  return (
    <div className="space-y-4">
      <header className="page-intro flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="section-kicker">THE DROP</div>
          <h1>the drop</h1>
          <p>
            The pool is a cut of what the protocol earned this season, its tenth of the direct machine&apos;s tax
            and its thirty basis points of every curve trade, and it grows while people trade.
            <br />
            Points decide how it splits between the wallets that hold them. Nothing is promised and nothing is minted.
          </p>
        </div>
        {list.length > 0 && (
          <label className="flex items-center gap-2 text-xs dim">
            <span>season</span>
            <span className="block w-44">
              <select
                className="input mono"
                value={season}
                onChange={(e) => setPicked(Number(e.target.value))}
              >
                {list.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.id} · {s.name}
                    {s.id === current ? " · live" : ""}
                  </option>
                ))}
              </select>
            </span>
          </label>
        )}
      </header>

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
