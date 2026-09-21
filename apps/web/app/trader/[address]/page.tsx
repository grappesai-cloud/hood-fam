"use client";

import { use } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { ago, compact, shortAddress } from "@/lib/format";
import { FollowButton } from "@/components/Social";

/// One trader, as everybody else sees them: what they are up, what they trade, and a button to
/// follow them. Public on purpose — a profile that needs a sign-in cannot be linked into a group
/// chat, and being linked into a group chat is the entire point of having one.

interface Trader {
  address: string;
  season: number;
  volumeUsd: number;
  trades: number;
  launches: number;
  followers: number;
  pnl: { realizedUsd: number; unrealizedUsd: number; totalUsd: number };
}

interface TradeRow {
  token: string; side: string; trader: string; pair_amount: string; token_amount: string; ts: string;
  symbol?: string; name?: string;
}

const money = (usd: number) => `${usd < 0 ? "-" : ""}$${Math.abs(usd).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

export default function TraderPage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = use(params);
  const { data } = useQuery({
    queryKey: ["trader", address],
    queryFn: () => api<Trader>(`/traders/${address}`),
    refetchInterval: 30_000,
  });
  const { data: activity } = useQuery({
    queryKey: ["trader-activity", address],
    queryFn: () => api<{ activity: TradeRow[] }>(`/activity?limit=40&trader=${address}`).catch(() => ({ activity: [] })),
  });

  const pnl = data?.pnl;
  const trades = (activity?.activity ?? []).filter((t) => t.trader?.toLowerCase() === address.toLowerCase());

  return (
    <div className="trader-shell">
      <div className="page-head">
        <header className="page-intro">
          <div className="section-kicker">Trader</div>
          <h1 className="mono">{shortAddress(address)}</h1>
          <p>
            Everything here is read off this pad&apos;s own index of the chain: what they bought, what
            they sold, and what that is worth now. Following is a subscription to a public feed and
            nothing else.
          </p>
        </header>
        <div className="head-figure">
          <strong className={pnl && pnl.totalUsd < 0 ? "text-[var(--color-red)]" : undefined}>
            {pnl ? money(pnl.totalUsd) : "·"}
          </strong>
          <span>profit, open and banked</span>
        </div>
      </div>

      <div className="market-summary">
        <div className="stat"><strong>{pnl ? money(pnl.realizedUsd) : "·"}</strong><span>banked</span></div>
        <div className="stat"><strong>{pnl ? money(pnl.unrealizedUsd) : "·"}</strong><span>still open</span></div>
        <div className="stat"><strong>{data ? money(data.volumeUsd) : "·"}</strong><span>volume this season</span></div>
        <div className="stat"><strong>{data?.trades ?? "·"}</strong><span>trades</span></div>
        <div className="stat"><strong>{data?.launches ?? "·"}</strong><span>launches</span></div>
        <div className="stat"><strong>{data?.followers ?? "·"}</strong><span>followers</span></div>
      </div>

      <div className="trader-actions">
        <FollowButton address={address} />
        <Link className="btn btn-ghost" href={`/portfolio?address=${address}`}>See what they hold</Link>
      </div>

      <section className="panel">
        <header className="refer-head"><h2>Recent trades</h2></header>
        <div className="table-scroll">
          <table>
            <thead><tr><th>When</th><th>Side</th><th>Launch</th><th>Size</th><th /></tr></thead>
            <tbody>
              {trades.map((trade, i) => (
                <tr key={`${trade.token}-${trade.ts}-${i}`}>
                  <td className="dim">{ago(trade.ts)}</td>
                  <td className={trade.side === "buy" ? "text-[var(--color-green)]" : "text-[var(--color-red)]"}>{trade.side}</td>
                  <td><Link href={`/token/${trade.token}`}>{trade.symbol ?? shortAddress(trade.token)}</Link></td>
                  <td>{compact(BigInt(trade.token_amount))}</td>
                  <td><Link className="btn btn-ghost" href={`/token/${trade.token}`}>Copy this trade</Link></td>
                </tr>
              ))}
              {!trades.length && <tr><td colSpan={5} className="dim">No trades indexed for this wallet yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
