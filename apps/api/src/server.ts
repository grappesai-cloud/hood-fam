import { gzip as gzipCb } from "node:zlib";
import { promisify } from "node:util";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { createPublicClient, http, isAddress, parseAbi, zeroAddress, type Address } from "viem";
import { z } from "zod";

const gzip = promisify(gzipCb);
/// Below this a compressed body plus its headers is not worth the CPU; above it the board (up to a
/// hundred token rows) and the candle series (up to a thousand buckets) are JSON that gzips five to
/// ten times smaller, which is the wire the browser waits on. Done with the standard library rather
/// than a plugin so it adds no dependency.
const GZIP_MIN_BYTES = 1024;

import { pool, currentSeason } from "./db.js";
import { pairAsset, PAIR_ASSETS as PAIR_CATALOG, robinhood } from "@hood/sdk";
import { PAIR_ASSETS as PRICEABLE, pairUsdPrice } from "./price.js";
import { resolveQuote } from "./quote-resolver.js";
import { hasNativeRoute, localNativeRoute, nativeQuoteRoute } from "./uniswap-route.js";

/// The two views the pair list asks the factory for. A client of its own rather than the
/// indexer's, because this one answers a request and must not wait behind a block scan.
const chain = createPublicClient({ chain: robinhood, transport: http(process.env.HOOD_RPC ?? robinhood.rpcUrls.default.http[0]!) });
const pairViewAbi = parseAbi([
  "function pairAllowed(address) view returns (bool)",
  "function lockThreshold(address) view returns (uint256)",
]);
import { leaderboard, pointsFor, RANKS, POINTS } from "./points.js";
import { chatMessage, registerChat } from "./chat.js";
import { registerStream } from "./events.js";
import { registerSupport } from "./support.js";
import { registerUploads } from "./uploads.js";
import { registerSocial } from "./social.js";
import { registerQuests } from "./quests.js";
import { pnlLeaderboard, walletPnl } from "./pnl.js";
import { chainHead, contracts, integrations, isAdmin } from "./admin.js";
import { closeSeason, frozenLeaderboard, listSeasons, openSeason, SeasonError, snapshotSeason } from "./seasons.js";
import { estimate, seasonPool, seasonPoints } from "./airdrop.js";
import { openGaps, rescanGaps } from "./indexer.js";
import { buildDrop, parseAmount, parseWei, saveDrop, storedDrop, storedProof, verifyDrop } from "./merkle.js";

/// One word for where a launch is, whichever machine printed it. The curve's phases and the direct
/// machine's latch both land on `graduated`, because that is the word every screener, bot and
/// trader uses; `bonded` stays on the row as the contract's own name for the latch.
const STATUS = `case when mode = 'direct' then (case when bonded then 'graduated' else 'curve' end)
                     when phase = 2 then 'graduated'
                     when phase = 1 then 'sold_out'
                     else 'curve' end`;

/// Progress towards graduation, 0 to 1, for either machine: supply sold on the curve, ticks
/// travelled from the opening tick to the graduation tick on a direct pool.
const PROGRESS = `case when mode = 'direct' then
                         (case when bonded then 1
                               when tick_start is null or tick_bond is null or last_tick is null or tick_bond = tick_start then 0
                               else greatest(0, least(1, (last_tick - tick_start)::numeric / (tick_bond - tick_start))) end)
                       when phase >= 2 then 1
                       when curve_supply = 0 then 0
                       else least(1, sold / curve_supply) end`;

/// Protocol contracts produce real swaps (first buys, buybacks and harvests), but a social tape
/// and a trader board are about people. Keep the exclusion in one place so both surfaces count the
/// same population as /stats.
const SYSTEM_TRADERS = [
  process.env.HOOD_FACTORY, process.env.HOOD_FEE_ROUTER, process.env.HOOD_STAKING, process.env.HOOD_GRADUATOR,
  process.env.HOOD_PORTAL, process.env.HOOD_BUYBACK_MODULE,
].filter(Boolean).map((a) => a!.toLowerCase());

/// How much of X-Forwarded-For to believe. A count of hops, never the whole header.
/// @dev proxy-addr walks the header from the right and asks this about each address; true means
///      "that one is ours, keep going". Trusting `hops` of them means the client address is the one
///      our own proxy appended, and anything the caller wrote further left is ignored.
function _trustProxy(): boolean | ((address: string, hop: number) => boolean) {
  const raw = (process.env.TRUST_PROXY ?? "").trim().toLowerCase();
  if (raw === "false" || raw === "0") return false;
  if (raw === "") return process.env.NODE_ENV === "production" ? (_a: string, hop: number) => hop < 1 : false;
  const parsed = Number(raw);
  // `true` used to mean "trust the whole header"; it now means "one proxy", which is what it was for.
  const hops = Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
  return (_address: string, hop: number) => hop < hops;
}

/// A query number that cannot come back as NaN or negative, because both reach Postgres as a
/// syntax error and answer a bad request with a 500.
function clampInt(value: unknown, fallback: number, max: number, min = 0): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/// Read side. Everything the app shows comes from here, so the browser never has to walk the chain.
export async function buildServer() {
  // Behind Traefik or Coolify the client's address arrives in X-Forwarded-For, and without this
  // every request looks like it came from the proxy, so one bucket would hold the whole internet.
  //
  // How MANY hops to trust matters more than whether to trust any. `true` means "believe the whole
  // header", and the header is written by the caller: one line of curl and every rate limit here,
  // on the assistant and on the uploads, is a different bucket every request. A number means "trust
  // that many hops from the right", so only what our own proxy appended is believed. One proxy is
  // the normal deployment; TRUST_PROXY takes a count for a longer chain, or `false` for none.
  const trustProxy = _trustProxy();
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" }, trustProxy });

  // Reflecting every origin is fine for a read API with no cookies, but it is not what a deployment
  // with its own domain wants, and nothing here needs it. CORS_ORIGIN is the list; in production the
  // site's own URL is the fallback, and a deployment that sets neither gets a warning rather than a
  // silent wildcard.
  const origins = process.env.CORS_ORIGIN?.split(",").map((o) => o.trim()).filter(Boolean);
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  let origin: string[] | boolean = true;
  if (origins?.length) origin = origins;
  else if (process.env.NODE_ENV === "production" && siteUrl) origin = [siteUrl];
  else if (process.env.NODE_ENV === "production") {
    app.log.warn("CORS_ORIGIN is not set: this API answers any origin. Set it to the site's URL.");
  }
  await app.register(cors, { origin });

  // Make the public read endpoints cacheable at a shared cache -- a CDN, or Traefik in front -- so
  // that under load the board is served from the edge at edge latency instead of hitting Postgres
  // for every viewer. `s-maxage` targets shared caches only, not the browser (the app fetches with
  // no-store anyway), and `stale-while-revalidate` lets the edge serve the last answer instantly
  // while it refreshes behind the scenes, so nobody waits on the origin and nothing goes more than a
  // few seconds stale. Only GETs, only the public read paths (matched on the route pattern, so admin,
  // support, uploads and the airdrop build never match), and never an error response.
  const CACHE_RULES: [RegExp, string][] = [
    [/^\/tokens$/, "public, s-maxage=3, stale-while-revalidate=15"],
    [/^\/tokens\/:token$/, "public, s-maxage=3, stale-while-revalidate=15"],
    [/^\/tokens\/:token\/candles$/, "public, s-maxage=3, stale-while-revalidate=30"],
    [/^\/tokens\/:token\/trades$/, "public, s-maxage=2, stale-while-revalidate=10"],
    [/^\/tokens\/:token\/holders$/, "public, s-maxage=5, stale-while-revalidate=30"],
    [/^\/activity$/, "public, s-maxage=2, stale-while-revalidate=8"],
    [/^\/top-traders$/, "public, s-maxage=5, stale-while-revalidate=20"],
    [/^\/stakes\/:owner$/, "public, s-maxage=5, stale-while-revalidate=30"],
    [/^\/leaderboard$/, "public, s-maxage=5, stale-while-revalidate=30"],
    [/^\/seasons$/, "public, s-maxage=10, stale-while-revalidate=60"],
    [/^\/stats$/, "public, s-maxage=10, stale-while-revalidate=60"],
  ];
  app.addHook("onSend", async (req, reply, payload) => {
    if (req.method !== "GET" || (reply.statusCode >= 300) || reply.getHeader("cache-control")) return payload;
    const pattern = req.routeOptions?.url;
    if (!pattern) return payload;
    for (const [re, value] of CACHE_RULES) {
      if (re.test(pattern)) { reply.header("cache-control", value); break; }
    }
    return payload;
  });

  // Compress JSON responses over the wire. The app fetches every list, chart and holder count from
  // here, and those payloads are the biggest thing between a click and the screen updating. Only
  // when the client asked for gzip, only above the threshold, only for a string body we serialised
  // (never a already-encoded or hijacked stream), and Vary so a cache keeps the two encodings apart.
  app.addHook("onSend", async (req, reply, payload) => {
    if (typeof payload !== "string" || payload.length < GZIP_MIN_BYTES) return payload;
    if (reply.getHeader("content-encoding")) return payload;
    if (!/\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""))) return payload;
    const ct = String(reply.getHeader("content-type") ?? "");
    if (!ct.includes("application/json") && !ct.includes("text/")) return payload;
    const zipped = await gzip(payload);
    reply.header("content-encoding", "gzip");
    reply.header("vary", "accept-encoding");
    reply.removeHeader("content-length");
    return zipped;
  });

  /// A read API in front of a database is cheap to call and cheap to abuse. Registered before the
  /// routes so it covers all of them; /health opts out, the admin routes tighten it.
  await app.register(rateLimit, {
    max: Number(process.env.RATE_LIMIT_PER_MINUTE ?? 300),
    timeWindow: "1 minute",
    allowList: process.env.RATE_LIMIT_TRUST_LOCAL === "1" ? ["127.0.0.1", "::1"] : [],
    keyGenerator: (req) => req.ip,
  });

  /// Every admin route: the token, then sixty a minute. The token check is the first thing that
  /// runs, so an anonymous caller never reaches the database.
  const adminOnly = {
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    preHandler: async (req: FastifyRequest, reply: FastifyReply) => {
      if (!isAdmin(req)) return reply.code(401).send({ error: "unauthorized" });
    },
  };

  /// A few endpoints aggregate a whole table on every hit -- the live leaderboard sums every point
  /// in a season, /stats counts distinct traders across all trades -- and the app, which fetches
  /// with no-store, calls them on every navigation. Their answer barely changes second to second, so
  /// a tiny in-process cache turns a hot aggregate into a map lookup. Per-instance and best-effort:
  /// a second replica just caches independently, and the staleness is the TTL, which is the point.
  const _cache = new Map<string, { at: number; value: unknown }>();
  async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
    const hit = _cache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
    const value = await fn();
    _cache.set(key, { at: Date.now(), value });
    if (_cache.size > 500) for (const [k, v] of _cache) if (Date.now() - v.at > 60_000) _cache.delete(k);
    return value;
  }

  /// Bad input from a caller, not a bug: the season layer says which, the route says it back.
  const seasonError = (e: unknown, reply: FastifyReply) => {
    if (e instanceof SeasonError) return reply.code(e.status).send({ error: e.message });
    throw e;
  };

  app.get("/health", { config: { rateLimit: false } }, async () => {
    const { rows } = await pool.query(`select block from cursors where name = 'main'`);
    return { ok: true, indexedBlock: rows[0]?.block ?? null, integrations: integrations() };
  });

  /// What an uptime check should ask. `/health` says the process answered, which is the least
  /// interesting thing that can be true: a box whose indexer died an hour ago still answers it,
  /// with a board quietly frozen behind it. This one fails, with 503 and a reason, when the
  /// database is unreachable, when the chain is, or when the indexer has fallen far enough behind
  /// that the site is showing yesterday. A deployment that is deliberately not indexing (a preview)
  /// says so and stays green, because there is nothing to be behind on.
  app.get("/ready", { config: { rateLimit: false } }, async (_req, reply) => {
    const out: Record<string, unknown> = { ok: true };
    try {
      await pool.query("select 1");
    } catch {
      return reply.code(503).send({ ok: false, database: "unreachable" });
    }
    out.database = "ok";

    if (process.env.INDEXER === "0") {
      out.indexer = "off";
      return reply.send(out);
    }

    const [head, { rows }] = await Promise.all([
      chainHead(),
      pool.query<{ block: string }>(`select block from cursors where name = 'main'`),
    ]);
    const cursor = rows[0] ? Number(rows[0].block) : null;
    if (head === null) return reply.code(503).send({ ...out, ok: false, chain: "unreachable", indexedBlock: cursor });
    if (cursor === null) return reply.code(503).send({ ...out, ok: false, indexer: "has not indexed anything yet", head });

    // Blocks are 100ms here, so the default is ten minutes of silence before anybody is woken.
    const behind = head - cursor;
    const limit = Number(process.env.READY_MAX_BLOCKS_BEHIND ?? 6000);
    if (behind > limit) {
      return reply.code(503).send({ ...out, ok: false, indexer: "behind", blocksBehind: behind, limit });
    }

    // A gap is worse than being behind: behind catches up on its own, a gap is trades and points
    // that are missing and will stay missing until the range is read again. The indexer retries
    // them on its slow clock, and `POST /admin/indexer/rescan` forces a pass.
    const gaps = await openGaps();
    if (gaps.open > 0) {
      return reply.code(503).send({ ...out, ok: false, indexer: "has gaps", blocksBehind: behind, gaps });
    }
    return reply.send({ ...out, indexer: "ok", blocksBehind: behind });
  });

  app.get("/tokens", async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const limit = clampInt(q.limit, 30, 100, 1);
    const offset = clampInt(q.offset, 0, 1_000_000);
    const sort =
      q.sort === "volume" ? "volume_24h desc"
      : q.sort === "progress" ? `(${PROGRESS}) desc`
      : q.sort === "graduated" ? "graduated_at desc nulls last"
      : "launched_at desc";
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.creator) { params.push(q.creator.toLowerCase()); where.push(`creator = $${params.length}`); }
    if (q.phase) { params.push(Number(q.phase)); where.push(`phase = $${params.length}`); }
    if (q.category === "new") where.push(`launched_at >= now() - interval '24 hours'`);
    if (q.category === "stocks") {
      params.push(PAIR_CATALOG.filter((asset) => asset.share).map((asset) => asset.address.toLowerCase()));
      where.push(`pair_token = any($${params.length}::text[])`);
    }
    if (q.category === "culture") {
      params.push(PAIR_CATALOG.map((asset) => asset.address.toLowerCase()));
      where.push(`pair_token <> all($${params.length}::text[])`);
    }
    if (q.category === "direct") where.push(`mode = 'direct'`);
    if (q.category === "locked") where.push(`first_buy_locked > 0 and (first_buy_unlock_at is null or first_buy_unlock_at > now())`);
    // `graduating` is the screener's "about to": at least halfway there and not there yet.
    if (q.status === "graduating") where.push(`(${PROGRESS}) >= 0.5 and (${STATUS}) <> 'graduated'`);
    else if (q.status === "curve" || q.status === "sold_out" || q.status === "graduated") {
      params.push(q.status); where.push(`(${STATUS}) = $${params.length}`);
    }
    if (q.q) { params.push(`%${q.q.toLowerCase()}%`); where.push(`(lower(name) like $${params.length} or lower(symbol) like $${params.length})`); }
    params.push(limit, offset);
    const { rows } = await pool.query(
      `select *, (${STATUS}) as status from launches ${where.length ? "where " + where.join(" and ") : ""}
       order by ${sort} limit $${params.length - 1} offset $${params.length}`,
      params,
    );
    return { tokens: rows };
  });

  app.get("/tokens/:token", async (req, reply) => {
    const { token } = req.params as { token: string };
    const { rows } = await pool.query(`select *, (${STATUS}) as status from launches where token = $1`, [token.toLowerCase()]);
    if (!rows[0]) return reply.code(404).send({ error: "unknown token" });
    // `accrued` is what came in: the router's bookings on a curve token, the splitter's sweeps on a
    // direct one. The claims and buybacks that follow are slices of it, not more of it. `flushed`
    // is what has left along the split, and the four legs under it are where it went; they add up
    // to it. `burned` is the tokens the buyback leg took off the supply, which is not pair money
    // and never belongs in the same sum.
    const [{ rows: holders }, { rows: fees }, { rows: stakes }] = await Promise.all([
      pool.query(`select count(*) as holders from balances where token = $1 and balance > 0`, [token.toLowerCase()]),
      pool.query(
        `select coalesce(sum(amount) filter (where kind in ('accrued', 'swept')), 0) as accrued,
                coalesce(sum(amount) filter (where kind = 'flushed'), 0) as flushed,
                coalesce(sum(to_stakers), 0) as to_stakers,
                coalesce(sum(to_buyback), 0) as to_buyback,
                coalesce(sum(to_liquidity), 0) as to_liquidity,
                coalesce(sum(to_creator), 0) as to_creator,
                coalesce(sum(result) filter (where kind = 'flushed'), 0) as burned
         from fee_events where token = $1`, [token.toLowerCase()]),
      pool.query(`select coalesce(sum(amount),0) as staked, count(*) as positions from stakes where token = $1 and active`, [token.toLowerCase()]),
    ]);
    return { ...rows[0], holders: Number(holders[0].holders), fees: fees[0], staking: stakes[0] };
  });

  app.get("/tokens/:token/trades", async (req) => {
    const { token } = req.params as { token: string };
    const { limit } = req.query as { limit?: string };
    const { rows } = await pool.query(
      `select side, trader, recipient, pair_amount, token_amount, fee, price, ts, tx
       from trades where token = $1 order by ts desc limit $2`,
      [token.toLowerCase(), clampInt(limit, 50, 500, 1)],
    );
    return { trades: rows };
  });

  /// OHLC straight out of the trade table, so a chart never needs a second data source.
  app.get("/tokens/:token/candles", async (req) => {
    const { token } = req.params as { token: string };
    const { interval = "5 minutes", limit = "288" } = req.query as Record<string, string>;
    const allowed = new Set(["1 minute", "5 minutes", "15 minutes", "1 hour", "4 hours", "1 day"]);
    const bucket = allowed.has(interval) ? interval : "5 minutes";
    const n = clampInt(limit, 288, 1000, 1);
    // The chart polls the same token and interval every few seconds. A 3 second cache makes a
    // repeated poll a map lookup; a 5-minute candle does not change meaningfully in 3 seconds.
    return cached(`candles:${token.toLowerCase()}:${bucket}:${n}`, 3_000, async () => {
    // Only look at the trades in the span the chart actually shows: the last `n` buckets' worth of
    // time, anchored to the token's OWN last trade (not now(), so a token that went quiet still
    // charts its final activity). Without this the query aggregates the token's entire history to
    // return the last 288 buckets, which scales with total trades: 52 ms over 60k rows of a
    // month-old token becomes 2.7 ms, and a viral token with half a million trades stops being a
    // full-history scan on every chart poll.
    const { rows } = await pool.query(
      `select to_timestamp(floor(extract(epoch from ts) / extract(epoch from $2::interval)) * extract(epoch from $2::interval)) as t,
              (array_agg(price order by ts))[1] as open,
              max(price) as high, min(price) as low,
              (array_agg(price order by ts desc))[1] as close,
              sum(pair_amount) as volume, count(*) as trades
       from trades
       where token = $1 and price > 0
         and ts >= coalesce((select max(ts) from trades where token = $1), now()) - ($3 * $2::interval)
       group by 1 order by 1 desc limit $3`,
      [token.toLowerCase(), bucket, n],
    );
    return { interval: bucket, candles: rows.reverse() };
    });
  });

  app.get("/tokens/:token/holders", async (req) => {
    const { token } = req.params as { token: string };
    const { rows } = await pool.query(
      `select address, balance from balances where token = $1 and balance > 0 order by balance desc limit 100`,
      [token.toLowerCase()],
    );
    return { holders: rows };
  });

  /// The global FOMO tape: newest human trades with enough launch metadata to render without a
  /// request per row. The token page keeps its deeper, token-specific tape.
  app.get("/activity", async (req) => {
    const { limit, trader } = req.query as { limit?: string; trader?: string };
    // With a trader, this is one wallet's tape, which is what a profile and a follow feed read.
    // Without one, it is the whole floor. Same rows, same exclusions, one query.
    const one = trader && isAddress(trader) ? trader.toLowerCase() : null;
    const { rows } = await pool.query(
      `select t.side, t.trader, t.pair_amount, t.token_amount, t.ts, t.tx, t.log_index,
              l.token, l.symbol, l.name, l.pair_token, l.pair_symbol, l.pair_decimals
       from trades t join launches l on l.token = t.token
       where t.trader <> all($1::text[])
         and ($3::text is null or t.trader = $3)
       order by t.ts desc limit $2`,
      [SYSTEM_TRADERS, clampInt(limit, 24, 80, 1), one],
    );
    return { activity: rows };
  });

  /// A trader board with real time windows. `netUsd` is cash flow (sells minus buys) and is still
  /// not called profit: it does not know what a position cost. Profit is its own sort, built on the
  /// cost basis the indexer keeps per wallet and launch, and it says out loud which half of it is
  /// banked and which half is only marked at the last price.
  app.get("/top-traders", async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const hours = q.window === "24h" ? 24 : q.window === "30d" ? 24 * 30 : q.window === "all" ? 0 : 24 * 7;
    const order = q.sort === "net" ? "net_usd desc" : "volume_usd desc";
    const n = clampInt(q.limit, 20, 100, 1);
    // Profit is its own board. It is built from cost basis rather than from points, and it is
    // deliberately all-time: realised profit is banked, and a window would rank a wallet by when it
    // happened to close a position. The window still labels the response so a client cannot show
    // "24h" over numbers that are not.
    if (q.sort === "pnl") {
      const traders = await pnlLeaderboard(n);
      return { window: "all", sort: "pnl", traders };
    }
    const { rows } = await pool.query(
      `select address,
              coalesce(sum(usd), 0)::numeric(20,2) as volume_usd,
              coalesce(sum(usd) filter (where kind = 'trade_buy'), 0)::numeric(20,2) as bought_usd,
              coalesce(sum(usd) filter (where kind = 'trade_sell'), 0)::numeric(20,2) as sold_usd,
              (coalesce(sum(usd) filter (where kind = 'trade_sell'), 0)
               - coalesce(sum(usd) filter (where kind = 'trade_buy'), 0))::numeric(20,2) as net_usd,
              count(*)::int as trades
       from points
       where kind in ('trade_buy','trade_sell')
         and address <> all($1::text[])
         and ($2::int = 0 or ts >= now() - ($2::int * interval '1 hour'))
       group by address order by ${order} limit $3`,
      [SYSTEM_TRADERS, hours, n],
    );
    return { window: q.window ?? "7d", sort: q.sort === "net" ? "net" : "volume", traders: rows };
  });

  app.get("/stakes/:owner", async (req) => {
    const { owner } = req.params as { owner: string };
    const { rows } = await pool.query(
      `select s.*, l.symbol, l.name, l.pair_token from stakes s
       join launches l on l.token = s.token
       where s.owner = $1 order by s.created_at desc`,
      [owner.toLowerCase()],
    );
    return { positions: rows };
  });

  app.get("/portfolio/:address", async (req) => {
    const { address } = req.params as { address: string };
    const a = address.toLowerCase();
    const [{ rows: held }, { rows: stakes }, { rows: created }] = await Promise.all([
      pool.query(
        `select b.token, b.balance, l.symbol, l.name, l.image, l.price, l.pair_token, l.phase,
                l.pair_symbol, l.pair_decimals
         from balances b join launches l on l.token = b.token
         where b.address = $1 and b.balance > 0 order by b.balance desc`, [a]),
      pool.query(`select * from stakes where owner = $1 and active`, [a]),
      pool.query(`select token, symbol, name, image, phase, volume_total from launches where creator = $1`, [a]),
    ]);
    const pnl = await walletPnl(a);
    return { address: a, holdings: held, stakes, launches: created, pnl, points: await pointsFor(a, await currentSeason()) };
  });

  app.get("/points/:address", async (req) => {
    const { address } = req.params as { address: string };
    return pointsFor(address, await currentSeason());
  });

  /// A season with a snapshot is frozen: the board for it stops moving even if late points land.
  /// Everything else is computed live, which is what the current season always is.
  app.get("/leaderboard", async (req) => {
    const { season, limit } = req.query as Record<string, string>;
    const s = season ? Number(season) : await currentSeason();
    const n = clampInt(limit, 100, 250, 1);
    const frozen = await frozenLeaderboard(s, n);
    if (frozen) {
      return { season: s, frozen: true, takenAt: frozen.takenAt, rules: { POINTS, RANKS }, rows: frozen.rows };
    }
    // The live board sums every point in the season on each hit. Cache it for a few seconds: it is
    // read far more often than it meaningfully changes, and a frozen season never reaches here.
    const rows = await cached(`lb:${s}:${n}`, 5_000, () => leaderboard(s, n));
    return { season: s, frozen: false, rules: { POINTS, RANKS }, rows };
  });

  app.get("/seasons", async () => {
    const { rows } = await pool.query(`select * from seasons order by id`);
    return { seasons: rows, current: await currentSeason() };
  });

  // ---------------------------------------------------------------- the season drop

  /// What the season is worth so far, how many points are chasing it, and the published list if
  /// there is one. Everything here is derived from revenue already collected; the pool percentage
  /// is a figure the treasury sets per season, not a rate anybody is owed.
  app.get("/airdrop/season/:season", async (req, reply) => {
    const { season } = req.params as { season: string };
    const id = Number(season);
    if (!Number.isInteger(id) || id < 1) return reply.code(400).send({ error: "season must be a positive integer" });
    try {
      const [money, points, drop] = await Promise.all([
        seasonPool(id),
        seasonPoints(id),
        storedDrop(id),
      ]);
      return {
        season: money.take.season,
        pool: { poolBps: money.poolBps, poolUsd: money.poolUsd, take: money.take },
        points,
        drop,
      };
    } catch (e) {
      return seasonError(e, reply);
    }
  });

  /// The calculator behind "what would this add". Clamped hard: the answer to a hundred billion
  /// dollars of pretend volume is not a number anybody should be shown.
  const EstimateBody = z.object({
    season: z.number().int().min(1).max(1_000_000).optional(),
    address: z.string().refine(isAddress, "not an address").nullish(),
    launches: z.number().int().min(0).max(100).default(0),
    buyUsd: z.number().min(0).max(100_000_000).default(0),
    sellUsd: z.number().min(0).max(100_000_000).default(0),
    stakeUsd: z.number().min(0).max(100_000_000).default(0),
    lockDays: z.number().int().min(0).max(365).default(0),
    currentVolumeUsd: z.number().min(0).max(100_000_000).optional(),
  });

  app.post("/airdrop/estimate", async (req, reply) => {
    const parsed = EstimateBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "bad request", field: parsed.error.issues[0]?.path.join(".") });
    }
    try {
      return await estimate(parsed.data);
    } catch (e) {
      return seasonError(e, reply);
    }
  });

  /// One wallet's proof out of a published tree. `claimed` is always null: whether the money has
  /// been taken is a fact about the drop contract, and the contract is the only honest source.
  app.get("/airdrop/:season/proof/:address", async (req, reply) => {
    const { season, address } = req.params as { season: string; address: string };
    const id = Number(season);
    if (!Number.isInteger(id) || id < 1) return reply.code(400).send({ error: "season must be a positive integer" });
    if (!isAddress(address)) return reply.code(400).send({ error: "not an address" });
    const proof = await storedProof(id, address);
    if (!proof) return reply.code(404).send({ error: "no claim for that address in that season" });
    return { ...proof, claimed: null };
  });

  /// Resolves a pasted ERC-20 directly from Robinhood Chain and checks its deepest USDG v3 pool.
  /// This endpoint never mutates the allow list: launchCustom is permissionless and the contract is
  /// still the final authority on decimals and transfer behaviour.
  app.get("/pairs/resolve/:address", async (req, reply) => {
    const { address } = req.params as { address: string };
    if (!isAddress(address) || address.toLowerCase() === zeroAddress) {
      return reply.code(400).send({ error: "not an ERC-20 address" });
    }
    try {
      return await resolveQuote(address);
    } catch (e) {
      return reply.code(422).send({ error: e instanceof Error ? e.message : "could not resolve token" });
    }
  });

  const RouteBody = z.object({
    tokenOut: z.string().refine(isAddress, "not an ERC-20 address"),
    amount: z.string().regex(/^[1-9][0-9]*$/, "amount must be base units").max(80),
    slippageTolerance: z.number().min(0.1).max(10).default(1),
  });

  /// Builds the DEX half of ETH -> custom quote -> launch token. Only opaque UniversalRouter
  /// calldata leaves this API; the browser never sees the routing key, and HoodCurveRouter still
  /// verifies the quote-token balance it actually received before buying from the curve.
  app.post("/pairs/route", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const parsed = RouteBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "bad route request" });
    const tokenOut = parsed.data.tokenOut as Address;
    // The routing service first when there is a key for it, because it sees every venue and every
    // hop. Without one, the pad builds the single hop it can build itself, which covers the pairs
    // people actually launch against (the dollar and the liquid shares all have an ETH pool). A
    // pair with neither is told so plainly, and the app falls back to the two step.
    const key = process.env.UNISWAP_API_KEY?.trim();
    try {
      if (key) return await nativeQuoteRoute(tokenOut, parsed.data.amount, parsed.data.slippageTolerance);
    } catch (e) {
      req.log.warn({ err: e }, "routing service failed, trying the local pool");
    }
    try {
      return await localNativeRoute(tokenOut, parsed.data.amount, parsed.data.slippageTolerance);
    } catch (e) {
      const message = e instanceof Error ? e.message : "could not build route";
      const unavailable = message.includes("no direct ETH pool") || message.includes("not configured");
      return reply.code(unavailable ? 503 : 502).send({ error: message });
    }
  });

  /// Whether a pair can be reached from ETH in one transaction, asked before the button is offered.
  app.get("/pairs/route/:token", async (req, reply) => {
    const { token } = req.params as { token: string };
    if (!isAddress(token)) return reply.code(400).send({ error: "that is not a token address" });
    const configured = Boolean(process.env.HOOD_CURVE_ROUTER);
    return { token, available: configured && await hasNativeRoute(token as Address), configured };
  });

  /// What a launch may trade against, and therefore what its creator can be paid in.
  ///
  /// The factory's allow list is the authority, so this asks it rather than answering from a
  /// constant: an asset the owner adds is offered by the wizard the moment it is added, and one
  /// they withdraw stops being offered without a deploy. The dollar price comes with it, because
  /// a creator picking a share as their pair is picking a number they think in dollars.
  /// The last list the chain answered with. A menu that shrinks because a node was busy for a
  /// second is worse than a menu a minute out of date: a creator would simply not see the asset
  /// they came for, and nothing would look broken.
  interface PairRow {
    address: Address; symbol: string; name: string | null; decimals: number; share: boolean;
    allowed: boolean; lockThreshold: string; usd: number;
  }
  let lastPairs: PairRow[] | null = null;

  app.get("/pairs", async () => cached("pairs", 60_000, async () => {
    const factory = process.env.HOOD_FACTORY as Address | undefined;
    const known = Object.entries(PRICEABLE).map(([address, a]) => ({
      address: address as Address,
      symbol: a.symbol,
      // The company behind the ticker, when the asset is one of the chain's own shares. The menu
      // shows it, because five tokens here answer to NVDA and only one of them is NVIDIA.
      name: a.name ?? null,
      decimals: a.decimals,
      share: Boolean(pairAsset(address)?.share || a.share),
    }));

    // A handful of reads, not four hundred. Asking the factory asset by asset meant a flaky moment
    // dropped assets out of the menu one at a time, each one looking exactly like a deliberate
    // refusal. All of them in ONE multicall is the other failure: the node refuses a call that
    // large and the menu comes back empty. So: batches, each one able to fail on its own.
    const calls = known.flatMap((asset) => [
      { address: factory!, abi: pairViewAbi, functionName: "pairAllowed", args: [asset.address] },
      { address: factory!, abi: pairViewAbi, functionName: "lockThreshold", args: [asset.address] },
    ]);
    const allowed: { status: string; result?: unknown }[] = [];
    if (factory) {
      const BATCH = 60;
      for (let i = 0; i < calls.length; i += BATCH) {
        const chunk = calls.slice(i, i + BATCH);
        try {
          const read = await chain.multicall({ allowFailure: true, contracts: chunk as never }) as unknown as { status: string; result?: unknown }[];
          allowed.push(...read);
        } catch {
          // This batch is unreadable; the rows it covers keep whatever was last known about them.
          allowed.push(...chunk.map(() => ({ status: "failure" as const })));
        }
      }
    }

    const rows = await Promise.all(known.map(async (asset, i) => {
      const ok = allowed[i * 2];
      const lock = allowed[i * 2 + 1];
      return {
        ...asset,
        allowed: ok?.status === "success" ? Boolean(ok.result) : false,
        readable: ok?.status === "success",
        lockThreshold: lock?.status === "success" ? String(lock.result) : "0",
        usd: await pairUsdPrice(asset.address),
      };
    }));

    // A read that failed is not a refusal, so a pair the chain would not answer for keeps whatever
    // the last good answer said about it.
    const previous = new Map((lastPairs ?? []).map((p) => [p.address, p]));
    const pairs: PairRow[] = rows.map(({ readable, ...rest }) => {
      if (readable) return rest;
      const remembered = previous.get(rest.address);
      return remembered ? { ...remembered, usd: rest.usd } : rest;
    }).filter((r) => r.allowed);
    if (rows.every((r) => r.readable)) lastPairs = pairs;
    return { pairs };
  }));

  /// Our own contracts trade too (a buyback, a harvest, the portal's first buy on a creator's
  /// behalf). They are trades, but they are not traders.
  app.get("/stats", async () => {
    // `count(distinct trader)` over the whole trades table is the expensive one, and the headline
    // numbers move slowly. Ten seconds of cache makes a repeated hit a map lookup.
    return cached("stats", 10_000, async () => {
    const { rows } = await pool.query(
      `select count(*) as launches,
              count(*) filter (where phase = 2 or bonded) as graduated,
              coalesce(sum(volume_total), 0) as volume_total,
              coalesce(sum(volume_24h), 0) as volume_24h,
              -- Both figures count the same population. Counting every row as a trade while
              -- counting only people as traders reads as "the machines traded", which inflates the
              -- headline with our own buybacks, harvests and the portal's first buy.
              (select count(*) from trades where trader <> all($1::text[])) as trades,
              (select count(distinct trader) from trades where trader <> all($1::text[])) as traders
       from launches`,
      [SYSTEM_TRADERS],
    );
    return rows[0];
    });
  });

  // ---------------------------------------------------------------- admin

  app.get("/admin/me", adminOnly, async () => ({ ok: true }));

  /// One screen for an operator: is the indexer keeping up, what is wired, what is deployed.
  app.get("/admin/overview", adminOnly, async () => {
    const [head, { rows: cursor }, { rows: counts }, { rows: tickets }, season, gaps] = await Promise.all([
      chainHead(),
      pool.query(`select block from cursors where name = 'main'`),
      pool.query(`select count(*)::int as launches, count(*) filter (where phase = 2 or bonded)::int as graduated from launches`),
      pool.query(`select count(*)::int as open from support_tickets where status = 'open'`),
      currentSeason(),
      openGaps(),
    ]);
    const indexedBlock = cursor[0] ? Number(cursor[0].block) : null;
    return {
      indexedBlock,
      head,
      blocksBehind: head !== null && indexedBlock !== null ? head - indexedBlock : null,
      integrations: integrations(),
      contracts: contracts(),
      launches: counts[0].launches,
      graduated: counts[0].graduated,
      openTickets: tickets[0].open,
      currentSeason: season,
      /// Ranges the node refused and the indexer walked past. Not zero means data is missing.
      gaps,
    };
  });

  /// Reads the refused ranges again, now. The indexer already retries them on its own clock; this
  /// is for the operator who just fixed the node and does not want to wait for the next pass.
  app.post("/admin/indexer/rescan", adminOnly, async () => ({ ...(await rescanGaps(20)), gaps: await openGaps() }));

  app.get("/admin/seasons", adminOnly, async () => listSeasons());

  app.post("/admin/seasons", adminOnly, async (req, reply) => {
    const body = (req.body ?? {}) as { name: unknown; starts?: unknown; ends?: unknown };
    try {
      return { season: await openSeason(body) };
    } catch (e) {
      return seasonError(e, reply);
    }
  });

  app.post("/admin/seasons/:id/close", adminOnly, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { ends } = (req.body ?? {}) as { ends?: unknown };
    try {
      return { season: await closeSeason(id, ends) };
    } catch (e) {
      return seasonError(e, reply);
    }
  });

  app.post("/admin/seasons/:id/snapshot", adminOnly, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return { season: Number(id), rows: await snapshotSeason(id) };
    } catch (e) {
      return seasonError(e, reply);
    }
  });

  /// Builds a season's tree and stores it, so /airdrop/:season/proof/:address can serve it. The
  /// pool is a string because a uint256 does not survive JSON as a number. Building twice replaces
  /// the earlier build of that season, root and proofs together.
  /// `pool` is in the asset's own units ("1" is one ETH); `poolWei` is the raw integer. One of the
  /// two, never both, so a pool can never be out by a factor of 1e18 without somebody saying so.
  const BuildBody = z.object({
    pool: z.string().min(1).max(80).optional(),
    poolWei: z.string().min(1).max(80).optional(),
    asset: z.string().refine(isAddress, "not an address").optional(),
    decimals: z.number().int().min(0).max(36).optional(),
    min: z.string().max(80).optional(),
  }).refine((b) => Boolean(b.pool) !== Boolean(b.poolWei), "pass either pool (in units) or poolWei (raw), not both");

  app.post("/admin/airdrop/:season/build", adminOnly, async (req, reply) => {
    const { season } = req.params as { season: string };
    const parsed = BuildBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "bad request" });
    const body = parsed.data;
    try {
      const decimals = body.decimals ?? 18;
      const { file, stats } = await buildDrop({
        season,
        poolWei: body.poolWei ? parseWei(body.poolWei) : parseAmount(body.pool!, decimals),
        asset: body.asset,
        minWei: body.min === undefined ? 0n : parseAmount(body.min, 0, "min"),
      });
      verifyDrop(file);
      await saveDrop(file, { ...stats, decimals, pool: body.pool, builtBy: "admin" });
      return { season: file.season, root: file.root, total: file.total, asset: file.asset, claims: stats.included, stats };
    } catch (e) {
      return seasonError(e, reply);
    }
  });

  registerSupport(app);
  /// The rooms, and the feed they arrive on. The stream is registered with the one thing it cannot
  /// assemble for itself: a chat message, which is three tables wide.
  registerChat(app);
  // The session the chat issues is the pad's session, so these two sit after it and take it as it
  // is: one signature, no account, and nothing here can spend anything.
  registerSocial(app);
  registerQuests(app);
  registerStream(app, { message: chatMessage });
  /// Token art, so a launch carries a link instead of a data URI. Awaited because the route needs
  /// the multipart parser registered under it; with no bucket configured it answers 501 and
  /// nothing else in here notices.
  await registerUploads(app);

  return app;
}
