import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isAddress } from "viem";

import { isAdmin } from "./admin.js";
import { sessionOf } from "./chat.js";
import { currentSeason, pool } from "./db.js";
import { award } from "./points.js";

/// Quests and races: the two things that make a season a game rather than a spreadsheet.
///
/// A quest is a sentence a wallet can finish in one sitting, checked against what the indexer
/// already knows. Nothing here trusts the browser: progress is a query, the reward is paid through
/// the same points table as everything else, and the ref is the quest plus the wallet plus the
/// season, so the unique index makes claiming twice impossible rather than merely discouraged.
///
/// A race is a window with a name. The standings are the points the board already keeps, read
/// between two timestamps. The prize is a line the operator wrote, never a number this code can
/// pay: a leaderboard that promises money it cannot move is how a season ends in an argument.

export interface Quest {
  id: string;
  title: string;
  /// What finishing it is worth, in points, before nothing: quests are not multiplied by rank.
  reward: number;
  /// What the wallet has to reach. Progress is counted in the same unit.
  target: number;
  /// Plain words, on the card.
  how: string;
  unit: "trades" | "dollars" | "launches" | "messages" | "friends" | "locks";
}

export const QUESTS: Quest[] = [
  { id: "first_trade", title: "First blood", reward: 250, target: 1, unit: "trades",
    how: "Buy any launch on the pad." },
  { id: "print", title: "Print a market", reward: 250, target: 1, unit: "launches",
    how: "Launch a token, on either machine." },
  { id: "volume_1k", title: "Warmed up", reward: 500, target: 1_000, unit: "dollars",
    how: "Trade a thousand dollars this season." },
  { id: "volume_10k", title: "Regular", reward: 2_500, target: 10_000, unit: "dollars",
    how: "Trade ten thousand dollars this season." },
  { id: "volume_100k", title: "Size", reward: 10_000, target: 100_000, unit: "dollars",
    how: "Trade a hundred thousand dollars this season." },
  { id: "locked", title: "Skin in the game", reward: 1_000, target: 1, unit: "locks",
    how: "Lock the house coin for thirty days or more." },
  { id: "talker", title: "In the room", reward: 200, target: 5, unit: "messages",
    how: "Post five messages in any launch's chat." },
  { id: "graduate", title: "Graduation day", reward: 2_500, target: 1, unit: "launches",
    how: "Be the creator of a launch that reaches the pool." },
  { id: "friend", title: "Bring the fam", reward: 500, target: 1, unit: "friends",
    how: "Bring a wallet that trades at least a hundred dollars." },
];

const refuse = (reply: FastifyReply, status: number, error: string, reason: string) =>
  reply.code(status).send({ error, reason });

function walletOf(req: FastifyRequest, reply: FastifyReply): string | null {
  const address = sessionOf(req);
  if (!address) {
    refuse(reply, 401, "no_session", "Sign in with your wallet first; it is one signature and costs nothing.");
    return null;
  }
  return address.toLowerCase();
}

export interface QuestProgress extends Quest {
  progress: number;
  done: boolean;
  claimed: boolean;
}

/// One round trip per family of facts rather than one per quest, because this runs on every load of
/// the page and a wallet with nine quests should not cost nine scans of the points table.
export async function questsFor(address: string, season: number): Promise<QuestProgress[]> {
  const a = address.toLowerCase();
  const [points, launches, graduated, messages, locks, friends, claimed] = await Promise.all([
    pool.query<{ trades: string; volume: string | null; launches: string }>(
      `select count(*) filter (where kind in ('trade_buy','trade_sell')) as trades,
              coalesce(sum(usd) filter (where kind in ('trade_buy','trade_sell')), 0) as volume,
              count(*) filter (where kind = 'launch') as launches
         from points where address = $1 and season = $2`,
      [a, season],
    ),
    pool.query<{ count: string }>(`select count(*) as count from launches where creator = $1`, [a]),
    pool.query<{ count: string }>(
      `select count(*) as count from launches
        where creator = $1 and (graduated_at is not null or bonded)`, [a],
    ),
    pool.query<{ count: string }>(`select count(*) as count from messages where author = $1`, [a]),
    pool.query<{ count: string }>(
      `select count(*) as count from stakes
        where owner = $1 and active and unlock_at >= created_at + interval '30 days'`, [a],
    ),
    pool.query<{ count: string }>(
      `select count(*) as count from (
         select r.referee from referrals r
           join points p on p.address = r.referee and p.ts >= r.bound_at
                        and p.kind in ('trade_buy','trade_sell')
          where r.referrer = $1
          group by r.referee
         having coalesce(sum(p.usd), 0) >= 100
       ) x`, [a],
    ),
    pool.query<{ ref: string }>(
      `select ref from points where address = $1 and season = $2 and kind = 'quest'`, [a, season],
    ),
  ]);

  const trades = Number(points.rows[0]?.trades ?? 0);
  const volume = Number(points.rows[0]?.volume ?? 0);
  const printed = Number(launches.rows[0]?.count ?? 0);
  const done = new Set(claimed.rows.map((r) => r.ref.split(":")[1]));

  const progressOf = (quest: Quest): number => {
    switch (quest.id) {
      case "first_trade": return trades;
      case "print": return printed;
      case "volume_1k": case "volume_10k": case "volume_100k": return volume;
      case "locked": return Number(locks.rows[0]?.count ?? 0);
      case "talker": return Number(messages.rows[0]?.count ?? 0);
      case "graduate": return Number(graduated.rows[0]?.count ?? 0);
      case "friend": return Number(friends.rows[0]?.count ?? 0);
      default: return 0;
    }
  };

  return QUESTS.map((quest) => {
    const progress = progressOf(quest);
    return { ...quest, progress, done: progress >= quest.target, claimed: done.has(quest.id) };
  });
}

/// Claiming pays every finished quest that has not been paid, in one pass. The season is the one
/// the pad is in now: a quest finished in a season that has closed is not paid into the new one,
/// because the points behind it already belong to the old board.
///
/// The ref carries the wallet as well as the quest and the season. The points table is unique on
/// (kind, ref), so a ref of quest and season alone would let the first wallet to claim "First
/// blood" take it away from everybody else on the pad: the insert would find a conflict and do
/// nothing, silently, for every wallet after the first.
export async function claimQuests(address: string, season: number) {
  const quests = await questsFor(address, season);
  const owed = quests.filter((q) => q.done && !q.claimed);
  const now = new Date();
  for (const quest of owed) {
    await award({
      address, kind: "quest", usd: 0, flat: quest.reward,
      ref: `quest:${quest.id}:${season}:${address}`, ts: now,
    });
  }
  return {
    claimed: owed.map((q) => ({ id: q.id, title: q.title, reward: q.reward })),
    points: owed.reduce((sum, q) => sum + q.reward, 0),
  };
}

// -------------------------------------------------------------------- races

export interface RaceRow {
  id: number;
  name: string;
  starts: Date;
  ends: Date;
  prize: string;
  metric: string;
}

export async function currentRace(): Promise<RaceRow | null> {
  const { rows } = await pool.query<RaceRow>(
    `select id, name, starts, ends, prize, metric from races
      where starts <= now() and ends > now() order by ends asc limit 1`,
  );
  return rows[0] ?? null;
}

export async function raceStandings(race: RaceRow, limit: number) {
  const column = race.metric === "volume"
    ? `coalesce(sum(usd) filter (where kind in ('trade_buy','trade_sell')), 0)`
    : `coalesce(sum(amount), 0)`;
  const { rows } = await pool.query(
    `select address, ${column}::numeric(20,2) as score,
            coalesce(sum(usd) filter (where kind in ('trade_buy','trade_sell')), 0)::numeric(20,2) as volume_usd
       from points where ts >= $1 and ts < $2
       group by address having ${column} > 0
       order by score desc limit $3`,
    [race.starts, race.ends, limit],
  );
  return rows.map((r: Record<string, unknown>, i: number) => ({
    position: i + 1,
    address: r.address as string,
    score: Number(r.score),
    volumeUsd: Number(r.volume_usd ?? 0),
  }));
}

export function registerQuests(app: FastifyInstance) {
  /// The list itself, with nothing filled in. A visitor with no wallet should still see what the
  /// quests are: a page that says "connect to see" sells nothing to the person deciding whether to.
  app.get("/quests", async () => ({
    season: await currentSeason(),
    quests: QUESTS.map((quest) => ({ ...quest, progress: 0, done: false, claimed: false })),
    unclaimed: 0,
  }));

  /// Public: a wallet's own board is worth linking, and an address in the path is not a secret.
  app.get("/quests/:address", async (req, reply) => {
    const raw = (req.params as { address: string }).address;
    if (!isAddress(raw)) return refuse(reply, 400, "bad_address", "That is not an address.");
    const season = await currentSeason();
    const quests = await questsFor(raw.toLowerCase(), season);
    return {
      season,
      quests,
      unclaimed: quests.filter((q) => q.done && !q.claimed).reduce((sum, q) => sum + q.reward, 0),
    };
  });

  app.post("/quests/claim", async (req, reply) => {
    const me = walletOf(req, reply);
    if (!me) return;
    const season = await currentSeason();
    return claimQuests(me, season);
  });

  app.get("/races/current", async (req) => {
    const race = await currentRace();
    if (!race) return { race: null, standings: [] };
    const asked = Number((req.query as { limit?: string }).limit ?? 25);
    const limit = Number.isFinite(asked) ? Math.min(Math.max(Math.floor(asked), 1), 100) : 25;
    return { race, standings: await raceStandings(race, limit) };
  });

  app.get("/races", async () => {
    const { rows } = await pool.query<RaceRow>(
      `select id, name, starts, ends, prize, metric from races order by ends desc limit 50`,
    );
    return { races: rows };
  });

  /// Opening a race is an operator's act, like opening a season: it names a window and what is on
  /// the line, and it can be corrected until it starts paying anybody's attention.
  app.post("/admin/races", async (req, reply) => {
    if (!isAdmin(req)) return refuse(reply, 401, "unauthorized", "This needs the admin token.");
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const starts = new Date(String(body.starts ?? ""));
    const ends = new Date(String(body.ends ?? ""));
    const metric = body.metric === "volume" ? "volume" : "points";
    const prize = typeof body.prize === "string" ? body.prize.trim() : "";
    if (!name) return refuse(reply, 400, "bad_request", "A race needs a name.");
    if (Number.isNaN(starts.getTime()) || Number.isNaN(ends.getTime()) || ends <= starts) {
      return refuse(reply, 400, "bad_window", "A race needs a start and an end, in that order.");
    }
    const { rows } = await pool.query<RaceRow>(
      `insert into races (name, starts, ends, prize, metric) values ($1,$2,$3,$4,$5)
       returning id, name, starts, ends, prize, metric`,
      [name, starts, ends, prize, metric],
    );
    return { race: rows[0] };
  });

  app.delete("/admin/races/:id", async (req, reply) => {
    if (!isAdmin(req)) return refuse(reply, 401, "unauthorized", "This needs the admin token.");
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) return refuse(reply, 400, "bad_request", "That is not a race id.");
    await pool.query(`delete from races where id = $1`, [id]);
    return { deleted: id };
  });
}
