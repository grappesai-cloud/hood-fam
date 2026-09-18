import { currentSeason, pool } from "./db.js";
import { POINTS, STAKE_MONTH_DAYS, lockMultiplier, rankFor, volumeUsd30d } from "./points.js";
import { usdValue } from "./price.js";
import { isSystem } from "./system.js";

/// Points for time actually locked.
///
/// A lock is a promise to leave money where it is, so it is paid for as long as it is kept rather
/// than at the moment it is made. Paying at the moment it is made was farmable: the flexible tier
/// unlocks in the block it locks, so a wallet could lock, be paid, unlock and do it again forever.
///
/// Three properties matter here:
///   - **it is a ledger, not a balance.** Every credit is a row in `points` like every other credit,
///     so the leaderboard, the season total and the drop need to know nothing about staking.
///   - **it cannot double pay.** `stakes.points_through` is the watermark, moved in the same
///     transaction as the credit, and the row key is the position and the day, so a crash between
///     the two, a restart, or two runs in the same minute all land on the same number.
///   - **an expired lock is worth 1x, whether or not anybody demoted it.** `Demoted` is
///     permissionless, which means it is also optional; the multiplier here follows `unlock_at`, so
///     a position nobody bothered to demote stops earning the long-lock rate the moment it expires.

const DAY_MS = 86_400_000;
const MONTH_MS = STAKE_MONTH_DAYS * DAY_MS;

/// How little time is worth writing a row for. Hourly keeps the board fresh enough that a wallet
/// which just locked sees something, without a row per position per minute.
const MIN_STEP_MS = Number(process.env.STAKE_ACCRUAL_MIN_MINUTES ?? 60) * 60_000;

interface StakeRow {
  position_id: string;
  token: string;
  owner: string;
  amount: string;
  unlock_at: Date;
  weight_bps: number;
  created_at: Date;
  points_through: Date | null;
  pair_token: string;
  price: string;
}

export interface AccrualResult {
  /// Positions that were looked at.
  positions: number;
  /// Positions that earned something this run.
  credited: number;
  points: number;
}

const QUERY = `select s.position_id, s.token, s.owner, s.amount, s.unlock_at, s.weight_bps,
                      s.created_at, s.points_through, l.pair_token, l.price
               from stakes s join launches l on l.token = s.token
               where s.active`;

/// Everything still locked. Safe to call as often as you like: a position that has not been open
/// long enough since its last credit is skipped rather than paid twice.
export async function accrueStakePoints(now: Date = new Date()): Promise<AccrualResult> {
  const { rows } = await pool.query<StakeRow>(QUERY);
  const season = await currentSeason();
  const ranks = new Map<string, number>();
  let credited = 0;
  let points = 0;

  for (const row of rows) {
    const earned = await creditRow(row, now, season, ranks, MIN_STEP_MS);
    if (earned > 0) { credited++; points += earned; }
  }
  return { positions: rows.length, credited, points };
}

/// The last slice of one position, paid before it is closed. Called from the indexer when it sees
/// the position leave, with the block's own time: whatever it earned between the last credit and
/// the moment it was unlocked belongs to it, and nothing after.
export async function settleStake(positionId: number | string, until: Date): Promise<number> {
  const { rows } = await pool.query<StakeRow>(`${QUERY} and s.position_id = $1`, [positionId]);
  const row = rows[0];
  if (!row) return 0;
  // No minimum here: this is the position's last chance to be paid at all.
  return creditRow(row, until, await currentSeason(), new Map(), 0);
}

async function creditRow(
  row: StakeRow, now: Date, season: number, ranks: Map<string, number>, minStep: number,
): Promise<number> {
  const owner = row.owner.toLowerCase();
  if (isSystem(owner)) return 0;

  const from = (row.points_through ?? row.created_at).getTime();
  const to = now.getTime();
  if (to - from < minStep || to <= from) return 0;

  // The window, split where the lock expires: what was earned under the promise is worth the tier,
  // what came after is worth what an unlocked balance is worth.
  const unlock = row.unlock_at.getTime();
  const locked = Math.max(0, Math.min(to, unlock) - from);
  const loose = Math.max(0, to - Math.max(from, unlock));
  const tier = lockMultiplier(row.weight_bps);

  const dollars = await usdValue(row.pair_token, (BigInt(row.amount) * BigInt(row.price || "0")) / 10n ** 18n);
  if (dollars <= 0) {
    // Nothing to pay, but the watermark still moves: an unpriced hour is not owed later, when the
    // price is back, or a feed outage would quietly become a windfall.
    await pool.query(`update stakes set points_through = $2 where position_id = $1`, [row.position_id, now]);
    return 0;
  }

  if (!ranks.has(owner)) ranks.set(owner, rankFor(await volumeUsd30d(owner)).multiplier);
  const rank = ranks.get(owner)!;
  const months = (locked * tier + loose) / MONTH_MS;
  const amount = dollars * POINTS.perDollarStakedPerMonth * months * rank;
  if (amount <= 0) return 0;

  // One row per position per day, added to as the day goes on, so a season of locks is a few
  // hundred rows rather than a few hundred thousand. The upsert is what makes a second run in the
  // same hour harmless in the one place the watermark cannot help: a retry after a failed commit.
  const day = now.toISOString().slice(0, 10);
  const client = await pool.connect();
  try {
    await client.query("begin");
    // The watermark moves first, and only from the exact value this credit was computed against.
    // Two processes reading the same position in the same second both compute the same window; the
    // one that loses this update has already been paid for by the one that won, so it rolls back.
    const { rowCount } = await client.query(
      `update stakes set points_through = $2
       where position_id = $1 and points_through is not distinct from $3`,
      [row.position_id, now, row.points_through],
    );
    if (!rowCount) {
      await client.query("rollback");
      return 0;
    }
    await client.query(
      `insert into points (address, season, kind, token, amount, usd, ref, ts)
       values ($1,$2,'stake',$3,$4,$5,$6,$7)
       on conflict (kind, ref) do update set amount = points.amount + excluded.amount,
                                             usd = excluded.usd, ts = excluded.ts`,
      [owner, season, row.token, amount.toFixed(2), dollars.toFixed(2), `stake:${row.position_id}:${day}`, now],
    );
    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
  return amount;
}
