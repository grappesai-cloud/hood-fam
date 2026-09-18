"use client";

import Link from "next/link";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useAccount } from "wagmi";
import { api } from "@/lib/api";
import { compact, fmt, pairDecimals, pairSymbol, shortAddress, timeUntil } from "@/lib/format";

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
      <section className="portfolio-empty panel"><h2>Your portfolio starts here.</h2><p>Connect a wallet to see what you hold, lock and launch.</p></section>
    </div>
  );
  if (isError) return <div className="portfolio-shell">{intro}<div className="portfolio-empty panel"><span>↯</span><h2>Portfolio unavailable.</h2><p>Wallet activity will appear when the indexer reconnects.</p></div></div>;
  if (!data) return <div className="portfolio-shell">{intro}<div className="panel portfolio-loading">Loading wallet activity…</div></div>;

  return (
    <div className="portfolio-shell space-y-4">
      {intro}
      <header className="panel portfolio-summary flex flex-wrap items-center gap-6 p-4">
        <div>
          <div className="section-kicker">WALLET ADDRESS</div>
          <h2 className="text-lg font-semibold mono">{shortAddress(address)}</h2>
          <p className="text-xs dim">Everything this wallet holds, locks or launches</p>
        </div>
        <div className="portfolio-stats ml-auto flex gap-6 text-sm">
          <div><div className="mono text-base">{Math.round(data.points.points).toLocaleString()}</div><div className="text-xs dim">points</div></div>
          <div><div className="mono text-base">{data.points.rank}</div><div className="text-xs dim">rank · {data.points.multiplier}x</div></div>
          <div><div className="mono text-base">#{data.points.position}</div><div className="text-xs dim">place</div></div>
        </div>
      </header>

      <div className="portfolio-sections">
      <Section title="Holdings" number="01">
        {data.holdings.length === 0 && <p className="text-sm dim">nothing yet</p>}
        {data.holdings.map((h) => (
          <Link key={h.token} href={`/token/${h.token}`} className="portfolio-row flex items-center gap-3 border-b border-[var(--color-line)] py-2 last:border-0">
            <span className="flex-1 truncate">{h.name} <span className="mono text-xs dim">{h.symbol}</span></span>
            <span className="mono text-sm">{fmt(BigInt(h.balance))}</span>
            <span className="mono text-xs dim">
              ≈ {compact((BigInt(h.balance) * BigInt(h.price || "0")) / 10n ** 18n, pairDecimals(h.pair_token))} {pairSymbol(h.pair_token)}
            </span>
          </Link>
        ))}
      </Section>

      <Section title="Locked positions" number="02">
        {data.stakes.length === 0 && <p className="text-sm dim">nothing locked</p>}
        {data.stakes.map((s) => (
          <div key={s.position_id} className="portfolio-row flex items-center gap-3 border-b border-[var(--color-line)] py-2 text-sm last:border-0">
            <Link href={`/token/${s.token}`} className="flex-1 mono text-xs hover:text-[var(--color-lime)]">{shortAddress(s.token)}</Link>
            <span className="mono">{fmt(BigInt(s.amount))}</span>
            <span className="text-xs dim">{s.weight_bps / 10_000}x</span>
            <span className="text-xs dim">{timeUntil(new Date(s.unlock_at).getTime() / 1000)}</span>
          </div>
        ))}
      </Section>

      <Section title="Your launches" number="03">
        {data.launches.length === 0 && <p className="text-sm dim">nothing printed</p>}
        {data.launches.map((l) => (
          <Link key={l.token} href={`/token/${l.token}`} className="portfolio-row flex items-center gap-3 border-b border-[var(--color-line)] py-2 text-sm last:border-0">
            <span className="flex-1">{l.name} <span className="mono text-xs dim">{l.symbol}</span></span>
            <span className="mono text-xs dim">volume {compact(BigInt(l.volume_total || "0"))}</span>
          </Link>
        ))}
      </Section>
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

function Section({ title, number, children }: { title: string; number: string; children: React.ReactNode }) {
  return (
    <section className="panel portfolio-section p-4">
      <div className="portfolio-section-heading"><span>{number} / PORTFOLIO</span><h2>{title}</h2></div>
      {children}
    </section>
  );
}
