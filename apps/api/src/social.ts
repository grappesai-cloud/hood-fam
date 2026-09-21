import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isAddress } from "viem";

import { sessionOf } from "./chat.js";
import { pool, currentSeason } from "./db.js";
import { isSystem } from "./system.js";
import { walletPnl } from "./pnl.js";

/// The parts of this pad that are about people rather than about money: who brought whom, whose
/// trades you want to see, and which launches should tell you when something happens.
///
/// All three sit behind the chat's session, which is one signature and no account. None of them can
/// move anything: a follow is a read, a watch is a list, and a referral pays its share out of the
/// points table, never out of a wallet.

const refuse = (reply: FastifyReply, status: number, error: string, reason: string) =>
  reply.code(status).send({ error, reason });

function wallet(req: FastifyRequest, reply: FastifyReply): string | null {
  const address = sessionOf(req);
  if (!address) {
    refuse(reply, 401, "no_session", "Sign in with your wallet first; it is one signature and costs nothing.");
    return null;
  }
  return address.toLowerCase();
}

const address = (value: unknown): string | null =>
  typeof value === "string" && isAddress(value) ? value.toLowerCase() : null;

// ------------------------------------------------------------------ referrals

/// A code is an address: there is no namespace to squat, nothing to expire, and anyone can check on
/// chain who they are about to be tied to before they click.
export async function referralSummary(referrer: string, season: number) {
  const [{ rows: earned }, { rows: friends }] = await Promise.all([
    pool.query<{ points: string | null; events: string }>(
      `select coalesce(sum(amount), 0) as points, count(*) as events
         from points where address = $1 and season = $2 and kind = 'referral'`,
      [referrer, season],
    ),
    pool.query<{ referee: string; bound_at: Date; volume_usd: string | null; trades: string }>(
      `select r.referee, r.bound_at,
              coalesce(sum(p.usd) filter (where p.kind in ('trade_buy','trade_sell')), 0) as volume_usd,
              count(p.*) filter (where p.kind in ('trade_buy','trade_sell')) as trades
         from referrals r
         left join points p on p.address = r.referee and p.ts >= r.bound_at
        where r.referrer = $1
        group by r.referee, r.bound_at
        order by volume_usd desc
        limit 200`,
      [referrer],
    ),
  ]);
  return {
    code: referrer,
    season,
    points: Number(earned[0]?.points ?? 0),
    paidEvents: Number(earned[0]?.events ?? 0),
    friends: friends.map((f) => ({
      address: f.referee,
      boundAt: f.bound_at,
      volumeUsd: Number(f.volume_usd ?? 0),
      trades: Number(f.trades ?? 0),
    })),
  };
}

// ---------------------------------------------------------------------- feed

/// What the wallets a follower follows have been doing, newest first. It is the same trades table
/// the tape reads, narrowed to a list, so a follower sees exactly what everybody else can see.
export async function followFeed(follower: string, limit: number) {
  const { rows } = await pool.query(
    `select t.token, t.side, t.trader, t.pair_amount, t.token_amount, t.price, t.tx, t.ts,
            l.name, l.symbol, l.image, l.pair_token, l.pair_symbol, l.pair_decimals, l.mode
       from trades t
       join follows f on f.followed = t.trader
       join launches l on l.token = t.token
      where f.follower = $1
      order by t.ts desc
      limit $2`,
    [follower, limit],
  );
  return rows.map((r: Record<string, unknown>) => ({
    token: r.token as string,
    side: r.side as string,
    trader: r.trader as string,
    pairAmount: String(r.pair_amount),
    tokenAmount: String(r.token_amount),
    price: String(r.price),
    tx: r.tx as string,
    at: r.ts as Date,
    name: r.name as string,
    symbol: r.symbol as string,
    image: r.image as string,
    pairToken: r.pair_token as string,
    pairSymbol: (r.pair_symbol as string) ?? null,
    pairDecimals: (r.pair_decimals as number) ?? null,
    mode: r.mode as string,
  }));
}

export function registerSocial(app: FastifyInstance) {
  // ---------------------------------------------------------------- referrals

  /// Binding is once and for ever: a referral that could be re-pointed is one worth farming, and
  /// only trades made after the binding pay, so tying a fresh code to an old wallet earns nothing.
  app.post("/refer/bind", async (req, reply) => {
    const me = wallet(req, reply);
    if (!me) return;
    const code = address((req.body as Record<string, unknown> | undefined)?.code);
    if (!code) return refuse(reply, 400, "bad_code", "A referral code is the referrer's own address.");
    if (code === me) return refuse(reply, 400, "self_referral", "A wallet cannot bring itself.");
    if (isSystem(code) || isSystem(me)) return refuse(reply, 400, "system_wallet", "That address is one of the protocol's own contracts.");

    const { rows: existing } = await pool.query<{ referrer: string }>(
      `select referrer from referrals where referee = $1`, [me],
    );
    if (existing[0]) {
      return existing[0].referrer === code
        ? { bound: true, referrer: code, alreadyBound: true }
        : refuse(reply, 409, "already_bound", "This wallet was already brought by somebody else, and that does not change.");
    }
    // A ring of two wallets pointing at each other would pay itself a tenth of its own wash volume
    // twice over, so the second half of the ring is refused at the door.
    const { rows: theirs } = await pool.query<{ referrer: string }>(
      `select referrer from referrals where referee = $1`, [code],
    );
    if (theirs[0]?.referrer === me) return refuse(reply, 400, "circular", "You already brought that wallet; it cannot bring you back.");

    await pool.query(
      `insert into referrals (referee, referrer) values ($1,$2) on conflict (referee) do nothing`,
      [me, code],
    );
    return { bound: true, referrer: code };
  });

  app.get("/refer/me", async (req, reply) => {
    const me = wallet(req, reply);
    if (!me) return;
    const season = await currentSeason();
    const { rows } = await pool.query<{ referrer: string; bound_at: Date }>(
      `select referrer, bound_at from referrals where referee = $1`, [me],
    );
    return { ...(await referralSummary(me, season)), broughtBy: rows[0]?.referrer ?? null, boundAt: rows[0]?.bound_at ?? null };
  });

  /// Public, so a landing page can show whose link this is before anybody signs anything.
  app.get("/refer/:code", async (req, reply) => {
    const code = address((req.params as { code: string }).code);
    if (!code) return refuse(reply, 400, "bad_code", "A referral code is an address.");
    const season = await currentSeason();
    const { rows } = await pool.query<{ friends: string }>(
      `select count(*) as friends from referrals where referrer = $1`, [code],
    );
    const { rows: points } = await pool.query<{ points: string | null }>(
      `select coalesce(sum(amount), 0) as points from points where address = $1 and season = $2`,
      [code, season],
    );
    return { code, friends: Number(rows[0]?.friends ?? 0), points: Number(points[0]?.points ?? 0) };
  });

  // ------------------------------------------------------------------ follows

  app.get("/follows", async (req, reply) => {
    const me = wallet(req, reply);
    if (!me) return;
    const { rows } = await pool.query<{ followed: string; created_at: Date }>(
      `select followed, created_at from follows where follower = $1 order by created_at desc limit 500`, [me],
    );
    return { following: rows.map((r) => ({ address: r.followed, since: r.created_at })) };
  });

  app.post("/follows/:address", async (req, reply) => {
    const me = wallet(req, reply);
    if (!me) return;
    const target = address((req.params as { address: string }).address);
    if (!target) return refuse(reply, 400, "bad_address", "That is not an address.");
    if (target === me) return refuse(reply, 400, "self_follow", "You already see your own trades.");
    await pool.query(
      `insert into follows (follower, followed) values ($1,$2) on conflict do nothing`, [me, target],
    );
    return { following: true, address: target };
  });

  app.delete("/follows/:address", async (req, reply) => {
    const me = wallet(req, reply);
    if (!me) return;
    const target = address((req.params as { address: string }).address);
    if (!target) return refuse(reply, 400, "bad_address", "That is not an address.");
    await pool.query(`delete from follows where follower = $1 and followed = $2`, [me, target]);
    return { following: false, address: target };
  });

  app.get("/feed", async (req, reply) => {
    const me = wallet(req, reply);
    if (!me) return;
    const asked = Number((req.query as { limit?: string }).limit ?? 40);
    const limit = Number.isFinite(asked) ? Math.min(Math.max(Math.floor(asked), 1), 100) : 40;
    return { feed: await followFeed(me, limit) };
  });

  /// One wallet, as everybody else sees it: what it is worth following. Public on purpose, so a
  /// profile can be linked into a group chat without the reader having to sign in first.
  app.get("/traders/:address", async (req, reply) => {
    const who = address((req.params as { address: string }).address);
    if (!who) return refuse(reply, 400, "bad_address", "That is not an address.");
    const season = await currentSeason();
    const [{ rows: totals }, { rows: followers }, pnl] = await Promise.all([
      pool.query<{ volume_usd: string | null; trades: string; launches: string }>(
        `select coalesce(sum(usd) filter (where kind in ('trade_buy','trade_sell')), 0) as volume_usd,
                count(*) filter (where kind in ('trade_buy','trade_sell')) as trades,
                count(*) filter (where kind = 'launch') as launches
           from points where address = $1 and season = $2`,
        [who, season],
      ),
      pool.query<{ followers: string }>(`select count(*) as followers from follows where followed = $1`, [who]),
      walletPnl(who),
    ]);
    const viewer = sessionOf(req)?.toLowerCase();
    let following = false;
    if (viewer) {
      const { rows } = await pool.query(`select 1 from follows where follower = $1 and followed = $2`, [viewer, who]);
      following = rows.length > 0;
    }
    return {
      address: who,
      season,
      volumeUsd: Number(totals[0]?.volume_usd ?? 0),
      trades: Number(totals[0]?.trades ?? 0),
      launches: Number(totals[0]?.launches ?? 0),
      followers: Number(followers[0]?.followers ?? 0),
      pnl,
      following,
    };
  });

  // ---------------------------------------------------------------- watchlist

  app.get("/watchlist", async (req, reply) => {
    const me = wallet(req, reply);
    if (!me) return;
    const { rows } = await pool.query(
      `select w.token, w.created_at, l.name, l.symbol, l.image, l.mode
         from watchlist w join launches l on l.token = w.token
        where w.address = $1 order by w.created_at desc limit 200`,
      [me],
    );
    return {
      watching: rows.map((r: Record<string, unknown>) => ({
        token: r.token as string,
        since: r.created_at as Date,
        name: r.name as string,
        symbol: r.symbol as string,
        image: r.image as string,
        mode: r.mode as string,
      })),
    };
  });

  app.post("/watchlist/:token", async (req, reply) => {
    const me = wallet(req, reply);
    if (!me) return;
    const token = address((req.params as { token: string }).token);
    if (!token) return refuse(reply, 400, "bad_token", "That is not a token address.");
    const { rowCount } = await pool.query(
      `insert into watchlist (address, token)
       select $1, token from launches where token = $2
       on conflict do nothing`,
      [me, token],
    );
    const { rows } = await pool.query(`select 1 from watchlist where address = $1 and token = $2`, [me, token]);
    if (!rows.length && !rowCount) return refuse(reply, 404, "unknown_token", "This pad has not indexed that token.");
    return { watching: true, token };
  });

  app.delete("/watchlist/:token", async (req, reply) => {
    const me = wallet(req, reply);
    if (!me) return;
    const token = address((req.params as { token: string }).token);
    if (!token) return refuse(reply, 400, "bad_token", "That is not a token address.");
    await pool.query(`delete from watchlist where address = $1 and token = $2`, [me, token]);
    return { watching: false, token };
  });
}
