#!/usr/bin/env node
/// What every pair asset is worth, from the chain, right now.
///
/// The indexer prices trades through `apps/api/src/price.ts`, and a pair it cannot price is a pair
/// whose trades earn nobody any points. The prices come from pools that can move, be replaced or
/// dry up, so this prints all of them in one line each: run it after adding an asset, and again
/// whenever a number on the board looks wrong.
///
///   node scripts/checks/pair-prices.mjs

import { createPublicClient, http, erc20Abi, parseAbiItem, zeroAddress } from "viem";
import { PAIR_ASSETS, pairUsdPrice } from "../../apps/api/dist/price.js";

const RPC = process.env.HOOD_RPC ?? "https://rpc.mainnet.chain.robinhood.com";
const client = createPublicClient({ transport: http(RPC) });
const factory = process.env.HOOD_FACTORY;
const allowed = parseAbiItem("function pairAllowed(address) view returns (bool)");
const threshold = parseAbiItem("function lockThreshold(address) view returns (uint256)");

let bad = 0;
let unallowed = 0;
for (const [address, asset] of Object.entries(PAIR_ASSETS)) {
  const price = await pairUsdPrice(address);
  let onChain = "";
  let allowedHere = true;
  if (factory) {
    try {
      const [ok, lock] = await Promise.all([
        client.readContract({ address: factory, abi: [allowed], functionName: "pairAllowed", args: [address] }),
        client.readContract({ address: factory, abi: [threshold], functionName: "lockThreshold", args: [address] }),
      ]);
      onChain = ok
        ? `allowed, ticker locks above ${(Number(lock) / 10 ** asset.decimals).toLocaleString()} ${asset.symbol} in 24h`
        : "known and priceable, not allowed";
      allowedHere = ok;
    } catch (e) { onChain = `factory unreadable: ${String(e).slice(0, 40)}`; }
  }
  // The symbol the token itself claims, so a wrong address in the table shows up as a wrong name.
  let claimed = asset.symbol;
  if (address !== zeroAddress) {
    try { claimed = await client.readContract({ address, abi: erc20Abi, functionName: "symbol" }); } catch { claimed = "unreadable"; }
  }
  const agrees = claimed === asset.symbol;
  // A price this far from anything a person would pay is a decimals mistake, not a market: the
  // only way to get one is to scale a pool's raw price by the wrong power of ten.
  const absurd = price > 1_000_000 || (price > 0 && price < 1e-12);
  // An asset the owner has not allowed is a decision, not a fault. What is a fault is an asset
  // that IS allowed and cannot be priced, or one whose name does not match the token at that
  // address, because both of those quietly mislead somebody launching against it.
  if (!allowedHere) { unallowed++; if (!agrees) bad++; }
  else if (!agrees || price <= 0 || absurd) bad++;
  if (!allowedHere && !absurd && agrees && price > 0) continue;
  console.log(
    `${asset.symbol.padEnd(6)} ${address} ${agrees ? "  " : "!!"} $${price.toFixed(2).padStart(10)}  ${onChain}`,
  );
  if (!agrees) console.log(`       the token at that address calls itself ${claimed}`);
  if (price <= 0) console.log(`       no price: trades in this pair would be credited zero points`);
  if (absurd) console.log(`       that is not a price: check this asset's decimals against its pool`);
}

const total = Object.keys(PAIR_ASSETS).length;
console.log(`\n${total - unallowed} allowed and priced, ${unallowed} more known to the indexer and not allowed.`);
if (bad) { console.error(`${bad} problem(s) above.`); process.exit(1); }
