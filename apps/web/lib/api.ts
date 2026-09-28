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

/// Two shapes, one meaning. Uniswap's routing service hands back finished router calldata; the
/// pad's own single-hop builder hands back the actions, which the curve router executes itself.
/// Whichever arrives, `minQuoteOut` is the floor the trade is signed against.
export interface NativeQuoteRoute {
  routerCalldata?: `0x${string}`;
  commands?: `0x${string}`;
  inputs?: `0x${string}`[];
  source?: "local";
  pool?: { fee: number; tickSpacing: number };
  value: string;
  quoteOut: string;
  minQuoteOut: string;
  requestId?: string;
}

export interface RouteAvailability {
  token: string;
  available: boolean;
  configured: boolean;
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
  /// The company or fund behind the ticker, for the chain's own shares. Null for a currency, and
  /// for any asset the scan could only read a ticker off.
  name?: string | null;
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
  /// A block-zero launch: how many team wallets bought in the launch transaction and what they got
  /// between them. Zero on every other launch. `launched_by` is the periphery that made it.
  team_legs?: number; team_tokens?: string; launched_by?: string | null;
  sold: string; curve_supply: string; reserve: string; price: string;
  price_24h_ago?: string | null;
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
  /// One unit of the pair in dollars, with where that came from, or `null` and why not. Never 0.
  usd?: UsdQuote;
  /// A referral the owner set by hand on this launch: who is paid a slice of the protocol's share,
  /// and the slice in basis points of that share. Null when nobody is.
  referral_to?: string | null; referral_bps?: number | null;
  /// The launch's pot: the contract that pays this token's holders in the token's quote. A curve
  /// launch gets one from the factory, a direct launch uses its splitter. Null on launches printed
  /// before the Bag existed, and absent from an API that does not know about pots yet.
  pot?: string | null;
  /// Whether this launch holds a boost slot on the board for the current hour.
  boosted?: boolean;
}

/// The sell-side penalties a launch turned on at print time, as the indexer stored them. Zero is
/// off; every one is fixed for the life of the launch.
export interface PenaltyConfig {
  jeet_tax_bps: number | null; jeet_window_seconds: number | null;
  whale_tax_bps: number | null; whale_tick_limit: number | null;
  king_bps: number | null; penalties_to_vault: boolean | null;
  auction_blocks: number | null;
}

/// Where a dollar figure came from. `feed` is the Chainlink ETH/USD feed, `pool` a USDG pool this
/// API read, `resolver` the best pool it could find for a pair nobody registered, `fallback` a
/// number an operator set, `dollar` the stablecoin itself.
export interface UsdQuote {
  usd: number | null;
  source: "dollar" | "feed" | "pool" | "resolver" | "fallback" | null;
  reason: string | null;
}

/// One payout on the ledger: a flush of a curve's router, a sweep of a direct launch's splitter, a
/// protocol claim, a creator claim or a buyback, with the transaction that did it.
export interface LedgerRow {
  id: number; token: string; kind: "flushed" | "swept" | "protocol_claimed" | "creator_claimed" | "bought_back" | "referral_paid";
  amount: string; result: string; recipient: string | null;
  to_stakers: string | null; to_buyback: string | null; to_liquidity: string | null; to_creator: string | null;
  tx: string; ts: string;
  symbol: string; name: string; image: string; mode: "curve" | "direct";
  pair_token: string; pair_symbol: string | null; pair_decimals: number | null;
}

export interface LedgerPairTotal {
  pair_token: string; pair_symbol: string | null; pair_decimals: number | null;
  distributions: string; tokens: string; distributed: string;
  to_stakers: string; to_buyback: string; to_liquidity: string; to_creator: string;
  to_dividends: string; to_protocol: string; to_referrers: string; burned: string;
  usd: UsdQuote; distributedUsd: number | null;
}

export interface LedgerResponse {
  rows: LedgerRow[];
  totals: { pairs: LedgerPairTotal[]; usd: { total: number | null; reason: string | null } };
  nextBefore: number | null;
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
  /// The volume board fills these; the profit board fills the three below instead, because they
  /// are different queries answering different questions and neither pretends to be the other.
  volume_usd?: string;
  bought_usd?: string;
  sold_usd?: string;
  net_usd?: string;
  trades?: number;
  realizedUsd?: number;
  unrealizedUsd?: number;
  totalUsd?: number;
}

export interface TokenDetail extends TokenRow {
  holders: number;
  fees: { accrued: string; flushed: string };
  staking: { staked: string; positions: string };
  /// Everything ever booked for this token's holders, in the quote's smallest unit: the sum of the
  /// pot's deposits. Null when the launch has no pot; absent from an API that predates pots.
  paid_to_holders?: string | null;
  penalties?: PenaltyConfig | null;
}
