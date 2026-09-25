"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";

import { api, type LedgerPairTotal, type LedgerResponse, type LedgerRow } from "@/lib/api";
import { EXPLORER } from "@/lib/config";
import { ago, compact, fmt, pairDecimals, pairSymbol, shortAddress } from "@/lib/format";
import { useLive } from "@/lib/live";
import { Prov, ProvenanceKey, usdCompact } from "@/components/Provenance";

/// The receipts. A split on the launch wizard is a promise about where the fee goes; this page is
/// every time it went there, off the chain's own events, with the transaction that did it. Totals
/// are per pair, because ether, dollars and shares do not add; dollars sit on top for the pairs that
/// have a price, and the pairs that have none are named rather than counted as zero.

const KIND_LABEL: Record<LedgerRow["kind"], string> = {
  flushed: "pushed along the split",
  swept: "swept by the splitter",
  protocol_claimed: "protocol share claimed",
  creator_claimed: "creator claimed",
  bought_back: "bought back and burned",
  referral_paid: "referral paid from the protocol's share",
};

export default function LedgerPage() {
  return (
    <Suspense fallback={<div className="ledger-shell"><p className="panel text-sm dim">Reading the ledger…</p></div>}>
      <Ledger />
    </Suspense>
  );
}

function Ledger() {
  const params = useSearchParams();
  const token = params.get("token")?.toLowerCase() ?? null;
  const [pages, setPages] = useState<number[]>([]);

  useLive(token ? { tokens: [token] } : {});

  const query = (before: number | null) =>
    `/ledger?limit=60${token ? `&token=${token}` : ""}${before ? `&before=${before}` : ""}`;
  const first = useQuery({
    queryKey: ["ledger", token ?? "all"],
    queryFn: () => api<LedgerResponse>(query(null)),
    refetchInterval: 30_000,
  });
  const rest = useQuery({
    queryKey: ["ledger-more", token ?? "all", pages.join(",")],
    queryFn: async () => {
      const out: LedgerRow[] = [];
      for (const before of pages) out.push(...(await api<LedgerResponse>(query(before))).rows);
      return out;
    },
    enabled: pages.length > 0,
  });

  const rows = [...(first.data?.rows ?? []), ...(rest.data ?? [])];
  const last = rows[rows.length - 1];
  const more = first.data?.nextBefore != null && last && (rest.data?.length ?? 0) % 60 === 0 && rows.length % 60 === 0;
  const totals = first.data?.totals;
  const distributions = totals?.pairs.reduce((n, p) => n + Number(p.distributions), 0);
  const filtered = token ? rows.find((r) => r.token === token) ?? null : null;

  return (
    <div className="ledger-shell">
      <div className="page-head">
        <header className="page-intro">
          <div className="section-kicker">Receipts</div>
          <h1>Ledger</h1>
          <p>
            Every payout this pad ever made, as the chain recorded it. A split on the launch wizard is
            a promise about where the fee goes; these are the times it went there, each with the
            transaction that did it.
          </p>
        </header>
        <div className="head-figure">
          <strong>{distributions == null ? "·" : distributions.toLocaleString("en-US")}</strong>
          <span>payouts <Prov kind="measured" /></span>
        </div>
      </div>

      {token && (
        <div className="ledger-filter">
          <span>Showing {filtered ? <Link href={`/token/${token}`}>${filtered.symbol}</Link> : shortAddress(token)} only.</span>
          <Link className="btn btn-ghost" href="/ledger">Every launch</Link>
        </div>
      )}

      {totals && (
        <section className="panel">
          <header className="refer-head">
            <h2>Where it went</h2>
            <span className="dim text-sm">per pair, since the first flush</span>
          </header>
          {totals.pairs.length === 0 ? (
            <p className="dim text-sm">Nothing has been paid out yet. The first flush writes the first line.</p>
          ) : (
            <div className="ledger-totals">
              {totals.pairs.map((p) => <PairTotal key={p.pair_token} total={p} />)}
            </div>
          )}
          <div className="ledger-usd mt-4">
            {totals.usd.total != null
              ? <><strong>{usdCompact(totals.usd.total)}</strong><span className="dim text-sm">in dollars <Prov kind="derived" /></span></>
              : <><strong className="figure-dash">—</strong><span className="dim text-sm">in dollars</span></>}
            {totals.usd.reason && <span className="figure-reason">{totals.usd.reason}</span>}
          </div>
        </section>
      )}

      <section className="panel">
        <header className="refer-head">
          <h2>Every payout</h2>
          <span className="dim text-sm">newest first <Prov kind="measured" /></span>
        </header>
        <ul className="ledger-list">
          {rows.map((row) => <Row key={row.id} row={row} />)}
          {first.isSuccess && rows.length === 0 && (
            <li className="feed-empty dim">Nothing yet. A payout appears here the moment its transaction is indexed.</li>
          )}
          {first.isError && <li className="feed-empty dim">The ledger could not be read. The API is not answering.</li>}
        </ul>
        {more && (
          <button className="btn btn-ghost mt-3" onClick={() => setPages((p) => [...p, last.id])} disabled={rest.isFetching}>
            {rest.isFetching ? "Reading…" : "Older payouts"}
          </button>
        )}
      </section>

      <ProvenanceKey />
    </div>
  );
}

function PairTotal({ total }: { total: LedgerPairTotal }) {
  const dec = pairDecimals(total.pair_token, total);
  const sym = pairSymbol(total.pair_token, total);
  const leg = (label: string, value: string) =>
    BigInt(value || "0") > 0n ? [<span key={`${label}-l`}>{label}</span>, <span key={`${label}-v`}>{fmt(BigInt(value), dec, 4)}</span>] : null;
  return (
    <div className="ledger-pair">
      <div>
        <strong>{compact(BigInt(total.distributed || "0"), dec)} {sym}</strong>
        <div className="dim text-xs">
          {Number(total.distributions).toLocaleString("en-US")} payouts on {total.tokens} {Number(total.tokens) === 1 ? "launch" : "launches"} <Prov kind="measured" />
        </div>
      </div>
      <div className="ledger-pair-legs">
        {leg("to lockers", total.to_stakers)}
        {leg("to buybacks", total.to_buyback)}
        {leg("to liquidity", total.to_liquidity)}
        {leg("to creators", total.to_creator)}
        {leg("to holders", total.to_dividends)}
        {leg("to the protocol", total.to_protocol)}
        {leg("to referrers", total.to_referrers)}
      </div>
      <div className="dim text-xs">
        {total.distributedUsd != null
          ? <>{usdCompact(total.distributedUsd)} <Prov kind={total.usd.source === "feed" || total.usd.source === "resolver" ? "reported" : "derived"} /></>
          : <><span className="figure-dash">—</span> {total.usd.reason ?? "no dollar price for this pair"}</>}
      </div>
    </div>
  );
}

function Row({ row }: { row: LedgerRow }) {
  const dec = pairDecimals(row.pair_token, row);
  const sym = pairSymbol(row.pair_token, row);
  const legs: [string, string | null][] = row.kind === "flushed" || row.kind === "swept"
    ? [
        ["lockers", row.to_stakers], ["buyback", row.to_buyback], ["liquidity", row.to_liquidity],
        ["creator", row.to_creator], ["holders", row.kind === "swept" ? row.result : null],
      ]
    : [];
  return (
    <li>
      <span className="ledger-when" title={new Date(row.ts).toLocaleString()}>{ago(row.ts)} ago</span>
      <div className="ledger-what">
        <Link href={`/token/${row.token}`}>${row.symbol}</Link>
        <span>{KIND_LABEL[row.kind]}</span>
      </div>
      <div className="ledger-legs">
        <b>{fmt(BigInt(row.amount || "0"), dec, 5)} {sym}</b>
        {legs.filter(([, v]) => v && BigInt(v) > 0n).map(([label, v]) => (
          <span key={label}>{label} <b>{fmt(BigInt(v!), dec, 5)}</b></span>
        ))}
        {row.kind === "referral_paid" && row.recipient && <span>to <b><Link href={`/trader/${row.recipient}`}>{shortAddress(row.recipient)}</Link></b></span>}
        {row.kind === "bought_back" && BigInt(row.result || "0") > 0n && <span>burned <b>{compact(BigInt(row.result))}</b></span>}
        {row.kind === "flushed" && BigInt(row.result || "0") > 0n && <span>burned <b>{compact(BigInt(row.result))}</b></span>}
      </div>
      <a className="ledger-tx" href={`${EXPLORER}/tx/${row.tx}`} target="_blank" rel="noreferrer">{row.tx.slice(0, 10)}… ↗</a>
    </li>
  );
}
