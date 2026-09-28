"use client";

import Link from "next/link";
import { ago, imageUrl } from "@/lib/format";
import { useDrafts } from "@/components/team/app/drafts";
import { useMyLaunches } from "@/components/team/app/useMyLaunches";

/// Every launch the funder wallet sent, newest first, with the way into its watch, its desk and its
/// public page. Launches from this browser that the indexer has not picked up yet show from the
/// drafts, so a launch never goes missing in the minute after it lands.

export default function TrackerPage() {
  const { address, loading, launches } = useMyLaunches();
  const drafts = useDrafts().filter((d) => d.token);
  const known = new Set(launches.map((l) => l.row.token.toLowerCase()));
  const pending = drafts.filter((d) => !known.has(d.token!.toLowerCase()));

  return (
    <div className="tapp-page tt">
      <header className="tt-head">
        <h1>Tracker</h1>
        <p>Your launches, their team and what it holds now. Open one to watch the first minutes or to manage its wallets.</p>
      </header>
      {!address && <p className="tt-empty">Connect the funder wallet to see its launches.</p>}
      {address && loading && <p className="tt-empty">Reading your launches…</p>}
      {address && !loading && launches.length === 0 && pending.length === 0 && (
        <p className="tt-empty">No launches from this wallet yet. <Link href="/launch/team">Create one</Link>.</p>
      )}
      {(launches.length > 0 || pending.length > 0) && (
        <div className="tt-table">
          <div className="tt-row tt-th"><span>Token</span><span>Launched</span><span>Team wallets</span><span>Team spent</span><span>Team value</span><span /></div>
          {pending.map((d) => (
            <div key={d.id} className="tt-row">
              <span className="tt-token"><b>${d.symbol}</b><small>{d.name}</small></span>
              <span className="dim">indexing…</span><span>–</span><span>–</span><span>–</span>
              <span className="tt-actions"><Link href={`/launch/team?token=${d.token}`}>Watch</Link></span>
            </div>
          ))}
          {launches.map(({ row, wallets, spent, value }) => {
            const sym = row.pair_symbol ?? "ETH";
            const up = value >= spent;
            return (
              <div key={row.token} className="tt-row">
                <span className="tt-token">
                  <i>{row.image ? <img src={imageUrl(row.image)} alt="" /> : row.symbol.slice(0, 2)}</i>
                  <b>${row.symbol}</b><small>{row.name}</small>
                </span>
                <span className="dim">{ago(row.launched_at)}</span>
                <span>{wallets || <span className="dim">none</span>}</span>
                <span className="mono">{spent ? `${spent.toFixed(4)} ${sym}` : "–"}</span>
                <span className={`mono ${wallets ? (up ? "good" : "bad") : ""}`}>{wallets ? `${value.toFixed(4)} ${sym}` : "–"}</span>
                <span className="tt-actions">
                  <Link href={`/launch/team?token=${row.token}`}>Watch</Link>
                  <Link href={`/launch/team/desk?token=${row.token}`}>Wallets</Link>
                  <Link href={`/token/${row.token}`}>Page</Link>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
