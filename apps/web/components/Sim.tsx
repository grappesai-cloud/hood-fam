"use client";

import { useState } from "react";
import { curveBuy, raiseTarget, priceAt, snipeBpsAt } from "@hood/sdk";
import { compact, fmt } from "@/lib/format";
import { Slider } from "@/components/LaunchUI";

/// Play with it before you sign it.
///
/// A creator picking a curve is picking what the first buyer pays and what the last one pays, and
/// until now the wizard said that in two numbers: starts here, graduates there. Two numbers do not
/// tell you that the tenth ETH in buys a third of what the first one did. So: move the money, move
/// the point on the curve you are buying at, and watch what comes out. The arithmetic is the
/// contract's own, checked against it wei for wei by `scripts/checks/curve-port.mjs`, which is the
/// only reason a toy like this is allowed near a launch button.
///
/// What it is not: a forecast. Nothing here says the curve sells out, and the panel says so.

const WAD = 10n ** 18n;

export function CurveSim({ p0, p1, curveSupply, totalSupply, dec, sym, feeBps, ticker }: {
  p0: bigint; p1: bigint; curveSupply: bigint; totalSupply: bigint;
  dec: number; sym: string; feeBps: number; ticker: string;
}) {
  // Two dials, because two questions: how much am I putting in, and how early am I.
  const [size, setSize] = useState(20);
  const [entry, setEntry] = useState(0);

  const raise = raiseTarget(p0, p1, curveSupply);
  // Squared, so the bottom half of the slider covers the small buys people actually make.
  const pairIn = (raise * BigInt(Math.round(size * size))) / 10_000n / 4n;
  const sold = (curveSupply * BigInt(entry)) / 100n;
  const shot = curveBuy({ p0, p1, supply: curveSupply, sold, pairIn, feeBps });

  const paid = shot.spent === 0n ? pairIn : shot.spent;
  const avg = shot.tokensOut === 0n ? 0n : (paid * WAD) / shot.tokensOut;
  const move = shot.priceBefore === 0n ? 0 : Number((shot.priceAfter - shot.priceBefore) * 10_000n / shot.priceBefore) / 100;
  const supplyPct = totalSupply === 0n ? 0 : Number((shot.tokensOut * 10_000n) / totalSupply) / 100;
  const worth = shot.worthAtGraduation;
  const multiple = paid === 0n ? 0 : Number((worth * 100n) / paid) / 100;

  // The picture: price against how much of the curve is gone. Linear, so the line is straight and
  // the area under it is the raise; the lime block is the slice this buy takes out of it.
  const x = (s: bigint) => 8 + Number((s * 300n) / curveSupply);
  const y = (price: bigint) => 104 - Number(((price - p0) * 86n) / (p1 - p0 || 1n));
  const x0 = x(sold);
  const x1 = x(sold + shot.tokensOut);

  return (
    <div className="sim">
      <svg viewBox="0 0 316 128" className="sim-chart" role="img"
        aria-label={`The price along the curve, and where a ${fmt(pairIn, dec, 4)} ${sym} buy lands`}>
        <path d={`M8 ${y(p0)} L308 ${y(p1)} L308 112 L8 112 Z`} className="sim-area" />
        <path d={`M${x0} ${y(shot.priceBefore)} L${x1} ${y(shot.priceAfter)} L${x1} 112 L${x0} 112 Z`} className="sim-band" />
        <path d={`M8 ${y(p0)} L308 ${y(p1)}`} className="sim-line" />
        <circle cx={x0} cy={y(shot.priceBefore)} r="3.4" className="sim-dot" />
        <text x="8" y="124" className="sim-axis">the open</text>
        <text x="308" y="124" className="sim-axis sim-axis-end">graduation</text>
      </svg>

      <Slider label={`You buy with ${fmt(pairIn, dec, 5)} ${sym}`} hint={`The whole curve takes ${fmt(raise, dec, 3)} ${sym} to sell out.`}
        min={1} max={100} step={1} value={size} onChange={setSize} />
      <Slider label={entry === 0 ? "You are the first buy" : `You buy when ${entry}% of the curve is gone`}
        hint="Everything on a curve depends on who is in front of you."
        min={0} max={95} step={1} value={entry} onChange={setEntry} />

      <div className="sim-out">
        <SimRow label="you get" value={`${compact(shot.tokensOut)} ${ticker || "tokens"}`} note={`${supplyPct.toFixed(2)}% of the supply`} />
        <SimRow label="average price" value={priceLine(avg, dec, sym)} note={`the price moves +${move.toFixed(2)}%`} />
        <SimRow label="fee on the way in" value={`${fmt(shot.fee, dec, 6)} ${sym}`} note={`${(feeBps / 100).toFixed(2)}% of the trade`} />
        <SimRow label="if it sells out" value={`${fmt(worth, dec, 5)} ${sym}`} note={`${multiple.toFixed(2)}x what you put in`} strong />
      </div>
      <p className="sim-note">
        Arithmetic, not a forecast. The last line is what those tokens are worth at the graduation
        price and assumes the curve gets there, which nothing guarantees.
      </p>
    </div>
  );
}

/// The other machine's dials: a tax that never changes and a surcharge that is gone in seconds.
export function DirectSim({ buyTax, sellTax, snipeTax, snipeSeconds, openFdv, bondFdv, quoteSymbol }: {
  buyTax: number; sellTax: number; snipeTax: number; snipeSeconds: number;
  openFdv: number; bondFdv: number; quoteSymbol: string;
}) {
  const [t, setT] = useState(0);
  const [poolProgress, setPoolProgress] = useState(25);
  const span = Math.max(snipeSeconds, 10);
  const surcharge = snipeBpsAt(snipeTax * 100, snipeSeconds, t) / 100;
  const onBuy = buyTax + surcharge;
  const roundTrip = 100 - (100 - onBuy) * (100 - sellTax) / 100;
  const validOpen = Math.max(openFdv || 0, 0.000001);
  const validBond = Math.max(bondFdv || validOpen, validOpen);
  const currentFdv = validOpen * Math.pow(validBond / validOpen, poolProgress / 100);
  const priceMultiple = currentFdv / validOpen;

  const x = (s: number) => 8 + (s / span) * 300;
  const y = (pct: number) => 104 - (pct / Math.max(1, snipeTax + buyTax)) * 86;
  const line = Array.from({ length: 61 }, (_, i) => {
    const s = (i / 60) * span;
    return `${i === 0 ? "M" : "L"}${x(s).toFixed(1)} ${y(buyTax + snipeBpsAt(snipeTax * 100, snipeSeconds, s) / 100).toFixed(1)}`;
  }).join(" ");

  return (
    <div className="sim">
      <svg viewBox="0 0 316 128" className="sim-chart" role="img" aria-label="What a buy is taxed, second by second after the open">
        <path d={`${line} L308 112 L8 112 Z`} className="sim-area" />
        <path d={line} className="sim-line" />
        <circle cx={x(t)} cy={y(onBuy)} r="3.4" className="sim-dot" />
        <text x="8" y="124" className="sim-axis">the open</text>
        <text x="308" y="124" className="sim-axis sim-axis-end">{span}s later</text>
      </svg>

      <Slider label={t === 0 ? "A buy in the same second as the open" : `A buy ${t}s after the open`}
        hint="The surcharge falls away by itself. Nobody has to switch it off."
        min={0} max={span} step={1} value={t} onChange={setT} />

      <div className="sim-journey">
        <div className="sim-journey-line"><i style={{ width: `${poolProgress}%` }}><b /></i></div>
        <div className="sim-journey-labels"><span>open<br /><b>{openFdv || 0} {quoteSymbol}</b></span><span>bonded<br /><b>{bondFdv || 0} {quoteSymbol}</b></span></div>
      </div>
      <Slider label={`Pool price journey ${poolProgress}%`}
        hint="Move the pool from its opening valuation to the bonding valuation. This is a price path, not a countdown."
        min={0} max={100} step={1} value={poolProgress} onChange={setPoolProgress} />

      <div className="sim-out">
        <SimRow label="that buy pays" value={`${onBuy.toFixed(2)}%`} note={surcharge > 0.01 ? `${buyTax}% tax plus ${surcharge.toFixed(2)}% surcharge` : `${buyTax}% tax, the surcharge is gone`} strong />
        <SimRow label="1 ETH in" value={`${((100 - onBuy) / 100).toFixed(4)} ETH of token`} note="the rest is split the way you set below" />
        <SimRow label="straight back out" value={`${roundTrip.toFixed(2)}%`} note="what a buy and an immediate sell costs" />
        <SimRow label="pool valuation" value={`${currentFdv.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${quoteSymbol}`} note={`${priceMultiple.toFixed(2)}x the opening price · ${(100 - poolProgress).toFixed(0)}% of the price path left`} strong />
      </div>
      <p className="sim-note">
        The surcharge is quadratic: half the window in, it is already a quarter of what it started
        at. It punishes the first block, not the first minute.
      </p>
    </div>
  );
}

/// A price of 0.000000001 ETH tells a reader nothing at all. Below a millionth of a unit the price
/// is quoted per million tokens, which is the size anybody here is actually buying.
function priceLine(avg: bigint, dec: number, sym: string): string {
  if (avg === 0n) return `0 ${sym}`;
  if (Number(avg) / 10 ** dec < 1e-6) return `${fmt(avg * 1_000_000n, dec, 6)} ${sym} per 1M`;
  return `${fmt(avg, dec, 9)} ${sym}`;
}

function SimRow({ label, value, note, strong }: { label: string; value: string; note?: string; strong?: boolean }) {
  return (
    <div className={strong ? "sim-row sim-row-strong" : "sim-row"}>
      <span className="sim-row-label">{label}</span>
      <span className="sim-row-value mono">{value}</span>
      {note && <span className="sim-row-note">{note}</span>}
    </div>
  );
}
