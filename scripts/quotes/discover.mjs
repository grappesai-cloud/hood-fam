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
  createPublicClient, createWalletClient, erc20Abi, getAddress, http, parseAbiItem,
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

const headNow = await client.getBlockNumber();
const cache = loadCache();
const from = BigInt(cache.scannedTo || 0);
console.error(from === 0n
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

/// The deepest pool an asset has, and what it says the asset is worth.
async function priceOf(asset, pools, decimals) {
  let best = null;
  for (const p of pools.slice(0, 24)) {
    try {
      if (p.kind === "v3") {
        const [slot0, liquidity] = await Promise.all([
          client.readContract({ address: p.pool, abi: v3Pool, functionName: "slot0" }),
          client.readContract({ address: p.pool, abi: v3Pool, functionName: "liquidity" }),
        ]);
        if (slot0[0] === 0n || liquidity === 0n) continue;
        // Real dollars sitting in the pool, which is the only depth figure that cannot be inflated
        // by a price nobody trades at.
        const held = await client.readContract({ address: USDG, abi: erc20Abi, functionName: "balanceOf", args: [p.pool] });
        const usd = usdFrom(slot0[0], p.assetIsToken0, decimals);
        const depth = Number(held) / 1e6;
        if (!best || depth > best.depth) best = { ...p, usd, depth };
      } else {
        const [slot0, liquidity] = await Promise.all([
          client.readContract({ address: STATE_VIEW, abi: stateView, functionName: "getSlot0", args: [p.poolId] }),
          client.readContract({ address: STATE_VIEW, abi: stateView, functionName: "getLiquidity", args: [p.poolId] }),
        ]);
        if (slot0[0] === 0n || liquidity === 0n) continue;
        const usd = usdFrom(slot0[0], p.assetIsToken0, decimals);
        // v4 keeps every pool's money in one contract, so the dollars in THIS pool are the virtual
        // reserve: liquidity divided by the square root of the price, in the dollar's direction.
        const sqrt = Number(slot0[0]) / 2 ** 96;
        const dollars = p.assetIsToken0 ? (Number(liquidity) * sqrt) / 1e6 : Number(liquidity) / sqrt / 1e6;
        if (!best || dollars > best.depth) best = { ...p, usd, depth: dollars };
      }
    } catch { /* a pool that will not answer is not a price */ }
  }
  return best;
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

console.error(`reading the swaps of the last ${WINDOW} blocks…`);
let swaps = 0;
for (let to = head; to > head - WINDOW; to -= STEP) {
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
console.error(`  ${swaps.toLocaleString()} swaps, ${volume.size} pools with any volume at all`);

const best = new Map(); // asset -> its busiest pool against the dollar
for (const [key, dollars] of volume) {
  const p = poolOf.get(key);
  if (!p) continue;
  const prev = best.get(p.asset);
  if (!prev || dollars > prev.traded) best.set(p.asset, { ...p, traded: dollars });
}
const worthReading = [...best.entries()].filter(([, p]) => p.traded >= MIN_USD).sort((a, b) => b[1].traded - a[1].traded);
console.error(`  ${worthReading.length} assets traded at least $${MIN_USD.toLocaleString()} against the dollar in that window`);

const rows = [];
for (const [asset, pool] of worthReading) {
  if (rows.length >= LIMIT) break;
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

mkdirSync(join(ROOT, "deploy"), { recursive: true });
const out = { chainId: 4663, readAt: new Date().toISOString(), minPoolUsd: MIN_USD, assets: rows };
writeFileSync(join(ROOT, "deploy/quotes.json"), `${JSON.stringify(out, null, 2)}\n`);
const good = rows.filter((r) => r.verdict === "candidate");
console.error(`\n${good.length} candidates of ${rows.length} assets -> deploy/quotes.json`);
console.error(ON_FORK ? "run the transfer screen next: node scripts/quotes/screen.mjs" : "screen them before allowing any: node scripts/quotes/screen.mjs");
