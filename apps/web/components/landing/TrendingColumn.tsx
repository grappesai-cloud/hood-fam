"use client";

import { useQuery } from "@tanstack/react-query";
import { api, type TokenRow } from "@/lib/api";
import { isMissing, useBag } from "@/lib/bag";
import { Prov } from "@/components/Provenance";
import { usePaydayCountdown } from "@/components/bag/PaydayClock";
import { TokenLine, changeOf } from "./TokenLine";

/// Column three: what is trading, by the day's volume, with the three biggest movers tagged. The
/// header is the Payday clock, because the hour's pot goes to the hour's wallets and this column is
/// where the hour is being traded. The query sits under "tokens" so every trade off the stream
/// refreshes it (lib/live.ts); the clock runs on the reader's wall clock and takes the API's
/// `endsAt` as truth whenever the Bag answers.

export function TrendingColumn({ className }: { className?: string }) {
  const trending = useQuery({
    queryKey: ["tokens", "desk", "volume"],
    queryFn: () => api<{ tokens: TokenRow[] }>("/tokens?sort=volume&limit=30"),
    refetchInterval: 30_000,
    retry: false,
  });
  const bag = useBag();
  const { text, due } = usePaydayCountdown(bag.data?.payday?.endsAt);
  const rows = trending.data?.tokens ?? [];
  // HOT is the three that moved up the most today; a day where nothing went up tags nobody.
  const hot = new Set(
    rows
      .map((t) => ({ token: t.token, change: changeOf(t) }))
      .filter((r): r is { token: string; change: number } => r.change != null && r.change > 0)
      .sort((a, b) => b.change - a.change)
      .slice(0, 3)
      .map((r) => r.token),
  );
  const missing = trending.isError && isMissing(trending.error);

  return (
    <section className={className ? `ox-desk-col ${className}` : "ox-desk-col"} aria-labelledby="desk-trending-title">
      <header className="ox-desk-head">
        <div className="ox-desk-title">
          <span className="ox-desk-kicker">Trending now</span>
          <h2 id="desk-trending-title">Most traded today</h2>
        </div>
        <div className={due ? "ox-desk-figure due" : "ox-desk-figure"} aria-live="off">
          <strong className="mono" title={bag.data ? "the hour Payday closes, as the Bag reports it" : "the top of the hour on your clock; the Bag has not answered yet"}>
            {text ?? "--:--"} <span className="ox-desk-unit">{due ? "the hour is up" : "to Payday"}</span> <Prov kind={bag.data ? "measured" : "derived"} />
          </strong>
          <small>{due ? "The keeper is paying the hour now. The hour's pot goes to the hour's wallets." : "The hour's pot goes to the hour's wallets, by points. Trade in the hour, get a slice at the top of it."}</small>
        </div>
      </header>
      <div className="ox-desk-body">
        {trending.isPending ? (
          <div className="ox-desk-skeleton" aria-label="Reading the market"><i /><i /><i /></div>
        ) : trending.isError ? (
          <p className="ox-desk-empty">{missing ? "The board is not served by this API yet. Coins show up once the indexer answers." : "The market could not be read. The API is not answering."}</p>
        ) : rows.length === 0 ? (
          <p className="ox-desk-empty">Nothing is trading yet. The first buy on a curve puts a coin here.</p>
        ) : (
          rows.map((t) => (
            <TokenLine key={t.token} token={t} tag={hot.has(t.token) ? <span className="ox-line-tag hot" title="one of the three biggest 24h moves on the board">hot</span> : undefined} />
          ))
        )}
      </div>
    </section>
  );
}
