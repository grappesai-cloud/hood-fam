import { z } from "zod";

/// Where the creator leg of the trading fee goes. Four destinations rather than one choice, set at
/// launch and never editable, and they must add up to the whole: a creator splits it the way the
/// direct machine has always split its tax. A launch that wants no creator fee at all does not pick
/// a leg for it, it uses a preset whose creatorFeeBps is zero, which is where that belongs.
export const FEE_LEGS = ["stakers", "buyback", "liquidity", "creator"] as const;
export type FeeLeg = (typeof FEE_LEGS)[number];

export interface FeeSplit {
  stakersBps: number;
  buybackBps: number;
  liquidityBps: number;
  creatorBps: number;
}

export const FEE_LEG_LABEL: Record<FeeLeg, string> = {
  // Not "stakers of this token": there is one vault on the pad and it holds one coin, so this leg
  // pays the people who locked that coin, whatever launch the fee came from.
  stakers: "The coin holders take it",
  buyback: "Buy back and burn",
  liquidity: "Deepen the liquidity",
  creator: "The creator keeps it",
};

export const BPS = 10_000;

/// The whole, or the launch reverts. Stated here so a form can say so before a wallet does.
export function splitAddsUp(split: FeeSplit): boolean {
  return split.stakersBps + split.buybackBps + split.liquidityBps + split.creatorBps === BPS;
}

/// The legs that actually pay something, largest first, for anywhere a split has to be read out.
export function splitLegs(split: FeeSplit): { leg: FeeLeg; bps: number }[] {
  return ([
    { leg: "stakers" as const, bps: split.stakersBps },
    { leg: "buyback" as const, bps: split.buybackBps },
    { leg: "liquidity" as const, bps: split.liquidityBps },
    { leg: "creator" as const, bps: split.creatorBps },
  ]).filter((l) => l.bps > 0).sort((a, b) => b.bps - a.bps);
}

/// A split in one line: "60% stakers, 40% buy back and burn".
export function splitLabel(split: FeeSplit): string {
  const legs = splitLegs(split);
  if (legs.length === 0) return "no creator leg";
  return legs.map((l) => `${Math.round((l.bps / BPS) * 100)}% ${FEE_LEG_LABEL[l.leg].toLowerCase()}`).join(", ");
}

export const PHASES = ["curve", "sold", "graduated"] as const;
export type Phase = (typeof PHASES)[number];
export const phaseFromIndex = (i: number): Phase => PHASES[i] ?? "curve";

export const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/, "not an address");

export const launchParamsSchema = z.object({
  name: z.string().min(1).max(64),
  symbol: z.string().min(1).max(16),
  image: z.string().max(400).default(""),
  description: z.string().max(2000).default(""),
  website: z.string().max(200).default(""),
  twitter: z.string().max(200).default(""),
  telegram: z.string().max(200).default(""),
  pairToken: addressSchema.default("0x0000000000000000000000000000000000000000"),
  configId: z.union([z.number(), z.bigint()]).default(0),
  /// Four numbers that must add up to 10,000. The default sends the whole creator leg to stakers,
  /// which is what the single-choice default used to mean.
  feeSplit: z.object({
    stakersBps: z.number().int().min(0).max(BPS),
    buybackBps: z.number().int().min(0).max(BPS),
    liquidityBps: z.number().int().min(0).max(BPS),
    creatorBps: z.number().int().min(0).max(BPS),
  }).refine(splitAddsUp, { message: "the four legs must add up to 10,000" })
    // Half back into the pool, half to the creator: a default that launches on a pad whose house
    // coin has not been named yet, which the whole-fee-to-stakers default could not.
    .default({ stakersBps: 0, buybackBps: 0, liquidityBps: 5_000, creatorBps: 5_000 }),
  creatorFeeRecipient: addressSchema.optional(),
  /// Pair units spent on the creator's own first buy, inside the launch transaction.
  firstBuy: z.union([z.string(), z.bigint()]).default("0"),
  /// Seconds the creator's own first buy is held by the locker, earning nothing. Zero is no lock,
  /// and any other value must be one of its lengths (7, 30, 90 or 180 days) or the launch reverts.
  firstBuyLock: z.union([z.number(), z.bigint()]).default(0),
  salt: z.string().optional(),
  /// Economics hash read with previewLaunchEconomics. Zero skips the check.
  econ: z.string().optional(),
});

export type LaunchParamsInput = z.input<typeof launchParamsSchema>;

export interface CurveConfig {
  /// The asset this preset's caps are written in, and the only pair it can be launched against.
  pairToken: `0x${string}`;
  totalSupply: bigint;
  curveSupplyBps: number;
  startCap: bigint;
  graduationCap: bigint;
  liquidityBps: number;
  protocolFeeBps: number;
  creatorFeeBps: number;
  poolFee: number;
  tickSpacing: number;
  enabled: boolean;
}

export interface Launch {
  curve: `0x${string}`;
  creator: `0x${string}`;
  creatorFeeRecipient: `0x${string}`;
  pairToken: `0x${string}`;
  configId: bigint;
  feeSplit: FeeSplit;
  /// Token units of the creator's own first buy that were locked in the staking vault at launch.
  firstBuyLocked: bigint;
  firstBuyUnlockAt: number;
  symbolHash: `0x${string}`;
  imageHash: `0x${string}`;
  launchedAt: number;
  exists: boolean;
}

export interface CurveState {
  token: `0x${string}`;
  pairToken: `0x${string}`;
  phase: Phase;
  sold: bigint;
  reserve: bigint;
  bonus: bigint;
  curveSupply: bigint;
  lpSupply: bigint;
  price: bigint;
  p0: bigint;
  p1: bigint;
  remaining: bigint;
  raiseTarget: bigint;
  protocolFeeBps: number;
  creatorFeeBps: number;
  liquidityBps: number;
  /// How far the curve is from graduating, 0 to 1.
  progress: number;
  /// Fully diluted valuation at the current price, in pair units.
  marketCap: bigint;
}

export interface StakePosition {
  id: bigint;
  /// The house coin: one vault, one token, so this is the same address for every position.
  token: `0x${string}`;
  owner: `0x${string}`;
  amount: bigint;
  unlockAt: number;
  weightBps: number;
  /// What this position can claim, per reward asset. A vault fed by launches paired against
  /// different things owes in more than one currency, and a single number could not say which.
  pending: { asset: `0x${string}`; amount: bigint }[];
}
