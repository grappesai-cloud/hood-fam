"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type TokenRow } from "@/lib/api";
import { useLive } from "@/lib/live";
import { ago, compact, imageUrl, launchProgress, pairDecimals, pairSymbol, shortAddress } from "@/lib/format";
import { Artwork } from "@/components/Artwork";

const SORTS = [
  { key: "new", label: "New", query: "sort=new" },
  { key: "volume", label: "Trending", query: "sort=volume" },
  { key: "graduating", label: "Graduating", query: "sort=progress&status=graduating" },
  { key: "graduated", label: "Graduated", query: "sort=graduated&status=graduated" },
] as const;

type SortKey = (typeof SORTS)[number]["key"];

export function Explore() {
  const [sort, setSort] = useState<SortKey>("new");
  const [q, setQ] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const query = SORTS.find((item) => item.key === sort)?.query ?? "sort=new";

  useLive();

  const stats = useQuery({
    queryKey: ["stats"],
    queryFn: () => api<{ launches: string; graduated: string; volume_24h: string; trades: string; traders: string }>("/stats"),
  });
  const tokens = useQuery({
    queryKey: ["tokens", sort, q],
    queryFn: () => api<{ tokens: TokenRow[] }>(`/tokens?${query}&limit=60${q ? `&q=${encodeURIComponent(q)}` : ""}`),
  });
  const trending = useQuery({
    queryKey: ["ox-trending"],
    queryFn: () => api<{ tokens: TokenRow[] }>("/tokens?sort=volume&limit=5"),
    refetchInterval: 30_000,
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement) return;
      event.preventDefault();
      search.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const rows = tokens.data?.tokens ?? [];

  return (
    <div className="ox-home">
      <section className="ox-hero">
        <div className="ox-hero-copy">
          <div className="ox-live-pill"><i aria-hidden="true" /> Live on Robinhood Chain</div>
          <h1>Launch a token.<br /><em>Find its family.</em></h1>
          <p>
            Create and trade community tokens from the first buy to the open market. Every launch
            starts on a transparent curve and graduates automatically into permanently locked liquidity.
          </p>
          <div className="ox-hero-actions">
            <Link className="ox-primary-action" href="/launch"><span>＋</span>Create token</Link>
            <a className="ox-secondary-action" href="#how-it-works">How it works <span>↓</span></a>
          </div>
          <div className="ox-trust-line">
            <span>✓ No presale</span><span>✓ Non-custodial</span><span>✓ Locked liquidity</span>
          </div>
        </div>
        <div className="ox-hero-visual" aria-label="ox.family glass logo">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/ox/ox-green-hero.png" alt="Green glass OX logo" />
          <div className="ox-hero-orbit ox-orbit-one" />
          <div className="ox-hero-orbit ox-orbit-two" />
        </div>
      </section>

      <section className="ox-market-strip" aria-label="Platform activity">
        <MarketStat label="Tokens launched" value={stats.data?.launches ?? "—"} />
        <MarketStat label="Graduated" value={stats.data?.graduated ?? "—"} />
        <MarketStat label="24h volume" value={stats.data ? `${compact(BigInt(stats.data.volume_24h || "0"))} ETH` : "—"} hot />
        <MarketStat label="Active traders" value={stats.data?.traders ?? "—"} />
      </section>

      {trending.data?.tokens.length ? (
        <section className="ox-trending-section" aria-labelledby="trending-title">
          <div className="ox-section-heading compact">
            <div><span className="ox-heading-kicker">Happening now</span><h2 id="trending-title">Trending on ox</h2></div>
            <button type="button" onClick={() => setSort("volume")}>View all <span>→</span></button>
          </div>
          <div className="ox-trending-row">
            {trending.data.tokens.map((token, index) => <TrendingCard key={token.token} token={token} rank={index + 1} />)}
          </div>
        </section>
      ) : null}

      <section className="ox-how" id="how-it-works" aria-labelledby="how-title">
        <div className="ox-how-intro">
          <span className="ox-heading-kicker">One continuous market</span>
          <h2 id="how-title">From idea to<br />locked liquidity.</h2>
          <p>No manual migration and no liquidity switch to miss. Your token stays the same while its market grows up.</p>
        </div>
        <ol className="ox-steps">
          <li><b>01</b><span><strong>Create</strong><small>Choose the name, ticker, image and fee split.</small></span></li>
          <li><b>02</b><span><strong>Trade the curve</strong><small>Buy and sell from block one at a transparent price.</small></span></li>
          <li><b>03</b><span><strong>Graduate</strong><small>The curve fills and creates the market automatically.</small></span></li>
          <li><b>04</b><span><strong>Open market</strong><small>Liquidity is locked and trading continues in the pool.</small></span></li>
        </ol>
      </section>

      <section className="ox-discover" aria-labelledby="discover-title">
        <div className="ox-section-heading">
          <div><span className="ox-heading-kicker">Explore the family</span><h2 id="discover-title">Discover tokens</h2></div>
          <p>Watch launches move from their first trade to graduation.</p>
        </div>

        <div className="ox-discover-controls">
          <label className="ox-search">
            <span aria-hidden="true">⌕</span>
            <input
              ref={search}
              value={q}
              onChange={(event) => setQ(event.target.value)}
              placeholder="Search by name, ticker or address"
              aria-label="Search tokens"
            />
            <kbd>/</kbd>
          </label>
          <div className="ox-sort-tabs" role="tablist" aria-label="Sort tokens">
            {SORTS.map((item) => (
              <button
                key={item.key}
                type="button"
                role="tab"
                aria-selected={sort === item.key}
                className={sort === item.key ? "active" : ""}
                onClick={() => setSort(item.key)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        {tokens.isError ? (
          <State title="Market feed unavailable" body="The indexer is reconnecting. Your assets and every on-chain market remain unchanged." />
        ) : tokens.isLoading ? (
          <div className="ox-token-grid" aria-label="Loading tokens">
            {Array.from({ length: 8 }, (_, index) => <div className="ox-token-skeleton" key={index} />)}
          </div>
        ) : rows.length ? (
          <div className="ox-token-grid">{rows.map((token) => <Token key={token.token} token={token} />)}</div>
        ) : (
          <State
            title={q ? "No tokens found" : "No launches here yet"}
            body={q ? `Nothing matches “${q}”. Try a ticker or paste the token address.` : "Be the first member of this part of the family."}
            action={!q ? <Link className="ox-primary-action" href="/launch">Create the first token</Link> : undefined}
          />
        )}
      </section>
    </div>
  );
}

function MarketStat({ label, value, hot = false }: { label: string; value: string; hot?: boolean }) {
  return <div className={hot ? "ox-market-stat hot" : "ox-market-stat"}><span>{label}</span><strong>{value}</strong></div>;
}

function TrendingCard({ token, rank }: { token: TokenRow; rank: number }) {
  const decimals = pairDecimals(token.pair_token, token);
  const unit = pairSymbol(token.pair_token, token);
  const cap = (BigInt(token.price || "0") * BigInt(token.total_supply || "0")) / 10n ** 18n;
  return (
    <Link href={`/token/${token.token}`} className="ox-trending-card">
      <span className="ox-rank">{String(rank).padStart(2, "0")}</span>
      <Artwork src={imageUrl(token.image)} symbol={token.symbol} size={48} rounded="rounded-full" />
      <span className="ox-trending-name"><strong>{token.name}</strong><small>${token.symbol}</small></span>
      <span className="ox-trending-cap"><strong>{compact(cap, decimals)}</strong><small>{unit} MC</small></span>
    </Link>
  );
}

function Token({ token }: { token: TokenRow }) {
  const decimals = pairDecimals(token.pair_token, token);
  const unit = pairSymbol(token.pair_token, token);
  const cap = (BigInt(token.price || "0") * BigInt(token.total_supply || "0")) / 10n ** 18n;
  const progress = token.mode === "direct" || token.status === "graduated" ? 1 : launchProgress(token);
  const done = progress >= 1;
  const status = token.mode === "direct" ? "Open market" : done ? "Graduated" : "Bonding curve";

  return (
    <Link href={`/token/${token.token}`} className="ox-token-card">
      <div className="ox-token-art">
        <Artwork src={imageUrl(token.image)} symbol={token.symbol} size={180} rounded="rounded-none" />
        <span className={done ? "ox-status done" : "ox-status"}>{status}</span>
        <span className="ox-age">{ago(token.launched_at)} ago</span>
      </div>
      <div className="ox-token-body">
        <div className="ox-token-title"><span><strong>{token.name}</strong><small>${token.symbol}</small></span><b>↗</b></div>
        <p>{token.description || "A community token launched on Robinhood Chain."}</p>
        <div className="ox-token-numbers">
          <span><small>Market cap</small><strong>{compact(cap, decimals)} {unit}</strong></span>
          <span><small>24h volume</small><strong>{compact(BigInt(token.volume_24h || "0"), decimals)} {unit}</strong></span>
        </div>
        <div className="ox-progress-label"><span>{done ? "Liquidity pool live" : "Graduation progress"}</span><b>{Math.round(progress * 100)}%</b></div>
        <div className={done ? "ox-progress done" : "ox-progress"}><i style={{ width: `${Math.min(100, progress * 100)}%` }} /></div>
        <div className="ox-token-foot"><span>{shortAddress(token.token)}</span><b>Trade token →</b></div>
      </div>
    </Link>
  );
}

function State({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return <div className="ox-state"><span>OX</span><h3>{title}</h3><p>{body}</p>{action}</div>;
}
