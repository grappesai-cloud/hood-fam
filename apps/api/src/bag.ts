import type { FastifyInstance, FastifyReply } from "fastify";
import { createPublicClient, http, isAddress, parseAbi, zeroAddress, type Address } from "viem";
import { z } from "zod";

import { pairAsset, robinhood } from "@hood/sdk";
import { chainHead } from "./admin.js";
import { pool } from "./db.js";
import { PAIR_ASSETS as PRICEABLE, pairUsdQuote } from "./price.js";
import { SYSTEM } from "./system.js";

/// The Bag, read back. Everything the indexer wrote about the platform's money (the Bag's
/// inflows and outlets, every token's pot, the hourly Payday, the burn clock, the boost board,
/// the penalties and the wall of shame) served the way the ledger is served: amounts as decimal
/// strings in the asset's smallest unit, every asset with its symbol and decimals, dollars only
/// where a price exists and a reason where it does not.
///
/// Nothing here writes. The keeper reads two routes (`/payday/:epoch`, `/auctions/open`) and acts
/// on chain; the chain is the only thing that moves money.

// ------------------------------------------------------------------ addresses

/// The env keys the new contracts arrive under. Exported so the server's trader exclusion and the
/// keeper-facing routes count the same machines.
export const BAG_ENV_KEYS = [
  "HOOD_BAG", "HOOD_PAYDAY", "HOOD_BURN_CLOCK", "HOOD_BOOSTS", "HOOD_GRADUATION_HOOK", "HOOD_OPENING_AUCTION",
] as const;

const envAddress = (key: string): string | null => {
  const raw = process.env[key]?.trim();
  return raw && isAddress(raw) ? raw.toLowerCase() : null;
};

/// The deployed addresses as this process sees them: null when unset, so the page can print
/// "not deployed" next to the outlet rather than nothing. The Vault is the staking contract, the
/// house is the treasury Safe, the coin is unset until it launches.
export const bagAddresses = () => ({
  bag: envAddress("HOOD_BAG"),
  payday: envAddress("HOOD_PAYDAY"),
  burnClock: envAddress("HOOD_BURN_CLOCK"),
  boosts: envAddress("HOOD_BOOSTS"),
  vault: envAddress("HOOD_STAKING"),
  house: envAddress("HOOD_SAFE"),
  graduationHook: envAddress("HOOD_GRADUATION_HOOK"),
  openingAuction: envAddress("HOOD_OPENING_AUCTION"),
  houseCoin: envAddress("HOOD_HOUSE_COIN"),
});

const chain = createPublicClient({
  chain: robinhood,
  transport: http(process.env.HOOD_RPC ?? robinhood.rpcUrls.default.http[0]),
});

// ---------------------------------------------------------------------- helpers

/// Hours since the epoch, which is what every hourly contract here calls an epoch.
const HOUR_MS = 3_600_000;
const currentHour = () => Math.floor(Date.now() / HOUR_MS);
const hourStart = (hour: number) => new Date(hour * HOUR_MS).toISOString();

/// The same tiny per-process cache the server keeps for its hot aggregates. Per instance and
/// best-effort; the TTL is the staleness.
const memo = new Map<string, { at: number; value: unknown }>();
async function cachedFor<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const value = await fn();
  memo.set(key, { at: Date.now(), value });
  if (memo.size > 500) for (const [k, v] of memo) if (Date.now() - v.at > 60_000) memo.delete(k);
  return value;
}

const bad = (reply: FastifyReply, error: string) => reply.code(400).send({ error });

/// A decimal string for anything Postgres hands back as a numeric, a bigint, or nothing.
const dec = (value: unknown): string => (value == null ? "0" : String(value));
const num = (value: unknown): number | null => (value == null ? null : Number(value));

export interface AssetMeta { symbol: string | null; decimals: number }

const metaCache = new Map<string, { at: number; meta: AssetMeta }>();

/// Symbol and decimals for every asset a response names, the way /ledger resolves a pair: the
/// price registry first (it knows every allowed quote), the SDK's catalogue, then what the
/// launches table recorded about the pair (a custom quote arrives with its own symbol), and a
/// launched token's own symbol for an asset that is one of ours (the house coin). Unknown stays
/// unknown: a null symbol and eighteen decimals, never a made-up ticker.
export async function assetMetas(addresses: Iterable<string | null | undefined>): Promise<Map<string, AssetMeta>> {
  const out = new Map<string, AssetMeta>();
  const unknown: string[] = [];
  for (const raw of addresses) {
    if (!raw) continue;
    const a = raw.toLowerCase();
    if (out.has(a)) continue;
    const priced = PRICEABLE[a];
    if (priced) { out.set(a, { symbol: priced.symbol, decimals: priced.decimals }); continue; }
    const known = pairAsset(a);
    if (known) { out.set(a, { symbol: known.symbol, decimals: known.decimals }); continue; }
    const hit = metaCache.get(a);
    if (hit && Date.now() - hit.at < 60_000) { out.set(a, hit.meta); continue; }
    if (!unknown.includes(a)) unknown.push(a);
  }
  if (unknown.length) {
    const { rows } = await pool.query<{ asset: string; symbol: string | null; decimals: number | null }>(
      `select pair_token as asset, pair_symbol as symbol, pair_decimals as decimals
         from launches where pair_token = any($1::text[]) and pair_symbol is not null
       union all
       select token as asset, symbol, 18 as decimals from launches where token = any($1::text[])`,
      [unknown],
    );
    for (const r of rows) if (!out.has(r.asset)) out.set(r.asset, { symbol: r.symbol, decimals: Number(r.decimals ?? 18) });
    for (const a of unknown) {
      const meta = out.get(a) ?? { symbol: null, decimals: 18 };
      out.set(a, meta);
      metaCache.set(a, { at: Date.now(), meta });
    }
  }
  return out;
}

const metaOf = (metas: Map<string, AssetMeta>, asset: string | null | undefined): AssetMeta =>
  (asset && metas.get(asset.toLowerCase())) || { symbol: null, decimals: 18 };

/// Dollars for an amount of an asset, or null with the reason. A dollar figure is derived from a
/// price somebody read; when nobody read one, the page prints a dash and this says why.
interface UsdResult { usd: number | null; reason: string | null }
async function usdOf(asset: string, amount: string, decimals: number): Promise<UsdResult> {
  const quote = await pairUsdQuote(asset);
  if (quote.usd == null) return { usd: null, reason: quote.reason };
  return { usd: (Number(amount) / 10 ** decimals) * quote.usd, reason: null };
}

/// A total over several assets in dollars: the priced ones added up, the unpriced ones named. Null
/// when nothing could be priced, so a zero is never printed over money that exists.
async function usdTotal(
  legs: { asset: string; amount: string; decimals: number; symbol: string | null }[],
): Promise<{ usd: number | null; reason: string | null }> {
  const priced = await Promise.all(legs.map(async (leg) => ({ ...leg, ...(await usdOf(leg.asset, leg.amount, leg.decimals)) })));
  const unpriced = priced.filter((l) => l.usd == null && Number(l.amount) > 0);
  const any = priced.some((l) => l.usd != null);
  const usd = any ? priced.reduce((sum, l) => sum + (l.usd ?? 0), 0) : null;
  const names = unpriced.map((l) => l.symbol ?? l.asset.slice(0, 10)).join(", ");
  const reason = unpriced.length
    ? `${names} ${unpriced.length === 1 ? "has" : "have"} no dollar price and ${unpriced.length === 1 ? "is" : "are"} left out`
    : usd == null && legs.length ? "no price source for these assets" : usd == null ? "nothing has moved yet" : null;
  return { usd, reason };
}

/// Money that reached a wallet without the wallet lifting a finger: a pot pushing dividends, Payday
/// paying the hour, a row of a season's airdrop being claimed (permissionless, and always paid to
/// the listed account). One shape over the three tables, so /earners and /paid add up the same
/// thing. `$1` is the window in whole days; `$2` is the machine list to leave out.
const AUTO_PAID = `
  select holder as address, asset, amount, ts, 'push' as source
    from pot_payouts where ts > now() - make_interval(days => $1::int)
  union all
  select wallet, asset, amount, ts, 'payday'
    from payday_payouts where ts > now() - make_interval(days => $1::int)
  union all
  select account, asset, amount, ts, 'airdrop'
    from airdrop_payouts where ts > now() - make_interval(days => $1::int)`;

/// Dollars per smallest unit of each priced asset, for ranking inside the query: the amount times
/// this is the leg in dollars. An asset nobody can price is left out, so its wallets rank by what
/// they were paid in native, the same rule /shame ranks by count under.
async function unitPrices(assets: string[], metas: Map<string, AssetMeta>): Promise<{ asset: string; unit: number }[]> {
  const units = await Promise.all(assets.map(async (asset) => {
    const quote = await pairUsdQuote(asset);
    return quote.usd == null ? null : { asset, unit: quote.usd / 10 ** metaOf(metas, asset).decimals };
  }));
  return units.filter((u): u is { asset: string; unit: number } => u != null);
}

/// `bag_events.extra` carries the Bag's source and outlet. The indexer may store the enum as its
/// number or as its name; both are matched so a tape written either way adds up the same.
const SOURCES = ["trade", "graduation", "penalty", "house", "housecoin"] as const;
const OUTLETS = ["house", "vault", "payday", "burn", "confetti"] as const;
const sourceIs = (i: number) => `lower(replace(coalesce(b.extra->>'source', ''), '_', '')) in ('${i}', '${SOURCES[i]}')`;
const outletIs = (i: number) => `lower(coalesce(b.extra->>'outlet', '')) in ('${i}', '${OUTLETS[i]}')`;

/// The Bag's books per asset, straight off the BagIn, BagOut and Held rows.
interface BagTotalsRow {
  asset: string;
  in_trade: string; in_graduation: string; in_penalty: string; in_house: string; in_house_coin: string; in_total: string;
  out_house: string; out_vault: string; out_payday: string; out_burn: string; out_confetti: string; out_total: string;
  held_vault: string; held_burn: string;
}
async function bagTotals(): Promise<BagTotalsRow[]> {
  const { rows } = await pool.query<BagTotalsRow>(
    `select b.asset,
            coalesce(sum(b.amount) filter (where b.kind = 'bag_in' and ${sourceIs(0)}), 0) as in_trade,
            coalesce(sum(b.amount) filter (where b.kind = 'bag_in' and ${sourceIs(1)}), 0) as in_graduation,
            coalesce(sum(b.amount) filter (where b.kind = 'bag_in' and ${sourceIs(2)}), 0) as in_penalty,
            coalesce(sum(b.amount) filter (where b.kind = 'bag_in' and ${sourceIs(3)}), 0) as in_house,
            coalesce(sum(b.amount) filter (where b.kind = 'bag_in' and ${sourceIs(4)}), 0) as in_house_coin,
            coalesce(sum(b.amount) filter (where b.kind = 'bag_in'), 0) as in_total,
            coalesce(sum(b.amount) filter (where b.kind = 'bag_out' and ${outletIs(0)}), 0) as out_house,
            coalesce(sum(b.amount) filter (where b.kind = 'bag_out' and ${outletIs(1)}), 0) as out_vault,
            coalesce(sum(b.amount) filter (where b.kind = 'bag_out' and ${outletIs(2)}), 0) as out_payday,
            coalesce(sum(b.amount) filter (where b.kind = 'bag_out' and ${outletIs(3)}), 0) as out_burn,
            coalesce(sum(b.amount) filter (where b.kind = 'bag_out' and ${outletIs(4)}), 0) as out_confetti,
            coalesce(sum(b.amount) filter (where b.kind = 'bag_out'), 0) as out_total,
            coalesce(sum(b.amount) filter (where b.kind = 'held' and ${outletIs(1)}), 0) as held_vault,
            coalesce(sum(b.amount) filter (where b.kind = 'held' and ${outletIs(3)}), 0) as held_burn
       from bag_events b
      where b.kind in ('bag_in', 'bag_out', 'held') and b.asset is not null
      group by b.asset
      order by in_total desc`,
  );
  return rows;
}

/// What is still held inside the Bag for an outlet that has no coin yet. Held rows are what
/// accrued while the coin was unset; the release, when it comes, leaves as an ordinary BagOut of
/// the same outlet, so held minus out is what has not left, floored at zero once it all has.
const stillHeld = (held: string, out: string): string => {
  const left = BigInt(held) - BigInt(out);
  return left > 0n ? left.toString() : "0";
};

// ---------------------------------------------------------------------- boosts

const boostsAbi = parseAbi([
  "function slotPrice() view returns (uint256)",
  "function SLOTS() view returns (uint8)",
]);

interface BoostTerms { price: string | null; slotCount: number | null; priceSource: "chain" | "last_paid" | null; priceReason: string | null }

/// What a slot costs, read off the contract and remembered for a minute. With no contract to ask,
/// the last price anybody paid is offered with a reason, and with nothing ever bought there is no
/// number at all.
async function boostTerms(): Promise<BoostTerms> {
  return cachedFor("boost-terms", 60_000, async () => {
    const boosts = envAddress("HOOD_BOOSTS");
    if (boosts) {
      try {
        const [price, slots] = await Promise.all([
          chain.readContract({ address: boosts as Address, abi: boostsAbi, functionName: "slotPrice" }),
          chain.readContract({ address: boosts as Address, abi: boostsAbi, functionName: "SLOTS" }),
        ]);
        return { price: String(price), slotCount: Number(slots), priceSource: "chain", priceReason: null };
      } catch {
        // Fall through to what the tape remembers.
      }
    }
    const why = boosts ? "HoodBoosts did not answer" : "HOOD_BOOSTS is not set";
    const { rows } = await pool.query<{ paid: string }>(`select paid from boosts order by hour_epoch desc, slot desc limit 1`);
    if (rows[0]) return { price: dec(rows[0].paid), slotCount: null, priceSource: "last_paid", priceReason: `${why}; this is what the last slot cost` };
    return { price: null, slotCount: null, priceSource: null, priceReason: `${why} and no slot was ever bought` };
  });
}

interface BoostSlot { slot: number; token: string; symbol: string | null; name: string | null; image: string | null; buyer: string; paid: string; tx: string; ts: Date }
async function boostSlots(hour: number): Promise<BoostSlot[]> {
  const { rows } = await pool.query(
    `select b.slot, b.token, b.buyer, b.paid, b.tx, b.ts, l.symbol, l.name, l.image
       from boosts b left join launches l on l.token = b.token
      where b.hour_epoch = $1 order by b.slot`,
    [hour],
  );
  return rows.map((r) => ({ ...r, slot: Number(r.slot), paid: dec(r.paid) }));
}

// ---------------------------------------------------------------------- per token

/// The launch columns the Bag routes read. `pot` is the launch's own pot; a direct launch whose
/// splitter is its pot (it already runs the per-share accumulator) answers with the splitter.
interface PotLaunch {
  token: string; symbol: string; mode: string; pot: string | null; splitter: string | null;
  pair_token: string; pair_symbol: string | null; pair_decimals: number | null;
  king_bps: number | null; auction_blocks: number | null;
}
const effectivePot = (l: { pot?: string | null; mode?: string | null; splitter?: string | null }): string | null =>
  l.pot ?? (l.mode === "direct" ? l.splitter ?? null : null);

async function potLaunch(token: string): Promise<PotLaunch | null> {
  const { rows } = await pool.query<PotLaunch>(
    `select token, symbol, mode, pot, splitter, pair_token, pair_symbol, pair_decimals, king_bps, auction_blocks
       from launches where token = $1`,
    [token],
  );
  return rows[0] ?? null;
}

const pairMeta = (l: PotLaunch): AssetMeta => ({
  symbol: l.pair_symbol ?? pairAsset(l.pair_token)?.symbol ?? PRICEABLE[l.pair_token]?.symbol ?? null,
  decimals: Number(l.pair_decimals ?? pairAsset(l.pair_token)?.decimals ?? PRICEABLE[l.pair_token]?.decimals ?? 18),
});

/// The reasons a pot deposit can carry, as the contracts tag them. Every key is present so a page
/// never has to guess whether a missing one is zero or unknown.
const REASONS = ["snipe", "jeet", "whale", "confetti", "slash", "auction", "payday", "dividends", "lp_fees", "king"] as const;

/// What `/tokens/:token` adds for a launch: its pot, its penalty settings, what its holders were
/// paid so far, and whether it holds a boost slot this hour. Takes the row the route already read.
export async function tokenBag(row: Record<string, unknown>) {
  const token = String(row.token).toLowerCase();
  const [{ rows: paid }, { rows: boosted }] = await Promise.all([
    pool.query<{ paid: string; deposits: string }>(
      `select coalesce(sum(amount), 0) as paid, count(*) as deposits from pot_deposits where token = $1`, [token],
    ),
    pool.query(`select 1 from boosts where token = $1 and hour_epoch = $2 limit 1`, [token, currentHour()]),
  ]);
  return {
    pot: effectivePot(row as { pot?: string | null; mode?: string | null; splitter?: string | null }),
    penalties: {
      snipe_tax_bps: num(row.snipe_tax_bps),
      snipe_decay_seconds: num(row.snipe_decay_seconds),
      jeet_tax_bps: num(row.jeet_tax_bps),
      jeet_window_seconds: num(row.jeet_window_seconds),
      whale_tax_bps: num(row.whale_tax_bps),
      whale_tick_limit: num(row.whale_tick_limit),
      king_bps: num(row.king_bps),
      penalties_to_vault: row.penalties_to_vault == null ? null : Boolean(row.penalties_to_vault),
      auction_blocks: num(row.auction_blocks),
    },
    paid_to_holders: dec(paid[0]?.paid),
    pot_deposits: Number(paid[0]?.deposits ?? 0),
    boosted: boosted.length > 0,
  };
}

/// What `/portfolio/:address` adds for a wallet: dividends pushed to it per launch, its Payday
/// wins, what the Vault paid it per asset, and its bounty points. All of it is what the chain
/// already did; nothing here is owed.
export async function walletBag(address: string) {
  const a = address.toLowerCase();
  const [{ rows: pushed }, { rows: payday }, { rows: paydayTotal }, { rows: vault }, { rows: bounty }, { rows: bountyRecent }] = await Promise.all([
    pool.query(
      `select p.token, l.symbol, l.name, l.image, l.pair_token as asset,
              sum(p.amount) as amount, count(*)::int as pushes, max(p.ts) as last_ts
         from pot_payouts p join launches l on l.token = p.token
        where p.holder = $1
        group by p.token, l.symbol, l.name, l.image, l.pair_token
        order by last_ts desc`,
      [a],
    ),
    pool.query(`select epoch, asset, amount, tx, ts from payday_payouts where wallet = $1 order by id desc limit 100`, [a]),
    pool.query(`select asset, sum(amount) as amount, count(*)::int as epochs from payday_payouts where wallet = $1 group by asset order by amount desc`, [a]),
    pool.query(
      `select key as asset, sum(value::numeric) as claimed
         from stakes s, jsonb_each_text(s.claimed_by_asset)
        where s.owner = $1 group by key order by claimed desc`,
      [a],
    ),
    pool.query(
      `select coalesce(sum(amount), 0) as points, count(*)::int as events, max(ts) as last_ts
         from points where address = $1 and kind = 'bounty'`,
      [a],
    ),
    pool.query(
      `select p.token, l.symbol, p.amount, p.ts, p.ref from points p left join launches l on l.token = p.token
        where p.address = $1 and p.kind = 'bounty' order by p.ts desc limit 20`,
      [a],
    ),
  ]);
  const metas = await assetMetas([
    ...pushed.map((r) => r.asset), ...payday.map((r) => r.asset), ...paydayTotal.map((r) => r.asset), ...vault.map((r) => r.asset),
  ]);
  const withMeta = <T extends { asset: string }>(r: T) => ({ ...r, ...metaOf(metas, r.asset) });
  return {
    // `symbol` stays the launch's; the asset it was paid in is named beside it.
    pushed: pushed.map((r) => {
      const meta = metaOf(metas, r.asset);
      return { ...r, assetSymbol: meta.symbol, decimals: meta.decimals, amount: dec(r.amount) };
    }),
    payday: payday.map((r) => ({ ...withMeta(r), epoch: Number(r.epoch), amount: dec(r.amount) })),
    payday_total: paydayTotal.map((r) => ({ ...withMeta(r), amount: dec(r.amount) })),
    // `pending` is a view on the staking contract, not a row here; the page asks the chain for it.
    vault: vault.map((r) => ({ ...withMeta(r), claimed: dec(r.claimed) })),
    bounties: {
      points: Number(bounty[0]?.points ?? 0),
      events: Number(bounty[0]?.events ?? 0),
      last_ts: bounty[0]?.last_ts ?? null,
      recent: bountyRecent.map((r) => ({ ...r, amount: Number(r.amount) })),
    },
  };
}

// ---------------------------------------------------------------------- routes

const tapeQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(60),
  before: z.coerce.number().int().positive().optional(),
  token: z.string().optional(),
  kind: z.string().max(600).optional(),
});
const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.coerce.number().int().positive().optional(),
});
const limitQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });
const earnersQuery = z.object({
  days: z.coerce.number().int().min(1).max(90).default(7),
  limit: z.coerce.number().int().min(1).max(200).default(30),
});
const paidQuery = z.object({ days: z.coerce.number().int().min(1).max(90).default(1) });
const hourQuery = z.object({ hour: z.coerce.number().int().min(0).max(10_000_000).optional() });
const headQuery = z.object({ head: z.coerce.number().int().min(0).optional() });

/// A route parameter that must be a token address, lowercased; anything else is a 400, not a
/// query against the table.
function tokenParam(req: { params: unknown }, reply: FastifyReply): string | null {
  const { token } = req.params as { token: string };
  if (!isAddress(token)) { bad(reply, "that is not a token address"); return null; }
  return token.toLowerCase();
}

export function registerBag(app: FastifyInstance, opts: { systemTraders?: string[] } = {}) {
  /// Wallets that never take a Payday share and never count as somebody paid: the protocol's own
  /// contracts, the new Bag machines, the season drop, and whatever the server already keeps out
  /// of the trader boards.
  const excluded = Array.from(new Set([
    ...SYSTEM,
    ...BAG_ENV_KEYS.map(envAddress).filter((a): a is string => Boolean(a)),
    ...[envAddress("HOOD_SEASON_DROP")].filter((a): a is string => Boolean(a)),
    ...(opts.systemTraders ?? []).map((a) => a.toLowerCase()),
  ]));

  // -------------------------------------------------------------------- /bag

  /// The Bag page in one read: addresses, the books per asset, the Payday clock, the burn clock
  /// and this hour's boosts. Ten seconds of cache; the tape underneath it is the live part.
  app.get("/bag", async () => cachedFor("bag", 10_000, async () => {
    const hour = currentHour();
    const [totals, { rows: funded }, { rows: carried }, { rows: last }, { rows: burnTotals }, { rows: lastBurn }, slots, terms] = await Promise.all([
      bagTotals(),
      pool.query<{ asset: string; funded: string }>(`select asset, funded from payday_epochs where epoch = $1`, [hour]),
      pool.query<{ asset: string; carried: string }>(
        `select distinct on (asset) asset, carried from payday_epochs
          where paid_at is not null and epoch < $1 order by asset, epoch desc`, [hour],
      ),
      pool.query<{ epoch: string; paid_at: Date; asset: string; to_wallets: string; to_launches: string; carried: string }>(
        `select epoch, paid_at, asset, to_wallets, to_launches, carried from payday_epochs
          where paid_at is not null and epoch = (select max(epoch) from payday_epochs where paid_at is not null)
          order by asset`,
      ),
      pool.query<{ asset: string; spent: string; coin_burned: string; burns: string; last_ts: Date }>(
        `select asset, coalesce(sum(spent), 0) as spent, coalesce(sum(coin_burned), 0) as coin_burned,
                count(*) as burns, max(ts) as last_ts from burns group by asset`,
      ),
      pool.query<{ asset: string; spent: string; coin_burned: string; epoch: string; ts: Date; tx: string }>(
        `select asset, spent, coin_burned, epoch, ts, tx from burns order by id desc limit 1`,
      ),
      boostSlots(hour),
      boostTerms(),
    ]);
    const spentByAsset = new Map(burnTotals.map((r) => [r.asset, r]));
    const metas = await assetMetas([
      ...totals.map((t) => t.asset), ...funded.map((r) => r.asset), ...carried.map((r) => r.asset),
      ...last.map((r) => r.asset), ...burnTotals.map((r) => r.asset), ...lastBurn.map((r) => r.asset),
    ]);

    const books = await Promise.all(totals.map(async (t) => {
      const meta = metaOf(metas, t.asset);
      const [inUsd, outUsd] = await Promise.all([usdOf(t.asset, t.in_total, meta.decimals), usdOf(t.asset, t.out_total, meta.decimals)]);
      return {
        asset: t.asset, ...meta,
        in: { trade: dec(t.in_trade), graduation: dec(t.in_graduation), penalty: dec(t.in_penalty), house: dec(t.in_house), houseCoin: dec(t.in_house_coin), total: dec(t.in_total) },
        out: { house: dec(t.out_house), vault: dec(t.out_vault), payday: dec(t.out_payday), burn: dec(t.out_burn), confetti: dec(t.out_confetti), total: dec(t.out_total) },
        held: { vault: stillHeld(t.held_vault, t.out_vault), burn: stillHeld(t.held_burn, t.out_burn) },
        usd: inUsd.usd == null ? null : { in: inUsd.usd, out: outUsd.usd ?? 0 },
        usdReason: inUsd.reason,
      };
    }));

    // This hour's pot per asset: what was funded into it so far plus what the last payout carried.
    const potByAsset = new Map<string, { funded: string; carried: string }>();
    for (const r of funded) potByAsset.set(r.asset, { funded: dec(r.funded), carried: "0" });
    for (const r of carried) potByAsset.set(r.asset, { funded: potByAsset.get(r.asset)?.funded ?? "0", carried: dec(r.carried) });
    const lastEpoch = last[0] ? Number(last[0].epoch) : null;
    const { rows: lastWallets } = lastEpoch == null
      ? { rows: [] as { wallets: string }[] }
      : await pool.query<{ wallets: string }>(`select count(distinct wallet) as wallets from payday_payouts where epoch = $1`, [lastEpoch]);

    // The burn clock: what it is holding per asset (what the Bag sent it, less what it spent),
    // plus what the Bag itself still holds for it while there is no coin to buy.
    const waiting = totals
      .map((t) => {
        const spent = spentByAsset.get(t.asset)?.spent ?? "0";
        const atClock = stillHeld(t.out_burn, spent);
        const held = stillHeld(t.held_burn, t.out_burn);
        return { asset: t.asset, ...metaOf(metas, t.asset), amount: atClock, held };
      })
      .filter((w) => w.amount !== "0" || w.held !== "0");

    return {
      addresses: bagAddresses(),
      totals: books,
      payday: {
        epoch: hour,
        startsAt: hourStart(hour),
        endsAt: hourStart(hour + 1),
        pot: Array.from(potByAsset, ([asset, p]) => ({ asset, ...metaOf(metas, asset), ...p })),
        last: lastEpoch == null ? null : {
          epoch: lastEpoch,
          paid_at: last[0]!.paid_at,
          toWallets: last.map((r) => ({ asset: r.asset, ...metaOf(metas, r.asset), amount: dec(r.to_wallets) })),
          toLaunches: last.map((r) => ({ asset: r.asset, ...metaOf(metas, r.asset), amount: dec(r.to_launches) })),
          carried: last.map((r) => ({ asset: r.asset, ...metaOf(metas, r.asset), amount: dec(r.carried) })),
          wallets: Number(lastWallets[0]?.wallets ?? 0),
        },
      },
      burn: {
        houseCoin: envAddress("HOOD_HOUSE_COIN"),
        totalBurned: burnTotals.reduce((sum, r) => sum + BigInt(r.coin_burned), 0n).toString(),
        burns: burnTotals.reduce((sum, r) => sum + Number(r.burns), 0),
        spent: burnTotals.map((r) => ({ asset: r.asset, ...metaOf(metas, r.asset), amount: dec(r.spent), last_ts: r.last_ts })),
        last: lastBurn[0] ? {
          asset: lastBurn[0].asset, ...metaOf(metas, lastBurn[0].asset),
          spent: dec(lastBurn[0].spent), coinBurned: dec(lastBurn[0].coin_burned),
          epoch: Number(lastBurn[0].epoch), ts: lastBurn[0].ts, tx: lastBurn[0].tx,
        } : null,
        waiting,
      },
      boosts: { hour, ...terms, slots },
      updatedAt: new Date().toISOString(),
    };
  }));

  // --------------------------------------------------------------- /bag/tape

  /// Every row the Bag's indexer wrote, newest first, paged by id the way /ledger pages. `kind`
  /// takes a comma list; `token` narrows to one launch.
  app.get("/bag/tape", async (req, reply) => {
    const parsed = tapeQuery.safeParse(req.query);
    if (!parsed.success) return bad(reply, parsed.error.issues[0]?.message ?? "bad request");
    const q = parsed.data;
    const token = q.token?.toLowerCase();
    if (token && !isAddress(token)) return bad(reply, "bad token");
    const kinds = q.kind ? q.kind.split(",").map((k) => k.trim()).filter(Boolean) : [];
    if (kinds.some((k) => !/^[a-z_]{1,40}$/.test(k))) return bad(reply, "bad kind");

    const params: unknown[] = [];
    const where: string[] = [];
    if (kinds.length) { params.push(kinds); where.push(`b.kind = any($${params.length}::text[])`); }
    if (token) { params.push(token); where.push(`b.token = $${params.length}`); }
    if (q.before) { params.push(q.before); where.push(`b.id < $${params.length}`); }
    params.push(q.limit);
    const { rows } = await pool.query(
      `select b.id, b.kind, b.token, l.symbol, l.name, l.image, b.asset, b.amount, b.extra, b.recipient, b.block, b.tx, b.ts
         from bag_events b left join launches l on l.token = b.token
        ${where.length ? "where " + where.join(" and ") : ""}
        order by b.id desc limit $${params.length}`,
      params,
    );
    const metas = await assetMetas(rows.map((r) => r.asset));
    return {
      rows: rows.map((r) => {
        const meta = metaOf(metas, r.asset);
        return {
          id: Number(r.id), kind: r.kind, token: r.token, symbol: r.symbol, name: r.name, image: r.image,
          asset: r.asset, assetSymbol: meta.symbol, decimals: meta.decimals,
          amount: dec(r.amount), extra: r.extra ?? {}, recipient: r.recipient, block: num(r.block), tx: r.tx, ts: r.ts,
        };
      }),
      nextBefore: rows.length === q.limit ? Number(rows[rows.length - 1].id) : null,
    };
  });

  // ------------------------------------------------------------------ /shame

  /// The wall of shame: every wallet a penalty was taken from, what it paid and how often. Ranked
  /// by dollars where the assets have a price, by count where they do not.
  app.get("/shame", async (req, reply) => {
    const parsed = limitQuery.safeParse(req.query);
    if (!parsed.success) return bad(reply, parsed.error.issues[0]?.message ?? "bad request");
    const { limit } = parsed.data;
    return cachedFor(`shame:${limit}`, 30_000, async () => {
      const { rows: payers } = await pool.query<{ payer: string; count: number; snipe: number; jeet: number; whale: number; last_ts: Date; tokens: number }>(
        `select payer, count(*)::int as count,
                count(*) filter (where kind = 'snipe')::int as snipe,
                count(*) filter (where kind = 'jeet')::int as jeet,
                count(*) filter (where kind = 'whale')::int as whale,
                max(ts) as last_ts, count(distinct token)::int as tokens
           from penalties where kind in ('snipe', 'jeet', 'whale')
          group by payer order by count desc, last_ts desc limit 500`,
      );
      if (!payers.length) return { rows: [] };
      const { rows: paid } = await pool.query<{ payer: string; asset: string; amount: string }>(
        `select payer, asset, sum(amount) as amount from penalties
          where kind in ('snipe', 'jeet', 'whale') and payer = any($1::text[]) group by payer, asset`,
        [payers.map((p) => p.payer)],
      );
      const metas = await assetMetas(paid.map((p) => p.asset));
      const byPayer = new Map<string, { asset: string; amount: string; symbol: string | null; decimals: number }[]>();
      for (const p of paid) {
        const legs = byPayer.get(p.payer) ?? [];
        legs.push({ asset: p.asset, amount: dec(p.amount), ...metaOf(metas, p.asset) });
        byPayer.set(p.payer, legs);
      }
      const rows = await Promise.all(payers.map(async (p) => {
        const legs = byPayer.get(p.payer) ?? [];
        const total = await usdTotal(legs);
        return { ...p, paid: legs, usd: total.usd, usdReason: total.reason };
      }));
      rows.sort((x, y) => {
        if (x.usd != null && y.usd != null && x.usd !== y.usd) return y.usd - x.usd;
        if ((x.usd != null) !== (y.usd != null)) return x.usd != null ? -1 : 1;
        return y.count - x.count;
      });
      return { rows: rows.slice(0, limit) };
    });
  });

  // ---------------------------------------------------------------- /earners

  /// The wallets the machine paid the most in the window, without them asking: pushed dividends,
  /// Payday shares and airdrop claims, summed per asset. Ranked in dollars where the assets have
  /// a price and by native otherwise, inside the query, so the cut is taken over every wallet and
  /// not over whichever ones a first page happened to hold.
  app.get("/earners", async (req, reply) => {
    const parsed = earnersQuery.safeParse(req.query);
    if (!parsed.success) return bad(reply, parsed.error.issues[0]?.message ?? "bad request");
    const { days, limit } = parsed.data;
    return cachedFor(`earners:${days}:${limit}`, 30_000, async () => {
      const { rows: assets } = await pool.query<{ asset: string }>(
        `select distinct asset from (${AUTO_PAID}) p where p.address <> all($2::text[])`, [days, excluded],
      );
      const metas = await assetMetas(assets.map((a) => a.asset));
      const prices = await unitPrices(assets.map((a) => a.asset), metas);
      const { rows } = await pool.query<{
        address: string; usd: string | null; native: string; pushes: number; payday: number; airdrops: number;
        last_ts: Date; paid: { asset: string; amount: string }[];
      }>(
        `with paid as (${AUTO_PAID}),
              px as (select * from jsonb_to_recordset($3::jsonb) as x(asset text, unit numeric)),
              legs as (
                select p.address, p.asset, sum(p.amount) as amount, max(p.ts) as last_ts,
                       count(*) filter (where p.source = 'push')::int as pushes,
                       count(*) filter (where p.source = 'payday')::int as payday,
                       count(*) filter (where p.source = 'airdrop')::int as airdrops
                  from paid p where p.address <> all($2::text[])
                 group by p.address, p.asset),
              ranked as (
                select l.address,
                       sum(l.amount * px.unit) as usd,
                       coalesce(sum(l.amount) filter (where l.asset = $4), 0) as native,
                       sum(l.pushes)::int as pushes, sum(l.payday)::int as payday, sum(l.airdrops)::int as airdrops,
                       max(l.last_ts) as last_ts,
                       jsonb_agg(jsonb_build_object('asset', l.asset, 'amount', l.amount::text) order by l.amount desc) as paid
                  from legs l left join px on px.asset = l.asset
                 group by l.address)
         select * from ranked order by usd desc nulls last, native desc, last_ts desc limit $5`,
        [days, excluded, JSON.stringify(prices), zeroAddress, limit],
      );
      const out = await Promise.all(rows.map(async (r) => {
        const legs = r.paid.map((leg) => ({ asset: leg.asset, amount: dec(leg.amount), ...metaOf(metas, leg.asset) }));
        const total = await usdTotal(legs);
        return {
          address: r.address, paid: legs, usd: total.usd, usdReason: total.reason,
          pushes: Number(r.pushes), payday: Number(r.payday), airdrops: Number(r.airdrops), last_ts: r.last_ts,
        };
      }));
      return { days, rows: out };
    });
  });

  // ------------------------------------------------------------------- /paid

  /// What the machine paid people in the window, per asset, over the same three sources: the
  /// landing page's "paid to people today". `wallets` is distinct recipients across every asset;
  /// `events` is every payout line.
  app.get("/paid", async (req, reply) => {
    const parsed = paidQuery.safeParse(req.query);
    if (!parsed.success) return bad(reply, parsed.error.issues[0]?.message ?? "bad request");
    const { days } = parsed.data;
    return cachedFor(`paid:${days}`, 10_000, async () => {
      // One pass with a rollup: the per-asset rows, then one row with asset null for the whole
      // window, which is where a distinct count of wallets across assets has to come from.
      interface PaidRow { asset: string | null; amount: string; events: number; wallets: number; pushes: number; payday: number; airdrops: number }
      const { rows } = await pool.query<PaidRow>(
        `select p.asset, coalesce(sum(p.amount), 0) as amount, count(*)::int as events,
                count(distinct p.address)::int as wallets,
                count(*) filter (where p.source = 'push')::int as pushes,
                count(*) filter (where p.source = 'payday')::int as payday,
                count(*) filter (where p.source = 'airdrop')::int as airdrops
           from (${AUTO_PAID}) p where p.address <> all($2::text[])
          group by rollup (p.asset)`,
        [days, excluded],
      );
      const perAsset = rows.filter((r): r is PaidRow & { asset: string } => r.asset != null);
      const all = rows.find((r) => r.asset == null);
      const metas = await assetMetas(perAsset.map((r) => r.asset));
      const totals = perAsset
        .map((r) => ({ asset: r.asset, ...metaOf(metas, r.asset), amount: dec(r.amount), events: Number(r.events), wallets: Number(r.wallets) }))
        .sort((x, y) => (BigInt(y.amount) > BigInt(x.amount) ? 1 : BigInt(y.amount) < BigInt(x.amount) ? -1 : 0));
      const usd = await usdTotal(totals);
      return {
        days,
        since: new Date(Date.now() - days * 86_400_000).toISOString(),
        totals,
        usd: usd.usd,
        usdReason: usd.reason,
        wallets: Number(all?.wallets ?? 0),
        events: Number(all?.events ?? 0),
        pushes: Number(all?.pushes ?? 0),
        payday: Number(all?.payday ?? 0),
        airdrops: Number(all?.airdrops ?? 0),
      };
    });
  });

  // ------------------------------------------------------- /tokens/:token/pot

  /// One launch's pot: what went in and why, what was pushed out, and who is still owed.
  app.get("/tokens/:token/pot", async (req, reply) => {
    const token = tokenParam(req, reply);
    if (!token) return;
    const launch = await potLaunch(token);
    if (!launch) return reply.code(404).send({ error: "unknown token" });
    return cachedFor(`pot:${token}`, 5_000, async () => {
      const [{ rows: totals }, { rows: reasons }, { rows: paid }, { rows: holders }, { rows: recent }] = await Promise.all([
        pool.query<{ deposited: string; deposits: string; last_ts: Date | null }>(
          `select coalesce(sum(amount), 0) as deposited, count(*) as deposits, max(ts) as last_ts from pot_deposits where token = $1`, [token],
        ),
        pool.query<{ reason: string; amount: string }>(`select reason, sum(amount) as amount from pot_deposits where token = $1 group by reason`, [token]),
        pool.query<{ paid: string; pushes: string; last_ts: Date | null; count_24h: string; paid_24h: string }>(
          `select coalesce(sum(amount), 0) as paid, count(*) as pushes, max(ts) as last_ts,
                  count(*) filter (where ts > now() - interval '24 hours') as count_24h,
                  coalesce(sum(amount) filter (where ts > now() - interval '24 hours'), 0) as paid_24h
             from pot_payouts where token = $1`, [token],
        ),
        pool.query<{ holders: string }>(`select count(*) as holders from balances where token = $1 and balance > 0`, [token]),
        pool.query(
          `select id, reason, payer, asset, amount, eligible_supply, holders, tx, ts
             from pot_deposits where token = $1 order by id desc limit 20`, [token],
        ),
      ]);
      const meta = pairMeta(launch);
      const byReason: Record<string, string> = Object.fromEntries(REASONS.map((r) => [r, "0"]));
      for (const r of reasons) byReason[r.reason] = dec(r.amount);
      const deposited = dec(totals[0]?.deposited);
      const paidOut = dec(paid[0]?.paid);
      const [depositedUsd, paidUsd] = await Promise.all([usdOf(launch.pair_token, deposited, meta.decimals), usdOf(launch.pair_token, paidOut, meta.decimals)]);
      return {
        token, pot: effectivePot(launch), asset: launch.pair_token, ...meta,
        totalDeposited: deposited,
        totalPaid: paidOut,
        deposits: Number(totals[0]?.deposits ?? 0),
        last_deposit_ts: totals[0]?.last_ts ?? null,
        pending_holders: Number(holders[0]?.holders ?? 0),
        byReason,
        recent: recent.map((r) => ({ ...r, id: Number(r.id), amount: dec(r.amount), eligible_supply: dec(r.eligible_supply), holders: num(r.holders) })),
        pushes: {
          last_ts: paid[0]?.last_ts ?? null,
          count: Number(paid[0]?.pushes ?? 0),
          count_24h: Number(paid[0]?.count_24h ?? 0),
          paid_24h: dec(paid[0]?.paid_24h),
        },
        usd: depositedUsd.usd == null ? null : { deposited: depositedUsd.usd, paid: paidUsd.usd ?? 0 },
        usdReason: depositedUsd.reason,
      };
    });
  });

  // ------------------------------------------------------ /tokens/:token/king

  /// King of the hill: who holds the crown, what the pot is, when the timer runs out, and the
  /// last twenty rounds. Two seconds of cache because the timer is the whole point.
  app.get("/tokens/:token/king", async (req, reply) => {
    const token = tokenParam(req, reply);
    if (!token) return;
    const launch = await potLaunch(token);
    if (!launch) return reply.code(404).send({ error: "unknown token" });
    return cachedFor(`king:${token}`, 2_000, async () => {
      const { rows } = await pool.query(
        `select id, king, pot, ends_at, won_amount, won_at, tx from king_rounds where token = $1 order by id desc limit 20`, [token],
      );
      const rounds = rows.map((r) => ({ ...r, id: Number(r.id), pot: dec(r.pot), won_amount: r.won_amount == null ? null : dec(r.won_amount) }));
      const open = rounds[0] && rounds[0].won_at == null ? rounds[0] : null;
      const kingBps = Number(launch.king_bps ?? 0);
      return {
        token, enabled: kingBps > 0, king_bps: kingBps,
        asset: launch.pair_token, ...pairMeta(launch),
        king: open?.king ?? null,
        pot: open?.pot ?? null,
        ends_at: open?.ends_at ?? null,
        live: open ? new Date(open.ends_at).getTime() > Date.now() : false,
        rounds,
      };
    });
  });

  // --------------------------------------------------- /tokens/:token/auction

  /// The sniper auction for the first slot, while it runs and after. A launch that did not turn
  /// it on says so; one that did but has no bid yet answers with the terms and an empty book.
  app.get("/tokens/:token/auction", async (req, reply) => {
    const token = tokenParam(req, reply);
    if (!token) return;
    const launch = await potLaunch(token);
    if (!launch) return reply.code(404).send({ error: "unknown token" });
    return cachedFor(`auction:${token}`, 2_000, async () => {
      const { rows } = await pool.query(`select * from auctions where token = $1`, [token]);
      const blocks = Number(launch.auction_blocks ?? 0);
      if (!rows[0] && blocks <= 0) return { enabled: false, token };
      const meta = pairMeta(launch);
      const a = rows[0];
      return {
        enabled: true, token, auction_blocks: blocks, asset: launch.pair_token, ...meta,
        end_block: a ? num(a.end_block) : null,
        top_bidder: a?.top_bidder ?? null,
        top_bid: a ? dec(a.top_bid) : "0",
        bids: Number(a?.bids ?? 0),
        settled: Boolean(a?.settled),
        winner: a?.winner ?? null,
        to_holders: a?.to_holders == null ? null : dec(a.to_holders),
        to_liquidity: a?.to_liquidity == null ? null : dec(a.to_liquidity),
        updated_at: a?.updated_at ?? null,
      };
    });
  });

  // ------------------------------------------------- /tokens/:token/penalties

  /// Every penalty taken on one launch, newest first, paged by id.
  app.get("/tokens/:token/penalties", async (req, reply) => {
    const token = tokenParam(req, reply);
    if (!token) return;
    const parsed = pageQuery.safeParse(req.query);
    if (!parsed.success) return bad(reply, parsed.error.issues[0]?.message ?? "bad request");
    const q = parsed.data;
    const { rows } = await pool.query(
      `select id, kind, payer, asset, amount, to_holders, to_bag, holders, block, tx, log_index, ts
         from penalties where token = $1 and ($2::bigint is null or id < $2)
        order by id desc limit $3`,
      [token, q.before ?? null, q.limit],
    );
    const metas = await assetMetas(rows.map((r) => r.asset));
    return {
      token,
      rows: rows.map((r) => ({
        ...r, ...metaOf(metas, r.asset), id: Number(r.id), block: num(r.block),
        amount: dec(r.amount), to_holders: dec(r.to_holders), to_bag: dec(r.to_bag), holders: num(r.holders),
      })),
      nextBefore: rows.length === q.limit ? Number(rows[rows.length - 1].id) : null,
    };
  });

  // ----------------------------------------------------------------- /boosts

  /// The boost board for an hour (this one by default) and the hour after it, so the page can
  /// show what is taken now and what can still be bought next.
  app.get("/boosts", async (req, reply) => {
    const parsed = hourQuery.safeParse(req.query);
    if (!parsed.success) return bad(reply, parsed.error.issues[0]?.message ?? "bad request");
    const hour = parsed.data.hour ?? currentHour();
    return cachedFor(`boosts:${hour}`, 5_000, async () => {
      const [terms, slots, next] = await Promise.all([boostTerms(), boostSlots(hour), boostSlots(hour + 1)]);
      return {
        hour, startsAt: hourStart(hour), endsAt: hourStart(hour + 1), current: hour === currentHour(),
        ...terms, slots,
        next: { hour: hour + 1, startsAt: hourStart(hour + 1), slots: next },
      };
    });
  });

  // ---------------------------------------------------------- /payday/:epoch

  /// What the keeper needs to pay an hour: every wallet that earned points in it and how many,
  /// and the ten launches before it whose pots take the slice. Never cached and never counts the
  /// machines: the whole list is what the keeper signs.
  app.get("/payday/:epoch", async (req, reply) => {
    const { epoch: raw } = req.params as { epoch: string };
    const epoch = Number(raw);
    if (!Number.isInteger(epoch) || epoch < 0 || epoch > 10_000_000) return bad(reply, "epoch must be hours since 1970, a whole number");
    const start = epoch * 3600;
    const end = start + 3600;
    const [{ rows: wallets }, { rows: lastTen }, { rows: pot }] = await Promise.all([
      pool.query<{ address: string; points: string }>(
        `select address, sum(amount)::numeric(20,2) as points
           from points
          where ts >= to_timestamp($1) and ts < to_timestamp($2) and address <> all($3::text[])
          group by address having sum(amount) > 0
          order by points desc, address`,
        [start, end, excluded],
      ),
      pool.query<{ token: string; symbol: string; pot: string; asset: string; launched_at: Date }>(
        `select token, symbol, coalesce(pot, case when mode = 'direct' then splitter end) as pot, pair_token as asset, launched_at
           from launches
          where coalesce(pot, case when mode = 'direct' then splitter end) is not null and launched_at < to_timestamp($1)
          order by launched_at desc limit 10`,
        [end],
      ),
      pool.query<{ asset: string; funded: string; to_wallets: string | null; to_launches: string | null; carried: string | null; paid_at: Date | null; tx: string | null }>(
        `select asset, funded, to_wallets, to_launches, carried, paid_at, tx from payday_epochs where epoch = $1 order by asset`, [epoch],
      ),
    ]);
    // Points carry two decimals; `weight` is the same figure as an integer (points times a
    // hundred) so the keeper's share arithmetic stays in whole numbers.
    const weightOf = (points: string) => BigInt(Math.round(Number(points) * 100));
    const totalWeight = wallets.reduce((sum, w) => sum + weightOf(w.points), 0n);
    const metas = await assetMetas([...lastTen.map((l) => l.asset), ...pot.map((p) => p.asset)]);
    return {
      epoch,
      startsAt: new Date(start * 1000).toISOString(),
      endsAt: new Date(end * 1000).toISOString(),
      closed: Date.now() >= end * 1000,
      totalPoints: wallets.reduce((sum, w) => sum + Number(w.points), 0),
      totalWeight: totalWeight.toString(),
      wallets: wallets.map((w) => ({ address: w.address, points: w.points, weight: weightOf(w.points).toString() })),
      lastTen: lastTen.map((l) => {
        const meta = metaOf(metas, l.asset);
        return { ...l, assetSymbol: meta.symbol, decimals: meta.decimals };
      }),
      pot: pot.map((p) => ({
        ...p, ...metaOf(metas, p.asset), funded: dec(p.funded),
        to_wallets: p.to_wallets == null ? null : dec(p.to_wallets),
        to_launches: p.to_launches == null ? null : dec(p.to_launches),
        carried: p.carried == null ? null : dec(p.carried),
      })),
      excluded: excluded.length,
    };
  });

  // ---------------------------------------------------------- /auctions/open

  /// Auctions whose clock has run out and that nobody settled. The keeper passes the head it
  /// already knows; without one the chain is asked, and a chain that does not answer means an
  /// empty list with a reason, never a guess.
  app.get("/auctions/open", async (req, reply) => {
    const parsed = headQuery.safeParse(req.query);
    if (!parsed.success) return bad(reply, parsed.error.issues[0]?.message ?? "bad request");
    const head = parsed.data.head ?? await chainHead();
    if (head == null) return { head: null, auctions: [], reason: "the chain did not answer for the head block; pass ?head=" };
    const { rows } = await pool.query(
      `select a.token, l.symbol, a.end_block, a.top_bidder, a.top_bid, a.bids, a.updated_at
         from auctions a left join launches l on l.token = a.token
        where not a.settled and a.end_block <= $1
        order by a.end_block`,
      [head],
    );
    return {
      head,
      auctions: rows.map((r) => ({ ...r, end_block: Number(r.end_block), top_bid: dec(r.top_bid), bids: Number(r.bids ?? 0) })),
    };
  });

  // ------------------------------------------------------------------ /vault

  /// The Vault as the lockers see it: what is locked, what it has been fed per asset, and what
  /// the Bag still holds for it while there is no coin.
  app.get("/vault", async () => cachedFor("vault", 10_000, async () => {
    const houseCoin = envAddress("HOOD_HOUSE_COIN");
    const [{ rows: locked }, { rows: rewards }, { rows: fromBag }] = await Promise.all([
      pool.query<{ total_locked: string; positions: string; lockers: string }>(
        `select coalesce(sum(amount), 0) as total_locked, count(*) as positions, count(distinct owner) as lockers
           from stakes where active and ($1::text is null or token = $1)`,
        [houseCoin],
      ),
      pool.query<{ asset: string; total: string; events: string; last_ts: Date }>(
        `select asset, sum(amount) as total, count(*) as events, max(ts) as last_ts from vault_rewards group by asset order by total desc`,
      ),
      pool.query<{ asset: string; out_vault: string; held_vault: string }>(
        `select b.asset,
                coalesce(sum(b.amount) filter (where b.kind = 'bag_out' and ${outletIs(1)}), 0) as out_vault,
                coalesce(sum(b.amount) filter (where b.kind = 'held' and ${outletIs(1)}), 0) as held_vault
           from bag_events b where b.kind in ('bag_out', 'held') and b.asset is not null group by b.asset`,
      ),
    ]);
    const metas = await assetMetas([...rewards.map((r) => r.asset), ...fromBag.map((r) => r.asset)]);
    const bagByAsset = new Map(fromBag.map((r) => [r.asset, r]));
    const rewardRows = rewards.map((r) => ({
      asset: r.asset, ...metaOf(metas, r.asset), total: dec(r.total), events: Number(r.events), last_ts: r.last_ts,
      fromBag: dec(bagByAsset.get(r.asset)?.out_vault),
    }));
    const held = fromBag
      .map((r) => ({ asset: r.asset, ...metaOf(metas, r.asset), amount: stillHeld(r.held_vault, r.out_vault) }))
      .filter((h) => h.amount !== "0");
    const usd = await usdTotal(rewardRows.map((r) => ({ asset: r.asset, amount: r.total, decimals: r.decimals, symbol: r.symbol })));
    return {
      houseCoin,
      totalLocked: dec(locked[0]?.total_locked),
      positions: Number(locked[0]?.positions ?? 0),
      lockers: Number(locked[0]?.lockers ?? 0),
      rewards: rewardRows,
      held,
      usd: usd.usd == null ? null : { rewards: usd.usd },
      usdReason: usd.reason,
    };
  }));
}
