"use client";

import { ago, compact, fmt } from "@/lib/format";
import { Prov } from "@/components/Provenance";
import { assetOf, big, type BagBurn } from "@/lib/bag";

/// The burn clock: every hour it buys the house coin with its share and burns it, impact-capped.
/// Until the coin launches there is nothing to buy, and the share waits in the Bag, which is a
/// fact the panel says rather than a zero it draws.

export function BurnClock({ burn, missing }: { burn: BagBurn | null | undefined; missing: boolean }) {
  const waiting = (burn?.waiting ?? []).filter((w) => big(w.amount) > 0n);
  const last = burn?.last ?? null;
  const burned = big(burn?.totalBurned);
  const coinSet = Boolean(burn?.houseCoin);

  return (
    <section className="panel bag-card">
      <header className="refer-head">
        <h2>Burn clock</h2>
        <span className="dim text-sm">every hour, impact-capped</span>
      </header>
      <div className="bag-clock">
        <strong className="mono">
          {missing || !burn
            ? <span className="figure-dash" title="the API does not serve the Bag yet">—</span>
            : burned > 0n ? compact(burned) : <span className="figure-dash" title="nothing has been burned yet">—</span>}
        </strong>
        <span>of the house coin burned so far <Prov kind="measured" /></span>
      </div>
      {!missing && burn && burned === 0n && (
        <p className="bag-reason">
          {coinSet ? "Nothing has been burned yet. The first hour with a balance buys and burns." : "The house coin has not launched. The burn share waits in the Bag until it exists, and the clock starts then."}
        </p>
      )}
      <div className="bag-rows">
        <div>
          <span>waiting to be spent</span>
          <span className="mono">
            {waiting.length === 0
              ? <span className="figure-dash" title="nothing is waiting">—</span>
              : waiting.map((w) => {
                  const { symbol, decimals } = assetOf(w.asset, w);
                  return <span key={w.asset} className="bag-amount">{fmt(big(w.amount), decimals, decimals >= 18 ? 4 : 2)} {symbol}</span>;
                })}
            {" "}<Prov kind="measured" />
          </span>
        </div>
        <div>
          <span>last burn</span>
          <span className="mono">
            {last
              ? (() => {
                  const { symbol, decimals } = assetOf(last.asset);
                  return <>bought and burned {compact(big(last.coinBurned))} with {fmt(big(last.spent), decimals, decimals >= 18 ? 4 : 2)} {symbol}, {ago(last.ts)} ago <Prov kind="measured" /></>;
                })()
              : <span className="figure-dash" title="no burn yet">—</span>}
          </span>
        </div>
      </div>
      <p className="bag-fine">77% of every graduation fee buys the house coin and burns it, and so does a quarter of every house-coin trade, through its own buyback. The buy is capped by price impact, so a thin hour does not move the pool.</p>
    </section>
  );
}
