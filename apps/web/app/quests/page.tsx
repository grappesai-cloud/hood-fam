"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAccount } from "wagmi";

import { api } from "@/lib/api";
import { shortAddress } from "@/lib/format";
import { describe, useWalletSession } from "@/lib/session";

/// Quests and the race: the season, as a list of things to do rather than a column of numbers.
///
/// Every quest is checked against what the indexer already saw, so nothing here can be claimed by
/// asking nicely. The reward lands in the same points the leaderboard and the season drop read, so
/// finishing one is worth exactly what it says on the card and not a separate currency.

interface Quest {
  id: string; title: string; how: string; reward: number;
  target: number; unit: string; progress: number; done: boolean; claimed: boolean;
}

interface QuestBoard { season: number; quests: Quest[]; unclaimed: number }

interface Race {
  race: { id: number; name: string; starts: string; ends: string; prize: string; metric: string } | null;
  standings: { position: number; address: string; score: number; volumeUsd: number }[];
}

const shape = (quest: Quest) => {
  const pct = Math.min(100, Math.round((quest.progress / quest.target) * 100));
  const unit = quest.unit === "dollars" ? "$" : "";
  const amount = (n: number) => (quest.unit === "dollars" ? Math.round(n).toLocaleString("en-US") : n.toLocaleString("en-US"));
  return { pct, label: `${unit}${amount(Math.min(quest.progress, quest.target))} of ${unit}${amount(quest.target)}` };
};

export default function QuestsPage() {
  const { address } = useAccount();
  const { authed, signingIn } = useWalletSession();
  const queryClient = useQueryClient();
  const [claiming, setClaiming] = useState(false);
  const [message, setMessage] = useState<string>();

  // With a wallet, this is your board. Without one it is still the board: the same nine cards at
  // zero, so somebody deciding whether to connect can see what they would be playing for.
  const { data: board } = useQuery({
    queryKey: ["quests", address ?? "anon"],
    queryFn: () => api<QuestBoard>(address ? `/quests/${address}` : "/quests"),
    refetchInterval: 30_000,
  });
  const { data: race } = useQuery({
    queryKey: ["race"],
    queryFn: () => api<Race>("/races/current"),
    refetchInterval: 60_000,
  });

  async function claim() {
    setClaiming(true);
    setMessage(undefined);
    try {
      const result = await authed<{ claimed: { title: string }[]; points: number }>("/quests/claim", { method: "POST" });
      setMessage(result.claimed.length
        ? `Claimed ${result.claimed.map((q) => q.title).join(", ")} for ${Math.round(result.points).toLocaleString("en-US")} points.`
        : "Nothing finished yet.");
      void queryClient.invalidateQueries({ queryKey: ["quests"] });
      void queryClient.invalidateQueries({ queryKey: ["points"] });
    } catch (error) {
      setMessage(describe(error));
    } finally {
      setClaiming(false);
    }
  }

  const quests = board?.quests ?? [];
  const finished = quests.filter((q) => q.claimed).length;

  return (
    <div className="quests-shell">
      <div className="page-head">
        <header className="page-intro">
          <div className="section-kicker">Season {board?.season ?? "·"}</div>
          <h1>Quests</h1>
          <p>
            Nine things worth doing on the pad, each one checked on chain. What they pay lands in the
            same points the leaderboard counts and the season drop pays out.
          </p>
        </header>
        <div className="head-figure">
          <strong>{board ? `${finished}/${quests.length}` : "·"}</strong>
          <span>claimed this season</span>
        </div>
      </div>

      {!address && (
        <p className="panel p-6 text-sm dim">Connect a wallet to see where you stand on these.</p>
      )}

      {address && (
        <div className="panel quest-claim">
          <div>
            <strong>{Math.round(board?.unclaimed ?? 0).toLocaleString("en-US")} points</strong>
            <span className="dim"> finished and waiting</span>
          </div>
          <button className="btn" onClick={claim} disabled={claiming || signingIn || !(board?.unclaimed ?? 0)}>
            {signingIn ? "Sign in your wallet" : claiming ? "Claiming" : "Claim"}
          </button>
        </div>
      )}
      {message && <p className="text-sm dim">{message}</p>}

      <div className="quest-grid">
        {quests.map((quest) => {
          const { pct, label } = shape(quest);
          return (
            <article key={quest.id} className={`panel quest-card${quest.claimed ? " is-claimed" : ""}`}>
              <header>
                <h3>{quest.title}</h3>
                <span className="quest-reward">{quest.reward.toLocaleString("en-US")} pts</span>
              </header>
              <p className="dim">{quest.how}</p>
              <div className="quest-bar" role="img" aria-label={`${pct}% done`}>
                <i style={{ width: `${pct}%` }} />
              </div>
              <footer>
                <span className="dim">{label}</span>
                <span>{quest.claimed ? "claimed" : quest.done ? "ready" : `${pct}%`}</span>
              </footer>
            </article>
          );
        })}
        {!quests.length && <p className="panel p-6 text-sm dim">Loading the board.</p>}
      </div>

      <section className="panel race-panel">
        <header className="race-head">
          <div>
            <div className="section-kicker">The race</div>
            <h2>{race?.race?.name ?? "No race running"}</h2>
          </div>
          {race?.race && (
            <div className="dim text-sm">
              {race.race.prize || "Bragging rights"} · ends {new Date(race.race.ends).toLocaleString()}
            </div>
          )}
        </header>
        {race?.race ? (
          <ol className="race-board">
            {race.standings.map((row) => (
              <li key={row.address}>
                <span className="race-position">{row.position}</span>
                <Link href={`/trader/${row.address}`} className="mono">{shortAddress(row.address)}</Link>
                <span className="race-score">
                  {race.race?.metric === "volume"
                    ? `$${Math.round(row.volumeUsd).toLocaleString("en-US")}`
                    : `${Math.round(row.score).toLocaleString("en-US")} pts`}
                </span>
              </li>
            ))}
            {!race.standings.length && <li className="dim">Nobody has scored in this window yet.</li>}
          </ol>
        ) : (
          <p className="dim text-sm">
            A race is a window with a name: the same points, counted between two moments, with whatever
            the pad has put on the line. The next one will show up here.
          </p>
        )}
      </section>
    </div>
  );
}
