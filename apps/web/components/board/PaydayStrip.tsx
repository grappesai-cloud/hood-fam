"use client";

import { useEffect, useState } from "react";
import { assetOf, big, isMissing, useBag } from "@/lib/bag";
import { fmt } from "@/lib/format";
import { Prov } from "@/components/Provenance";

/// Payday, on the board: how long until the hour closes, what the hour's pot holds per asset, and
/// the one rule a reader needs (the last ten launches share a tenth of it). The clock is the wall
/// clock, because the epoch is `timestamp / 1 hours` on chain and needs no read; the pot is the
/// indexer's sum of Funded events, and is a dash with the reason until the API serves it.

function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export function PaydayStrip() {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() / 1000), 1_000);
    return () => clearInterval(t);
  }, []);
  const bag = useBag();
  const payday = bag.data?.payday;
  const endsAt = payday?.endsAt ? new Date(payday.endsAt).getTime() / 1000 : NaN;
  const left = (Number.isFinite(endsAt) && endsAt > now ? endsAt : (Math.floor(now / 3600) + 1) * 3600) - now;

  const pots = (payday?.pot ?? [])
    .map((p) => ({ ...assetOf(p.asset, p), amount: big(p.funded) + big(p.carried) }))
    .filter((p) => p.amount > 0n);
  const last = payday?.last ?? null;
  const lastUnit = last ? assetOf(last.asset ?? null, last) : null;

  return (
    <div className="payday-strip" aria-label="Payday">
      <div className="payday-clock-wrap">
        <span className="payday-kicker">Payday</span>
        <strong className="payday-clock mono">{clock(left)}</strong>
        <span className="payday-sub">to the hour</span>
      </div>
      <div className="payday-pot">
        {bag.isError ? (
          <span className="payday-dash">
            <span className="figure-dash">—</span>{" "}
            {isMissing(bag.error) ? "the hour's pot is not indexed on this deployment yet" : "the indexer did not answer"}
          </span>
        ) : !bag.data ? (
          <span className="payday-dash"><span className="figure-dash">—</span> reading the hour's pot</span>
        ) : pots.length === 0 ? (
          <span className="payday-dash">nothing in the pot yet this hour <Prov kind="measured" /></span>
        ) : (
          <span className="payday-amounts">
            {pots.map((p, i) => (
              <b key={p.symbol + i} className="mono">{fmt(p.amount, p.decimals, 4)} {p.symbol}</b>
            ))}
            <span className="payday-sub">in the pot <Prov kind="measured" /></span>
          </span>
        )}
      </div>
      <p className="payday-rule">
        The hour's pot goes to the hour's wallets, by points. The last ten launches share a tenth of it.
        {last && lastUnit && (
          <> Last hour paid <b className="mono">{fmt(big(last.toWallets), lastUnit.decimals, 4)} {lastUnit.symbol}</b> to {last.wallets} wallet{last.wallets === 1 ? "" : "s"}.</>
        )}
      </p>
    </div>
  );
}
