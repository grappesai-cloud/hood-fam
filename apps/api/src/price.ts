import { readFileSync } from "node:fs";

import { createPublicClient, http, parseAbiItem, zeroAddress, type Address } from "viem";
import { robinhood } from "@hood/sdk";
import { resolveQuote } from "./quote-resolver.js";

/// What a pair amount is worth in dollars.
///
/// Its own module rather than a corner of the indexer, because the indexer is not the only thing
/// that has to price something any more: the stake accrual credits points for dollars locked, and
/// the season take reports dollars earned. A module that everything can import is also a module
/// that cannot take part in an import cycle, which is what this is really avoiding.

const RPC = process.env.HOOD_RPC ?? robinhood.rpcUrls.default.http[0]!;
/// Batched, because `/pairs` now prices three hundred assets at once: one Multicall3 call per
/// batch instead of three hundred round trips a minute at a public node that rate limits.
const client = createPublicClient({
  chain: robinhood,
  transport: http(RPC),
  batch: { multicall: { batchSize: 1024, wait: 16 } },
});

const ETH_USD_FEED = "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9" as Address;

/// Volume has to be priced in dollars for points to mean anything across pairs. The Chainlink
/// ETH/USD feed on 4663 is the source; the last good answer is kept, because a feed that hiccups
/// for a minute must not quietly price a day of trading at zero. HOOD_ETH_USD is the floor under
/// that: on a chain with no feed at all (a local run), it is the only price there is.
const FALLBACK_ETH_USD = Number(process.env.HOOD_ETH_USD ?? 0);
let ethUsd = { price: FALLBACK_ETH_USD, at: 0 };
let ethUsdSource: UsdSource | null = FALLBACK_ETH_USD > 0 ? "fallback" : null;
let warnedNoPrice = false;

export async function ethUsdPrice(): Promise<number> {
  if (Date.now() - ethUsd.at < 60_000 && ethUsd.price > 0) return ethUsd.price;
  try {
    const answer = (await client.readContract({
      address: ETH_USD_FEED,
      abi: [parseAbiItem("function latestAnswer() view returns (int256)")],
      functionName: "latestAnswer",
    })) as bigint;
    if (answer > 0n) {
      ethUsd = { price: Number(answer) / 1e8, at: Date.now() };
      ethUsdSource = "feed";
    }
  } catch {
    ethUsd = { price: ethUsd.price || FALLBACK_ETH_USD, at: Date.now() };
    if (!ethUsdSource && ethUsd.price > 0) ethUsdSource = "fallback";
  }
  if (ethUsd.price === 0 && !warnedNoPrice) {
    warnedNoPrice = true;
    console.warn(
      "no ETH/USD price: trades in the native pair are being credited zero points. " +
      "Set HOOD_ETH_USD, or point HOOD_RPC at a chain that carries the Chainlink feed.",
    );
  }
  return ethUsd.price;
}

/// Every asset a launch is allowed to trade against, and where its dollar price comes from.
///
/// This chain's whole point is that a share of NVIDIA is an ERC-20 like any other, so a launch can
/// be paired against one and its creator paid in one. That only works if the indexer can say what
/// a share is worth: points are dollars, and a pair nobody can price is a pair whose trades are
/// credited zero. So each asset carries its own source, read off the chain:
///
/// - the chain's own currency: the Chainlink feed above,
/// - the dollar: itself,
/// - a share: the Uniswap v3 pool it trades against the dollar in, by `slot0`.
///
/// `scripts/checks/pair-prices.mjs` prints all of them, so a pool that moves or dries up is
/// visible rather than silently wrong. Adding an asset is this table plus `setPair` on the
/// factory; nothing else in the system knows the list.
export interface PairAsset {
  symbol: string;
  decimals: number;
  /// The company or fund behind a tokenised share, as the token itself names it. A ticker alone is
  /// not an identification when five tokens on this chain answer to NVDA.
  name?: string;
  /// A share of a company rather than a currency, verified by the issuer's own code.
  share?: boolean;
  /// The pool this asset trades against USDG in, and which side of it the asset sits on. A v3 pool
  /// answers `slot0()` at its own address; a v4 pool has no address at all, only an id inside the
  /// PoolManager, read through the StateView the graduator already uses. Both give the same
  /// number, and which one an asset has is an accident of where its liquidity landed.
  usdPool?: { kind: "v3"; pool: Address; assetIsToken0: boolean }
    | { kind: "v4"; poolId: `0x${string}`; assetIsToken0: boolean };
  /// True for the dollar itself.
  isDollar?: boolean;
}

/// The v4 StateView on 4663. Same one the graduator reads pool state through.
const STATE_VIEW = "0xF3334192D15450CdD385c8B70e03f9A6bD9E673b" as Address;

/// The table the pad ships with: the chain's own currency, the dollar, and the tokenised shares
/// that were read off the chain by hand. Everything else arrives from `deploy/quotes.json` below,
/// which is how a quote added after this build still gets a price.
const BUILT_IN: Record<string, PairAsset> = {
  [zeroAddress]: { symbol: "ETH", decimals: 18 },
  "0x5fc5360d0400a0fd4f2af552add042d716f1d168": { symbol: "USDG", decimals: 6, isDollar: true },
  "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec": {
    symbol: "NVDA", decimals: 18,
    usdPool: { kind: "v3", pool: "0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3", assetIsToken0: false },
  },
  "0x1b0e319c6a659f002271b69db8a7df2f911c153e": {
    symbol: "GME", decimals: 18,
    usdPool: { kind: "v3", pool: "0xe9713f453adb9245b19559790c96f470a18f2fdf", assetIsToken0: true },
  },
  "0x117cc2133c37b721f49de2a7a74833232b3b4c0c": {
    symbol: "SPY", decimals: 18,
    usdPool: { kind: "v3", pool: "0xa7bb1ac63bbab0c44316e6c8c455213441689167", assetIsToken0: true },
  },
  "0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea": {
    symbol: "SPCX", decimals: 18,
    usdPool: { kind: "v3", pool: "0xc61284332117c3fb23a2a56cceffd07f7af60029", assetIsToken0: true },
  },
  "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9": {
    symbol: "AAPL", decimals: 18,
    usdPool: { kind: "v3", pool: "0xaae0d815ee56e4092a5e5c2911e676fea50b2d6d", assetIsToken0: false },
  },
  "0xc0d6457c16cc70d6790dd43521c899c87ce02f35": {
    symbol: "META", decimals: 18,
    usdPool: { kind: "v4", poolId: "0xc58bb68060bcb7b3ea0f6d4a4afef1e57f628722e808db12afb6d1733552872f", assetIsToken0: false },
  },
  "0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3": {
    symbol: "GOOGL", decimals: 18,
    usdPool: { kind: "v4", poolId: "0xf28d25a3078d0cf697ff18767f57052090aca2ffdfd11c808d6f29e96b44506a", assetIsToken0: true },
  },
  "0xc72b96e0e48ecd4dc75e1e45396e26300bc39681": {
    symbol: "INTC", decimals: 18,
    usdPool: { kind: "v4", poolId: "0x4d0e6d81d9634c20ea0fd3f980f67560c06a76f3d530eef9654ecca7381acb53", assetIsToken0: false },
  },
};

/// Every asset the discovery found and the owner allowed. Read from the file rather than compiled
/// in, so allowing a new quote is a plan, a transaction and a restart, not a release.
function discovered(): Record<string, PairAsset> {
  const out: Record<string, PairAsset> = {};
  try {
    const file = new URL("../../../deploy/quotes.json", import.meta.url);
    const found = JSON.parse(readFileSync(file, "utf8")) as {
      assets: {
        address: string; symbol: string; name?: string; share?: boolean; decimals: number;
        verdict: string; pool?: PairAsset["usdPool"];
      }[];
    };
    for (const a of found.assets) {
      if (a.verdict !== "candidate" || !a.pool) continue;
      const key = a.address.toLowerCase();
      if (BUILT_IN[key]) {
        // What was checked by hand wins on the price source, but the scan is the only thing that
        // knows the company behind the ticker, so that much is taken from it.
        if (a.name) BUILT_IN[key]!.name = a.name;
        if (a.share) BUILT_IN[key]!.share = true;
        continue;
      }
      out[key] = { symbol: a.symbol, name: a.name, share: a.share, decimals: a.decimals, usdPool: a.pool };
    }
  } catch {
    // No file, or a file this build cannot read: the built in table is the whole answer, which is
    // what every deployment before the discovery existed ran on.
  }
  return out;
}

export const PAIR_ASSETS: Record<string, PairAsset> = { ...BUILT_IN, ...discovered() };

const slot0Abi = parseAbiItem(
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 a, uint16 b, uint16 c, uint8 d, bool e)",
);
const getSlot0Abi = parseAbiItem(
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
);

const poolPrices = new Map<string, { price: number; at: number }>();

/// Where a dollar figure came from, said next to it. A page that prints "$1.2M" owes the reader
/// the source: a Chainlink feed, a USDG pool this process read, the resolver's best pool for a
/// pair nobody registered, or a number an operator typed into HOOD_ETH_USD. And when there is no
/// source, the answer is `null` with the reason, never a zero: a zero reads as a measurement
/// somebody took, and nobody took it.
export type UsdSource = "dollar" | "feed" | "pool" | "resolver" | "fallback";
export interface UsdQuote { usd: number | null; source: UsdSource | null; reason: string | null }

export async function pairUsdQuote(pairToken: string): Promise<UsdQuote> {
  const key = pairToken.toLowerCase();
  const asset = PAIR_ASSETS[key];
  if (!asset) {
    try {
      const resolved = await resolveQuote(key);
      if (resolved.usd > 0) return { usd: resolved.usd, source: "resolver", reason: null };
      return { usd: null, source: null, reason: `no USDG pool quotes ${resolved.symbol}` };
    } catch {
      return { usd: null, source: null, reason: "this pair is not in the price registry and no pool quotes it" };
    }
  }
  if (asset.isDollar) return { usd: 1, source: "dollar", reason: null };
  if (!asset.usdPool) {
    const eth = await ethUsdPrice();
    if (eth > 0) return { usd: eth, source: ethUsdSource ?? "feed", reason: null };
    return { usd: null, source: null, reason: "the ETH/USD feed is unreachable and no fallback price is set" };
  }
  const price = await poolPrice(key, asset);
  if (price > 0) return { usd: price, source: "pool", reason: null };
  return { usd: null, source: null, reason: `the ${asset.symbol}/USDG pool could not be read` };
}

/// What one whole unit of a pair asset is worth in dollars, or zero when nobody knows. The zero is
/// for the callers that add dollars up (points, season takes), where an unknown pair contributes
/// nothing; anything a reader sees goes through `pairUsdQuote` and prints the reason instead.
export async function pairUsdPrice(pairToken: string): Promise<number> {
  return (await pairUsdQuote(pairToken)).usd ?? 0;
}

async function poolPrice(pairToken: string, asset: PairAsset): Promise<number> {
  const cached = poolPrices.get(pairToken);
  if (cached && Date.now() - cached.at < 60_000 && cached.price > 0) return cached.price;
  try {
    const usdPool = asset.usdPool!;
    const sqrtPriceX96 = usdPool.kind === "v3"
      ? ((await client.readContract({
          address: usdPool.pool, abi: [slot0Abi], functionName: "slot0",
        })) as readonly [bigint, ...unknown[]])[0]
      : ((await client.readContract({
          address: STATE_VIEW, abi: [getSlot0Abi], functionName: "getSlot0", args: [usdPool.poolId],
        })) as readonly [bigint, ...unknown[]])[0];
    // A pool's price is token1 per token0 in RAW units, so the two decimals decide the scale: a
    // share has eighteen and the dollar six, but wrapped bitcoin has eight, and assuming the
    // eighteen priced it at eight hundred trillion dollars a coin.
    const raw = (Number(sqrtPriceX96) / 2 ** 96) ** 2;
    const scale = 10 ** (asset.decimals - 6);
    const price = usdPool.assetIsToken0 ? raw * scale : scale / raw;
    if (Number.isFinite(price) && price > 0) poolPrices.set(pairToken, { price, at: Date.now() });
  } catch {
    // Keep the last good answer: a pool that cannot be read for a minute must not price a day of
    // trading at zero, the same rule the feed above lives under.
  }
  return poolPrices.get(pairToken)?.price ?? 0;
}

export async function usdValue(pairToken: string, amount: bigint): Promise<number> {
  const key = pairToken.toLowerCase();
  const asset = PAIR_ASSETS[key];
  if (asset) return (Number(amount) / 10 ** asset.decimals) * (await pairUsdPrice(key));
  try {
    const resolved = await resolveQuote(key);
    return (Number(amount) / 10 ** resolved.decimals) * resolved.usd;
  } catch {
    return 0;
  }
}
