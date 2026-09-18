import { z } from "zod";

/// What happens to the creator leg of the trading fee. Picked at launch, locked forever.
export const FEE_MODELS = ["staking", "buyback", "liquidity", "creator", "zero"] as const;
export type FeeModel = (typeof FEE_MODELS)[number];

export const feeModelToIndex: Record<FeeModel, number> = {
  staking: 0,
  buyback: 1,
  liquidity: 2,
  creator: 3,
  zero: 4,
};
export const feeModelFromIndex = (i: number): FeeModel => FEE_MODELS[i] ?? "staking";

export const feeModelLabel: Record<FeeModel, string> = {
  staking: "Stakers take the fee",
  buyback: "Buy back and burn",
  liquidity: "Deepen the liquidity",
  creator: "Creator keeps the fee",
  zero: "No creator fee",
};

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
  feeModel: z.enum(FEE_MODELS).default("staking"),
  creatorFeeRecipient: addressSchema.optional(),
  /// Pair units spent on the creator's own first buy, inside the launch transaction.
  firstBuy: z.union([z.string(), z.bigint()]).default("0"),
  salt: z.string().optional(),
  /// Economics hash read with previewLaunchEconomics. Zero skips the check.
  econ: z.string().optional(),
});

export type LaunchParamsInput = z.input<typeof launchParamsSchema>;

export interface CurveConfig {
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
  feeModel: FeeModel;
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
  token: `0x${string}`;
  owner: `0x${string}`;
  amount: bigint;
  unlockAt: number;
  weightBps: number;
  pending: bigint;
}
