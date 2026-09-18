import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { isAddress } from "viem";
import { z } from "zod";

import { pool, currentSeason } from "./db.js";
import { leaderboard, pointsFor, RANKS, POINTS } from "./points.js";
import { registerSupport } from "./support.js";
import { registerUploads } from "./uploads.js";
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
    // direct one. The claims and buybacks that follow are slices of it, not more of it.
    const [{ rows: holders }, { rows: fees }, { rows: stakes }] = await Promise.all([
      pool.query(`select count(*) as holders from balances where token = $1 and balance > 0`, [token.toLowerCase()]),
      pool.query(
        `select coalesce(sum(amount) filter (where kind in ('accrued', 'swept')), 0) as accrued,
                coalesce(sum(result) filter (where kind = 'flushed'), 0) as flushed
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
    const { rows } = await pool.query(
      `select to_timestamp(floor(extract(epoch from ts) / extract(epoch from $2::interval)) * extract(epoch from $2::interval)) as t,
              (array_agg(price order by ts))[1] as open,
              max(price) as high, min(price) as low,
              (array_agg(price order by ts desc))[1] as close,
              sum(pair_amount) as volume, count(*) as trades
       from trades where token = $1 and price > 0
       group by 1 order by 1 desc limit $3`,
      [token.toLowerCase(), bucket, clampInt(limit, 288, 1000, 1)],
    );
    return { interval: bucket, candles: rows.reverse() };
  });

  app.get("/tokens/:token/holders", async (req) => {
    const { token } = req.params as { token: string };
    const { rows } = await pool.query(
      `select address, balance from balances where token = $1 and balance > 0 order by balance desc limit 100`,
      [token.toLowerCase()],
    );
    return { holders: rows };
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
        `select b.token, b.balance, l.symbol, l.name, l.image, l.price, l.pair_token, l.phase
         from balances b join launches l on l.token = b.token
         where b.address = $1 and b.balance > 0 order by b.balance desc`, [a]),
      pool.query(`select * from stakes where owner = $1 and active`, [a]),
      pool.query(`select token, symbol, name, image, phase, volume_total from launches where creator = $1`, [a]),
    ]);
    return { address: a, holdings: held, stakes, launches: created, points: await pointsFor(a, await currentSeason()) };
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

  /// Our own contracts trade too (a buyback, a harvest, the portal's first buy on a creator's
  /// behalf). They are trades, but they are not traders.
  const system = [
    process.env.HOOD_FACTORY, process.env.HOOD_FEE_ROUTER, process.env.HOOD_STAKING, process.env.HOOD_GRADUATOR,
    process.env.HOOD_PORTAL, process.env.HOOD_BUYBACK_MODULE,
  ].filter(Boolean).map((a) => a!.toLowerCase());

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
      [system],
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
  /// Token art, so a launch carries a link instead of a data URI. Awaited because the route needs
  /// the multipart parser registered under it; with no bucket configured it answers 501 and
  /// nothing else in here notices.
  await registerUploads(app);

  return app;
}
