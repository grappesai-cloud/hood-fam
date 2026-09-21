#!/usr/bin/env node
/// Does the browser's curve agree with the chain's, to the wei?
///
/// `packages/sdk/src/sim.ts` is a hand port of `CurveMath` and `HoodCurve.quoteBuy`, and it is what
/// the launch wizard shows a creator before a single contract exists. This runs the Solidity for a
/// table of shapes, runs the port for the same table, and refuses to agree about anything that is
/// off by one. Rounding is where a port dies: floor on the way out, ceil on the way in.
///
///   node scripts/checks/curve-port.mjs

import { execFileSync } from "node:child_process";
import { curveBuy, priceAt, raiseTarget } from "../../packages/sdk/dist/sim.js";

// The same table as test/CurvePort.t.sol, in the same order. Kept in both places on purpose: if one
// side is edited alone the counts stop matching and this shouts.
const VECTORS = [
  { p0: 3_000_000_000n, p1: 30_000_000_000n, supply: 800_000_000n * 10n ** 18n, sold: 0n, budget: 10n ** 17n, feeBps: 0 },
  { p0: 2_500_000n, p1: 90_000_000n, supply: 1_000_000n * 10n ** 18n, sold: 250_000n * 10n ** 18n, budget: 7_500_000n, feeBps: 100 },
  { p0: 1_000_000_000n, p1: 30_000_000_000n, supply: 600_000_000n * 10n ** 18n, sold: 599_000_000n * 10n ** 18n, budget: 4n * 10n ** 15n, feeBps: 250 },
  { p0: 3_000_000_000n, p1: 30_000_000_000n, supply: 800_000_000n * 10n ** 18n, sold: 123_456_789n * 10n ** 18n, budget: 1n, feeBps: 100 },
];

const out = execFileSync("forge", ["test", "--match-path", "test/CurvePort.t.sol", "-vv"], {
  cwd: new URL("../..", import.meta.url).pathname,
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024,
});

const chain = [];
for (const line of out.split("\n")) {
  const start = line.match(/^\s+vector (\d+)\s*$/);
  if (start) { chain.push({}); continue; }
  const field = line.match(/^\s+(price|out|net|fee|after|raise) (\d+)\s*$/);
  if (field && chain.length) chain[chain.length - 1][field[1]] = BigInt(field[2]);
}

if (chain.length !== VECTORS.length) {
  console.error(`the Solidity printed ${chain.length} vectors, this file has ${VECTORS.length}`);
  process.exit(1);
}

let bad = 0;
VECTORS.forEach((v, i) => {
  const shot = curveBuy({ p0: v.p0, p1: v.p1, supply: v.supply, sold: v.sold, pairIn: v.budget, feeBps: v.feeBps });
  const mine = {
    price: priceAt(v.p0, v.p1, v.supply, v.sold),
    out: shot.tokensOut,
    net: shot.net,
    fee: shot.fee,
    after: shot.priceAfter,
    raise: raiseTarget(v.p0, v.p1, v.supply),
  };
  for (const [k, value] of Object.entries(mine)) {
    const theirs = chain[i][k];
    if (theirs !== value) {
      bad++;
      console.error(`vector ${i} ${k}: chain ${theirs}, port ${value}`);
    }
  }
  if (bad === 0) console.log(`vector ${i}  ok  out ${mine.out} net ${mine.net} fee ${mine.fee}`);
});

if (bad) { console.error(`\n${bad} number(s) disagree. The wizard would lie by that much.`); process.exit(1); }
console.log(`\n${VECTORS.length} vectors, every number identical to the contract.`);
