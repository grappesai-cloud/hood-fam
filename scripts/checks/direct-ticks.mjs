#!/usr/bin/env node
/// The direct machine's two ticks, checked against the numbers the fork test pinned.
///
/// A direct launch opens the whole supply as one position between two ticks, computed from two
/// valuations a creator typed. The arithmetic depends on the quote's decimals and on which side
/// the token address sorted into, and getting it wrong opens the launch at a valuation nobody
/// chose. `test/ForkDirect.t.sol` worked those numbers out by hand for a dollar quote; this holds
/// the SDK to them, and to the ETH case the app has been using all along.
///
///   node scripts/checks/direct-ticks.mjs

import { directTicks, predictDirectToken } from "../../packages/sdk/dist/direct.js";

let bad = 0;
const check = (name, got, want) => {
  const ok = got === want;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}  got ${got}${ok ? "" : `, wanted ${want}`}`);
  if (!ok) bad++;
};

const SUPPLY = 1_000_000_000;

// The fork test's dollar launch: ten thousand dollars at the open, a hundred thousand at the bond,
// six decimals on the quote, spacing 200. It worked these out by hand from ln(1e17)/ln(1.0001).
const asToken1 = directTicks({ openFdv: 10_000, bondFdv: 100_000, supply: SUPPLY, quoteDecimals: 6, tokenIsZero: false, tickSpacing: 200 });
check("a dollar launch, token as currency1, opens at the hand computed tick", asToken1.tickStart, 391_400);
check("a dollar launch, token as currency1, bonds at the hand computed tick", asToken1.tickBond, 368_400);

const asToken0 = directTicks({ openFdv: 10_000, bondFdv: 100_000, supply: SUPPLY, quoteDecimals: 6, tokenIsZero: true, tickSpacing: 200 });
check("the same launch mirrors when the token sorts into currency0", asToken0.tickStart, -391_400);
check("and so does its bond tick", asToken0.tickBond, -368_400);

// The native case the app already shipped: both sides eighteen decimals, so the price is the plain
// ratio and the ticks are the ones `fdvToTick` produced before any of this existed.
const eth = directTicks({ openFdv: 10, bondFdv: 100, supply: SUPPLY, quoteDecimals: 18, tokenIsZero: false, tickSpacing: 200 });
const plain = (fdv) => Math.round(Math.log(SUPPLY / fdv) / Math.log(1.0001) / 200) * 200;
check("a ten ETH open matches the old native formula", eth.tickStart, plain(10));
check("a hundred ETH bond matches it too", eth.tickBond, plain(100));

// Dearer means a higher price for the token, which is a lower tick when the token is currency1 and
// a higher one when it is currency0. Every launch in the machine relies on this direction.
check("bonding is dearer than opening, as currency1", asToken1.tickBond < asToken1.tickStart, true);
check("bonding is dearer than opening, as currency0", asToken0.tickBond > asToken0.tickStart, true);

// The address the portal will clone, worked out the way the portal works it out.
const predicted = predictDirectToken({
  deployer: "0x64BCd6CD0bCA8D2CE80C30E50B3976aB0ADaE74e",
  implementation: "0x83dF8e91c0dDc482Ea1F96b2dB96795db886EF22",
  creator: "0xC2383bF6003d4cE2ca203aF9bF7f77B423e91aEc",
  salt: `0x${"11".repeat(32)}`,
});
check("the predicted clone is an address", /^0x[0-9a-fA-F]{40}$/.test(predicted), true);

if (bad) { console.error(`\n${bad} wrong.`); process.exit(1); }
console.log("\nthe ticks are the ones the contracts were tested against.");
