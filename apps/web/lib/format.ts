export { fmt, compact, shortAddress, timeUntil, LOCK_TIERS } from "@hood/sdk";

/// What a launch does with its trading fee, in one line. A direct launch has no fee model at all:
/// its tax is split four ways by its own splitter, which is why this takes a null rather than
/// pretending the absence of a model is model zero, "stakers take the fee".
export const feeModelLabel = (model: number | null | undefined) =>
  model === null || model === undefined
    ? "Split four ways by the splitter"
    : FEE_MODEL_LABEL[model] ?? "Chosen at launch";

export const FEE_MODEL_LABEL = [
  "Stakers take the fee",
  "Buy back and burn",
  "Deepen the liquidity",
  "Creator keeps the fee",
  "No creator fee",
] as const;

export const FEE_MODEL_SHORT = ["staking", "buyback", "liquidity", "creator", "zero fee"] as const;

export const PHASE_LABEL = ["on the curve", "sold out", "graduated"] as const;

export function pairDecimals(pairToken: string) {
  return pairToken === "0x0000000000000000000000000000000000000000" ? 18 : 6;
}

export function pairSymbol(pairToken: string) {
  return pairToken === "0x0000000000000000000000000000000000000000" ? "ETH" : "USDG";
}

export function ago(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
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
