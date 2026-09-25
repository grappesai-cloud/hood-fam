"use client";

import { fmt, compact } from "@/lib/format";
import { Prov, usdCompact } from "@/components/Provenance";
import { big, type BagTotal } from "@/lib/bag";

/// The four outlets per asset, off the Bag's own events. Ether, dollars and shares do not add, so
/// each asset is its own card; dollars sit on top only for the assets that have a price, and the
/// ones that have none say why instead of counting as zero.

export function BagTotals({ totals }: { totals: BagTotal[] }) {
  if (totals.length === 0) {
    return <p className="dim text-sm">Nothing has entered the Bag yet. The first trade on the new machine fills it.</p>;
  }
  return (
    <div className="bag-totals">
      {totals.map((t) => <AssetTotal key={t.asset} total={t} />)}
    </div>
  );
}

function AssetTotal({ total }: { total: BagTotal }) {
  const dec = total.decimals ?? 18;
  const digits = dec >= 18 ? 4 : 2;
  const leg = (label: string, value: string | undefined) => {
    const n = big(value);
    return n > 0n ? [<span key={`${label}-l`}>{label}</span>, <span key={`${label}-v`}>{fmt(n, dec, digits)}</span>] : null;
  };
  const heldVault = big(total.held?.vault);
  const heldBurn = big(total.held?.burn);
  return (
    <div className="bag-asset">
      <div>
        <strong>{compact(big(total.in?.total), dec)} {total.symbol}</strong>
        <div className="dim text-xs">came in <Prov kind="measured" /></div>
      </div>
      <div className="bag-legs">
        {leg("to the house", total.out?.house)}
        {leg("to the Vault", total.out?.vault)}
        {leg("to Payday", total.out?.payday)}
        {leg("to the burn clock", total.out?.burn)}
        {leg("as Confetti", total.out?.confetti)}
        {leg("held for the Vault", total.held?.vault)}
        {leg("held for the burn clock", total.held?.burn)}
      </div>
      {(heldVault > 0n || heldBurn > 0n) && (
        <div className="bag-note">Held, not lost: the Vault and burn shares wait in the Bag until the house coin exists.</div>
      )}
      <details className="bag-sources">
        <summary>where it came from</summary>
        <div className="bag-legs">
          {leg("trades", total.in?.trade)}
          {leg("graduations", total.in?.graduation)}
          {leg("penalties", total.in?.penalty)}
          {leg("launch fees and boosts", total.in?.house)}
          {leg("the house coin", total.in?.houseCoin)}
        </div>
      </details>
      <div className="dim text-xs">
        {total.usd
          ? <>{usdCompact(total.usd.in)} in, {usdCompact(total.usd.out)} out <Prov kind="derived" /></>
          : <><span className="figure-dash">—</span> {total.usdReason ?? "no dollar price for this asset"}</>}
      </div>
    </div>
  );
}
