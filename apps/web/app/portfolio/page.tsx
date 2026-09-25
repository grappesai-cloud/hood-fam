"use client";

import Link from "next/link";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Empty } from "@/components/Empty";
import { useAccount } from "wagmi";
import { api } from "@/lib/api";
import { compact, imageUrl, pairDecimals, pairSymbol, shortAddress, timeUntil } from "@/lib/format";
import { Artwork } from "@/components/Artwork";
import { PortfolioEarnings, type EarningSource } from "@/components/PortfolioEarnings";
import { PushedDividends, type PushedRow } from "@/components/portfolio/PushedDividends";
import { PaydayWins, type PaydayRow, type PaydayTotal } from "@/components/portfolio/PaydayWins";
import { VaultEarnings, type VaultWalletRow } from "@/components/portfolio/VaultEarnings";

interface Portfolio {
  address: string;
  holdings: { token: string; balance: string; symbol: string; name: string; image: string; price: string; pair_token: string; phase: number; pair_symbol?: string | null; pair_decimals?: number | null }[];
  stakes: { position_id: string; token: string; amount: string; unlock_at: string; weight_bps: number; claimed: string }[];
  launches: { token: string; symbol: string; name: string; phase: number; volume_total: string; pair_token: string; pair_symbol?: string | null; pair_decimals?: number | null }[];
  earnings: EarningSource[];
  points: { points: number; rank: string; multiplier: number; position: number; volumeUsd: number };
  // The Bag release. Missing on an API from before it, and every section below treats missing as
  // "not reported" rather than as zero.
  pushed?: PushedRow[];
  payday?: PaydayRow[];
  payday_total?: PaydayTotal[];
  vault?: VaultWalletRow[];
  bounties?: unknown;
}

function PortfolioInner() {
  const { address: connected } = useAccount();
  const search = useSearchParams();
  const address = (search.get("address") ?? connected ?? "").toLowerCase();

  const { data, isError } = useQuery({
    queryKey: ["portfolio", address],
    queryFn: () => api<Portfolio>(`/portfolio/${address}`),
    enabled: Boolean(address),
  });

  const intro = (
    <header className="page-intro portfolio-intro">
      <div className="section-kicker">WALLET</div>
      <h1>Portfolio</h1>
      <p>Your tokens, positions and launches in one place.</p>
    </header>
  );

  if (!address) return (
    <div className="portfolio-shell">{intro}
      <Empty title="Your portfolio starts here." body="Connect a wallet to see what you hold, what you have locked and what you have launched." />
    </div>
  );
  if (isError) return <div className="portfolio-shell">{intro}<Empty title="Portfolio unavailable." body="The indexer is not answering. Wallet activity appears here the moment it reconnects, and nothing on chain has changed." /></div>;
  if (!data) return <div className="portfolio-shell">{intro}<div className="panel portfolio-loading">Loading wallet activity…</div></div>;

  // A quote amount is only comparable with another amount of that same asset. In particular,
  // adding ETH, USDG and a custom meme quote and printing "ETH" invents portfolio value.
  const valued = data.holdings.map((h) => ({
    ...h, value: (BigInt(h.balance) * BigInt(h.price || "0")) / 10n ** 18n,
  }));
  const byQuote = new Map<string, { symbol: string; decimals: number; total: bigint; rows: typeof valued }>();
  for (const holding of valued) {
    const key = holding.pair_token.toLowerCase();
    const group = byQuote.get(key) ?? {
      symbol: pairSymbol(holding.pair_token, holding),
      decimals: pairDecimals(holding.pair_token, holding),
      total: 0n,
      rows: [],
    };
    group.total += holding.value;
    group.rows.push(holding);
    byQuote.set(key, group);
  }
  for (const group of byQuote.values()) group.rows.sort((a, b) => a.value < b.value ? 1 : a.value > b.value ? -1 : 0);
  const quoteGroups = [...byQuote.values()];

  return (
    <div className="portfolio-shell">
      <div className="page-head">
        <header className="page-intro">
          <div className="section-kicker">Wallet</div>
          <h1 className="mono">{shortAddress(address)}</h1>
          <p>Everything this wallet holds, has locked and has printed.</p>
        </header>
        <div className="head-figure">
          <strong>{valued.length} token{valued.length === 1 ? "" : "s"}</strong>
          <span>held across {quoteGroups.length} quote asset{quoteGroups.length === 1 ? "" : "s"}</span>
        </div>
      </div>

      <div className="market-summary" aria-label="This wallet this season">
        <div className="stat"><strong>{Math.round(data.points.points).toLocaleString()}</strong><span>points</span></div>
        <div className="stat"><strong>{data.points.rank}</strong><span>rank · {data.points.multiplier}x</span></div>
        <div className="stat"><strong>#{data.points.position}</strong><span>place on the board</span></div>
        <div className="stat"><strong>{valued.length}</strong><span>tokens held</span></div>
      </div>

      <section className="panel portfolio-section p-5">
        <div className="panel-head"><span className="n">01 / HOLDINGS</span><h2>What this wallet holds</h2><span className="hatch" aria-hidden="true" /><span className="aside">{valued.length} token{valued.length === 1 ? "" : "s"}</span></div>
        {valued.length === 0 ? <p className="empty-inline">Nothing held yet. Anything bought on the board shows up here.</p> : quoteGroups.map((group) => {
          const biggest = group.rows[0]?.value ?? 0n;
          return <div key={`${group.symbol}-${group.rows[0]?.pair_token}`} className="mb-5 last:mb-0">
            <div className="mb-2 flex items-baseline justify-between gap-3 border-b border-[var(--color-line)] pb-2 text-sm">
              <strong>{group.symbol} markets</strong>
              <span className="mono">{compact(group.total, group.decimals)} {group.symbol}</span>
            </div>
            <div className="rows">{group.rows.map((h) => (
              <Link key={h.token} href={`/token/${h.token}`} className="row">
                <span className="row-art"><Artwork src={imageUrl(h.image)} symbol={h.symbol} size={36} rounded="rounded-none" /></span>
                <span className="row-name"><strong>{h.name}</strong><span>${h.symbol} · {compact(BigInt(h.balance))} held</span></span>
                <span className="row-num"><strong>{compact(h.value, pairDecimals(h.pair_token, h))}</strong><span>{pairSymbol(h.pair_token, h)}</span></span>
                <span className="row-meter"><i style={{ width: `${biggest > 0n ? Number((h.value * 100n) / biggest) : 0}%` }} /></span>
              </Link>
            ))}</div>
          </div>;
        })}
        {valued.length > 0 && <p className="mt-3 text-xs dim">Last traded prices, grouped by quote asset. Different currencies are not added together; these are not guaranteed sale proceeds.</p>}
      </section>

      <PortfolioEarnings address={address} sources={data.earnings ?? []} />

      <PushedDividends address={address} rows={data.pushed} />

      <div className="portfolio-sections">
        <PaydayWins payday={data.payday} totals={data.payday_total} bounties={data.bounties} />
        <VaultEarnings scope="wallet" n="05 / VAULT" title="Vault earnings" rows={data.vault} />
      </div>

      <div className="portfolio-sections">
        <section className="panel portfolio-section p-5">
          <div className="panel-head"><span className="n">06 / LOCKED</span><h2>Locked positions</h2><span className="hatch" aria-hidden="true" /></div>
          {data.stakes.length === 0 ? <p className="empty-inline">Nothing locked. You lock the house coin, the Vault pays you a share of what the Bag sends it, every block, for as long as it stays locked.</p> : (
            <div className="rows">
              {data.stakes.map((st) => (
                <Link key={st.position_id} href={`/token/${st.token}`} className="row">
                  <span className="row-art">{shortAddress(st.token).slice(2, 4).toUpperCase()}</span>
                  <span className="row-name"><strong>{shortAddress(st.token)}</strong><span>{st.weight_bps / 10_000}x · unlocks {timeUntil(new Date(st.unlock_at).getTime() / 1000)}</span></span>
                  <span className="row-num"><strong>{compact(BigInt(st.amount))}</strong><span>locked</span></span>
                </Link>
              ))}
            </div>
          )}
        </section>

        <section className="panel portfolio-section p-5">
          <div className="panel-head"><span className="n">07 / PRINTED</span><h2>Launches from this wallet</h2><span className="hatch" aria-hidden="true" /></div>
          {data.launches.length === 0 ? <p className="empty-inline">Nothing printed yet.</p> : (
            <div className="rows">
              {data.launches.map((l) => (
                <Link key={l.token} href={`/token/${l.token}`} className="row">
                  <span className="row-art">{(l.symbol || "?").slice(0, 2).toUpperCase()}</span>
                  <span className="row-name"><strong>{l.name}</strong><span>${l.symbol}</span></span>
                  <span className="row-num"><strong>{compact(BigInt(l.volume_total || "0"), pairDecimals(l.pair_token, l))}</strong><span>{pairSymbol(l.pair_token, l)} traded</span></span>
                </Link>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

export default function PortfolioPage() {
  return (
    <Suspense fallback={<p className="panel p-6 text-sm dim">loading</p>}>
      <PortfolioInner />
    </Suspense>
  );
}
