import { curveBuy, raiseTarget } from "@hood/sdk";

/// The team's buys as the chain will run them inside the launch transaction: in order, each at the
/// price the one before it left. The form asks for shares of the supply, the contract wants what
/// each wallet pays, so this turns one into the other on the same curve the contract prices with.

export interface CurveCfg {
  pairToken: `0x${string}`;
  totalSupply: bigint; curveSupplyBps: number; startCap: bigint; graduationCap: bigint;
  liquidityBps: number; protocolFeeBps: number; creatorFeeBps: number; enabled: boolean;
  poolFee: number; tickSpacing: number;
}

export interface Curve { p0: bigint; p1: bigint; supply: bigint; feeBps: number }

export function curveOf(c: CurveCfg): Curve {
  return {
    p0: (c.startCap * 10n ** 18n) / c.totalSupply,
    p1: (c.graduationCap * 10n ** 18n) / c.totalSupply,
    supply: (c.totalSupply * BigInt(c.curveSupplyBps)) / 10_000n,
    feeBps: Number(c.protocolFeeBps) + Number(c.creatorFeeBps),
  };
}

/// The least a wallet pays to get at least `want` tokens with `sold` already gone. Undefined when
/// the curve has fewer than `want` left.
export function pairFor(c: Curve, sold: bigint, want: bigint): bigint | undefined {
  if (want <= 0n) return 0n;
  if (sold + want > c.supply) return undefined;
  let hi = ((raiseTarget(c.p0, c.p1, c.supply) * 10_000n) / BigInt(10_000 - c.feeBps)) * 2n + 1n;
  let lo = 0n;
  for (let i = 0; i < 256 && hi - lo > 1n; i++) {
    const mid = (lo + hi) / 2n;
    if (curveBuy({ ...c, sold, pairIn: mid }).tokensOut >= want) hi = mid; else lo = mid;
  }
  return hi;
}

export interface LegPlan {
  role: "developer" | "holder";
  wallet: string;
  pairIn: bigint;
  tokens: bigint;
  lock: number;
}

export interface Plan {
  legs: LegPlan[];
  pairTotal: bigint;
  tokens: bigint;
  /// Price per whole token once the last team buy is in, in the pair's own units (18 decimals).
  priceAfter: bigint;
  overflow: boolean;
}

/// Shares are in basis points of the total supply, not of the curve's part of it: "2% to the
/// developer" means 2% of every token that will ever exist, which is what a holder map shows.
export function buildPlan(cfg: CurveCfg, dev: { wallet: string; bps: number; lock: number }, holders: { wallets: string[]; bps: number; lock: number }): Plan {
  const c = curveOf(cfg);
  const wants: Omit<LegPlan, "pairIn" | "tokens">[] = [];
  if (dev.bps > 0) wants.push({ role: "developer", wallet: dev.wallet, lock: dev.lock });
  holders.wallets.forEach((w) => wants.push({ role: "holder", wallet: w, lock: holders.lock }));
  const each = holders.wallets.length ? (cfg.totalSupply * BigInt(holders.bps)) / 10_000n / BigInt(holders.wallets.length) : 0n;
  let sold = 0n;
  let overflow = false;
  const legs = wants.map((w) => {
    const want = w.role === "developer" ? (cfg.totalSupply * BigInt(dev.bps)) / 10_000n : each;
    const pairIn = overflow ? undefined : pairFor(c, sold, want);
    if (pairIn === undefined) { overflow = true; return { ...w, pairIn: 0n, tokens: 0n }; }
    const shot = curveBuy({ ...c, sold, pairIn });
    sold += shot.tokensOut;
    return { ...w, pairIn, tokens: shot.tokensOut };
  });
  const priceAfter = curveBuy({ ...c, sold, pairIn: 0n }).priceBefore;
  return { legs, pairTotal: legs.reduce((s, l) => s + l.pairIn, 0n), tokens: sold, priceAfter, overflow };
}
