"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type TopTraderRow } from "@/lib/api";
import { shortAddress } from "@/lib/format";

const WINDOWS = ["24h", "7d", "30d", "all"] as const;

export function TopTraders() {
  const [window, setWindow] = useState<(typeof WINDOWS)[number]>("7d");
  const [sort, setSort] = useState<"volume" | "net">("volume");
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
          <button onClick={() => setSort(sort === "volume" ? "net" : "volume")}>{sort === "volume" ? "Volume" : "Net flow"}⌄</button>
          <div>{WINDOWS.map((item) => <button key={item} className={window === item ? "active" : ""} onClick={() => setWindow(item)}>{item === "all" ? "All" : item.toUpperCase()}</button>)}</div>
        </div>
      </header>
      <ol className="ox-trader-list">
        {(board.data?.traders ?? []).map((row, index) => {
          const amount = Number(sort === "net" ? row.net_usd : row.volume_usd);
          return (
            <li key={row.address}>
              <span className="ox-trader-rank">{index + 1}</span>
              <span className="ox-trader-avatar">{row.address.slice(2, 4).toUpperCase()}</span>
              <span><b>{shortAddress(row.address)}</b><small>{row.trades} trades</small></span>
              <strong className={amount >= 0 ? "positive" : "negative"}>{amount >= 0 ? "+" : "−"}${Math.abs(amount).toLocaleString(undefined, { maximumFractionDigits: 0 })}</strong>
            </li>
          );
        })}
        {!board.isLoading && !board.data?.traders.length ? <li className="ox-empty-line">Rankings start with the first indexed trade.</li> : null}
      </ol>
      {sort === "net" ? <p className="ox-board-note">Net flow is sells minus buys in the selected window, not unrealised P&amp;L.</p> : null}
    </section>
  );
}
