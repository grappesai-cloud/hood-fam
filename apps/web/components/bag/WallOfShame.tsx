"use client";

import Link from "next/link";
import { ago, fmt, shortAddress } from "@/lib/format";
import { Prov, usdCompact } from "@/components/Provenance";
import { assetOf, big, isMissing, useShame, type ShameRow } from "@/lib/bag";

/// The wall of shame: every wallet that paid a penalty, how many times, and what it cost them.
/// Display only. The holders who were there when a bot paid got season points for it, which is
/// the bounty the doc names.

export function WallOfShame({ limit = 50 }: { limit?: number }) {
  const shame = useShame(limit);
  const rows = shame.data?.rows ?? [];
  const missing = shame.isError && isMissing(shame.error);

  return (
    <section className="panel">
      <header className="refer-head">
        <h2>Wall of shame</h2>
        <span className="dim text-sm">who paid the penalties <Prov kind="measured" /></span>
      </header>
      {shame.isPending && <p className="dim text-sm">Reading the wall…</p>}
      {shame.isError && (
        <p className="dim text-sm">
          {missing ? "The wall is not wired into this API yet. It fills once the indexer serves the penalties." : "The wall could not be read. The API is not answering."}
        </p>
      )}
      {shame.isSuccess && rows.length === 0 && (
        <p className="dim text-sm">Nobody has paid a penalty yet. The first sniper writes the first line, and the holders who were there get the bounty.</p>
      )}
      {rows.length > 0 && (
        <ol className="shame-list">
          <li className="shame-head" aria-hidden="true">
            <span>payer</span><span>paid</span><span>kinds</span><span>in dollars</span><span>last</span>
          </li>
          {rows.map((row) => <Row key={row.payer} row={row} />)}
        </ol>
      )}
    </section>
  );
}

function Row({ row }: { row: ShameRow }) {
  const kinds = [
    row.snipe > 0 ? `${row.snipe} ${row.snipe === 1 ? "snipe" : "snipes"}` : null,
    row.jeet > 0 ? `${row.jeet} ${row.jeet === 1 ? "jeet" : "jeets"}` : null,
    row.whale > 0 ? `${row.whale} ${row.whale === 1 ? "dump" : "dumps"}` : null,
  ].filter(Boolean).join(", ");
  return (
    <li>
      <span className="shame-payer">
        <Link href={`/trader/${row.payer}`}>{shortAddress(row.payer)}</Link>
        <small className="dim">{row.count} {row.count === 1 ? "penalty" : "penalties"} on {row.tokens} {row.tokens === 1 ? "launch" : "launches"}</small>
      </span>
      <span className="shame-paid mono">
        {row.paid.filter((p) => big(p.amount) > 0n).map((p) => {
          const { symbol, decimals } = assetOf(p.asset, p);
          return <span key={p.asset}>{fmt(big(p.amount), decimals, decimals >= 18 ? 4 : 2)} {symbol}</span>;
        })}
      </span>
      <span className="shame-kinds dim">{kinds || "penalties"}</span>
      <span className="shame-usd mono">
        {row.usd != null ? <>{usdCompact(row.usd)} <Prov kind="derived" /></> : <span className="figure-dash" title="no dollar price for what they paid">—</span>}
      </span>
      <span className="shame-when dim" title={new Date(row.last_ts).toLocaleString()}>{ago(row.last_ts)} ago</span>
    </li>
  );
}
