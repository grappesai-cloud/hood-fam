"use client";

import { fmt } from "@/lib/format";
import { Figure } from "@/components/Provenance";
import { assetDecimals, assetSymbol, type AssetRef } from "./VaultEarnings";

/// `GET /portfolio/:address` -> `payday`: one row per hour this wallet was paid, and
/// `payday_total`: the same summed per asset.
export interface PaydayRow extends AssetRef { epoch: number | string; amount: string }
export interface PaydayTotal extends AssetRef { amount: string }

/// The bounty points as the API sends them. The route says "points of kind bounty" and nothing
/// more, so a number, a total, or the rows themselves are all read.
export function bountyPoints(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") return Number.isFinite(Number(raw)) ? Number(raw) : null;
  if (Array.isArray(raw)) return raw.reduce<number>((sum, row) => sum + (Number((row as { points?: unknown })?.points ?? 1) || 0), 0);
  if (typeof raw === "object") {
    const o = raw as { points?: unknown; total?: unknown; count?: unknown };
    const v = o.points ?? o.total ?? o.count;
    return typeof v === "number" ? v : Number.isFinite(Number(v)) ? Number(v) : null;
  }
  return null;
}

/// An hour epoch as the wall clock says it: the hour it started, in the reader's zone.
function hourLabel(epoch: number | string): string {
  const start = new Date(Number(epoch) * 3_600_000);
  if (Number.isNaN(start.getTime())) return `hour ${epoch}`;
  return start.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric" });
}

export function PaydayWins({ payday, totals, bounties }: {
  payday: PaydayRow[] | undefined;
  totals: PaydayTotal[] | undefined;
  bounties: unknown;
}) {
  const points = bountyPoints(bounties);
  const recent = [...(payday ?? [])].sort((a, b) => Number(b.epoch) - Number(a.epoch)).slice(0, 12);

  return (
    <section className="panel portfolio-section p-5">
      <div className="panel-head"><span className="n">04 / PAYDAY</span><h2>Payday wins</h2><span className="hatch" aria-hidden="true" /></div>
      <p className="mb-4 text-sm dim">
        Every hour the Bag pays the hour&apos;s pot to the wallets that earned points in that hour. You trade, you earn points; you hold a token when a bot pays a penalty, you earn a bounty point; the hour ends, you get paid.
      </p>
      <div className="earn-grid">
        {totals === undefined ? (
          <Figure label="won at Payday" kind="measured" value={null} reason="the indexer does not report Payday yet" />
        ) : totals.length === 0 ? (
          <Figure label="won at Payday" kind="measured" value="0" />
        ) : totals.map((t) => (
          <Figure key={t.asset} label={`won at Payday, ${assetSymbol(t)}`} kind="measured"
            value={`${fmt(BigInt(t.amount || "0"), assetDecimals(t), 6)} ${assetSymbol(t)}`} />
        ))}
        <Figure label="bounty points" kind="measured" value={points == null ? null : Math.round(points).toLocaleString()}
          reason="the indexer does not report bounty points yet" />
      </div>
      {recent.length > 0 && (
        <div className="rows mt-4">
          {recent.map((r) => (
            <div className="row earnings-row" key={`${r.epoch}-${r.asset}`}>
              <span className="row-name"><strong>{hourLabel(r.epoch)}</strong><span>hour {String(r.epoch)}</span></span>
              <span className="row-num"><strong>{fmt(BigInt(r.amount || "0"), assetDecimals(r), 6)} {assetSymbol(r)}</strong><span>paid to your wallet</span></span>
            </div>
          ))}
        </div>
      )}
      {payday !== undefined && payday.length === 0 && (
        <p className="empty-inline">No Payday yet. Points in an hour put you on that hour&apos;s list.</p>
      )}
    </section>
  );
}
