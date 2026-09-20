export { fmt, compact, shortAddress, timeUntil, LOCK_TIERS } from "@hood/sdk";
import { FEE_LEG_LABEL, type FeeLeg } from "@hood/sdk";

/// A launch's fee split as the app reads it off a row: the legs that pay something, largest first.
/// A direct launch is four zeros, because its own splitter divides its tax, and that is not the
/// same as a curve launch paying nobody, which the factory refuses.
export interface SplitRow {
  split_stakers_bps: number;
  split_buyback_bps: number;
  split_liquidity_bps: number;
  split_creator_bps: number;
  mode?: string;
}

export function splitOf(row: SplitRow): { leg: FeeLeg; bps: number; label: string }[] {
  return ([
    { leg: "stakers" as const, bps: row.split_stakers_bps ?? 0 },
    { leg: "buyback" as const, bps: row.split_buyback_bps ?? 0 },
    { leg: "liquidity" as const, bps: row.split_liquidity_bps ?? 0 },
    { leg: "creator" as const, bps: row.split_creator_bps ?? 0 },
  ]).filter((l) => l.bps > 0).sort((a, b) => b.bps - a.bps)
    .map((l) => ({ ...l, label: FEE_LEG_LABEL[l.leg] }));
}

/// One line for a card or a row: "60% stakers, 40% buy back and burn".
export function splitLabel(row: SplitRow): string {
  if (row.mode === "direct") return "Split four ways by the splitter";
  const legs = splitOf(row);
  if (legs.length === 0) return "Chosen at launch";
  return legs.map((l) => `${Math.round(l.bps / 100)}% ${l.label.toLowerCase()}`).join(", ");
}

/// Whether locking this token earns anything, which decides what the staking panel says.
export const paysStakers = (row: SplitRow) => (row.split_stakers_bps ?? 0) > 0;

export const PHASE_LABEL = ["on the curve", "sold out", "graduated"] as const;

export function pairDecimals(pairToken: string) {
  return pairToken === "0x0000000000000000000000000000000000000000" ? 18 : 6;
}

export function pairSymbol(pairToken: string) {
  return pairToken === "0x0000000000000000000000000000000000000000" ? "ETH" : "USDG";
}

export function ago(iso: string) {
  // Never negative. A chain's clock is its own: 4663 stamps blocks from its sequencer, a fork runs
  // ahead of the wall clock as soon as blocks are mined faster than a second, and a reader's laptop
  // can simply be behind. Any of those made a fresh launch read "printed -604918s ago".
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/// ipfs:// and bare CIDs go through a public gateway; anything else is left alone.
export function imageUrl(raw: string): string {
  if (!raw) return "";
  if (raw.startsWith("ipfs://")) return `https://ipfs.io/ipfs/${raw.slice(7)}`;
  if (/^[a-zA-Z0-9]{46,}$/.test(raw)) return `https://ipfs.io/ipfs/${raw}`;
  return raw;
}

/// Progress towards graduation for either machine, 0 to 1.
export function launchProgress(t: {
  mode: string; sold: string; curve_supply: string; bonded: boolean;
  tick_start: number | null; tick_bond: number | null; last_tick: number | null;
}): number {
  if (t.mode === "direct") {
    if (t.bonded) return 1;
    if (t.tick_start == null || t.tick_bond == null || t.last_tick == null) return 0;
    const span = t.tick_bond - t.tick_start;
    if (span === 0) return 0;
    return Math.max(0, Math.min(1, (t.last_tick - t.tick_start) / span));
  }
  const cs = Number(t.curve_supply);
  return cs === 0 ? 0 : Number(t.sold) / cs;
}

/// The word on the badge. `bonded` is the contract's name for the latch; to anyone reading a
/// screener it is graduation, so that is the word shown.
export function machineLabel(t: { mode: string; phase: number; bonded: boolean }): string {
  if (t.mode === "direct") return t.bonded ? "graduated" : "graduating";
  return PHASE_LABEL[t.phase] ?? "";
}

/// Where the rest of the world looks a pool up. A v4 pool has no contract of its own, so both
/// screeners address it by its id, the bytes32 the PoolManager keys on. Without a pool id
/// DexScreener can still find the token by address; GeckoTerminal cannot.
export const DEXSCREENER = "https://dexscreener.com/robinhood";
export const GECKOTERMINAL = "https://www.geckoterminal.com/robinhood/pools";

export function screenerLinks(token: string, poolId: string | null | undefined) {
  return {
    dexscreener: `${DEXSCREENER}/${poolId ?? token}`,
    geckoterminal: poolId ? `${GECKOTERMINAL}/${poolId}` : null,
  };
}

/// A link out of a launch's own metadata, or nothing.
/// @dev The string was typed by whoever printed the token and it lands in an `href`. React 18 only
///      warns about `javascript:` in an href, it does not refuse it, so a creator could plant a
///      click that runs on this origin, where the operator's admin token lives in sessionStorage.
///      Only http and https ever come back from here; anything else is dropped and the link is not
///      rendered at all.
export function safeUrl(raw: string | null | undefined): string | null {
  const text = raw?.trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    // no scheme: treat it as a bare domain, which is what most creators type
    return /^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(text) ? `https://${text}` : null;
  }
}

/// An x.com link from a handle a creator typed. Only the handle characters survive, so a value like
/// `"><script>` or `evil.com/path` cannot steer the href anywhere but a (possibly empty) x.com
/// profile. Returns null for nothing usable, so the caller renders no link rather than a broken one.
export function twitterUrl(raw: string | null | undefined): string | null {
  const handle = (raw ?? "").trim().replace(/^@+/, "").replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, "");
  const clean = handle.match(/^[A-Za-z0-9_]{1,30}/)?.[0];
  return clean ? `https://x.com/${clean}` : null;
}

/// A t.me link from whatever a creator typed: a bare handle, `t.me/foo`, or a full URL. A full URL
/// is only honoured when it already points at telegram; anything else, and any stray character
/// outside a handle, is dropped. `javascript:` never survives, because the scheme is stripped before
/// the host is checked.
export function telegramUrl(raw: string | null | undefined): string | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  // Strip a telegram prefix in any of its forms: a full URL, a scheme-less `t.me/foo`, or a bare
  // `@handle`. What is left must be a plain handle/path; a leftover scheme, host or dot means the
  // value pointed somewhere other than telegram, so it is dropped rather than linked.
  const path = text
    .replace(/^@+/, "")
    .replace(/^(https?:\/\/)?(www\.)?(t\.me|telegram\.me|telegram\.dog)\//i, "");
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || /^\/\//.test(path) || path.includes(".")) return null;
  const clean = path.match(/^[A-Za-z0-9_+/]{1,64}/)?.[0];
  return clean ? `https://t.me/${clean}` : null;
}
