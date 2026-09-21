import { API } from "./config";

/// Every list, chart and holder count comes from our own indexer, never from a third party.
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, { cache: "no-store", ...init });
  const body = await res.json().catch(() => null) as ({ error?: unknown } | null);
  if (!res.ok) {
    const detail = typeof body?.error === "string" ? `: ${body.error}` : "";
    throw new Error(`${path}: ${res.status}${detail}`);
  }
  return body as T;
}

export interface NativeQuoteRoute {
  routerCalldata: `0x${string}`;
  value: string;
  quoteOut: string;
  minQuoteOut: string;
  requestId: string;
}

export interface HealthStatus {
  ok: boolean;
  indexedBlock: string | null;
  integrations: {
    assistant: boolean;
    art: boolean;
    relay: boolean;
    routing?: boolean;
    storage: boolean;
  };
}

/// What this pad takes as a pair, as the API reports it: the factory's allow list, each asset's
/// own scale, and what one of it is worth in dollars right now.
export interface PairRow {
  address: string;
  symbol: string;
  decimals: number;
  /// A tokenised share rather than a currency.
  share: boolean;
  allowed: boolean;
  lockThreshold: string;
  usd: number;
}

export interface ResolvedQuote {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: string;
  compatible: boolean;
  hasLiquidity: boolean;
  liquiditySafe: boolean;
  depthUsd: number;
  usd: number;
  pool: null | { kind: "v3"; address: string; fee: number };
  warnings: string[];
}

export interface TokenRow {
  token: string; curve: string; creator: string; symbol: string; name: string; image: string;
  fee_recipient?: string;
  description: string; website: string; twitter: string; telegram: string;
  pair_token: string; phase: number;
  /// What the pair calls itself and how many decimals it has, as the indexer read them off the
  /// asset at launch. Null on rows written before the pad took anything but ETH and the dollar.
  pair_symbol?: string | null; pair_decimals?: number | null;
  /// Where the creator leg of the fee goes, in basis points, adding up to 10,000 on a curve launch.
  /// A direct launch is four zeros: its own splitter divides its tax, so the split does not apply.
  split_stakers_bps: number; split_buyback_bps: number; split_liquidity_bps: number; split_creator_bps: number;
  /// Token units of the creator's own first buy locked in the staking vault at launch, and when it
  /// comes free. Zero and null when the creator kept their first buy liquid, which is also a fact.
  first_buy_locked: string; first_buy_unlock_at: string | null;
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

export interface ActivityRow {
  side: "buy" | "sell";
  trader: string;
  pair_amount: string;
  token_amount: string;
  ts: string;
  tx: string;
  log_index: number;
  token: string;
  symbol: string;
  name: string;
  pair_token: string;
  pair_symbol: string | null;
  pair_decimals: number | null;
}

export interface TopTraderRow {
  address: string;
  volume_usd: string;
  bought_usd: string;
  sold_usd: string;
  net_usd: string;
  trades: number;
}

export interface TokenDetail extends TokenRow {
  holders: number;
  fees: { accrued: string; flushed: string };
  staking: { staked: string; positions: string };
}
