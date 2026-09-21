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
const toWei = (whole, decimals) => {
  // whole may be fractional; go through a string so 0.1 with eighteen decimals is exact
  const [int, frac = ""] = String(whole).split(".");
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(int + padded).toString();
};

const rows = [];
for (const a of candidates.slice(0, MAX)) {
  const open = units(OPEN_USD, a.usd);
  const bond = open * 10;
  const lock = units(LOCK_USD, a.usd);
  if (!(open > 0) || !(lock > 0)) continue;
  rows.push({
    address: a.address,
    symbol: a.symbol,
    decimals: a.decimals,
    usd: a.usd,
    lockThreshold: toWei(lock, a.decimals),
    startCap: toWei(open, a.decimals),
    graduationCap: toWei(bond, a.decimals),
    reads: `opens at ${open} ${a.symbol} (about $${Math.round(open * a.usd).toLocaleString()}), graduates at ${bond}, ticker locks over ${lock} in a day`,
  });
}

const plan = {
  chainId: found.chainId,
  plannedAt: new Date().toISOString(),
  openUsd: OPEN_USD,
  lockUsd: LOCK_USD,
  assets: rows.map((r) => r.address),
  symbols: rows.map((r) => r.symbol),
  lockThresholds: rows.map((r) => r.lockThreshold),
  startCaps: rows.map((r) => r.startCap),
  graduationCaps: rows.map((r) => r.graduationCap),
  detail: rows,
};
writeFileSync(join(ROOT, "deploy/quotes.plan.json"), `${JSON.stringify(plan, null, 2)}\n`);

for (const r of rows) console.log(`${r.symbol.padEnd(10)} ${r.reads}`);
console.log(`\n${rows.length} assets -> deploy/quotes.plan.json (apply with script/AllowQuotes.s.sol)`);
