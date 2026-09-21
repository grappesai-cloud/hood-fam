import { createPublicClient, http, parseAbiItem, zeroAddress, type Address } from "viem";
import { robinhood } from "@hood/sdk";

/// What a pair amount is worth in dollars.
///
/// Its own module rather than a corner of the indexer, because the indexer is not the only thing
/// that has to price something any more: the stake accrual credits points for dollars locked, and
/// the season take reports dollars earned. A module that everything can import is also a module
/// that cannot take part in an import cycle, which is what this is really avoiding.

const RPC = process.env.HOOD_RPC ?? robinhood.rpcUrls.default.http[0]!;
const client = createPublicClient({ chain: robinhood, transport: http(RPC) });

const ETH_USD_FEED = "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9" as Address;

/// Volume has to be priced in dollars for points to mean anything across pairs. The Chainlink
/// ETH/USD feed on 4663 is the source; the last good answer is kept, because a feed that hiccups
/// for a minute must not quietly price a day of trading at zero. HOOD_ETH_USD is the floor under
/// that: on a chain with no feed at all (a local run), it is the only price there is.
const FALLBACK_ETH_USD = Number(process.env.HOOD_ETH_USD ?? 0);
let ethUsd = { price: FALLBACK_ETH_USD, at: 0 };
let warnedNoPrice = false;

export async function ethUsdPrice(): Promise<number> {
  if (Date.now() - ethUsd.at < 60_000 && ethUsd.price > 0) return ethUsd.price;
  try {
    const answer = (await client.readContract({
      address: ETH_USD_FEED,
      abi: [parseAbiItem("function latestAnswer() view returns (int256)")],
      functionName: "latestAnswer",
    })) as bigint;
    if (answer > 0n) ethUsd = { price: Number(answer) / 1e8, at: Date.now() };
  } catch {
    ethUsd = { price: ethUsd.price || FALLBACK_ETH_USD, at: Date.now() };
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
  /// The v3 pool this asset trades against USDG in, and which side of it the asset sits on.
  usdPool?: { pool: Address; assetIsToken0: boolean };
  /// True for the dollar itself.
  isDollar?: boolean;
}

export const PAIR_ASSETS: Record<string, PairAsset> = {
  [zeroAddress]: { symbol: "ETH", decimals: 18 },
  "0x5fc5360d0400a0fd4f2af552add042d716f1d168": { symbol: "USDG", decimals: 6, isDollar: true },
  "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec": {
    symbol: "NVDA", decimals: 18,
    usdPool: { pool: "0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3", assetIsToken0: false },
  },
  "0x1b0e319c6a659f002271b69db8a7df2f911c153e": {
    symbol: "GME", decimals: 18,
    usdPool: { pool: "0xe9713f453adb9245b19559790c96f470a18f2fdf", assetIsToken0: true },
  },
  "0x117cc2133c37b721f49de2a7a74833232b3b4c0c": {
    symbol: "SPY", decimals: 18,
    usdPool: { pool: "0xa7bb1ac63bbab0c44316e6c8c455213441689167", assetIsToken0: true },
  },
};

const slot0Abi = parseAbiItem(
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 a, uint16 b, uint16 c, uint8 d, bool e)",
);

const poolPrices = new Map<string, { price: number; at: number }>();

/// What one whole unit of a pair asset is worth in dollars.
export async function pairUsdPrice(pairToken: string): Promise<number> {
  const asset = PAIR_ASSETS[pairToken.toLowerCase()];
  if (!asset) return 0;
  if (asset.isDollar) return 1;
  if (!asset.usdPool) return ethUsdPrice();

  const cached = poolPrices.get(pairToken);
  if (cached && Date.now() - cached.at < 60_000 && cached.price > 0) return cached.price;
  try {
    const slot0 = (await client.readContract({
      address: asset.usdPool.pool, abi: [slot0Abi], functionName: "slot0",
    })) as readonly [bigint, number, number, number, number, number, boolean];
    // A v3 pool's price is token1 per token0; the dollar has six decimals and a share eighteen,
    // so the same twelve orders of magnitude go one way or the other depending on the sort order.
    const raw = (Number(slot0[0]) / 2 ** 96) ** 2;
    const price = asset.usdPool.assetIsToken0 ? raw * 1e12 : 1e12 / raw;
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
  if (!asset) return 0;
  return (Number(amount) / 10 ** asset.decimals) * (await pairUsdPrice(key));
}
