/// The curve and the tax, run in the browser before anything exists on chain.
///
/// Every number here is the contract's own arithmetic, ported: `CurveMath.priceAt`, `cost` and
/// `tokensForPair` from `src/libraries/CurveMath.sol`, the two fee helpers from `HoodCurve.sol`,
/// and the opening tax from `SnipeSchedule.bpsAt`. Ported, not approximated, and in
/// bigint with the same rounding, so what the wizard promises a buyer will get is to the wei what
/// the buyer gets. A simulator that is merely close is a simulator that argues with the chain.

const WAD = 10n ** 18n;
const BPS = 10_000n;

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

export function priceAt(p0: bigint, p1: bigint, supply: bigint, sold: bigint): bigint {
  return p0 + ((p1 - p0) * sold) / supply;
}

/// Pair cost of moving the sold amount from `s` to `s + d`. One division, like on chain.
export function curveCost(p0: bigint, p1: bigint, supply: bigint, s: bigint, d: bigint, up: boolean): bigint {
  if (d <= 0n) return 0n;
  const num = (2n * p0 * supply + (p1 - p0) * (2n * s + d)) * d;
  const den = 2n * supply * WAD;
  return up ? ceilDiv(num, den) : num / den;
}

/// Largest token amount buyable with `budget`, bounded by what is left. Same bracket, same search.
export function tokensForPair(p0: bigint, p1: bigint, supply: bigint, s: bigint, budget: bigint, maxOut: bigint): bigint {
  if (budget <= 0n || maxOut <= 0n) return 0n;
  let hi = (budget * WAD) / priceAt(p0, p1, supply, s);
  if (hi > maxOut) hi = maxOut;
  if (hi === 0n) return 0n;
  let lo = (budget * WAD) / priceAt(p0, p1, supply, s + hi);
  if (lo > hi) lo = hi;
  if (lo !== 0n && curveCost(p0, p1, supply, s, lo, true) > budget) lo = 0n;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if (curveCost(p0, p1, supply, s, mid, true) <= budget) lo = mid;
    else hi = mid - 1n;
  }
  return lo;
}

export interface CurveShot {
  tokensOut: bigint;
  /// What the curve took, and the fee on top of it: together they are what leaves the wallet.
  net: bigint;
  fee: bigint;
  spent: bigint;
  priceBefore: bigint;
  priceAfter: bigint;
  /// What the same tokens are worth at the graduation price, if the curve ever gets there.
  worthAtGraduation: bigint;
}

/// One buy, at a point on the curve. `sold` is how much of the curve is gone when it lands.
export function curveBuy({ p0, p1, supply, sold, pairIn, feeBps }: {
  p0: bigint; p1: bigint; supply: bigint; sold: bigint; pairIn: bigint; feeBps: number;
}): CurveShot {
  const bps = BigInt(feeBps);
  const feeOnGross = bps === 0n ? 0n : ceilDiv(pairIn * bps, BPS);
  const budget = pairIn > feeOnGross ? pairIn - feeOnGross : 0n;
  const tokensOut = tokensForPair(p0, p1, supply, sold, budget, supply - sold);
  const net = curveCost(p0, p1, supply, sold, tokensOut, true);
  const fee = bps === 0n ? 0n : ceilDiv(net * bps, BPS - bps);
  return {
    tokensOut,
    net,
    fee,
    spent: net + fee,
    priceBefore: priceAt(p0, p1, supply, sold),
    priceAfter: priceAt(p0, p1, supply, sold + tokensOut),
    worthAtGraduation: (tokensOut * p1) / WAD,
  };
}

/// What the whole curve raises if it sells out: the integral, end to end.
export function raiseTarget(p0: bigint, p1: bigint, supply: bigint): bigint {
  return curveCost(p0, p1, supply, 0n, supply, false);
}

/// The opening tax every launch runs, `t` whole seconds after its launch block, in bps of a buy
/// (SnipeSchedule.sol): 99% in the launch's own second, 6.18%, 0.19%, then nothing. The same on
/// both machines and not a setting. Exempt wallets pay none of it.
export const SNIPE_SCHEDULE_BPS = [9_900, 618, 19] as const;
export const SNIPE_WINDOW_SECONDS = SNIPE_SCHEDULE_BPS.length;
export function snipeBpsAt(t: number): number {
  const s = Math.max(0, Math.floor(t));
  return s < SNIPE_WINDOW_SECONDS ? SNIPE_SCHEDULE_BPS[s]! : 0;
}
