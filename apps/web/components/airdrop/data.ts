import { API } from "@/lib/config";

/// The season pool, as the API hands it over, plus the small arithmetic the page does on top.
/// Nothing here throws on a missing route: a season that has no airdrop row yet, or an API that
/// is not up, comes back as null so a panel can print one line instead of a broken page.

export interface SeasonRow {
  id: number;
  name: string;
  starts: string;
  ends: string | null;
}

export interface SeasonList {
  seasons: SeasonRow[];
  current: number;
}

/// Wei arrives as a string because it does not fit a double. A number is still accepted, because
/// a small take could be serialised as one.
export type Wei = string | number;

export interface TakeAsset {
  asset: string;
  symbol: string;
  decimals: number;
  amountWei: Wei;
  usd: number;
}

export interface SeasonAirdrop {
  season: number;
  pool: {
    poolBps: number;
    poolUsd: number;
    take: {
      season: number;
      windowStart: string;
      windowEnd: string;
      byAsset: TakeAsset[];
      usd: number;
    };
  };
  points: {
    total: number;
    participants: number;
    median: number;
    p90: number;
    top10Share: number;
  };
  drop: null | { asset: string; total: Wei; root: string; generatedAt: string };
}

/// One arm of the estimate: the whole activity scored at a single rank. The API returns two,
/// because a season is not scored at one rank: every trade is scored when it lands.
export interface EstimateArm {
  rank: string;
  multiplier: number;
  points: { launch: number; buy: number; sell: number; stake: number; total: number };
  projectedPoints: number;
  seasonTotalAfter: number;
  sharePpm: number;
  estimateUsd: number;
}

export interface Estimate {
  rank: string;
  multiplier: number;
  points: { launch: number; buy: number; sell: number; stake: number; total: number };
  existingPoints: number;
  projectedPoints: number;
  seasonTotalAfter: number;
  sharePpm: number;
  poolUsd: number;
  estimateUsd: number;
  /// How many days of being locked the stake figure was scored over.
  stakeDays: number;
  low: EstimateArm;
  high: EstimateArm;
  assumptions: string[];
}

export interface Proof {
  season: number;
  address: string;
  amount: Wei;
  proof: string[];
  root: string;
  claimed: string | null;
}

/// What /points/:address already returns for the live season.
export interface WalletPoints {
  address: string;
  season: number;
  points: number;
  volumeUsd: number;
  volumeUsd30d: number;
  rank: string;
  multiplier: number;
  position: number;
}

export const LOCK_DAYS = [
  { days: 0, label: "none", multiplier: 1 },
  { days: 7, label: "7 days", multiplier: 1.25 },
  { days: 30, label: "30 days", multiplier: 1.5 },
  { days: 90, label: "90 days", multiplier: 2 },
  { days: 180, label: "180 days", multiplier: 2.5 },
] as const;

export type LockDays = (typeof LOCK_DAYS)[number]["days"];

export interface EstimateInput {
  launches: number;
  buyUsd: number;
  sellUsd: number;
  stakeUsd: number;
  lockDays: LockDays;
}

/// A route that is allowed to say "there is nothing here". 404 is an answer, not a failure.
export async function getOrNull<T>(path: string): Promise<T | null> {
  const res = await fetch(`${API}${path}`, { cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return (await res.json()) as T;
}

export async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return (await res.json()) as T;
}

export function weiOf(value: Wei | null | undefined): bigint {
  if (value === null || value === undefined) return 0n;
  try {
    return BigInt(typeof value === "number" ? Math.trunc(value) : value.trim());
  } catch {
    return 0n;
  }
}

export function usd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "$0";
  const abs = Math.abs(value);
  const digits = abs >= 1_000 ? 0 : abs >= 1 ? 2 : 4;
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function points(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "0";
  return Math.round(value).toLocaleString("en-US");
}

/// Parts per million is how the API keeps a share exact. On screen it has to read as a percentage,
/// with enough decimals that a small wallet still sees a number instead of a rounded zero.
export function sharePercent(ppm: number | null | undefined): string {
  if (ppm === null || ppm === undefined || !Number.isFinite(ppm) || ppm <= 0) return "0%";
  const pct = ppm / 10_000;
  if (pct >= 1) return `${pct.toFixed(2)}%`;
  if (pct >= 0.01) return `${pct.toFixed(4)}%`;
  return `${pct.toFixed(6)}%`;
}

/// A share that could be sent either as a fraction or as a percentage already. Above one it can
/// only be a percentage, because no wallet holds more than every point in the season.
export function ratioPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return "0%";
  const pct = value <= 1 ? value * 100 : value;
  return `${pct.toFixed(pct >= 10 ? 1 : 2)}%`;
}

export function when(value: string | null | undefined): string {
  if (!value) return "open";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString();
}

const MAX_USD = 1_000_000;
const SPAN = Math.log10(MAX_USD + 1);

/// Dollars on a slider only work on a log scale: the first hundred dollars matter as much to a
/// small wallet as the last hundred thousand do to a large one.
export function sliderToUsd(position: number): number {
  const raw = Math.pow(10, (position / 100) * SPAN) - 1;
  if (raw < 10) return Math.round(raw);
  return Number(raw.toPrecision(2));
}

export function usdToSlider(value: number): number {
  const safe = Math.max(0, Math.min(MAX_USD, value));
  return (Math.log10(safe + 1) / SPAN) * 100;
}
