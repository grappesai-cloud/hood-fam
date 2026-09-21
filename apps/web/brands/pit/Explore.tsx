"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type TokenRow } from "@/lib/api";
import { useLive } from "@/lib/live";
import { ago, compact, launchProgress, machineLabel, pairDecimals, pairSymbol } from "@/lib/format";
import { GraduationRace } from "@/components/GraduationRace";

const SORTS = [
  { key: "new", label: "Just printed", query: "sort=new" },
  { key: "volume", label: "Loudest", query: "sort=volume" },
  { key: "graduating", label: "Near the bell", query: "sort=progress&status=graduating" },
  { key: "graduated", label: "Rung out", query: "sort=graduated&status=graduated" },
] as const;

/// The floor. No hero, no invitation, no coin turning over in the dark: the board is the page, and
/// it starts at the top edge. Every launch is a ticket, the ticket is mostly its ticker, and the
/// tickets sit hard against each other so the whole thing reads as one printed sheet.
export default function Explore() {
  const [sort, setSort] = useState<(typeof SORTS)[number]["key"]>("new");
  const [q, setQ] = useState("");
  const query = SORTS.find((s) => s.key === sort)?.query ?? "sort=new";

  // A launch or a trade anywhere on the chain changes what this board is showing, so the board
  // is told rather than asked: the stream refreshes these same queries, and the timers stay as the
  // fallback for a reader whose stream never connected.
  useLive();

  const stats = useQuery({
    queryKey: ["stats"],
    queryFn: () => api<{ launches: string; graduated: string; volume_24h: string; trades: string; traders: string }>("/stats"),
  });
  const tokens = useQuery({
    queryKey: ["tokens", sort, q],
    queryFn: () => api<{ tokens: TokenRow[] }>(`/tokens?${query}&limit=60${q ? `&q=${encodeURIComponent(q)}` : ""}`),
  });

  // A floor is a thing people type into. Slash is the key every trading screen already uses, so it
  // is the one that puts the cursor in the box here too.
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
      e.preventDefault();
      search.current?.focus();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  const rows = tokens.data?.tokens ?? [];
  // The big inverted ticket is only honest on an unfiltered board: under a search term the first
  // result is the closest match, not the launch worth twice the space.
  const lead = !q && rows.length > 2;

  return (
    <div className="pit-board">
      {/* The race to the pool is the loop this place runs on, so it sits where a reader lands. */}
      <GraduationRace />
      <div className="pit-stats" aria-label="Floor totals">
        <Stat label="Launches" value={stats.data?.launches ?? "--"} />
        <Stat label="Rung out" value={stats.data?.graduated ?? "--"} />
        <Stat label="24h volume" value={stats.data ? compact(BigInt(stats.data.volume_24h || "0")) : "--"} big />
        <Stat label="Trades" value={stats.data?.trades ?? "--"} />
        <Stat label="Traders" value={stats.data?.traders ?? "--"} />
      </div>

      <div className="pit-controls">
        <div className="pit-tabs" role="tablist" aria-label="Sort launches">
          {SORTS.map((s) => (
            <button key={s.key} role="tab" aria-selected={sort === s.key}
              className={sort === s.key ? "pit-tab pit-tab-on" : "pit-tab"}
              onClick={() => setSort(s.key)}>
              {s.label}
            </button>
          ))}
        </div>
        <div className="pit-search">
          <input ref={search} className="pit-search-input" aria-label="Search launches"
            placeholder="NAME OR TICKER" value={q} onChange={(e) => setQ(e.target.value)} />
          <kbd className="pit-search-key" aria-hidden="true">/</kbd>
        </div>
        <Link className="pit-print" href="/launch">Print a ticker</Link>
      </div>

      {tokens.isError ? (
        <Shout
          head="The feed is down"
          body="The indexer stopped answering. Nothing on chain has moved because of it, and the board fills back in the second it picks up."
        />
      ) : tokens.isLoading ? (
        <div className="pit-wall" aria-label="Loading the floor">
          {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
            <div className="pit-ticket pit-ticket-blank" key={i} aria-hidden="true">
              <span className="pit-ticker">----</span>
              <span className="pit-ticket-name">reading the floor</span>
            </div>
          ))}
        </div>
      ) : rows.length ? (
        <div className="pit-wall">
          {rows.map((t, i) => <Ticket key={t.token} t={t} lead={lead && i === 0} />)}
        </div>
      ) : q ? (
        <Shout head={`Nothing called ${q.toUpperCase()}`} body="No ticker and no name on this board matches that. Try fewer letters." />
      ) : (
        <Shout
          head="Empty floor"
          body="Not one launch here yet. The first ticker printed on this chain lands on this wall the moment the block does."
          action={<Link className="pit-print" href="/launch">Print the first one</Link>}
        />
      )}
    </div>
  );
}

/// One launch, as a ticket. The ticker is the ticket: it is set as large as the block allows,
/// because on a floor the thing you shout is the symbol. Everything else is small print around it.
function Ticket({ t, lead }: { t: TokenRow; lead?: boolean }) {
  const decimals = pairDecimals(t.pair_token);
  const symbol = pairSymbol(t.pair_token);
  const mcap = (BigInt(t.price || "0") * BigInt(t.total_supply || "0")) / 10n ** 18n;
  const progress = launchProgress(t);
  const done = t.mode === "direct" || t.status === "graduated";
  // A launch with nowhere left to go reads full, so a graduated token is not drawn as one that
  // stalled on the curve at zero.
  const fill = done ? 1 : progress;

  return (
    <Link href={`/token/${t.token}`} className={lead ? "pit-ticket pit-ticket-lead" : "pit-ticket"}>
      <span className="pit-ticket-head">
        <span className="pit-ticket-machine">{machineLabel(t)}</span>
        <span className="pit-ticket-age">{ago(t.launched_at)}</span>
      </span>

      <span className="pit-ticker">{t.symbol}</span>
      <span className="pit-ticket-name">{t.name}</span>

      <span className="pit-ticket-figures">
        <span className="pit-figure">
          <b>{compact(mcap, decimals)}</b>
          <i>{symbol} MKT CAP</i>
        </span>
        <span className="pit-figure">
          <b>{compact(BigInt(t.volume_24h || "0"), decimals)}</b>
          <i>{symbol} 24H</i>
        </span>
      </span>

      <span className={fill >= 1 ? "pit-bar pit-bar-full" : "pit-bar"} role="img"
        aria-label={done ? "trading in the pool" : `${Math.round(progress * 100)} percent of the way to the pool`}>
        <span style={{ width: `${Math.min(100, fill * 100).toFixed(1)}%` }} />
      </span>
    </Link>
  );
}

/// The board with nothing on it still has to say something, and in here it says it at the same
/// volume as everything else rather than apologising in a rounded box.
function Shout({ head, body, action }: { head: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="pit-shout">
      <h2>{head}</h2>
      <p>{body}</p>
      {action}
    </div>
  );
}

function Stat({ label, value, big }: { label: string; value: string; big?: boolean }) {
  return (
    <div className={big ? "pit-stat pit-stat-big" : "pit-stat"}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}
