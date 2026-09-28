"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useMyLaunches, type LaunchPnl } from "@/components/team/app/useMyLaunches";

/// The funder's results: what its teams paid in their launches against what they hold now, launch
/// by launch, and its referral link. Team value is marked at each token's last traded price, so it
/// is open profit, not banked, and it says so.

const RANGES = [["all", "All-Time", Infinity], ["1y", "1 Year", 365], ["1m", "1 Month", 30], ["7d", "7 Days", 7], ["1d", "1 Day", 1]] as const;

function usdOf(l: LaunchPnl, v: number): number | null {
  return l.usd === null ? null : v * l.usd;
}
function money(v: number): string {
  const s = Math.abs(v) >= 1000 ? `${(Math.abs(v) / 1000).toFixed(2)}K` : Math.abs(v).toFixed(2);
  return `${v < 0 ? "-" : ""}$${s}`;
}

export default function DashboardPage() {
  const { address, launches } = useMyLaunches();
  const [range, setRange] = useState<(typeof RANGES)[number][0]>("all");
  const [copied, setCopied] = useState(false);
  const refer = useQuery({
    queryKey: ["refer", address],
    queryFn: () => api<{ friends: number; points: number }>(`/refer/${address}`),
    enabled: Boolean(address),
  });

  const days = RANGES.find((r) => r[0] === range)![2];
  const since = Date.now() - days * 86_400_000;
  const inRange = launches.filter((l) => new Date(l.row.launched_at).getTime() >= since)
    .sort((a, b) => +new Date(a.row.launched_at) - +new Date(b.row.launched_at));
  const pnl = inRange.map((l) => ({ l, usd: usdOf(l, l.value - l.spent) ?? 0 }));
  const total = pnl.reduce((s, p) => s + p.usd, 0);
  const cumulative = useMemo(() => pnl.reduce<number[]>((acc, p) => [...acc, (acc.at(-1) ?? 0) + p.usd], []), [pnl]);
  const link = address && typeof window !== "undefined" ? `${window.location.origin}/?ref=${address}` : "";

  return (
    <div className="tapp-page td">
      <div className="td-top">
        <div className="td-range" role="tablist">
          {RANGES.map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={range === k} className={range === k ? "on" : ""} onClick={() => setRange(k)}>{label}</button>
          ))}
        </div>
      </div>

      <div className="td-tiles">
        <div className="td-tile"><small>Team P&amp;L <em>open</em></small><strong className={total >= 0 ? "" : "bad"}>{money(total)}</strong></div>
        <div className="td-tile"><small>Total Launch</small><strong>{inRange.length}</strong></div>
        <div className="td-tile"><small>Referred wallets</small><strong>{refer.data?.friends ?? 0}</strong></div>
        <div className="td-tile"><small>Referral points</small><strong>{(refer.data?.points ?? 0).toLocaleString("en-US")}</strong></div>
      </div>

      <div className="td-charts">
        <div className="td-chart">
          <p>Cumulative P&amp;L</p>
          {inRange.length ? <Area values={cumulative} /> : <div className="td-none">{address ? "No launches found." : "Connect the funder wallet."}</div>}
        </div>
        <div className="td-chart">
          <p>P&amp;L by launch</p>
          {inRange.length ? <Bars items={pnl.map((p) => ({ label: `$${p.l.row.symbol}`, v: p.usd }))} /> : <div className="td-none">No launches found.</div>}
        </div>
      </div>

      <div className="td-divider"><span>Referral program</span></div>
      <div className="td-ref">
        <div className="td-chart">
          <p>Your link</p>
          {address ? (
            <div className="td-link">
              <code>{link}</code>
              <button type="button" className="tw-btn ghost sm" onClick={async () => {
                try { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard is optional */ }
              }}>{copied ? "Copied" : "Copy"}</button>
            </div>
          ) : <div className="td-none">Connect the funder wallet.</div>}
          <small className="dim">A wallet that arrives through it is tied to you, and its trades earn you season points.</small>
        </div>
        <div className="td-chart">
          <p>Launches in range</p>
          {inRange.length === 0 && <div className="td-none">No launches found.</div>}
          {[...inRange].reverse().map((l) => {
            const sym = l.row.pair_symbol ?? "ETH";
            return (
              <div key={l.row.token} className="td-line">
                <b>${l.row.symbol}</b>
                <span className="mono dim">{l.spent.toFixed(4)} → {l.value.toFixed(4)} {sym}</span>
                <span className={`mono ${l.value >= l.spent ? "good" : "bad"}`}>{money(usdOf(l, l.value - l.spent) ?? 0)}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Area({ values }: { values: number[] }) {
  const pts = [0, ...values];
  const min = Math.min(0, ...pts), max = Math.max(0, ...pts);
  const span = max - min || 1;
  const x = (i: number) => (i / Math.max(1, pts.length - 1)) * 100;
  const y = (v: number) => 95 - ((v - min) / span) * 85;
  const line = pts.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(" ");
  return (
    <svg className="td-svg" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Cumulative profit and loss">
      <path d={`${line} L100,${y(0)} L0,${y(0)} Z`} className="td-area" />
      <path d={line} className="td-line-path" vectorEffect="non-scaling-stroke" />
      <line x1="0" x2="100" y1={y(0)} y2={y(0)} className="td-zero" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Bars({ items }: { items: { label: string; v: number }[] }) {
  const max = Math.max(1e-9, ...items.map((i) => Math.abs(i.v)));
  return (
    <div className="td-bars">
      {items.map((i, k) => (
        <div key={k} className="td-bar" title={`${i.label}: ${money(i.v)}`}>
          <i className={i.v >= 0 ? "up" : "down"} style={{ height: `${(Math.abs(i.v) / max) * 100}%` }} />
          <small>{i.label}</small>
        </div>
      ))}
    </div>
  );
}
