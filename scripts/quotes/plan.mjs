#!/usr/bin/env node
/// Turns what the discovery found into what the owner would have to sign.
///
/// Every asset needs three things on chain before it can be a quote: the factory has to allow it
/// as a pair, the curve machine needs a preset denominated in it (a preset's caps are in the
/// pair's own units and are fixed forever, so each asset needs its own), and the portal has to
/// allow it as a quote for the direct machine. This works out the numbers for all three from the
/// price the discovery read, and writes them flat enough for a forge script to read back.
///
///   node scripts/quotes/plan.mjs [--open-usd 2700] [--lock-usd 70000] [--max 40]
///
/// The caps are dollars at the price on the day, rounded to something a person would type. They do
/// not follow the price afterwards: a preset is never edited, so an asset that doubles gets a new
/// preset rather than a changed one.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback;
};
const OPEN_USD = arg("open-usd", 2700);
const LOCK_USD = arg("lock-usd", 70000);
const MAX = arg("max", 40);

const found = JSON.parse(readFileSync(join(ROOT, "deploy/quotes.json"), "utf8"));

/// What was planned before, by address. A preset is written once and never edited, so an asset
/// that was already planned keeps the numbers it was planned with: re-pricing it at today's price
/// would not move the preset it already has on chain, it would add a second one beside it and put
/// the same asset in the menu twice.
const before = new Map();
try {
  const previous = JSON.parse(readFileSync(join(ROOT, "deploy/quotes.plan.json"), "utf8"));
  for (const r of previous.detail ?? []) before.set(r.address.toLowerCase(), r);
} catch { /* the first plan has nothing to keep */ }
const candidates = found.assets.filter((a) => a.verdict === "candidate" && a.usd > 0);

/// A number a person would type: one, two, three, five or eight at whatever size fits.
function readable(value) {
  if (!(value > 0)) return 0;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const steps = [1, 1.5, 2, 3, 5, 8, 10];
  const scaled = value / magnitude;
  const step = steps.reduce((best, s) => (Math.abs(s - scaled) < Math.abs(best - scaled) ? s : best), steps[0]);
  return step * magnitude;
}

const units = (dollars, price) => readable(dollars / price);

/// Every preset hands the curve one number for the opening price: the start cap spread over the
/// supply, in the pair's own units. An asset whose smallest unit is worth more than a token at
/// the open rounds that price to zero, which would be free tokens, so the factory refuses the
/// preset outright. cbBTC is the live example: eight decimals at eighty five thousand dollars
/// means one unit is worth a tenth of a cent, and a billion tokens opening at a few thousand
/// dollars are worth a thousandth of that each. Such an asset still becomes a pair and a direct
/// quote, where the price carries far more precision; it simply gets no curve preset.
const TOTAL_SUPPLY = 1_000_000_000n * 10n ** 18n;
const WAD = 10n ** 18n;
const openingPrice = (startCapWei) => (BigInt(startCapWei) * WAD) / TOTAL_SUPPLY;
const toWei = (whole, decimals) => {
  // whole may be fractional; go through a string so 0.1 with eighteen decimals is exact
  const [int, frac = ""] = String(whole).split(".");
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(int + padded).toString();
};

/// A ticker a person can read. An asset with no symbol, or one that is a paragraph, would render
/// as a blank card in the chooser and be unidentifiable in a wallet afterwards.
const nameable = (symbol) => typeof symbol === "string" && /^[\x20-\x7e]{1,12}$/.test(symbol.trim()) && symbol.trim().length > 0;

// Two tokens on this chain can carry the same ticker, and one of them is usually a joke about the
// other: a GME that is a share of GameStop and a GME that is worth a fifth of a cent. Offering
// both in the same menu is how somebody launches against the wrong one. The issuer's own share
// wins the ticker whenever there is one, because that is the thing the ticker names; between two
// tokens that are both jokes, or both shares, the busier one wins.
const byTicker = new Map();
const beats = (a, b) => (a.share === b.share ? (a.traded ?? 0) > (b.traded ?? 0) : Boolean(a.share));
for (const a of candidates) {
  const key = String(a.symbol ?? "").trim().toUpperCase();
  const prev = byTicker.get(key);
  if (!prev || beats(a, prev)) byTicker.set(key, a);
}
const unique = candidates.filter((a) => byTicker.get(String(a.symbol ?? "").trim().toUpperCase()) === a);

/// A ticker that changed hands. The pad allowed a token under some ticker, and the issuer's own
/// share of that name has since turned up: leaving both in the menu is how somebody launches
/// against the joke while believing they launched against the company. The loser is withdrawn,
/// which is a switch on the factory and not a deletion. Nothing it ever launched is touched.
const withdraw = candidates.filter((a) => {
  const key = String(a.symbol ?? "").trim().toUpperCase();
  return byTicker.get(key) !== a && byTicker.get(key)?.share && before.has(a.address.toLowerCase());
});

const rows = [];
/// A re-run does not re-open the meme half of the menu. The chain's own shares arrive as a set,
/// because they are one issuer's assets and one codehash proves it; every other token had to prove
/// it trades, and the set that proved it is the one already on chain. `--open-memes` widens that
/// again, deliberately and in one place.
const OPEN_MEMES = process.argv.includes("--open-memes");

for (const a of unique.slice(0, MAX)) {
  if (!nameable(a.symbol)) continue;
  if (!a.share && !OPEN_MEMES && !before.has(a.address.toLowerCase())) continue;
  const kept = before.get(a.address.toLowerCase());
  // Its numbers are the ones it was planned with, price included: the row describes the day the
  // preset was written, and that preset cannot be rewritten. Only what the asset IS can be filled
  // in afterwards.
  if (kept) { rows.push({ ...kept, name: a.name ?? kept.name, share: a.share ?? kept.share }); continue; }
  const open = units(OPEN_USD, a.usd);
  const bond = open * 10;
  const lock = units(LOCK_USD, a.usd);
  if (!(open > 0) || !(lock > 0)) continue;
  const startCap = toWei(open, a.decimals);
  const curve = openingPrice(startCap) > 0n;
  rows.push({
    address: a.address,
    symbol: a.symbol,
    name: a.name,
    share: a.share ?? false,
    decimals: a.decimals,
    usd: a.usd,
    curve,
    lockThreshold: toWei(lock, a.decimals),
    startCap,
    graduationCap: toWei(bond, a.decimals),
    reads: curve
      ? `opens at ${open} ${a.symbol} (about $${Math.round(open * a.usd).toLocaleString()}), graduates at ${bond}, ticker locks over ${lock} in a day`
      : `pair and direct quote only: one ${a.symbol} unit is worth more than a token at the open, so the curve cannot price it`,
  });
}

const plan = {
  chainId: found.chainId,
  plannedAt: new Date().toISOString(),
  openUsd: OPEN_USD,
  lockUsd: LOCK_USD,
  assets: rows.map((r) => r.address),
  withdraw: withdraw.map((a) => a.address),
  withdrawReads: withdraw.map((a) => `${a.symbol} at ${a.address} loses the ticker to ${byTicker.get(String(a.symbol).trim().toUpperCase()).name ?? "the issuer's share"}`),
  symbols: rows.map((r) => r.symbol),
  curvePresets: rows.map((r) => r.curve),
  lockThresholds: rows.map((r) => r.lockThreshold),
  startCaps: rows.map((r) => r.startCap),
  graduationCaps: rows.map((r) => r.graduationCap),
  detail: rows,
};
writeFileSync(join(ROOT, "deploy/quotes.plan.json"), `${JSON.stringify(plan, null, 2)}\n`);

for (const r of rows) console.log(`${r.symbol.padEnd(10)} ${r.reads}`);
const noCurve = rows.filter((r) => !r.curve);
const shares = rows.filter((r) => r.share).length;
const fresh = rows.filter((r) => !before.has(r.address.toLowerCase())).length;
console.log(`\n${rows.length} assets -> deploy/quotes.plan.json (apply with script/AllowQuotes.s.sol)`);
console.log(`${shares} of them are the chain's own shares; ${fresh} are new since the last plan, ${rows.length - fresh} keep the numbers they were planned with`);
for (const line of plan.withdrawReads) console.log(`withdrawn: ${line}`);
console.log(`${rows.length - noCurve.length} of them get a curve preset${
  noCurve.length ? `; ${noCurve.map((r) => r.symbol).join(", ")} can only be a direct quote` : ""
}`);
