"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type TopTraderRow } from "@/lib/api";
import { shortAddress } from "@/lib/format";

const WINDOWS = ["24h", "7d", "30d", "all"] as const;
/// Three ways to be at the top, and they are not the same question. Volume is who is loudest, net
/// flow is who has taken more out than they put in, and profit is the only one that knows what a
/// position cost. Profit is all-time by construction, so picking it takes the window away.
const SORTS = [
  { key: "volume" as const, label: "Volume" },
  { key: "net" as const, label: "Net flow" },
  { key: "pnl" as const, label: "Profit" },
];

export function TopTraders() {
  const [window, setWindow] = useState<(typeof WINDOWS)[number]>("7d");
  const [sort, setSort] = useState<"volume" | "net" | "pnl">("volume");
  const board = useQuery({
    queryKey: ["top-traders", window, sort],
    queryFn: () => api<{ traders: TopTraderRow[] }>(`/top-traders?window=${window}&sort=${sort}&limit=8`),
    refetchInterval: 20_000,
  });

  return (
    <section className="ox-social-panel" aria-labelledby="traders-title">
      <header>
        <div><span className="ox-heading-kicker">Leaderboard</span><h2 id="traders-title">Top traders</h2></div>
        <div className="ox-trader-controls">
          <div>{SORTS.map((item) => (
            <button key={item.key} className={sort === item.key ? "active" : ""} onClick={() => setSort(item.key)}>{item.label}</button>
          ))}</div>
          {sort !== "pnl" && (
            <div>{WINDOWS.map((item) => <button key={item} className={window === item ? "active" : ""} onClick={() => setWindow(item)}>{item === "all" ? "All" : item.toUpperCase()}</button>)}</div>
          )}
        </div>
      </header>
      <ol className="ox-trader-list">
        {(board.data?.traders ?? []).map((row, index) => {
          const amount = Number(sort === "pnl" ? (row.totalUsd ?? 0) : sort === "net" ? row.net_usd : row.volume_usd);
          return (
            <li key={row.address}>
              <span className="ox-trader-rank">{index + 1}</span>
              <span className="ox-trader-avatar">{row.address.slice(2, 4).toUpperCase()}</span>
              <span>
                <b><a href={`/trader/${row.address}`}>{shortAddress(row.address)}</a></b>
                <small>{sort === "pnl"
                  ? `${Math.round(row.realizedUsd ?? 0).toLocaleString("en-US")} banked`
                  : `${row.trades} trades`}</small>
              </span>
              <strong className={amount >= 0 ? "positive" : "negative"}>{amount >= 0 ? "+" : "−"}${Math.abs(amount).toLocaleString(undefined, { maximumFractionDigits: 0 })}</strong>
            </li>
          );
        })}
        {!board.isLoading && !board.data?.traders.length ? <li className="ox-empty-line">Rankings start with the first indexed trade.</li> : null}
      </ol>
      {sort === "net" ? <p className="ox-board-note">Net flow is sells minus buys in the selected window, not profit: it does not know what a position cost.</p> : null}
      {sort === "pnl" ? <p className="ox-board-note">Profit is banked plus still open, marked at the last traded price, from trades on this pad. All-time, because realised profit does not belong to a window.</p> : null}
    </section>
  );
}
