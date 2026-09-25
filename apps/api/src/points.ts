import { pool, currentSeason } from "./db.js";

/// Points: printing pays a flat amount, trading pays per dollar of volume, locking pays per dollar
/// per month it stays locked and pays more for a longer lock. A trader's rank multiplies everything
/// they earn, and rank is bought with volume, not with a wallet balance.
///
/// Locking used to pay ten per dollar the moment a position was opened. That was farmable and not
/// subtly: the flexible tier unlocks in the same block it locks, so a wallet could lock, be paid,
/// unlock and lock again for the price of gas, earning at five hundred times the rate of somebody
/// buying (a buy pays two per dollar and costs a one percent fee). The same ten per dollar is now
/// paid for a month of being locked, credited as it is earned, which makes the loop worthless:
/// a position that exists for one block is paid for one block.
export const POINTS = {
  launch: 500,
  perDollarBuy: 2,
  perDollarSell: 1,
  perDollarStakedPerMonth: 10,
  /// The wall of shame bounty: what every holder present when a bot paid a penalty is credited,
  /// per penalty, before their rank multiplies it. Small on purpose: it is a thank-you for being
  /// there, and anything bigger would make holding a token that bots hit a strategy.
  bounty: 1,
} as const;

/// What bringing somebody is worth: a tenth of what they earn by trading, paid on top rather than
/// taken out of their share, so a referral never costs the person who was referred anything. It is
/// capped by being a share of somebody else's real volume: there is no bonus for the introduction
/// itself, only for a wallet that actually trades, which is the only referral worth paying for.
export const REFERRAL_SHARE = 0.1;

/// What "per month" means, everywhere: thirty days.
export const STAKE_MONTH_DAYS = 30;

export const RANKS = [
  { name: "Wood", minVolumeUsd: 0, multiplier: 1.5 },
  { name: "Bronze", minVolumeUsd: 10_000, multiplier: 2 },
  { name: "Silver", minVolumeUsd: 50_000, multiplier: 2.5 },
  { name: "Gold", minVolumeUsd: 150_000, multiplier: 3 },
  { name: "Platinum", minVolumeUsd: 500_000, multiplier: 4 },
  { name: "Degen", minVolumeUsd: 1_000_000, multiplier: 5 },
] as const;

export type Rank = (typeof RANKS)[number];

export function rankFor(volumeUsd: number): Rank {
  let rank: Rank = RANKS[0];
  for (const r of RANKS) if (volumeUsd >= r.minVolumeUsd) rank = r;
  return rank;
}

/// Rolling 30 day volume decides the rank, so a rank has to be re-earned rather than kept.
export async function volumeUsd30d(address: string): Promise<number> {
  const { rows } = await pool.query<{ usd: string | null }>(
    `select coalesce(sum(usd), 0) as usd from points
     where address = $1 and kind in ('trade_buy','trade_sell') and ts > now() - interval '30 days'`,
    [address],
  );
  return Number(rows[0]?.usd ?? 0);
}

interface AwardInput {
  address: string;
  kind: "launch" | "trade_buy" | "trade_sell" | "stake" | "referral" | "quest" | "bounty";
  token?: string;
  /// Dollars: traded, for a trade; locked, for a stake. It is what the row stores, and for trades
  /// it is also what rank is bought with, so it stays the plain dollar figure in both cases.
  usd: number;
  /// Stakes only: the slice of a month this row pays for, and what the lock length is worth. A
  /// stake row is dollars times months times the lock multiplier; everything else ignores these.
  months?: number;
  lockMultiplier?: number;
  /// Referrals and quests only: the points themselves, already worked out by the caller.
  flat?: number;
  ref: string;
  ts: Date;
}

export async function award(input: AwardInput) {
  const season = await currentSeason();
  const volume = await volumeUsd30d(input.address);
  const rank = rankFor(volume);

  const base =
    input.kind === "launch" ? POINTS.launch
    : input.kind === "trade_buy" ? input.usd * POINTS.perDollarBuy
    : input.kind === "trade_sell" ? input.usd * POINTS.perDollarSell
    // A referral and a quest are already a finished number of points: they are not bought with
    // dollars, so they are not multiplied by a rank either. Paying them through the same table is
    // what puts them in the season, in the leaderboard and in the drop without a second ledger.
    : input.kind === "referral" || input.kind === "quest" ? input.flat ?? 0
    // A bounty is one point for being a holder when a bot paid, and the rank multiplies it the way
    // it multiplies a trade: the ref carries the penalty and the holder, so a re-read pays nothing twice.
    : input.kind === "bounty" ? POINTS.bounty
    : input.usd * POINTS.perDollarStakedPerMonth * (input.months ?? 0) * (input.lockMultiplier ?? 1);

  const amount = input.kind === "referral" || input.kind === "quest" ? base : base * rank.multiplier;
  await pool.query(
    `insert into points (address, season, kind, token, amount, usd, ref, ts)
     values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (kind, ref) do nothing`,
    [input.address.toLowerCase(), season, input.kind, input.token ?? null, amount.toFixed(2), input.usd.toFixed(2), input.ref, input.ts],
  );
  if (input.kind === "trade_buy" || input.kind === "trade_sell") await payReferrer(input, amount);
  return { amount, rank: rank.name, multiplier: rank.multiplier };
}

/// The person who brought this trader, if anyone did, earns their share of the same trade. The ref
/// carries the trade's own ref, so the unique index makes a re-read of the range pay nothing twice,
/// and a wallet that somehow points at itself is refused here as well as at the moment of binding.
async function payReferrer(input: AwardInput, earned: number) {
  if (earned <= 0) return;
  const referee = input.address.toLowerCase();
  const { rows } = await pool.query<{ referrer: string; bound_at: Date }>(
    `select referrer, bound_at from referrals where referee = $1`, [referee],
  );
  const row = rows[0];
  if (!row || row.referrer === referee) return;
  // Only trades made after the two were tied together. Binding a referral to a wallet with a
  // history and being paid for that history is the obvious way to farm this.
  if (input.ts < row.bound_at) return;
  await award({
    address: row.referrer,
    kind: "referral",
    token: input.token,
    usd: 0,
    flat: earned * REFERRAL_SHARE,
    ref: `referral:${input.ref}`,
    ts: input.ts,
  });
}

/// Staking pays for how long the lock is, which is exactly what the multiplier on chain says.
export const lockMultiplier = (weightBps: number) => weightBps / 10_000;

export async function leaderboard(season: number, limit = 100) {
  const { rows } = await pool.query(
    `select address,
            sum(amount)::numeric(20,2) as points,
            sum(usd) filter (where kind in ('trade_buy','trade_sell'))::numeric(20,2) as volume_usd,
            count(*) filter (where kind = 'launch') as launches
     from points where season = $1
     group by address order by points desc limit $2`,
    [season, limit],
  );
  return rows.map((r: Record<string, unknown>, i: number) => ({
    position: i + 1,
    address: r.address as string,
    points: Number(r.points),
    volumeUsd: Number(r.volume_usd ?? 0),
    launches: Number(r.launches ?? 0),
    rank: rankFor(Number(r.volume_usd ?? 0)).name,
  }));
}

export async function pointsFor(address: string, season: number) {
  const a = address.toLowerCase();
  const [{ rows: totals }, { rows: breakdown }] = await Promise.all([
    pool.query(
      `select coalesce(sum(amount),0) as points,
              coalesce(sum(usd) filter (where kind in ('trade_buy','trade_sell')),0) as volume_usd
       from points where address = $1 and season = $2`,
      [a, season],
    ),
    pool.query(
      `select kind, coalesce(sum(amount),0) as points, count(*) as events
       from points where address = $1 and season = $2 group by kind`,
      [a, season],
    ),
  ]);
  const volume30d = await volumeUsd30d(a);
  const rank = rankFor(volume30d);
  const { rows: position } = await pool.query(
    `select count(*) + 1 as position from (
       select address, sum(amount) as p from points where season = $2 group by address
     ) x where x.p > (select coalesce(sum(amount),0) from points where address = $1 and season = $2)`,
    [a, season],
  );
  return {
    address: a,
    season,
    points: Number(totals[0]?.points ?? 0),
    volumeUsd: Number(totals[0]?.volume_usd ?? 0),
    volumeUsd30d: volume30d,
    rank: rank.name,
    multiplier: rank.multiplier,
    nextRank: RANKS.find((r) => r.minVolumeUsd > volume30d) ?? null,
    position: Number(position[0]?.position ?? 1),
    breakdown: breakdown.map((r: Record<string, unknown>) => ({
      kind: r.kind as string,
      points: Number(r.points),
      events: Number(r.events),
    })),
  };
}
