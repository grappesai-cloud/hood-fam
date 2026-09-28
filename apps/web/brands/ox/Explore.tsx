"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type TokenRow } from "@/lib/api";
import { useLive } from "@/lib/live";
import { ago, compact, fmt, imageUrl, launchProgress, pairDecimals, pairSymbol, shortAddress } from "@/lib/format";
import { Artwork } from "@/components/Artwork";
import { GraduationRace } from "@/components/GraduationRace";
import { FomoFeed } from "@/components/FomoFeed";
import { BoostedRow, pinBoosted } from "@/components/board/BoostedRow";
import { PaydayStrip } from "@/components/board/PaydayStrip";
import { LastTen } from "@/components/board/LastTen";
import { BoostBadge } from "@/components/token/BoostBadge";
import { PaidTicker } from "@/components/landing/PaidTicker";
import { Desk } from "@/components/landing/Desk";

/// The ox front: a desk, not a hero. The strip of wallets paid this week runs under the header,
/// the search sits over three columns (paid out, migrated and boosted, trending), and the board
/// with every launch follows. The desk is components/landing; the board below it is the same
/// board this page always had.

const SORTS = [
  { key: "volume", label: "Trending", query: "sort=volume" },
  { key: "new", label: "New", query: "sort=new&category=new" },
  { key: "stocks", label: "Stocks", query: "sort=volume&category=stocks" },
  { key: "graduating", label: "Bonding", query: "sort=progress&status=graduating" },
  { key: "graduated", label: "Graduated", query: "sort=graduated&status=graduated" },
  { key: "culture", label: "Culture pairs", query: "sort=volume&category=culture" },
  { key: "direct", label: "Direct pool", query: "sort=volume&category=direct" },
  { key: "locked", label: "Dev locked", query: "sort=volume&category=locked" },
] as const;

type SortKey = (typeof SORTS)[number]["key"];

export function Explore() {
  const [sort, setSort] = useState<SortKey>("volume");
  const [q, setQ] = useState("");
  const [view, setView] = useState<"board" | "cards">("board");
  const search = useRef<HTMLInputElement>(null);
  const query = SORTS.find((item) => item.key === sort)?.query ?? "sort=new";

  useLive();

  const stats = useQuery({
    queryKey: ["stats"],
    queryFn: () => api<{ launches: string; graduated: string; volume_24h: string; volume_24h_native?: string; trades: string; traders: string }>("/stats"),
  });
  const tokens = useQuery({
    queryKey: ["tokens", sort, q],
    queryFn: () => api<{ tokens: TokenRow[] }>(`/tokens?${query}&limit=60${q ? `&q=${encodeURIComponent(q)}` : ""}`),
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

  // Whoever paid for the hour sits first, whatever the tab; the tab still orders the rest.
  const rows = pinBoosted(tokens.data?.tokens ?? []);
  const hasMarketActivity = Number(stats.data?.launches ?? 0) > 0 || rows.length > 0;

  return (
    <div className="ox-home">
      <PaidTicker />

      <div className="ox-market-toolbar">
        <label className="ox-search">
          <span aria-hidden="true">⌕</span>
          <input
            ref={search}
            value={q}
            onChange={(event) => setQ(event.target.value)}
            placeholder="Search tokens"
            aria-label="Search tokens by name, ticker or address"
          />
          <kbd>/</kbd>
        </label>
        <div className="ox-market-shortcuts">
          <button type="button" onClick={() => setSort("stocks")}>↗ <span>Stocks</span></button>
          <Link href="/launch">＋ <span>Create</span></Link>
        </div>
      </div>

      <Desk />

      <section className="ox-discover" aria-labelledby="discover-title">
        <div className="ox-section-heading">
          <div><span className="ox-heading-kicker">The market</span><h2 id="discover-title">Explore tokens</h2></div>
          <p>New launches, active curves and graduated markets in one place.</p>
        </div>

        <BoostedRow variant="ox" />

        <div className="ox-discover-controls">
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
          <div className="ox-view-switch" aria-label="Market view">
            <button type="button" aria-label="Table view" title="Table view" className={view === "board" ? "active" : ""} onClick={() => setView("board")}>☷</button>
            <button type="button" aria-label="Card view" title="Card view" className={view === "cards" ? "active" : ""} onClick={() => setView("cards")}>▦</button>
          </div>
        </div>

        {tokens.isError ? (
          <State title="Market feed unavailable" body="The indexer is reconnecting. Your assets and every on-chain market remain unchanged." />
        ) : tokens.isLoading ? (
          <div className="ox-token-grid" aria-label="Loading tokens">
            {Array.from({ length: 8 }, (_, index) => <div className="ox-token-skeleton" key={index} />)}
          </div>
        ) : rows.length ? (
          view === "board" ? <MarketBoard tokens={rows} /> : <div className="ox-token-grid">{rows.map((token) => <Token key={token.token} token={token} />)}</div>
        ) : (
          <State
            title={q ? "No tokens found" : "No launches here yet"}
            body={q ? `Nothing matches “${q}”. Try a ticker or paste the token address.` : "The board is ready. Create a token to start the first market."}
            action={!q ? <Link className="ox-primary-action" href="/launch">Create the first token</Link> : undefined}
          />
        )}
      </section>

      <section className="ox-hero">
        <div className="ox-hero-copy">
          <div className="ox-live-pill"><i aria-hidden="true" /> Robinhood Chain launchpad</div>
          <h1>Launch tokens.<br /><em>Trade together.</em></h1>
          <p>
            Create a token, follow the market and see exactly where the fees go.
            Creators choose a fee wallet; eligible activity earns points toward the season pool.
          </p>
          <div className="ox-hero-actions">
            <Link className="ox-primary-action" href="/launch"><span>＋</span>Create token</Link>
            <Link className="ox-secondary-action" href="/airdrop">See your cut <span>↗</span></Link>
          </div>
          <div className="ox-trust-line"><span>Transparent curves</span><span>Creator fee wallet</span><span>Locked liquidity at graduation</span></div>
        </div>
        <div className="ox-hero-visual" aria-label="hood.fam">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/ox/bags-mark.svg"
            alt="hood.fam"
            width={50}
            height={30}
            loading="lazy"
            decoding="async"
          />
        </div>
      </section>

      {Number(stats.data?.launches ?? 0) > 0 ? (
        <section className="ox-market-strip" aria-label="Platform activity">
          <MarketStat label="Tokens launched" value={stats.data?.launches ?? "—"} />
          <MarketStat label="Graduated" value={stats.data?.graduated ?? "—"} />
          <MarketStat label="24h volume · ETH pairs" value={stats.data ? `${compact(BigInt(stats.data.volume_24h_native ?? stats.data.volume_24h ?? "0"))} ETH` : "—"} hot />
          <MarketStat label="Active traders" value={stats.data?.traders ?? "—"} />
          <PaydayStrip />
        </section>
      ) : null}

      {hasMarketActivity ? <LastTen variant="ox" /> : null}

      {hasMarketActivity ? (
        <>
          <div className="ox-race-wrap"><GraduationRace /></div>
          <div className="ox-social-grid single"><FomoFeed /></div>
        </>
      ) : null}

      <section className="ox-how" id="how-it-works" aria-labelledby="how-title">
        <div className="ox-how-intro">
          <span className="ox-heading-kicker">How it works</span>
          <h2 id="how-title">From launch<br />to open market.</h2>
          <p>One token, one market path. Follow the curve and the fee split at every step.</p>
        </div>
        <ol className="ox-steps">
          <li><b>01</b><span><strong>Create</strong><small>Choose the name, ticker, image and fee split.</small></span></li>
          <li><b>02</b><span><strong>Trade the curve</strong><small>Buy and sell from block one at a transparent price.</small></span></li>
          <li><b>03</b><span><strong>Graduate</strong><small>The curve fills and creates the market automatically.</small></span></li>
          <li><b>04</b><span><strong>Open market</strong><small>Liquidity is locked and trading continues in the pool.</small></span></li>
        </ol>
      </section>
    </div>
  );
}

function MarketStat({ label, value, hot = false }: { label: string; value: string; hot?: boolean }) {
  return <div className={hot ? "ox-market-stat hot" : "ox-market-stat"}><span>{label}</span><strong>{value}</strong></div>;
}

function MarketBoard({ tokens }: { tokens: TokenRow[] }) {
  return (
    <div className="ox-board-wrap">
      <table className="ox-board-table">
        <thead>
          <tr>
            <th>Token / pair</th><th>Market cap</th><th>Price</th><th>24h</th><th>24h volume</th>
            <th>Trading fee</th><th>Graduation</th><th>Age</th><th aria-label="Trade" />
          </tr>
        </thead>
        <tbody>{tokens.map((token) => <BoardRow key={token.token} token={token} />)}</tbody>
      </table>
    </div>
  );
}

function BoardRow({ token }: { token: TokenRow }) {
  const decimals = pairDecimals(token.pair_token, token);
  const unit = pairSymbol(token.pair_token, token);
  const cap = (BigInt(token.price || "0") * BigInt(token.total_supply || "0")) / 10n ** 18n;
  const oldPrice = BigInt(token.price_24h_ago || "0");
  const change = oldPrice > 0n ? Number(((BigInt(token.price || "0") - oldPrice) * 10_000n) / oldPrice) / 100 : null;
  const price = BigInt(token.price || "0");
  const priceLabel = price > 0n && price < 10n ** BigInt(Math.max(0, decimals - 6))
    ? `${fmt(price * 1_000_000n, decimals, 6)} / 1M`
    : fmt(price, decimals, 8);
  const progress = token.mode === "direct" || token.status === "graduated" ? 1 : launchProgress(token);
  const done = progress >= 1;

  return (
    <tr>
      <td>
        <Link className="ox-board-token" href={`/token/${token.token}`}>
          <Artwork src={imageUrl(token.image)} symbol={token.symbol} size={42} rounded="rounded-lg" />
          <span><strong>${token.symbol} {isDevLocked(token) ? <em className="ox-dev-lock">🔒 DEV LOCKED</em> : null} {token.boosted ? <BoostBadge className="ox-boost-tag" /> : null}</strong><small>{token.name} · {unit} pair · {shortAddress(token.token)}</small></span>
        </Link>
      </td>
      <td><strong>{compact(cap, decimals)}</strong><small>{unit}</small></td>
      <td><strong>{priceLabel}</strong><small>{unit}</small></td>
      <td><strong className={change === null ? "dim" : change >= 0 ? "positive" : "negative"}>{change === null ? "—" : `${change >= 0 ? "+" : ""}${change.toFixed(1)}%`}</strong><small>{change === null ? "no trade history" : "vs 24h ago"}</small></td>
      <td><strong>{compact(BigInt(token.volume_24h || "0"), decimals)}</strong><small>{unit}</small></td>
      <td><strong>{token.mode === "direct" ? `${((token.buy_tax_bps ?? 0) / 100).toFixed(1)}% / ${((token.sell_tax_bps ?? 0) / 100).toFixed(1)}%` : "Curve fee"}</strong><small>{token.mode === "direct" ? "buy / sell + pool fee" : "see token terms"}</small></td>
      <td>
        <span className="ox-board-progress-label"><b>{done ? "Pool live" : `${Math.round(progress * 100)}%`}</b><small>{done ? "graduated" : "to graduation"}</small></span>
        <span className={`${done ? "ox-board-progress done" : "ox-board-progress"}${progress >= .85 && !done ? " hot" : ""}`}><i style={{ width: `${Math.min(100, progress * 100)}%` }} /></span>
      </td>
      <td><strong>{ago(token.launched_at)}</strong><small>ago</small></td>
      <td><Link className="ox-board-trade" href={`/token/${token.token}`}>Trade <span>↗</span></Link></td>
    </tr>
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
        {isDevLocked(token) ? <span className="ox-card-lock">🔒 Dev locked</span> : null}
        {token.boosted ? <BoostBadge className="ox-card-boost" /> : null}
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
        <div className={`${done ? "ox-progress done" : "ox-progress"}${progress >= .85 && !done ? " hot" : ""}`}><i style={{ width: `${Math.min(100, progress * 100)}%` }} /></div>
        <div className="ox-token-foot"><span>{shortAddress(token.token)}</span><b>Trade token →</b></div>
      </div>
    </Link>
  );
}

function isDevLocked(token: TokenRow) {
  if (BigInt(token.first_buy_locked || "0") === 0n) return false;
  return !token.first_buy_unlock_at || new Date(token.first_buy_unlock_at).getTime() > Date.now();
}

function State({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return <div className="ox-state"><span>hood</span><h3>{title}</h3><p>{body}</p>{action}</div>;
}
