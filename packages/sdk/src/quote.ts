import {
  type Address,
  type Hex,
  type PublicClient,
  BaseError,
  ContractFunctionRevertedError,
  zeroAddress,
} from "viem";

import { hoodBuybackModuleAbi, hoodLaunchHookAbi } from "./abi.generated.js";
import { uniswapV4 } from "./chains.js";
import { type PoolKey, poolIdOf } from "./swap.js";

/// The V4Quoter: it runs the swap inside `unlock`, hook and all, and reverts with the number.
/// The one on 4663 is the canonical contract (its selectors are in the bytecode); only the
/// router is the Robinhood fork with the extra field.
export const v4QuoterAbi = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [{
      name: "params",
      type: "tuple",
      components: [
        {
          name: "poolKey",
          type: "tuple",
          components: [
            { name: "currency0", type: "address" },
            { name: "currency1", type: "address" },
            { name: "fee", type: "uint24" },
            { name: "tickSpacing", type: "int24" },
            { name: "hooks", type: "address" },
          ],
        },
        { name: "zeroForOne", type: "bool" },
        { name: "exactAmount", type: "uint128" },
        { name: "hookData", type: "bytes" },
      ],
    }],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

/// The read side of the PoolManager, for the estimate that needs no quoter.
export const stateViewAbi = [
  {
    type: "function", name: "getSlot0", stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" }, { name: "tick", type: "int24" },
      { name: "protocolFee", type: "uint24" }, { name: "lpFee", type: "uint24" },
    ],
  },
  {
    type: "function", name: "getLiquidity", stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [{ name: "liquidity", type: "uint128" }],
  },
] as const;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export interface QuoteDirectSwapParams {
  publicClient: PublicClient;
  poolKey: PoolKey;
  tokenIn: Address;
  amountIn: bigint;
  /// The quoter to ask. Defaults to the chain's own; `null` says there is none and the number is
  /// computed here from the pool's state instead (see `estimateSingleRangeSwap` for what that
  /// leaves out).
  quoter?: Address | null;
  hookData?: Hex;
  /// Only read without a quoter: where the pool's price and liquidity come from.
  stateView?: Address;
}

export interface DirectQuote {
  amountOut: bigint;
  zeroForOne: boolean;
  /// Where the number came from: the chain's quoter, or the single-range estimate.
  source: "quoter" | "estimate";
  gasEstimate?: bigint;
}

/// What an exact-input swap on a hooked pool returns right now, the hook's tax and the pool fee
/// both taken. The quoter executes the very swap the router will, so whatever the hook does to
/// the amounts is in the number. What it cannot see is the next block: that is what the slippage
/// on top of it is for.
export async function quoteDirectSwap(p: QuoteDirectSwapParams): Promise<DirectQuote> {
  const zeroForOne = same(p.tokenIn, p.poolKey.currency0);
  if (!zeroForOne && !same(p.tokenIn, p.poolKey.currency1)) throw new Error("tokenIn is not in the pool");
  const quoter = p.quoter === undefined ? (uniswapV4.quoter as Address) : p.quoter;
  if (p.amountIn <= 0n) return { amountOut: 0n, zeroForOne, source: quoter ? "quoter" : "estimate" };
  if (!quoter) return estimateFromChain(p, zeroForOne);

  const { result } = await p.publicClient.simulateContract({
    address: quoter,
    abi: v4QuoterAbi,
    functionName: "quoteExactInputSingle",
    args: [{ poolKey: p.poolKey, zeroForOne, exactAmount: p.amountIn, hookData: p.hookData ?? "0x" }],
  });
  const [amountOut, gasEstimate] = result;
  return { amountOut, zeroForOne, source: "quoter", gasEstimate };
}

/// The floor to send with a quote: the quote less `slippageBps`, rounded down.
export function minOutFromQuote(amountOut: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    throw new Error(`slippage must be 0 to 10000 bps, got ${slippageBps}`);
  }
  return (amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
}

/// What `HoodBuybackModule.run` would burn for a launch right now, found by running it in a call
/// with no floor and reading what it returns. The module stops at its impact limit and carries
/// the rest, so this is the one quote that is exact for a run: the whole pot through the quoter
/// would overstate it. Nothing to spend is zero, not an error.
export async function quoteBuybackRun({ publicClient, buybackModule, token }: {
  publicClient: PublicClient;
  buybackModule: Address;
  token: Address;
}): Promise<bigint> {
  try {
    const { result } = await publicClient.simulateContract({
      address: buybackModule, abi: hoodBuybackModuleAbi, functionName: "run", args: [token, 0n],
    });
    return result;
  } catch (e) {
    if (revertName(e) === "Nothing") return 0n;
    throw e;
  }
}

function revertName(e: unknown): string | undefined {
  if (!(e instanceof BaseError)) return undefined;
  const revert = e.walk((x) => x instanceof ContractFunctionRevertedError);
  return revert instanceof ContractFunctionRevertedError ? revert.data?.errorName : undefined;
}

// ---------------------------------------------------------------- the estimate

/// The hook's tax on the quote leg: off the input of a buy, off the output of a sell.
export interface SwapTax {
  bps: number;
  side: "input" | "output";
}

export interface SingleRangeSwapInput {
  sqrtPriceX96: bigint;
  /// The liquidity in range at the current price.
  liquidity: bigint;
  /// The pool's swap fee in pips (1e6 is 100%).
  feePips: number;
  zeroForOne: boolean;
  amountIn: bigint;
  tax?: SwapTax;
  /// Where the swap has to stop: the edge of the range, or an impact cap. Defaults to the pool's
  /// own limits, which is the same as saying the range is unbounded.
  sqrtPriceLimitX96?: bigint;
}

export interface SingleRangeSwapResult {
  amountOut: bigint;
  /// What the swapper parts with: the tax, the fee and what the pool took. Less than `amountIn`
  /// only when the limit was hit.
  amountInUsed: bigint;
  feeAmount: bigint;
  taxAmount: bigint;
  sqrtPriceAfterX96: bigint;
  /// True when the swap stopped at the limit with input to spare. On chain that is a partial
  /// fill, which the quoter reports as NotEnoughLiquidity and the router refuses.
  exhausted: boolean;
}

const Q96 = 1n << 96n;
const MAX_FEE_PIPS = 1_000_000n;
const MIN_SQRT_PRICE = 4295128739n;
const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const mulDivUp = (a: bigint, b: bigint, d: bigint) => ceilDiv(a * b, d);

/// Token0 between two prices: L * (sqrtB - sqrtA) / (sqrtA * sqrtB), with the pool's rounding.
function amount0Delta(sqrtA: bigint, sqrtB: bigint, liquidity: bigint, roundUp: boolean): bigint {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  const numerator1 = liquidity << 96n;
  const numerator2 = sqrtB - sqrtA;
  return roundUp
    ? ceilDiv(mulDivUp(numerator1, numerator2, sqrtB), sqrtA)
    : (numerator1 * numerator2) / sqrtB / sqrtA;
}

/// Token1 between two prices: L * (sqrtB - sqrtA).
function amount1Delta(sqrtA: bigint, sqrtB: bigint, liquidity: bigint, roundUp: boolean): bigint {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  return roundUp ? mulDivUp(liquidity, sqrtB - sqrtA, Q96) : (liquidity * (sqrtB - sqrtA)) / Q96;
}

/// Where the price lands after the pool takes `amountIn` of one side. Token0 in pushes the price
/// down and rounds up; token1 in pushes it up and rounds down. Both round against the swapper.
function nextSqrtPriceFromInput(sqrtP: bigint, liquidity: bigint, amountIn: bigint, zeroForOne: boolean): bigint {
  if (amountIn === 0n) return sqrtP;
  if (zeroForOne) {
    const numerator1 = liquidity << 96n;
    return mulDivUp(numerator1, sqrtP, numerator1 + amountIn * sqrtP);
  }
  return sqrtP + (amountIn << 96n) / liquidity;
}

/// The output of an exact-input swap against one liquidity range, the way the pool computes it
/// (SwapMath.computeSwapStep over SqrtPriceMath, in bigint), with the launch hook's tax applied
/// around it: off the input before the swap for a buy, off the output after it for a sell.
///
/// Closed form, at a price sqrtP with liquidity L and an input x already net of tax and fee:
/// token0 in gives token1 out of L * x * sqrtP / (L / sqrtP + x); token1 in gives token0 out of
/// L * x / (sqrtP * (L * sqrtP + x)). At tick zero both collapse to L * x / (L + x).
///
/// What it assumes, and the quoter does not: that the liquidity is one range and the swap stays
/// inside it (no tick is crossed, so `liquidity` holds throughout), that the tokens are plain (no
/// fee on transfer, no rebasing), and that the hook takes exactly `bps` of the quote leg and
/// nothing else. Past the range's edge or the limit the output stops and `exhausted` is set.
export function estimateSingleRangeSwap(p: SingleRangeSwapInput): SingleRangeSwapResult {
  if (p.liquidity <= 0n) throw new Error("no liquidity in range");
  if (p.sqrtPriceX96 <= 0n) throw new Error("bad price");
  if (!Number.isInteger(p.feePips) || p.feePips < 0 || p.feePips >= 1_000_000) throw new Error("bad fee");
  if (p.amountIn < 0n) throw new Error("bad amount");
  const taxBps = BigInt(p.tax?.bps ?? 0);
  if (taxBps < 0n || taxBps > 10_000n) throw new Error("bad tax");

  const zeroForOne = p.zeroForOne;
  const limit = p.sqrtPriceLimitX96 ?? (zeroForOne ? MIN_SQRT_PRICE + 1n : MAX_SQRT_PRICE - 1n);
  if (zeroForOne ? limit >= p.sqrtPriceX96 : limit <= p.sqrtPriceX96) throw new Error("price limit is on the wrong side");

  // a buy's tax comes off the input before the pool sees it
  let taxAmount = 0n;
  let remaining = p.amountIn;
  if (p.tax?.side === "input") {
    taxAmount = (remaining * taxBps) / 10_000n;
    remaining -= taxAmount;
  }

  const feePips = BigInt(p.feePips);
  const lessFee = (remaining * (MAX_FEE_PIPS - feePips)) / MAX_FEE_PIPS;
  const toLimit = zeroForOne
    ? amount0Delta(limit, p.sqrtPriceX96, p.liquidity, true)
    : amount1Delta(p.sqrtPriceX96, limit, p.liquidity, true);

  let sqrtNext: bigint;
  let poolIn: bigint;
  let feeAmount: bigint;
  let exhausted = false;
  if (lessFee >= toLimit) {
    // the limit caps the input; the fee is what the pool keeps on the way there
    sqrtNext = limit;
    poolIn = toLimit;
    feeAmount = mulDivUp(toLimit, feePips, MAX_FEE_PIPS - feePips);
    exhausted = lessFee > toLimit;
  } else {
    poolIn = lessFee;
    sqrtNext = nextSqrtPriceFromInput(p.sqrtPriceX96, p.liquidity, lessFee, zeroForOne);
    feeAmount = remaining - lessFee;
  }
  let amountOut = zeroForOne
    ? amount1Delta(sqrtNext, p.sqrtPriceX96, p.liquidity, false)
    : amount0Delta(p.sqrtPriceX96, sqrtNext, p.liquidity, false);

  // a sell's tax comes off what the pool pays out
  if (p.tax?.side === "output") {
    taxAmount = (amountOut * taxBps) / 10_000n;
    amountOut -= taxAmount;
  }

  return {
    amountOut,
    amountInUsed: (p.tax?.side === "input" ? taxAmount : 0n) + poolIn + feeAmount,
    feeAmount,
    taxAmount,
    sqrtPriceAfterX96: sqrtNext,
    exhausted,
  };
}

/// The fee the pool charges in one direction: the LP fee, or the protocol's slice stacked on it.
function swapFeePips(protocolFee: number, lpFee: number, zeroForOne: boolean): number {
  const p = zeroForOne ? protocolFee & 0xfff : protocolFee >> 12;
  return p === 0 ? lpFee : p + lpFee - Math.floor((p * lpFee) / 1_000_000);
}

/// The estimate from live state: price and liquidity from the StateView, the rate from the hook.
async function estimateFromChain(p: QuoteDirectSwapParams, zeroForOne: boolean): Promise<DirectQuote> {
  const stateView = p.stateView ?? (uniswapV4.stateView as Address);
  const id = poolIdOf(p.poolKey);
  const [slot0, liquidity] = await Promise.all([
    p.publicClient.readContract({ address: stateView, abi: stateViewAbi, functionName: "getSlot0", args: [id] }),
    p.publicClient.readContract({ address: stateView, abi: stateViewAbi, functionName: "getLiquidity", args: [id] }),
  ]);
  const [sqrtPriceX96, , protocolFee, lpFee] = slot0;

  let tax: SwapTax | undefined;
  if (!same(p.poolKey.hooks, zeroAddress)) {
    const quote = await p.publicClient.readContract({ address: p.poolKey.hooks, abi: hoodLaunchHookAbi, functionName: "quote" });
    const isBuy = same(p.tokenIn, quote);
    const bps = await p.publicClient.readContract({
      address: p.poolKey.hooks, abi: hoodLaunchHookAbi, functionName: "currentTaxBps", args: [isBuy],
    });
    tax = { bps: Number(bps), side: isBuy ? "input" : "output" };
  }

  const est = estimateSingleRangeSwap({
    sqrtPriceX96, liquidity, feePips: swapFeePips(protocolFee, lpFee, zeroForOne), zeroForOne, amountIn: p.amountIn, tax,
  });
  return { amountOut: est.amountOut, zeroForOne, source: "estimate" };
}
