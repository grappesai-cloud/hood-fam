import { pool, currentSeason } from "./db.js";
import { leaderboard } from "./points.js";

/// Seasons are windows over the points table: a season is current when now() falls between its
/// starts and its ends, and points are stamped with the current season as they are earned. Opening
/// the next season closes the previous one at the same instant, so no point can fall into two
/// seasons or into none. A snapshot freezes a season's top 250 so the public board for it stops
/// moving even if late points trickle in.

export const SNAPSHOT_SIZE = 250;
const NAME_MIN = 2;
const NAME_MAX = 60;

export interface Season {
  id: number;
  name: string;
  starts: Date;
  ends: Date | null;
}

export interface LeaderboardRow {
  position: number;
  address: string;
  points: number;
  volumeUsd: number;
  launches: number;
  rank: string;
}

/// Bad input, not a bug: a route maps it to 400 (or 404), the CLI to a one-line error and exit 1.
export class SeasonError extends Error {
  constructor(message: string, public status: 400 | 404 = 400) {
    super(message);
  }
}

/// Accepts an ISO string, a Date, or nothing. Strings must parse; "tomorrow" does not.
function parseWhen(value: unknown, field: string): Date | null {
  if (value === undefined || value === null || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? bad(field) : value;
  if (typeof value !== "string") return bad(field);
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? bad(field) : d;
}

function bad(field: string): never {
  throw new SeasonError(`${field} must be an ISO date-time`);
}

function parseId(value: unknown): number {
  const id = typeof value === "number" ? value : Number(String(value ?? ""));
  if (!Number.isInteger(id) || id < 1) throw new SeasonError("season id must be a positive integer");
  return id;
}

export async function listSeasons(): Promise<{ seasons: (Season & { snapshot: boolean })[]; current: number }> {
  const { rows } = await pool.query<Season & { snapshot: boolean }>(
    `select s.id, s.name, s.starts, s.ends,
            exists (select 1 from season_snapshots x where x.season = s.id) as snapshot
     from seasons s order by s.id`,
  );
  return { seasons: rows, current: await currentSeason() };
}

export async function getSeason(id: unknown): Promise<Season> {
  const { rows } = await pool.query<Season>(`select id, name, starts, ends from seasons where id = $1`, [parseId(id)]);
  if (!rows[0]) throw new SeasonError("no such season", 404);
  return rows[0];
}

/// Opens a season and closes the latest one at the same instant. `starts` defaults to the
/// database's now() rather than the process clock, so "current" is decided by one clock. The
/// latest row is locked for the duration so two operators cannot both open "Season 2".
export async function openSeason(input: { name: unknown; starts?: unknown; ends?: unknown }): Promise<Season> {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name.length < NAME_MIN || name.length > NAME_MAX) throw new SeasonError(`name must be ${NAME_MIN} to ${NAME_MAX} characters`);
  const wantedStarts = parseWhen(input.starts, "starts");
  const ends = parseWhen(input.ends, "ends");

  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows: [latest] } = await client.query<Season>(`select id, name, starts, ends from seasons order by id desc limit 1 for update`);
    const { rows: [{ starts }] } = await client.query<{ starts: Date }>(`select coalesce($1::timestamptz, now()) as starts`, [wantedStarts]);
    if (latest && starts <= latest.starts) throw new SeasonError(`starts must be after ${latest.name} (id ${latest.id}) started at ${latest.starts.toISOString()}`);
    if (ends && ends <= starts) throw new SeasonError("ends must be after starts");
    // A season cannot outlive its successor: an open one closes here, and one with an end date
    // past the new start is pulled back to it.
    if (latest && (latest.ends === null || latest.ends > starts)) {
      await client.query(`update seasons set ends = $2 where id = $1`, [latest.id, starts]);
    }
    const { rows: [season] } = await client.query<Season>(
      `insert into seasons (id, name, starts, ends)
       values ((select coalesce(max(id), 0) + 1 from seasons), $1, $2, $3) returning id, name, starts, ends`,
      [name, starts, ends],
    );
    await client.query("commit");
    return season!;
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/// Sets (or moves) a season's end. Closing the current season with nothing after it leaves a gap;
/// see currentSeason in db.ts for where points land meanwhile. The usual path is openSeason.
export async function closeSeason(id: unknown, ends?: unknown): Promise<Season> {
  const season = await getSeason(id);
  const at = parseWhen(ends, "ends");
  const { rows } = await pool.query<Season>(
    `update seasons set ends = coalesce($2::timestamptz, now())
     where id = $1 and starts < coalesce($2::timestamptz, now()) returning id, name, starts, ends`,
    [season.id, at],
  );
  if (!rows[0]) throw new SeasonError(`ends must be after the season started at ${season.starts.toISOString()}`);
  return rows[0];
}

/// Freezes the top SNAPSHOT_SIZE of a season as it stands now, replacing any earlier snapshot of
/// the same season. Everything is written in one transaction with one taken_at, so a reader never
/// sees half of the old board and half of the new.
export async function snapshotSeason(id: unknown): Promise<number> {
  const season = await getSeason(id);
  const rows = await leaderboard(season.id, SNAPSHOT_SIZE);
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`delete from season_snapshots where season = $1`, [season.id]);
    if (rows.length > 0) {
      await client.query(
        `insert into season_snapshots (season, position, address, points, volume_usd, launches, rank, taken_at)
         select $1, u.position, u.address, u.points, u.volume_usd, u.launches, u.rank, now()
         from unnest($2::int[], $3::text[], $4::numeric[], $5::numeric[], $6::int[], $7::text[])
              as u(position, address, points, volume_usd, launches, rank)`,
        [
          season.id,
          rows.map((r) => r.position),
          rows.map((r) => r.address),
          rows.map((r) => r.points.toFixed(2)),
          rows.map((r) => r.volumeUsd.toFixed(2)),
          rows.map((r) => r.launches),
          rows.map((r) => r.rank),
        ],
      );
    }
    await client.query("commit");
    return rows.length;
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/// The frozen board for a season, in the live board's row shape, or null when there is none.
export async function frozenLeaderboard(season: number, limit = 100): Promise<{ takenAt: Date; rows: LeaderboardRow[] } | null> {
  const { rows } = await pool.query(
    `select position, address, points, volume_usd, launches, rank, taken_at
     from season_snapshots where season = $1 order by position limit $2`,
    [season, limit],
  );
  if (!rows[0]) return null;
  return {
    takenAt: rows[0].taken_at as Date,
    rows: rows.map((r: Record<string, unknown>) => ({
      position: Number(r.position),
      address: r.address as string,
      points: Number(r.points),
      volumeUsd: Number(r.volume_usd ?? 0),
      launches: Number(r.launches ?? 0),
      rank: r.rank as string,
    })),
  };
}
