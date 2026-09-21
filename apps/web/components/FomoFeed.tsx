"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { api, type ActivityRow } from "@/lib/api";
import { ago, compact, shortAddress } from "@/lib/format";

export function FomoFeed() {
  const feed = useQuery({
    queryKey: ["activity"],
    queryFn: () => api<{ activity: ActivityRow[] }>("/activity?limit=14"),
    refetchInterval: 12_000,
  });

  return (
    <section className="ox-social-panel" aria-labelledby="activity-title">
      <header>
        <div><span className="ox-heading-kicker">Social tape</span><h2 id="activity-title">The market is moving</h2></div>
        <span className="ox-live-small"><i /> live</span>
      </header>
      <div className="ox-fomo-list">
        {(feed.data?.activity ?? []).map((row) => {
          const decimals = row.pair_decimals ?? 18;
          return (
            <Link href={`/token/${row.token}`} key={`${row.tx}-${row.log_index}`} className={`ox-fomo-row ${row.side}`}>
              <span className="ox-fomo-action">{row.side === "buy" ? "BUY" : "SELL"}</span>
              <span><b>{shortAddress(row.trader)}</b><small>{row.side === "buy" ? "aped into" : "sold"} ${row.symbol}</small></span>
              <strong>{compact(BigInt(row.pair_amount || "0"), decimals)} {row.pair_symbol || "ETH"}</strong>
              <time>{ago(row.ts)}</time>
            </Link>
          );
        })}
        {!feed.isLoading && !feed.data?.activity.length ? <p className="ox-empty-line">The first trade will light up this feed.</p> : null}
      </div>
    </section>
  );
}
