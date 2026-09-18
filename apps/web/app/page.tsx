"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type TokenRow } from "@/lib/api";
import { TokenCard } from "@/components/TokenCard";
import { compact } from "@/lib/format";

const SORTS = [
  { key: "new", label: "Newest", query: "sort=new" },
  { key: "volume", label: "Trending", query: "sort=volume" },
  { key: "graduating", label: "Near graduation", query: "sort=progress&status=graduating" },
  { key: "graduated", label: "Graduated", query: "sort=graduated&status=graduated" },
] as const;

export default function Board() {
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

  return (
    <div className="home-shell">
      <section className="explore-section" aria-labelledby="explore-title">
        <div className="explore-heading">
          <div>
            <h1 id="explore-title">Explore</h1>
            <p>Discover and trade tokens on Robinhood Chain.</p>
          </div>
          <div className="network-label"><span className="live-indicator" /> LIVE ON ROBINHOOD CHAIN</div>
        </div>
        <div className="explore-searchbar">
          <label className="search-field"><span aria-hidden="true">⌕</span><input aria-label="Search tokens" placeholder="Search tokens by name or ticker" value={q} onChange={(e) => setQ(e.target.value)} /></label>
          <Link className="btn create-button" href="/launch"><span aria-hidden="true">＋</span> Create token</Link>
        </div>
        <div className="explore-toolbar">
          <div className="sort-tabs" role="tablist" aria-label="Sort launches">
            {SORTS.map((s) => <button key={s.key} role="tab" aria-selected={sort === s.key} onClick={() => setSort(s.key)} className={sort === s.key ? "sort-tab active" : "sort-tab"}>{s.label}</button>)}
          </div>
          <div className="board-count">{tokens.data ? `${tokens.data.tokens.length} shown` : "Live market"}</div>
        </div>
        {tokens.isError ? (
          <div className="board-message"><span className="message-symbol">↯</span><h3>Market feed unavailable</h3><p>The indexer is not answering. Live token data will appear when it reconnects.</p></div>
        ) : tokens.isLoading ? (
          <div className="token-grid" aria-label="Loading launches">{[0, 1, 2, 3, 4, 5, 6, 7].map((i) => <div key={i} className="token-skeleton" />)}</div>
        ) : tokens.data?.tokens.length ? (
          <div className="token-grid">{tokens.data.tokens.map((t) => <TokenCard key={t.token} t={t} />)}</div>
        ) : (
          <div className="board-message"><h3>{q ? "No matching tokens" : sort === "new" ? "No launches yet" : "Nothing here yet"}</h3><p>{q ? "Try another name or ticker." : "Create a token to start the market."}</p>{!q && <Link className="btn" href="/launch">Create token</Link>}</div>
        )}
        <div className="market-summary" aria-label="Platform activity">
          <Stat label="Launches" value={stats.data?.launches ?? "—"} />
          <Stat label="Graduated" value={stats.data?.graduated ?? "—"} />
          <Stat label="24h volume" value={stats.data ? compact(BigInt(stats.data.volume_24h || "0")) : "—"} />
          <Stat label="Traders" value={stats.data?.traders ?? "—"} />
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="stat"><strong>{value}</strong><span>{label}</span></div>;
}
