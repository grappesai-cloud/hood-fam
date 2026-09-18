import { API } from "./config";

/// Every list, chart and holder count comes from our own indexer, never from a third party.
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, { cache: "no-store", ...init });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return (await res.json()) as T;
}

export interface TokenRow {
  token: string; curve: string; creator: string; symbol: string; name: string; image: string;
  description: string; website: string; twitter: string; telegram: string;
  pair_token: string; fee_model: number | null; phase: number;
  sold: string; curve_supply: string; reserve: string; price: string;
  volume_24h: string; volume_total: string; trades_total: number;
  launched_at: string; graduated_at: string | null;
  mode: "curve" | "direct";
  hook: string | null; splitter: string | null; locker: string | null;
  pool_fee: number | null; tick_spacing: number | null; bonded: boolean;
  total_supply: string; tick_start: number | null; tick_bond: number | null; last_tick: number | null;
  /// supply is what is left after burns; burned is what left, so price times supply is the cap
  burned: string;
  /// one routing word for both machines; `bonded` above is the contract's name for the same latch
  status: "curve" | "sold_out" | "graduated";
  pool_id: string | null; buy_tax_bps: number | null; sell_tax_bps: number | null;
  snipe_tax_bps: number | null; snipe_decay_seconds: number | null;
  max_hold_bps: number | null; max_buy_bps: number | null; restrictions_end_block: string | null;
  alloc_creator_bps: number | null; alloc_buyback_bps: number | null;
  alloc_dividends_bps: number | null; alloc_liquidity_bps: number | null;
}

export interface TokenDetail extends TokenRow {
  holders: number;
  fees: { accrued: string; flushed: string };
  staking: { staked: string; positions: string };
}
