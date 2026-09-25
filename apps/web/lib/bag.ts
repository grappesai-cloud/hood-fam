import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { pairAsset } from "./format";

/// The Bag, as the API reports it: one router that every machine pays into, four fixed splits,
/// and the outlets it pays (the house, the Vault, Payday, the burn clock, Confetti). Every amount
/// here is a decimal string in the asset's smallest unit unless the field ends in `_usd` or is
/// called `usd`; asset address(0) is native ETH. The shapes follow the API contract in the Bag
/// brief and nothing is invented on this side of the wire: a route that is not there yet is a
/// 404, which `isMissing` names so a page can say so instead of drawing a zero.

export interface BagAsset {
  asset: string;
  symbol: string;
  decimals: number;
}

export interface BagTotal extends BagAsset {
  in: { trade: string; graduation: string; penalty: string; house: string; houseCoin: string; total: string };
  out: { house: string; vault: string; payday: string; burn: string; confetti: string; total: string };
  /// The Vault and burn shares the Bag keeps until the house coin exists. Held, not lost.
  held: { vault: string; burn: string };
  usd: { in: number; out: number } | null;
  usdReason: string | null;
}

export interface BagAddresses {
  bag: string | null;
  payday: string | null;
  burnClock: string | null;
  boosts: string | null;
  vault: string | null;
  house: string | null;
  graduationHook: string | null;
  openingAuction: string | null;
  /// Unset until the coin launches; the UI says "the house coin" until it has a name.
  houseCoin: string | null;
}

export interface PaydayPot extends BagAsset {
  funded: string;
  carried: string;
}

export interface PaydayLast {
  epoch: number;
  paid_at: string;
  toWallets: string;
  toLaunches: string;
  wallets: number;
  asset?: string;
  symbol?: string;
  decimals?: number;
}

export interface BagPayday {
  epoch: number;
  startsAt: string;
  endsAt: string;
  pot: PaydayPot[];
  last: PaydayLast | null;
}

export interface BagBurn {
  houseCoin: string | null;
  totalBurned: string;
  last: { asset: string; spent: string; coinBurned: string; ts: string } | null;
  waiting: { asset: string; amount: string; symbol?: string; decimals?: number }[];
}

export interface BoostSlot {
  slot: number;
  token: string | null;
  symbol: string | null;
  buyer: string | null;
}

export interface BagBoosts {
  hour: number;
  price: string;
  slots: BoostSlot[];
}

export interface BagResponse {
  addresses: BagAddresses;
  totals: BagTotal[];
  payday: BagPayday;
  burn: BagBurn;
  boosts: BagBoosts;
  updatedAt: string;
}

/// The bag_events kinds, as the indexer files them.
export type TapeKind =
  | "bag_in" | "bag_out" | "held"
  | "payday_funded" | "payday_paid" | "payday_slice" | "payday_epoch"
  | "burn" | "boost" | "penalty" | "holders_paid" | "pushed"
  | "king_crowned" | "king_won" | "slash"
  | "auction_bid" | "auction_settled" | "buyback" | "buyback_wanted";

export interface TapeRow {
  id: number;
  kind: TapeKind | string;
  token: string | null;
  symbol: string | null;
  asset: string | null;
  assetSymbol: string | null;
  decimals: number | null;
  amount: string;
  extra: Record<string, unknown> | null;
  tx: string;
  ts: string;
}

export interface TapeResponse {
  rows: TapeRow[];
  nextBefore: number | null;
}

export interface ShameRow {
  payer: string;
  count: number;
  snipe: number;
  jeet: number;
  whale: number;
  paid: (BagAsset & { amount: string })[];
  usd: number | null;
  last_ts: string;
  tokens: number;
}

export interface ShameResponse {
  rows: ShameRow[];
}

export interface BoostsResponse extends BagBoosts {
  next: { hour: number; slots: BoostSlot[] };
}

export interface VaultResponse {
  houseCoin: string | null;
  totalLocked: string;
  positions: number;
  rewards: (BagAsset & { total: string; last_ts: string | null })[];
  held: { asset: string; amount: string }[];
}

export type PotReason = "snipe" | "jeet" | "whale" | "confetti" | "slash" | "auction" | "payday" | "dividends" | "lp_fees" | "king";

export interface PotDeposit {
  id: number;
  token: string;
  reason: PotReason | string;
  payer: string | null;
  asset: string;
  amount: string;
  eligible_supply: string;
  holders: number | null;
  tx: string;
  log_index: number;
  ts: string;
}

export interface PotResponse extends BagAsset {
  token: string;
  pot: string | null;
  totalDeposited: string;
  totalPaid: string;
  pending_holders: number;
  byReason: Record<PotReason, string>;
  recent: PotDeposit[];
  pushes: { last_ts: string | null; count_24h: number; paid_24h: string };
}

export interface KingRound {
  id: number;
  token: string;
  king: string;
  pot: string;
  ends_at: string;
  won_amount: string | null;
  won_at: string | null;
  tx: string;
}

export interface KingResponse {
  enabled: boolean;
  king_bps: number;
  king: string | null;
  pot: string;
  ends_at: string | null;
  rounds: KingRound[];
}

export interface AuctionRow {
  enabled?: true;
  token: string;
  end_block: string;
  top_bidder: string | null;
  top_bid: string;
  bids: number;
  settled: boolean;
  winner: string | null;
  to_holders: string | null;
  to_liquidity: string | null;
  updated_at: string;
}

export type AuctionResponse = AuctionRow | { enabled: false };

export interface PenaltyRow {
  id: number;
  token: string;
  kind: "snipe" | "jeet" | "whale" | "slash" | string;
  payer: string;
  asset: string;
  amount: string;
  to_holders: string;
  to_bag: string;
  holders: number | null;
  block: string;
  tx: string;
  log_index: number;
  ts: string;
}

export interface PenaltiesResponse {
  rows: PenaltyRow[];
  nextBefore?: number | null;
}

/// The react-query keys, named once so the stream (lib/live.ts) and every page refresh the same
/// thing. Token-scoped keys put the address second, because that is where the stream looks.
export const BAG_KEYS = {
  bag: ["bag"] as const,
  tape: (token?: string | null, kinds?: string | null) => ["bag-tape", token?.toLowerCase() ?? "all", kinds ?? "all"] as const,
  shame: ["shame"] as const,
  boosts: (hour?: number | null) => ["boosts", hour ?? "now"] as const,
  vault: ["vault"] as const,
  pot: (token: string) => ["pot", token.toLowerCase()] as const,
  king: (token: string) => ["king", token.toLowerCase()] as const,
  auction: (token: string) => ["auction", token.toLowerCase()] as const,
  penalties: (token: string) => ["penalties", token.toLowerCase()] as const,
};

/// The tabs on the tape, each a comma list of bag_events kinds the API filters on.
export const TAPE_FILTERS: { id: string; label: string; kinds: string[] | null }[] = [
  { id: "all", label: "Everything", kinds: null },
  { id: "penalties", label: "Penalties", kinds: ["penalty", "slash"] },
  { id: "payday", label: "Payday", kinds: ["payday_funded", "payday_epoch", "payday_slice", "payday_paid"] },
  { id: "burn", label: "Burn clock", kinds: ["burn", "buyback"] },
  { id: "boosts", label: "Boosts", kinds: ["boost"] },
  { id: "pots", label: "Pots", kinds: ["holders_paid", "pushed", "king_crowned", "king_won", "auction_bid", "auction_settled"] },
];

export function fetchBag() {
  return api<BagResponse>("/bag");
}

export function fetchTape(opts: { limit?: number; before?: number | null; token?: string | null; kinds?: string[] | null } = {}) {
  const q = new URLSearchParams();
  q.set("limit", String(opts.limit ?? 60));
  if (opts.before) q.set("before", String(opts.before));
  if (opts.token) q.set("token", opts.token);
  if (opts.kinds?.length) q.set("kind", opts.kinds.join(","));
  return api<TapeResponse>(`/bag/tape?${q.toString()}`);
}

export function fetchShame(limit = 50) {
  return api<ShameResponse>(`/shame?limit=${limit}`);
}

export function fetchBoosts(hour?: number | null) {
  return api<BoostsResponse>(hour != null ? `/boosts?hour=${hour}` : "/boosts");
}

export function fetchVault() {
  return api<VaultResponse>("/vault");
}

export function fetchPot(token: string) {
  return api<PotResponse>(`/tokens/${token}/pot`);
}

export function fetchKing(token: string) {
  return api<KingResponse>(`/tokens/${token}/king`);
}

export function fetchAuction(token: string) {
  return api<AuctionResponse>(`/tokens/${token}/auction`);
}

export function fetchPenalties(token: string, opts: { limit?: number; before?: number | null } = {}) {
  const q = new URLSearchParams();
  q.set("limit", String(opts.limit ?? 50));
  if (opts.before) q.set("before", String(opts.before));
  return api<PenaltiesResponse>(`/tokens/${token}/penalties?${q.toString()}`);
}

/// `api()` throws "<path>: <status>" and nothing else tells a page why it has no data. A route
/// the API does not serve yet is a 404, and a page must say the Bag is not wired rather than that
/// it is empty; the two are different facts.
export function isMissing(error: unknown): boolean {
  return error instanceof Error && /: 404\b/.test(error.message);
}

/// Every hook reads on the timer its page can live with; the stream shortens the wait through the
/// keys above and never replaces the timer.
export function useBag() {
  return useQuery({ queryKey: BAG_KEYS.bag, queryFn: fetchBag, refetchInterval: 15_000, retry: false });
}

export function useShame(limit = 50) {
  return useQuery({ queryKey: BAG_KEYS.shame, queryFn: () => fetchShame(limit), refetchInterval: 60_000, retry: false });
}

export function useBoosts(hour?: number | null) {
  return useQuery({ queryKey: BAG_KEYS.boosts(hour), queryFn: () => fetchBoosts(hour), refetchInterval: 30_000, retry: false });
}

export function useVault() {
  return useQuery({ queryKey: BAG_KEYS.vault, queryFn: fetchVault, refetchInterval: 30_000, retry: false });
}

export function usePot(token: string | null | undefined) {
  return useQuery({
    queryKey: BAG_KEYS.pot(token ?? ""),
    queryFn: () => fetchPot(token!),
    enabled: Boolean(token),
    refetchInterval: 10_000,
    retry: false,
  });
}

export function useKing(token: string | null | undefined) {
  return useQuery({
    queryKey: BAG_KEYS.king(token ?? ""),
    queryFn: () => fetchKing(token!),
    enabled: Boolean(token),
    refetchInterval: 5_000,
    retry: false,
  });
}

export function useAuction(token: string | null | undefined) {
  return useQuery({
    queryKey: BAG_KEYS.auction(token ?? ""),
    queryFn: () => fetchAuction(token!),
    enabled: Boolean(token),
    refetchInterval: 6_000,
    retry: false,
  });
}

export function usePenalties(token: string | null | undefined, limit = 50) {
  return useQuery({
    queryKey: BAG_KEYS.penalties(token ?? ""),
    queryFn: () => fetchPenalties(token!, { limit }),
    enabled: Boolean(token),
    refetchInterval: 15_000,
    retry: false,
  });
}

/// What an asset calls itself and how it scales, from the row when the API said, else from the
/// pad's own registry, else ETH: the Bag takes nothing the factory did not allow as a pair.
export const NATIVE = "0x0000000000000000000000000000000000000000";

export function assetOf(asset: string | null | undefined, row?: { symbol?: string | null; decimals?: number | null; assetSymbol?: string | null }) {
  const known = pairAsset(asset ?? NATIVE);
  return {
    symbol: row?.assetSymbol ?? row?.symbol ?? known?.symbol ?? (asset && asset !== NATIVE ? "units" : "ETH"),
    decimals: row?.decimals ?? known?.decimals ?? 18,
  };
}

/// An amount off the wire is a string somebody else wrote, and `BigInt("")` throws.
export function big(value: unknown): bigint {
  try {
    if (typeof value === "bigint") return value;
    if (typeof value === "number") return BigInt(Math.trunc(value));
    if (typeof value === "string" && value !== "") return BigInt(value.split(".")[0]!);
    return 0n;
  } catch {
    return 0n;
  }
}
