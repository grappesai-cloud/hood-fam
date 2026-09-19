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

interface Portfolio {
  address: string;
  holdings: { token: string; balance: string; symbol: string; name: string; image: string; price: string; pair_token: string; phase: number }[];
  stakes: { position_id: string; token: string; amount: string; unlock_at: string; weight_bps: number; claimed: string }[];
  launches: { token: string; symbol: string; name: string; phase: number; volume_total: string }[];
  points: { points: number; rank: string; multiplier: number; position: number; volumeUsd: number };
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

  // The figure this page exists to show, and the one it never showed: everything this wallet holds,
  // added up in the pair asset. Holdings are then ranked by it, because a list of tokens in the
  // order the indexer happened to return them is not a portfolio.
  const valued = data.holdings
    .map((h) => ({ ...h, value: (BigInt(h.balance) * BigInt(h.price || "0")) / 10n ** 18n }))
    .sort((a, b) => (a.value < b.value ? 1 : a.value > b.value ? -1 : 0));
  const total = valued.reduce((sum, h) => sum + h.value, 0n);
  const biggest = valued[0]?.value ?? 0n;

  return (
    <div className="portfolio-shell">
      <div className="page-head">
        <header className="page-intro">
          <div className="section-kicker">Wallet</div>
          <h1 className="mono">{shortAddress(address)}</h1>
          <p>Everything this wallet holds, has locked and has printed.</p>
        </header>
        <div className="head-figure">
          <strong>{compact(total)} ETH</strong>
          <span>held, at the last trade</span>
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
        {valued.length === 0 ? <p className="empty-inline">Nothing held yet. Anything bought on the board shows up here.</p> : (
          <div className="rows">
            {valued.map((h) => (
              <Link key={h.token} href={`/token/${h.token}`} className="row">
                <span className="row-art"><Artwork src={imageUrl(h.image)} symbol={h.symbol} size={36} rounded="rounded-none" /></span>
                <span className="row-name"><strong>{h.name}</strong><span>${h.symbol} · {compact(BigInt(h.balance))} held</span></span>
                <span className="row-num"><strong>{compact(h.value, pairDecimals(h.pair_token))}</strong><span>{pairSymbol(h.pair_token)}</span></span>
                <span className="row-meter"><i style={{ width: `${biggest > 0n ? Number((h.value * 100n) / biggest) : 0}%` }} /></span>
              </Link>
            ))}
          </div>
        )}
      </section>

      <div className="portfolio-sections">
        <section className="panel portfolio-section p-5">
          <div className="panel-head"><span className="n">02 / LOCKED</span><h2>Locked positions</h2><span className="hatch" aria-hidden="true" /></div>
          {data.stakes.length === 0 ? <p className="empty-inline">Nothing locked. Locking a token pays you its trading fee for as long as you keep it locked.</p> : (
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
          <div className="panel-head"><span className="n">03 / PRINTED</span><h2>Launches from this wallet</h2><span className="hatch" aria-hidden="true" /></div>
          {data.launches.length === 0 ? <p className="empty-inline">Nothing printed yet.</p> : (
            <div className="rows">
              {data.launches.map((l) => (
                <Link key={l.token} href={`/token/${l.token}`} className="row">
                  <span className="row-art">{(l.symbol || "?").slice(0, 2).toUpperCase()}</span>
                  <span className="row-name"><strong>{l.name}</strong><span>${l.symbol}</span></span>
                  <span className="row-num"><strong>{compact(BigInt(l.volume_total || "0"))}</strong><span>ETH traded</span></span>
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
