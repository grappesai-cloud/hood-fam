import { zeroAddress } from "viem";

/// Links into Uniswap's own app, prefilled, so this pad never has to carry a pool-creation or a
/// position form of its own. The app reads a v4 pool key straight off the query string: the two
/// currencies (`NATIVE` for ether), the chain's slug, the fee as a small JSON object that also
/// names the tick spacing and whether the fee is the dynamic flag, and the hook when there is one.
/// A project clicks, sets a price, deposits, and Uniswap handles the wallet, the approvals and the
/// transaction.
export const UNISWAP_CHAIN = "robinhood";

/// v4 marks a pool with a dynamic fee by this value in the fee slot rather than by a fee tier.
export const DYNAMIC_FEE_FLAG = 0x800000;

export interface PoolKeyLike {
  currency0: string; currency1: string; fee: number; tickSpacing: number; hooks?: string | null;
}

const currency = (c: string) => (c.toLowerCase() === zeroAddress ? "NATIVE" : c);

/// The two sides of a v4 pool in the order the PoolManager keys them: lower address first, and
/// ether (the zero address) is always the lower one.
export function sortedPair(a: string, b: string): [string, string] {
  return a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
}

export function uniswapSwapUrl(token: string, pairToken: string): string {
  const input = pairToken.toLowerCase() === zeroAddress ? "ETH" : pairToken;
  return `https://app.uniswap.org/swap?chain=${UNISWAP_CHAIN}&inputCurrency=${input}&outputCurrency=${token}`;
}

export function uniswapAddLiquidityUrl(key: PoolKeyLike): string {
  const fee = encodeURIComponent(JSON.stringify({
    isDynamic: key.fee === DYNAMIC_FEE_FLAG, feeAmount: key.fee, tickSpacing: key.tickSpacing,
  }));
  const hook = key.hooks && key.hooks.toLowerCase() !== zeroAddress ? `&hook=${key.hooks}` : "";
  return `https://app.uniswap.org/positions/create/v4?currencyA=${currency(key.currency0)}&currencyB=${currency(key.currency1)}&chain=${UNISWAP_CHAIN}&fee=${fee}${hook}`;
}

export function uniswapPoolUrl(poolId: string): string {
  return `https://app.uniswap.org/explore/pools/${UNISWAP_CHAIN}/${poolId}`;
}
