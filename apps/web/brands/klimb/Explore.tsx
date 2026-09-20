"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type TokenRow } from "@/lib/api";
import { Artwork } from "@/components/Artwork";
import { ago, compact, imageUrl, launchProgress, machineLabel, pairDecimals, pairSymbol } from "@/lib/format";

/// The same four readings of the same market the board has always offered, asked of the indexer in
/// exactly the same words, so two faces of this launchpad can never disagree about what is new or
/// what is close to graduating.
const SORTS = [
  { key: "new", label: "New", query: "sort=new" },
  { key: "volume", label: "Volume", query: "sort=volume" },
  { key: "graduating", label: "Near graduation", query: "sort=progress&status=graduating" },
  { key: "graduated", label: "Graduated", query: "sort=graduated&status=graduated" },
] as const;

/// Klimb's front page: a column, not a gallery.
///
/// A grid of cards asks the reader to compare pictures; a table asks them to compare numbers, which
/// is the only comparison that tells you anything about a launch. Every figure sits in a column of
/// its own, right aligned and tabular, so the eye runs down one measure at a time, and the single
/// piece of colour on the page is the part of each ladder that has been climbed.
export default function Explore() {
  const [sort, setSort] = useState<(typeof SORTS)[number]["key"]>("new");
  const [q, setQ] = useState("");
  const query = SORTS.find((s) => s.key === sort)?.query ?? "sort=new";

  const stats = useQuery({
    queryKey: ["stats"],
    queryFn: () => api<{ launches: string; graduated: string; volume_24h: string; trades: string; traders: string }>("/stats"),
  });
  const tokens = useQuery({
    queryKey: ["tokens", sort, q],
    queryFn: () => api<{ tokens: TokenRow[] }>(`/tokens?${query}&limit=60${q ? `&q=${encodeURIComponent(q)}` : ""}`),
  });

  // Slash to search is what every terminal already does, and this face is a terminal.
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

  return (
    <div className="kl-board">
      <header className="kl-board-head">
        <h1>Market</h1>
        <p>Every launch on chain 4663, one row each, climbing towards the pool it graduates into.</p>
      </header>

      <section className="kl-metrics" aria-label="Platform activity">
        <Metric label="Launches" value={stats.data?.launches} />
        <Metric label="Graduated" value={stats.data?.graduated} />
        <Metric label="24h volume" value={stats.data ? compact(BigInt(stats.data.volume_24h || "0")) : undefined} />
        <Metric label="Traders" value={stats.data?.traders} />
      </section>

      <div className="kl-controls">
        <div className="kl-tabs" role="tablist" aria-label="Sort launches">
          {SORTS.map((s) => (
            <button key={s.key} role="tab" aria-selected={sort === s.key} onClick={() => setSort(s.key)}
              className={sort === s.key ? "kl-tab active" : "kl-tab"}>
              {s.label}
            </button>
          ))}
        </div>
        <label className="kl-search">
          <input ref={search} aria-label="Search tokens" placeholder="Filter by name or ticker"
            value={q} onChange={(e) => setQ(e.target.value)} />
          <kbd aria-hidden="true">/</kbd>
        </label>
      </div>

      <div className="kl-table">
        <div className="kl-head kl-grid">
          <span className="kl-c-rank">#</span>
          <span aria-hidden="true" />
          <span>Launch</span>
          <span className="kl-num">Price</span>
          <span className="kl-num kl-c-vol">24h volume</span>
          <span>To the pool</span>
          <span className="kl-num">Age</span>
          <span aria-hidden="true" />
        </div>

        {tokens.isError ? (
          <Note title="The feed is quiet"
            body="The indexer is not answering, so this column cannot be trusted to be current. Nothing on chain has changed and the rows fill back in the moment it reconnects." />
        ) : tokens.isLoading ? (
          <div aria-label="Loading the market" aria-busy="true">
            {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
              <div key={i} className="kl-row kl-grid kl-skeleton" aria-hidden="true">
                <span className="kl-skel" style={{ width: 14 }} />
                <span className="kl-skel kl-skel-art" />
                <span className="kl-skel" style={{ width: "62%" }} />
                <span className="kl-skel" style={{ width: "70%" }} />
                <span className="kl-skel kl-c-vol" style={{ width: "70%" }} />
                <span className="kl-skel" style={{ width: "100%" }} />
                <span className="kl-skel" style={{ width: "60%" }} />
                <span className="kl-skel" style={{ width: "80%" }} />
              </div>
            ))}
          </div>
        ) : rows.length ? (
          <div className="kl-rows">
            {rows.map((t, i) => <Row key={t.token} t={t} rank={i + 1} />)}
          </div>
        ) : q ? (
          <Note title="No row matches that" body={`Nothing on the board is called "${q}". Try a shorter string, or clear the filter to see the whole column.`} />
        ) : sort === "graduated" ? (
          <Note title="Nothing has graduated yet" body="A launch shows up here once its curve is bought out and the liquidity is in a pool nobody can pull." />
        ) : (
          <Note title="The column is empty" body="No launch has been printed on this chain yet. The first one takes the top row the moment its block lands."
            action={<Link className="btn" href="/launch">List the first one</Link>} />
        )}
      </div>

      {rows.length > 0 && (
        <p className="kl-foot-count">
          {rows.length} {rows.length === 1 ? "row" : "rows"} · sorted by {SORTS.find((s) => s.key === sort)?.label.toLowerCase()}
        </p>
      )}
    </div>
  );
}

/// One launch, read across. The whole row is the link: a table of forty rows where only a six letter
/// word is clickable is a table that is hard to use, and the word is still there at the end of the
/// row to say where the click goes.
/// A launch of a billion tokens prices each one at a billionth of its raise, and down there `compact`
/// falls back to exponent notation, which reads as noise in a column of figures. Below a thousandth
/// the price is quoted per million tokens instead, which is the size somebody actually buys.
function priceOf(price: bigint, decimals: number, unit: string): { value: string; unit: string } {
  const plain = compact(price, decimals);
  if (!plain.includes("e")) return { value: plain, unit };
  return { value: compact(price * 1_000_000n, decimals), unit: `${unit} /1M` };
}

function Row({ t, rank }: { t: TokenRow; rank: number }) {
  const decimals = pairDecimals(t.pair_token);
  const unit = pairSymbol(t.pair_token);
  const done = t.status === "graduated";
  // A graduated launch has nowhere left to climb, so its ladder reads full rather than stalled at
  // whatever the curve said on the block it bonded.
  const fill = done ? 1 : launchProgress(t);
  const pct = Math.round(fill * 100);
  const state = machineLabel(t);
  const price = priceOf(BigInt(t.price || "0"), decimals, unit);

  return (
    <Link href={`/token/${t.token}`} className="kl-row kl-grid">
      <span className="kl-c-rank kl-num">{rank}</span>
      <span className="kl-thumb"><Artwork src={imageUrl(t.image)} symbol={t.symbol} size={36} rounded="rounded-none" /></span>
      <span className="kl-name">
        <strong>{t.symbol}</strong>
        <span className="kl-name-full">{t.name}</span>
        {t.status !== "curve" && <span className="kl-flag">{state}</span>}
      </span>
      <span className="kl-num kl-price">{price.value} <small>{price.unit}</small></span>
      <span className="kl-num kl-c-vol">{compact(BigInt(t.volume_24h || "0"), decimals)} <small>{unit}</small></span>
      <span className="kl-ladder">
        <span className={done ? "kl-track done" : "kl-track"} role="img"
          aria-label={done ? "graduated into the pool" : `${pct} percent of the way to graduation`}>
          <span className="kl-fill" style={{ width: `${Math.min(100, fill * 100).toFixed(1)}%` }} />
        </span>
        <span className="kl-pct">{pct}%</span>
      </span>
      <span className="kl-num kl-age">{ago(t.launched_at)}</span>
      <span className="kl-go">trade</span>
    </Link>
  );
}

/// A figure over its name. The dash is what an unanswered reading looks like; a zero would be a
/// claim about the market rather than an admission that the number has not arrived.
function Metric({ label, value }: { label: string; value?: string }) {
  return (
    <div className="kl-metric">
      <span className="kl-metric-label">{label}</span>
      <strong className="kl-num">{value ?? "–"}</strong>
    </div>
  );
}

/// Empty, loading and broken all look the same here on purpose: a line of type where the rows would
/// have been, saying which of the three it is. No illustration, because a page with no data in it
/// should read as a page with no data in it.
function Note({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="kl-note">
      <h2>{title}</h2>
      <p>{body}</p>
      {action}
    </div>
  );
}
