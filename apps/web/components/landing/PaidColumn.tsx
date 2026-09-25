"use client";

import { Prov, usdCompact } from "@/components/Provenance";
import { MoneyTape } from "@/components/MoneyTape";
import { fmt } from "@/lib/format";
import { assetOf, big, isMissing, PAID_KINDS, usePaid } from "@/lib/bag";

/// Column one: every line where money reached people, newest first, live over the stream, with the
/// day's total on top. The tape is the Bag's own tape cut down to the paying kinds (MoneyTape lays
/// the stream over it and lights a line that lands while somebody is watching); the total is
/// `GET /paid?days=1`, a dash with its reason until the API serves it.

export function PaidColumn({ className }: { className?: string }) {
  const paid = usePaid(1);
  const missing = paid.isError && isMissing(paid.error);
  const totals = (paid.data?.totals ?? []).filter((t) => big(t.amount) > 0n);
  const usd = paid.data?.usd ?? null;
  const amounts = totals.map((t) => {
    const { symbol, decimals } = assetOf(t.asset, t);
    return `${fmt(big(t.amount), decimals, decimals >= 18 ? 4 : 2)} ${symbol}`;
  });
  const reason = paid.isPending ? "reading today's payouts"
    : missing ? "the API does not serve /paid yet"
    : paid.isError ? "the API is not answering"
    : totals.length === 0 ? "nobody has been paid today yet"
    : null;
  const count = paid.data && totals.length
    ? `${paid.data.wallets.toLocaleString("en-US")} wallet${paid.data.wallets === 1 ? "" : "s"}, ${paid.data.events.toLocaleString("en-US")} event${paid.data.events === 1 ? "" : "s"}`
    : null;

  return (
    <section className={className ? `ox-desk-col ${className}` : "ox-desk-col"} aria-labelledby="desk-paid-title">
      <header className="ox-desk-head">
        <div className="ox-desk-title">
          <span className="ox-desk-kicker">Paid out, live</span>
          <h2 id="desk-paid-title">Paid to people today</h2>
        </div>
        <div className="ox-desk-figure">
          {usd != null ? (
            <strong className="mono">{usdCompact(usd)} <Prov kind="derived" /></strong>
          ) : totals.length ? (
            <strong className="mono">{amounts.map((a) => <span key={a}>{a}</span>)} <Prov kind="measured" /></strong>
          ) : (
            <strong className="mono"><span className="figure-dash" title={reason ?? undefined}>—</span></strong>
          )}
          <small>
            {count
              ? `${count}${usd != null ? `, ${amounts.join(", ")}` : `, ${paid.data?.usdReason ?? "no dollar price for these assets"}`}`
              : reason}
          </small>
        </div>
      </header>
      <div className="ox-desk-body">
        <MoneyTape kinds={PAID_KINDS} limit={40} pages={false} empty="Nobody has been paid yet. The first trade on the new machine starts the tape." />
      </div>
    </section>
  );
}
