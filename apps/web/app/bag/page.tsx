"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { shortAddress } from "@/lib/format";
import { useLive } from "@/lib/live";
import { isMissing, TAPE_FILTERS, useBag } from "@/lib/bag";
import { Prov, ProvenanceKey, usdCompact } from "@/components/Provenance";
import { MoneyTape } from "@/components/MoneyTape";
import { BagTotals } from "@/components/bag/BagTotals";
import { PaydayClock } from "@/components/bag/PaydayClock";
import { BurnClock } from "@/components/bag/BurnClock";
import { BoostSlots } from "@/components/bag/BoostSlots";
import { Addresses } from "@/components/bag/Addresses";
import { WallOfShame } from "@/components/bag/WallOfShame";

/// The Bag: what every machine pays into, and where it goes. The totals are read off the Bag's
/// own events per asset, the contracts sit next to them, and the tape is every line the money
/// wrote. A figure that cannot be computed honestly is a dash with its reason, never a zero.

export default function BagPage() {
  return (
    <Suspense fallback={<div className="bag-shell"><p className="panel text-sm dim">Reading the Bag…</p></div>}>
      <Bag />
    </Suspense>
  );
}

function Bag() {
  const params = useSearchParams();
  const token = params.get("token")?.toLowerCase() ?? null;
  const initial = TAPE_FILTERS.find((f) => f.id === params.get("kind"))?.id ?? "all";
  const [filter, setFilter] = useState(initial);
  const kinds = TAPE_FILTERS.find((f) => f.id === filter)?.kinds ?? null;

  useLive();
  const bag = useBag();
  const missing = bag.isError && isMissing(bag.error);
  const data = bag.data ?? null;
  const totals = data?.totals ?? [];
  const priced = totals.filter((t) => t.usd);
  const usdIn = priced.length ? priced.reduce((n, t) => n + t.usd!.in, 0) : null;
  const unpriced = totals.find((t) => !t.usd)?.usdReason ?? null;

  return (
    <div className="bag-shell">
      <div className="page-head">
        <header className="page-intro">
          <div className="section-kicker">The Bag</div>
          <h1>The Bag</h1>
          <p>
            Every trade on every machine pays 1%. 30 bps go to the creator, 70 bps go into the Bag,
            and the Bag splits them four ways with the house paid first: the Vault, Payday, the burn
            clock, the house. Nobody owns it and nothing can be withdrawn from it. These are its
            totals as the chain recorded them.
          </p>
        </header>
        <div className="head-figure">
          <strong>{usdIn != null ? usdCompact(usdIn) : <span className="figure-dash">—</span>}</strong>
          <span>came in, in dollars <Prov kind="derived" /></span>
          {usdIn == null && (
            <small className="figure-reason">
              {bag.isPending ? "reading the Bag" : missing ? "the API does not serve the Bag yet" : bag.isError ? "the API is not answering" : totals.length === 0 ? "nothing has come in yet" : unpriced ?? "no dollar price for these assets"}
            </small>
          )}
        </div>
      </div>

      <section className="panel">
        <header className="refer-head">
          <h2>Where it went</h2>
          <span className="dim text-sm">per asset, since the first trade <Prov kind="measured" /></span>
        </header>
        {bag.isPending && <p className="dim text-sm">Reading the Bag…</p>}
        {bag.isError && (
          <p className="dim text-sm">
            {missing ? "The Bag is not wired into this API yet. The totals appear once the indexer serves it." : "The Bag could not be read. The API is not answering."}
          </p>
        )}
        {bag.isSuccess && <BagTotals totals={totals} />}
      </section>

      <div className="bag-grid">
        <PaydayClock payday={data?.payday} missing={missing} />
        <BurnClock burn={data?.burn} missing={missing} />
        <BoostSlots boosts={data?.boosts} missing={missing} />
      </div>

      <Addresses addresses={data?.addresses} missing={missing} />

      <section className="panel">
        <header className="refer-head">
          <h2>The tape</h2>
          <span className="dim text-sm">every line the money wrote, newest first <Prov kind="measured" /></span>
        </header>
        {token && (
          <div className="ledger-filter">
            <span>Showing <Link href={`/token/${token}`}>{shortAddress(token)}</Link> only.</span>
            <Link className="btn btn-ghost" href={`/bag${filter !== "all" ? `?kind=${filter}` : ""}`}>Every launch</Link>
          </div>
        )}
        <div className="sort-tabs bag-kinds" role="tablist" aria-label="Which lines to show">
          {TAPE_FILTERS.map((f) => (
            <button key={f.id} type="button" role="tab" aria-selected={filter === f.id} className={filter === f.id ? "sort-tab active" : "sort-tab"} onClick={() => setFilter(f.id)}>
              {f.label}
            </button>
          ))}
        </div>
        <MoneyTape token={token} kinds={kinds} limit={60} />
      </section>

      <WallOfShame />

      <ProvenanceKey />
    </div>
  );
}
