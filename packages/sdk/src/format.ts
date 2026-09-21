import { formatUnits, parseUnits } from "viem";

/// Lock lengths the vault knows, and what they are worth. The first buy locker takes the same
/// four lengths minus the flexible one, so a creator and a holder read the same words.
export const LOCK_TIERS = [
  { label: "flexible", seconds: 0, multiplier: 1 },
  { label: "7 days", seconds: 7 * 86_400, multiplier: 1.25 },
  { label: "30 days", seconds: 30 * 86_400, multiplier: 1.5 },
  { label: "90 days", seconds: 90 * 86_400, multiplier: 2 },
  { label: "180 days", seconds: 180 * 86_400, multiplier: 2.5 },
] as const;

export function fmt(amount: bigint, decimals = 18, maxFractionDigits = 6): string {
  const s = formatUnits(amount, decimals);
  const [whole, frac = ""] = s.split(".");
  const cut = frac.slice(0, maxFractionDigits).replace(/0+$/, "");
  const grouped = BigInt(whole!).toLocaleString("en-US");
  return cut ? `${grouped}.${cut}` : grouped;
}

export const parse = (value: string, decimals = 18) => parseUnits(value, decimals);

/// Compact market-cap style formatting: 1.2M, 940k, 12.5
export function compact(amount: bigint, decimals = 18): string {
  const n = Number(formatUnits(amount, decimals));
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  if (n >= 1) return n.toFixed(3);
  return n.toPrecision(3);
}

export function shortAddress(a: string): string {
  return `${a.slice(0, 6)}...${a.slice(-4)}`;
}

export function timeUntil(unix: number, now = Date.now() / 1000): string {
  const d = unix - now;
  if (d <= 0) return "unlocked";
  const days = Math.floor(d / 86_400);
  if (days > 0) return `${days}d`;
  const hours = Math.floor(d / 3_600);
  if (hours > 0) return `${hours}h`;
  return `${Math.max(1, Math.floor(d / 60))}m`;
}
