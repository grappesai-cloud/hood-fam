"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type TokenRow } from "@/lib/api";
import { useLive } from "@/lib/live";
import { TokenCard } from "@/components/TokenCard";
import { Empty } from "@/components/Empty";
import { Ticker } from "@/components/Ticker";
import { compact, imageUrl, launchProgress, pairDecimals, pairSymbol } from "@/lib/format";
import { brand } from "@/brands";
import { GraduationRace } from "@/components/GraduationRace";

const SORTS = [
  { key: "new", label: "Newest", query: "sort=new" },
  { key: "volume", label: "Trending", query: "sort=volume" },
  { key: "graduating", label: "Near graduation", query: "sort=progress&status=graduating" },
  { key: "graduated", label: "Graduated", query: "sort=graduated&status=graduated" },
] as const;

/// The front page is the one page a brand is most likely to want to lay out itself: it is the shop
/// window. A brand that brings its own gets it; the rest get this board, which is hood.fam's.
export default function Page() {
  return brand.Explore ? <brand.Explore /> : <Board />;
}

function Board() {
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
  // The tape runs whatever is moving, not whatever is newest, so it never depends on which sort the
  // reader happens to have picked.
  const tape = useQuery({
    queryKey: ["tape"],
    queryFn: () => api<{ tokens: TokenRow[] }>("/tokens?sort=volume&limit=14"),
    refetchInterval: 30_000,
  });

  // A market is a thing people come back to and type into, so the search takes a key. Slash is the
  // one every terminal and every trading screen already uses.
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
  // The card on the front of the hero stack is the launch the tape leads with, so the first thing
  // on the page is a real launch rather than a drawing of one.
  const lead = tape.data?.tokens[0];
  // The spotlight is only honest on an unfiltered board: with a search term the first result is the
  // best match, not the launch worth the biggest cell.
  const spotlit = !q && rows.length > 2;

  return (
    <div className="home-shell">
      {/* The race to the pool is the loop this place runs on, so it sits where a reader lands. */}
      <GraduationRace />
      <section className="hero" aria-labelledby="explore-title">
        <div className="hero-copy">
          <span className="eyebrow">Live on Robinhood Chain</span>
          <h1 id="explore-title"><span>Print a coin.</span><span>Let the fam trade it.</span></h1>
          <p>
            Every launch on chain 4663, on one board. Buy on the curve, watch it graduate into a
            pool nobody can pull, and take your cut of what the house collects.
          </p>
          <div className="hero-actions">
            <Link className="btn" href="/launch">Create token</Link>
            <Link className="btn btn-ghost" href="/airdrop">See the drop</Link>
          </div>
        </div>
        <div className="hero-object" aria-hidden="true">
          <div className="hero-plane" />
          <div className="hero-halo" />
          <div className="coin">
            <div className="coin-face front"><span className="coin-mark">{lead ? `$${lead.symbol}` : "hood"}</span></div>
            <div className="coin-face back"><span className="coin-mark">HOOD.FAM</span></div>
          </div>
          <div className="coin-shadow" />
        </div>
      </section>

      <div className="tape" aria-label="Market tape">
        {tape.data?.tokens.length ? (
          [0, 1].map((run) => (
            <div className="tape-run" key={run} aria-hidden={run === 1}>
              {marquee(tape.data!.tokens).map((t, i) => (
                <Link key={`${run}-${i}-${t.token}`} href={`/token/${t.token}`}>
                  <i /> <b>${t.symbol}</b> <Ticker value={cap(t)} />
                </Link>
              ))}
            </div>
          ))
        ) : (
          <span className="tape-empty">waiting for the first trade</span>
        )}
      </div>

      <section className="explore-section reveal" aria-label="Launches">
        <div className="market-summary" aria-label="Platform activity">
          <Stat label="Launches" value={stats.data?.launches ?? "·"} />
          <Stat label="Graduated" value={stats.data?.graduated ?? "·"} />
          <Stat label="24h volume" value={stats.data ? compact(BigInt(stats.data.volume_24h || "0")) : "·"} />
          <Stat label="Traders" value={stats.data?.traders ?? "·"} />
        </div>
        <div className="explore-searchbar">
          <label className="search-field">
            <span aria-hidden="true">⌕</span>
            <input ref={search} aria-label="Search tokens" placeholder="Search by name or ticker" value={q} onChange={(e) => setQ(e.target.value)} />
            <kbd className="search-key" aria-hidden="true">/</kbd>
          </label>
          <Link className="btn create-button" href="/launch"><span aria-hidden="true">＋</span> Create token</Link>
        </div>
        <div className="explore-toolbar">
          <div className="sort-tabs" role="tablist" aria-label="Sort launches">
            {SORTS.map((s) => <button key={s.key} role="tab" aria-selected={sort === s.key} onClick={() => setSort(s.key)} className={sort === s.key ? "sort-tab active" : "sort-tab"}>{s.label}</button>)}
          </div>
          <div className="board-count">{tokens.data ? `${tokens.data.tokens.length} shown` : "Live market"}</div>
        </div>
        {tokens.isError ? (
          <Empty title="Market feed unavailable" body="The indexer is not answering. The board fills back in the moment it reconnects, and nothing on chain has changed." />
        ) : tokens.isLoading ? (
          <div className="token-grid" aria-label="Loading launches">{[0, 1, 2, 3, 4, 5, 6, 7].map((i) => <div key={i} className="token-skeleton" />)}</div>
        ) : rows.length ? (
          <div className="token-grid">
            {rows.map((t, i) => (
              <TokenCard key={t.token} t={t} spotlight={spotlit && i === 0} flag={spotlit && i === 0 ? sortFlag(sort) : undefined} />
            ))}
          </div>
        ) : (
          <Empty
              title={q ? "No matching tokens" : sort === "new" ? "No launches yet" : "Nothing here yet"}
              body={q ? "Nothing on the board matches that name or ticker. Try a shorter one." : "The board is empty. The first token printed on this chain shows up here the moment the block lands."}
              action={q ? undefined : <Link className="btn" href="/launch">Create the first one</Link>}
          />
        )}
      </section>
    </div>
  );
}

/// The spotlight says why it is the spotlight. A cell twice the size of its neighbours with no
/// reason on it is decoration; with the reason on it, it is the board telling you where to look.
function sortFlag(sort: (typeof SORTS)[number]["key"]) {
  if (sort === "volume") return "most traded";
  if (sort === "graduating") return "closest to graduating";
  if (sort === "graduated") return "latest graduation";
  return "newest launch";
}

/// A board with two launches on it still has to fill a tape, or the marquee is one pair of tickers
/// followed by a screen of nothing. The list repeats until it is long enough to cover the run.
function marquee(tokens: TokenRow[]) {
  if (!tokens.length) return tokens;
  const out: TokenRow[] = [];
  while (out.length < 12) out.push(...tokens);
  return out;
}

/// The tape quotes the same number the cards do, worked out the same way, because two places on
/// one screen showing different market caps for one token is worse than showing none.
function cap(t: TokenRow) {
  const mcap = (BigInt(t.price || "0") * BigInt(t.total_supply || "0")) / 10n ** 18n;
  return `${compact(mcap, pairDecimals(t.pair_token, t))} ${pairSymbol(t.pair_token, t)}`;
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="stat"><strong><Ticker value={value} /></strong><span>{label}</span></div>;
}
