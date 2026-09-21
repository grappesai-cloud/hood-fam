#!/usr/bin/env node
/// Every asset on this chain that could be a launch's quote, found on the chain itself.
///
/// A quote asset is what a launch is priced in, holds its raise in, and pays its creator in. Three
/// things decide whether one can be offered, and none of them is an opinion:
///
///   1. **it can be priced.** Points are dollars and the board is dollars, so an asset with no
///      readable price against the dollar is an asset whose trades would silently earn nobody
///      anything. The price comes from the deepest pool it has against USDG, v3 or v4.
///   2. **it moves like an ERC-20.** A token that taxes its own transfers, or refuses to move to a
///      contract, cannot sit in a curve: the curve would hand back less than it pulled, or not be
///      able to pull at all. Both are simulated against a fork before anything is allowed.
///   3. **somebody trades it.** An asset with a pool and no depth prices off a single wei.
///
/// What comes out is `deploy/quotes.json`: every candidate, its verdict, its price, and the numbers
/// a preset would need. `script/AllowQuotes.s.sol` applies it; nothing here sends a transaction.
///
///   node scripts/quotes/discover.mjs [--min-usd 25000] [--fork] [--limit 200]
///
/// `--fork` runs the transfer screen against a local anvil fork of 4663 (slow, thorough). Without
/// it the screen is a static call, which catches a refusal but not a tax on transfer.

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  createPublicClient, createWalletClient, erc20Abi, getAddress, http, keccak256, parseAbiItem,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const RPC = process.env.HOOD_RPC ?? "https://rpc.mainnet.chain.robinhood.com";
const USDG = getAddress("0x5fc5360d0400a0fd4f2af552add042d716f1d168");
const WETH = getAddress("0x0bd7d308f8e1639fab988df18a8011f41eacad73");
const POOL_MANAGER = getAddress("0x8366a39CC670B4001A1121B8F6A443A643e40951");
const STATE_VIEW = getAddress("0xF3334192D15450CdD385c8B70e03f9A6bD9E673b");
const V3_FACTORY = getAddress("0x1f7d7550B1b028f7571E69A784071F0205FD2EfA");

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const MIN_USD = Number(arg("min-usd", "25000"));
const LIMIT = Number(arg("limit", "400"));
const ON_FORK = process.argv.includes("--fork");
/// Price what the file already names, again, and nothing else. The two expensive passes (every
/// pool ever opened, every swap of the last stretch) are about finding assets; when the question
/// is only what they are worth now, or when the pricing rule itself has changed, this skips both
/// and rewrites the same list with today's numbers.
const REPRICE = process.argv.includes("--reprice");
/// What a thousand dollars is allowed to lose going in and straight back out. Above this the pool
/// is a shop window: a price exists, and nothing can be bought at it.
const MAX_ROUND_TRIP_BPS = Number(arg("max-loss-bps", "300"));
const BLOCK_WINDOW = 500_000n;

import { robinhood } from "../../packages/sdk/dist/index.js";
/// Multicall3 is on this chain, so a scan of fifteen thousand assets is a few dozen round trips
/// rather than a few hundred thousand.
const client = createPublicClient({ chain: robinhood, transport: http(RPC), batch: { multicall: { batchSize: 1024, wait: 16 } } });

/// Read the same call over many addresses, in batches, without dying on the ones that revert.
async function readMany(contracts) {
  const out = [];
  for (let i = 0; i < contracts.length; i += 500) {
    const chunk = contracts.slice(i, i + 500);
    const res = await client.multicall({ contracts: chunk, allowFailure: true });
    out.push(...res);
    if (i && i % 5000 === 0) console.error(`    ${i}/${contracts.length}`);
  }
  return out;
}

const v3Created = parseAbiItem(
  "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)",
);
const v4Init = parseAbiItem(
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
);
const quoterAbi = [
  {
    type: "function", name: "quoteExactInputSingle", stateMutability: "nonpayable",
    inputs: [{
      name: "params", type: "tuple",
      components: [
        {
          name: "poolKey", type: "tuple",
          components: [
            { name: "currency0", type: "address" }, { name: "currency1", type: "address" },
            { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" },
          ],
        },
        { name: "zeroForOne", type: "bool" },
        { name: "exactAmount", type: "uint128" },
        { name: "hookData", type: "bytes" },
      ],
    }],
    outputs: [{ name: "amountOut", type: "uint256" }, { name: "gasEstimate", type: "uint256" }],
  },
];
const QUOTER = getAddress("0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94");

/// What a thousand dollars would really buy, and what selling it straight back would really
/// return. A pool with a tight range reports colossal liquidity and cannot absorb a hundred
/// dollars; a pool that was initialised and never used reports a price nobody has ever paid.
/// A round trip is the one number neither can fake.
async function roundTrip(pool, dollars = 1_000_000_000n) {
  const key = {
    currency0: pool.currency0, currency1: pool.currency1,
    fee: Number(pool.fee), tickSpacing: Number(pool.tickSpacing), hooks: pool.hooks,
  };
  const dollarIsZero = key.currency0.toLowerCase() === USDG.toLowerCase();
  try {
    const { result: bought } = await client.simulateContract({
      address: QUOTER, abi: quoterAbi, functionName: "quoteExactInputSingle",
      args: [{ poolKey: key, zeroForOne: dollarIsZero, exactAmount: dollars, hookData: "0x" }],
    });
    const out = bought[0];
    if (!out || out === 0n) return null;
    const { result: back } = await client.simulateContract({
      address: QUOTER, abi: quoterAbi, functionName: "quoteExactInputSingle",
      args: [{ poolKey: key, zeroForOne: !dollarIsZero, exactAmount: out, hookData: "0x" }],
    });
    const returned = back[0];
    if (!returned || returned === 0n) return null;
    return { bought: out, returned, lossBps: Number(((dollars - returned) * 10_000n) / dollars) };
  } catch {
    return null;
  }
}

const v3Pool = [
  parseAbiItem("function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 a, uint16 b, uint16 c, uint8 d, bool e)"),
  parseAbiItem("function liquidity() view returns (uint128)"),
];
const stateView = [
  parseAbiItem("function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)"),
  parseAbiItem("function getLiquidity(bytes32 poolId) view returns (uint128)"),
];

/// A pool's price, as the pool computes it, turned into dollars per whole unit of the asset.
function usdFrom(sqrtPriceX96, assetIsToken0, assetDecimals) {
  const raw = (Number(sqrtPriceX96) / 2 ** 96) ** 2;
  const scale = 10 ** (assetDecimals - 6);
  return assetIsToken0 ? raw * scale : scale / raw;
}

/// Every matching log the chain has ever emitted, in windows the node will serve. A window it
/// refuses is halved rather than skipped, because a pool missed here is an asset that can never be
/// offered and nobody would know why.
async function logsOver(params, fromBlock, toBlock) {
  const out = [];
  let to = toBlock;
  let window = BLOCK_WINDOW;
  while (to > fromBlock) {
    const from = to - window > fromBlock ? to - window : fromBlock;
    try {
      out.push(...(await client.getLogs({ ...params, fromBlock: from, toBlock: to })));
      to = from - 1n;
      if (window < BLOCK_WINDOW) window = window * 2n;
    } catch {
      if (window <= 5_000n) { to = from - 1n; continue; } // a range nothing will serve
      window = window / 2n;
    }
  }
  return out;
}

/// The pool map is the expensive half and it only ever grows, so it is kept on disk: the first run
/// reads the whole chain, every run after it reads what happened since.
function loadCache() {
  try { return JSON.parse(readFileSync(join(ROOT, "deploy/pools.cache.json"), "utf8")); }
  catch { return { scannedTo: 0, pools: [] }; }
}

/// What the last run offered. An asset that is already in the menu does not fall out of it because
/// it had a quiet hour: the threshold above decides what gets IN, not what stays. Dropping one
/// would leave it allowed on chain and unpriceable in the app, which is the worst of both.
function loadPrevious() {
  try { return JSON.parse(readFileSync(join(ROOT, "deploy/quotes.json"), "utf8")).assets ?? []; }
  catch { return []; }
}
const previousAssets = loadPrevious();
const offered = previousAssets.filter((a) => a.verdict === "candidate");

const headNow = await client.getBlockNumber();
const cache = loadCache();
const from = REPRICE ? headNow : BigInt(cache.scannedTo || 0);
console.error(REPRICE
  ? `pricing what deploy/quotes.json already names, from the ${cache.pools.length.toLocaleString()} cached pools…`
  : from === 0n
    ? "reading every pool this chain has ever opened against the dollar (once; cached afterwards)…"
    : `reading the pools opened since block ${from}…`);

const found = [...cache.pools];
for (const side of ["token0", "token1"]) {
  const logs = await logsOver({ address: V3_FACTORY, event: v3Created, args: { [side]: USDG } }, from, headNow);
  for (const l of logs) {
    const other = side === "token0" ? l.args.token1 : l.args.token0;
    found.push({ asset: getAddress(other), kind: "v3", pool: getAddress(l.args.pool), assetIsToken0: side === "token1", fee: Number(l.args.fee) });
  }
  console.error(`  v3, dollar as ${side}: ${logs.length} new`);
}
for (const side of ["currency0", "currency1"]) {
  const logs = await logsOver({ address: POOL_MANAGER, event: v4Init, args: { [side]: USDG } }, from, headNow);
  for (const l of logs) {
    const other = side === "currency0" ? l.args.currency1 : l.args.currency0;
    found.push({
      asset: getAddress(other), kind: "v4", poolId: l.args.id, assetIsToken0: side === "currency1", fee: Number(l.args.fee),
      currency0: l.args.currency0, currency1: l.args.currency1, tickSpacing: Number(l.args.tickSpacing), hooks: l.args.hooks,
    });
  }
  console.error(`  v4, dollar as ${side}: ${logs.length} new`);
}
mkdirSync(join(ROOT, "deploy"), { recursive: true });
writeFileSync(join(ROOT, "deploy/pools.cache.json"), JSON.stringify({ scannedTo: Number(headNow), pools: found }));

const candidates = new Map(); // asset -> its pools against the dollar
for (const p of found) {
  if (getAddress(p.asset) === USDG) continue;
  if (!candidates.has(p.asset)) candidates.set(p.asset, []);
  candidates.get(p.asset).push(p);
}
console.error(`  ${candidates.size} assets have a pool against the dollar`);

/// A pool somebody could actually trade in. Uniswap's fee is in hundredths of a bip, so three per
/// cent is 30000, and this chain is full of pools far above it: eighty, ninety, ninety nine per
/// cent, the fixed remains of other pads' launch pools. v4's dynamic fee flag is not a fee at all
/// but a marker that a hook sets one per swap, and on 4663 those are the busiest venues there are,
/// five thousand of them behind a single hook, so they count as tradeable.
///
/// This is a preference, not a filter. A share of Lockheed Martin was being priced at a third of
/// its value by a ninety nine per cent pool, but plenty of shares here have liquidity ONLY in an
/// expensive pool, and the price such a pool quotes is usually right: a high fee is a cost of
/// getting out, not a lie about what the thing is worth. So the deepest tradeable pool wins, and
/// the expensive ones are read only when nothing else has any liquidity at all.
const TRADEABLE_FEE = 30_000;
const DYNAMIC_FEE = 0x800000;
const tradeable = (pool) => Number(pool.fee) === DYNAMIC_FEE || Number(pool.fee) <= TRADEABLE_FEE;

/// The deepest pool an asset has, and what it says the asset is worth.
///
/// All of them, and all of them at once. Reading the first twenty four was how a share of Lockheed
/// Martin came out at a third of its price: its real pool, holding nearly six million dollars, was
/// the twenty seventh in the list, and a ninety nine per cent pool with a tight range won the ones
/// that were read. And one at a time would be four hundred round trips per asset where the
/// client's batching makes it four.
async function priceOf(asset, pools, decimals) {
  const read = await Promise.all(pools.slice(0, 64).map(async (p) => {
    try {
      if (p.kind === "v3") {
        const [slot0, liquidity, held] = await Promise.all([
          client.readContract({ address: p.pool, abi: v3Pool, functionName: "slot0" }),
          client.readContract({ address: p.pool, abi: v3Pool, functionName: "liquidity" }),
          // Real dollars sitting in the pool, which is the only depth figure that cannot be
          // inflated by a price nobody trades at.
          client.readContract({ address: USDG, abi: erc20Abi, functionName: "balanceOf", args: [p.pool] }),
        ]);
        if (slot0[0] === 0n || liquidity === 0n) return null;
        return { ...p, usd: usdFrom(slot0[0], p.assetIsToken0, decimals), depth: Number(held) / 1e6 };
      }
      const [slot0, liquidity] = await Promise.all([
        client.readContract({ address: STATE_VIEW, abi: stateView, functionName: "getSlot0", args: [p.poolId] }),
        client.readContract({ address: STATE_VIEW, abi: stateView, functionName: "getLiquidity", args: [p.poolId] }),
      ]);
      if (slot0[0] === 0n || liquidity === 0n) return null;
      // v4 keeps every pool's money in one contract, so the dollars in THIS pool are the virtual
      // reserve: liquidity divided by the square root of the price, in the dollar's direction.
      const sqrt = Number(slot0[0]) / 2 ** 96;
      const dollars = p.assetIsToken0 ? (Number(liquidity) * sqrt) / 1e6 : Number(liquidity) / sqrt / 1e6;
      return { ...p, usd: usdFrom(slot0[0], p.assetIsToken0, decimals), depth: dollars };
    } catch { return null; /* a pool that will not answer is not a price */ }
  }));
  const priced = read.filter(Boolean);
  const deepest = (set) => set.reduce((best, p) => (!best || p.depth > best.depth ? p : best), null);
  return deepest(priced.filter(tradeable)) ?? deepest(priced);
}

// ---- what actually trades ---------------------------------------------------------------------
//
// Depth is the wrong question, twice over. A v4 pool's liquidity is virtual: a tight range shows
// billions where there are thousands. And a pool with a hook refuses to be quoted by anybody but
// its own router, so asking it what a thousand dollars would do comes back as a revert whether the
// pool is deep or empty. What neither can dress up is the swaps that have already happened, so the
// measure here is the dollars that changed hands in each pool over the last stretch of blocks.
const v4Swap = parseAbiItem(
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
);
const v3Swap = parseAbiItem(
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
);

const poolOf = new Map(); // pool id or address -> { asset, ...pool }
for (const [asset, pools] of candidates) {
  for (const p of pools) poolOf.set((p.kind === "v3" ? p.pool : p.poolId).toLowerCase(), { asset, ...p });
}

const head = await client.getBlockNumber();
const WINDOW = BigInt(arg("window", "50000"));      // about an hour and a half of this chain
const STEP = 2_000n;                                  // what the node serves in one go
const volume = new Map();                             // pool -> dollars traded
const addVolume = (key, dollars) => volume.set(key, (volume.get(key) ?? 0) + dollars);

if (!REPRICE) console.error(`reading the swaps of the last ${WINDOW} blocks…`);
let swaps = 0;
for (let to = REPRICE ? 0n : head; to > head - WINDOW; to -= STEP) {
  const from = to > STEP ? to - STEP : 0n;
  const [v4Logs, v3Logs] = await Promise.all([
    client.getLogs({ address: POOL_MANAGER, event: v4Swap, fromBlock: from, toBlock: to }).catch(() => []),
    client.getLogs({ event: v3Swap, fromBlock: from, toBlock: to }).catch(() => []),
  ]);
  for (const l of v4Logs) {
    const p = poolOf.get(l.args.id.toLowerCase());
    if (!p || p.kind !== "v4") continue;
    // the dollar side is whichever currency the dollar is
    const raw = p.assetIsToken0 ? l.args.amount1 : l.args.amount0;
    addVolume(l.args.id.toLowerCase(), Math.abs(Number(raw)) / 1e6);
  }
  for (const l of v3Logs) {
    const p = poolOf.get(l.address.toLowerCase());
    if (!p || p.kind !== "v3") continue;
    const raw = p.assetIsToken0 ? l.args.amount1 : l.args.amount0;
    addVolume(l.address.toLowerCase(), Math.abs(Number(raw)) / 1e6);
  }
  swaps += v4Logs.length + v3Logs.length;
  if (from === 0n) break;
}
if (!REPRICE) console.error(`  ${swaps.toLocaleString()} swaps, ${volume.size} pools with any volume at all`);

const best = new Map(); // asset -> its busiest pool against the dollar
for (const [key, dollars] of volume) {
  const p = poolOf.get(key);
  if (!p) continue;
  const prev = best.get(p.asset);
  if (!prev || dollars > prev.traded) best.set(p.asset, { ...p, traded: dollars });
}
const worthReading = [...best.entries()].filter(([, p]) => p.traded >= MIN_USD).sort((a, b) => b[1].traded - a[1].traded);
if (!REPRICE) console.error(`  ${worthReading.length} assets traded at least $${MIN_USD.toLocaleString()} against the dollar in that window`);

// ---- the chain's own shares ---------------------------------------------------------------------
//
// Volume is the wrong question for these. Every tokenised share on 4663 is a clone of one beacon
// proxy, so a single codehash separates the issuer's own tokens from the ones that only borrow the
// name, and plenty do: five tokens here answer to NVDA and four of them are jokes. A share of
// Boeing that saw no swap in the last hour is still a share of Boeing, and a creator who wants to
// be paid in one should find it in the menu. So these come in on identity, and the only thing they
// still have to prove is that their price is readable.
const EQUITY_CODEHASH = "0x6c1fdd40002dcb440c7fff6a84171404d279ccb057803b65826f7546acd65630";
const EQUITY_SUFFIX = " \u2022 Robinhood Token";

const equities = new Map(); // asset -> { symbol, decimals, company }
if (!REPRICE && !process.argv.includes("--no-equities")) {
  const assets = [...candidates.keys()];
  console.error(`reading the name of all ${assets.length.toLocaleString()} of them, to find the chain's own shares…`);
  const names = await readMany(assets.map((address) => ({ address, abi: erc20Abi, functionName: "name" })));
  const named = assets.filter((_, i) => {
    const n = names[i];
    return n.status === "success" && typeof n.result === "string" && n.result.endsWith(EQUITY_SUFFIX);
  });
  console.error(`  ${named.length} carry the issuer's name; checking each one's code`);
  const genuine = [];
  for (let i = 0; i < named.length; i += 25) {
    const chunk = named.slice(i, i + 25);
    const codes = await Promise.all(chunk.map((a) => client.getBytecode({ address: a }).catch(() => null)));
    chunk.forEach((a, j) => { if (codes[j] && keccak256(codes[j]) === EQUITY_CODEHASH) genuine.push(a); });
  }
  console.error(`  ${genuine.length} are clones of the issuer's beacon; the other ${named.length - genuine.length} only borrow the name`);
  const meta = await readMany(genuine.flatMap((address) => [
    { address, abi: erc20Abi, functionName: "symbol" },
    { address, abi: erc20Abi, functionName: "decimals" },
    { address, abi: erc20Abi, functionName: "name" },
  ]));
  genuine.forEach((address, i) => {
    const [symbol, decimals, name] = [meta[i * 3], meta[i * 3 + 1], meta[i * 3 + 2]];
    if (symbol.status !== "success" || decimals.status !== "success") return;
    equities.set(address, {
      symbol: symbol.result,
      decimals: Number(decimals.result),
      company: name.status === "success" ? String(name.result).slice(0, -EQUITY_SUFFIX.length) : String(symbol.result),
    });
  });
}

const rows = [];

// The shares go in first, so a menu that is ever cut short is cut short at the memes.
for (const [asset, share] of equities) {
  if (share.decimals > 18) { rows.push({ address: asset, symbol: share.symbol, decimals: share.decimals, verdict: "more than eighteen decimals" }); continue; }
  const price = await priceOf(asset, candidates.get(asset) ?? [], share.decimals);
  if (!price || !(price.usd > 0) || !Number.isFinite(price.usd)) {
    rows.push({ address: asset, symbol: share.symbol, decimals: share.decimals, verdict: "no pool with a readable price" });
    continue;
  }
  rows.push({
    address: asset, symbol: share.symbol, name: share.company, decimals: share.decimals, share: true,
    usd: price.usd, traded: Math.round(best.get(asset)?.traded ?? 0),
    pool: price.kind === "v3"
      ? { kind: "v3", pool: price.pool, assetIsToken0: price.assetIsToken0 }
      : { kind: "v4", poolId: price.poolId, assetIsToken0: price.assetIsToken0 },
    verdict: "candidate",
  });
}
console.error(`  ${rows.filter((r) => r.verdict === "candidate").length} of them can be priced`);

// `--limit` is the size of the meme half of the menu. The shares above are not rationed by it:
// they are the chain's own assets, and there are two hundred of them at most.
let byVolume = 0;
for (const [asset, pool] of worthReading) {
  if (equities.has(asset)) continue; // already in, on identity
  if (byVolume >= LIMIT) break;
  byVolume++;
  let symbol = "";
  let decimals = 0;
  try {
    [symbol, decimals] = await Promise.all([
      client.readContract({ address: asset, abi: erc20Abi, functionName: "symbol" }),
      client.readContract({ address: asset, abi: erc20Abi, functionName: "decimals" }),
    ]);
  } catch {
    rows.push({ address: asset, verdict: "not an erc20 that answers symbol and decimals" });
    continue;
  }
  decimals = Number(decimals);
  if (decimals > 18) { rows.push({ address: asset, symbol, decimals, verdict: "more than eighteen decimals" }); continue; }

  const price = await priceOf(asset, [pool], decimals);
  if (!price) { rows.push({ address: asset, symbol, decimals, verdict: "no pool with a readable price" }); continue; }
  if (!(price.usd > 0) || !Number.isFinite(price.usd)) { rows.push({ address: asset, symbol, decimals, verdict: "price is not a number" }); continue; }

  rows.push({
    address: asset, symbol, decimals, usd: price.usd, traded: Math.round(pool.traded),
    pool: price.kind === "v3"
      ? { kind: "v3", pool: price.pool, assetIsToken0: price.assetIsToken0 }
      : { kind: "v4", poolId: price.poolId, assetIsToken0: price.assetIsToken0 },
    verdict: "candidate",
  });
  console.error(`  ${symbol.padEnd(10)} $${price.usd.toFixed(4).padStart(12)}  $${Math.round(pool.traded).toLocaleString().padStart(12)} traded`);
}

// The ones that were in the menu before and did not come up this time: same asset, same pools, a
// price read again now.
let carried = 0;
for (const a of offered) {
  if (rows.some((r) => r.address.toLowerCase() === a.address.toLowerCase())) continue;
  const pools = candidates.get(getAddress(a.address)) ?? (a.pool ? [a.pool] : []);
  const price = await priceOf(getAddress(a.address), pools, a.decimals);
  if (!price || !(price.usd > 0) || !Number.isFinite(price.usd)) {
    // It was in the menu and its price has gone. Said out loud rather than dropped, because an
    // asset that is allowed on chain and priced nowhere is the one thing this file exists to catch.
    rows.push({ address: a.address, symbol: a.symbol, decimals: a.decimals, verdict: "no pool with a readable price" });
    continue;
  }
  rows.push({
    ...a, usd: price.usd, traded: Math.round(best.get(getAddress(a.address))?.traded ?? a.traded ?? 0),
    pool: price.kind === "v3"
      ? { kind: "v3", pool: price.pool, assetIsToken0: price.assetIsToken0 }
      : { kind: "v4", poolId: price.poolId, assetIsToken0: price.assetIsToken0 },
  });
  carried++;
}
if (carried) console.error(`  ${carried} priced again from the last run's list`);
// A verdict this run did not reach is still the last thing anybody established about that asset.
for (const a of previousAssets) {
  if (a.verdict === "candidate") continue;
  if (!rows.some((r) => r.address.toLowerCase() === a.address.toLowerCase())) rows.push(a);
}

mkdirSync(join(ROOT, "deploy"), { recursive: true });
const out = { chainId: 4663, readAt: new Date().toISOString(), minPoolUsd: MIN_USD, assets: rows };
writeFileSync(join(ROOT, "deploy/quotes.json"), `${JSON.stringify(out, null, 2)}\n`);
const good = rows.filter((r) => r.verdict === "candidate");
console.error(`\n${good.length} candidates of ${rows.length} assets -> deploy/quotes.json`);
console.error(ON_FORK ? "run the transfer screen next: node scripts/quotes/screen.mjs" : "screen them before allowing any: node scripts/quotes/screen.mjs");
