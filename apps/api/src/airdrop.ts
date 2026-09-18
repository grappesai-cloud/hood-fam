import { zeroAddress } from "viem";

import { currentSeason, pool } from "./db.js";
import { usdValue } from "./price.js";
import { POINTS, RANKS, STAKE_MONTH_DAYS, lockMultiplier, rankFor, volumeUsd30d, type Rank } from "./points.js";
import { getSeason, SeasonError } from "./seasons.js";

/// The money side of a season. Points already say who did what; this says what the protocol earned
/// while they were doing it, what slice of that the treasury is putting up, and what a wallet's
/// slice of that slice looks like.
///
/// Nothing here promises anybody anything. The pool is a share of revenue the protocol has already
/// collected, set per season by the treasury, and every number a user sees carries the sentence
/// that says so.

// ---------------------------------------------------------------- the take

/// The direct machine's splitter takes a tenth of every sweep, hard coded as PROTOCOL_BPS = 1000 in
/// HoodRevenueSplitter and never settable. The indexer stores a Swept row with `amount` = the total
/// that was split, so the protocol's leg is that total divided by ten, floored exactly the way
/// Solidity floors `(unaccounted * 1000) / 10000`.
const SPLITTER_PROTOCOL_DIVISOR = 10;

/// The curve's fee is one number on the trade (`trades.fee` = protocol leg + creator leg) and the
/// curve splits it `mulDiv(fee, protocolFeeBps, protocolFeeBps + creatorFeeBps)`. Both legs are
/// per-config immutables that the indexer does not store, so they are configuration here: the
/// deployed configs all use 30 / 70. A ZeroFee launch (fee_model 4) has no creator leg at all, so
/// the whole fee is the protocol's; that one the `launches` row does tell us.
const CURVE_PROTOCOL_FEE_BPS = Number(process.env.HOOD_CURVE_PROTOCOL_FEE_BPS ?? 30);
const CURVE_CREATOR_FEE_BPS = Number(process.env.HOOD_CURVE_CREATOR_FEE_BPS ?? 70);
const FEE_MODEL_ZERO_FEE = 4;

/// What `usdValue` in the indexer assumes about a pair asset, said out loud so the API can label a
/// row. The native pair is the chain's own currency at eighteen decimals; every other pair on 4663
/// is a six decimal dollar token.
const assetMeta = (asset: string) =>
  asset === zeroAddress
    ? { symbol: "ETH", decimals: 18 }
    : { symbol: "USD", decimals: 6 };

export interface TakeAsset {
  asset: string;
  symbol: string;
  decimals: number;
  amountWei: string;
  usd: number;
  /// Where it came from, so a treasurer can reconcile a row against the chain.
  components: { directSweptWei: string; curveTradeWei: string };
  /// What the treasury has actually pulled out of the splitters so far. Informational: it is a
  /// withdrawal of money already counted above, never an addition to it.
  claimedWei: string;
}

export interface SeasonTake {
  season: number;
  windowStart: Date;
  windowEnd: Date;
  byAsset: TakeAsset[];
  usd: number;
  notes: string[];
}

interface TakeRow { asset: string; direct_wei: string | null; curve_wei: string | null }

export async function seasonTake(season: number | string): Promise<SeasonTake> {
  const s = await getSeason(season);
  const { rows: [win] } = await pool.query<{ starts: Date; ends: Date }>(
    `select starts, coalesce(ends, now()) as ends from seasons where id = $1`,
    [s.id],
  );
  if (!win) throw new SeasonError("no such season", 404);

  // One pass per machine, joined on the pair asset. The join to `launches` is what tells us which
  // asset the money is in, so a fee row for a launch the table no longer has cannot be priced and
  // is counted in `unpriced` below rather than guessed at.
  const { rows } = await pool.query<TakeRow>(
    `with win as (select starts, coalesce(ends, now()) as ends from seasons where id = $1),
     direct as (
       select l.pair_token as asset, sum(div(f.amount, $2::numeric)) as wei
       from fee_events f
       join launches l on l.token = f.token
       cross join win w
       where f.kind = 'swept' and f.ts >= w.starts and f.ts < w.ends
       group by 1
     ),
     curve as (
       select l.pair_token as asset,
              sum(div(t.fee * $3::numeric,
                      $3::numeric + case when l.fee_model = $5 then 0 else $4::numeric end)) as wei
       from trades t
       join launches l on l.token = t.token
       cross join win w
       where l.mode = 'curve' and t.fee > 0 and t.ts >= w.starts and t.ts < w.ends
       group by 1
     )
     select coalesce(d.asset, c.asset) as asset, d.wei as direct_wei, c.wei as curve_wei
     from direct d full join curve c on c.asset = d.asset`,
    [s.id, SPLITTER_PROTOCOL_DIVISOR, CURVE_PROTOCOL_FEE_BPS, CURVE_CREATOR_FEE_BPS, FEE_MODEL_ZERO_FEE],
  );

  const { rows: claimedRows } = await pool.query<{ asset: string; wei: string }>(
    `with win as (select starts, coalesce(ends, now()) as ends from seasons where id = $1)
     select l.pair_token as asset, sum(f.amount) as wei
     from fee_events f join launches l on l.token = f.token cross join win w
     where f.kind = 'protocol_claimed' and f.ts >= w.starts and f.ts < w.ends
     group by 1`,
    [s.id],
  );
  const claimed = new Map(claimedRows.map((r) => [r.asset, r.wei]));

  const { rows: [{ unpriced }] } = await pool.query<{ unpriced: string }>(
    `with win as (select starts, coalesce(ends, now()) as ends from seasons where id = $1)
     select count(*) as unpriced
     from fee_events f left join launches l on l.token = f.token cross join win w
     where l.token is null and f.kind in ('swept', 'protocol_claimed')
       and f.ts >= w.starts and f.ts < w.ends`,
    [s.id],
  );

  const byAsset: TakeAsset[] = [];
  for (const r of rows) {
    const direct = BigInt(r.direct_wei ?? "0");
    const curve = BigInt(r.curve_wei ?? "0");
    const total = direct + curve;
    if (total === 0n) continue;
    const meta = assetMeta(r.asset);
    byAsset.push({
      asset: r.asset,
      ...meta,
      amountWei: total.toString(),
      usd: await usdValue(r.asset, total),
      components: { directSweptWei: direct.toString(), curveTradeWei: curve.toString() },
      claimedWei: claimed.get(r.asset) ?? "0",
    });
  }
  byAsset.sort((a, b) => b.usd - a.usd);

  const notes = [
    `Direct machine: a tenth of every Swept row, the splitter's hard-coded PROTOCOL_BPS.`,
    `Curve machine: ${CURVE_PROTOCOL_FEE_BPS} of the ${CURVE_PROTOCOL_FEE_BPS + CURVE_CREATOR_FEE_BPS} bps trading fee on each trade, the whole fee on a ZeroFee launch.`,
    `Graduation fees paid straight to the treasury are not in this number: the indexer does not store them.`,
    `protocol_claimed is a withdrawal of money already counted here, so it is reported and not added.`,
  ];
  if (Number(unpriced) > 0) {
    notes.push(`${unpriced} fee rows belong to launches this database no longer has, so their asset is unknown and they are left out.`);
  }

  return {
    season: s.id,
    windowStart: win.starts,
    windowEnd: win.ends,
    byAsset,
    usd: byAsset.reduce((sum, a) => sum + a.usd, 0),
    notes,
  };
}

// ---------------------------------------------------------------- the pool

/// The share of the take the treasury puts up for a season. It is a parameter, set before the
/// season is settled and the same for everyone in it. It is not a rate anybody is owed, and the
/// contract that pays a drop is funded in the same call that opens it, so what is published is
/// always money that is already there.
export const seasonPoolBps = (): number => {
  const n = Number(process.env.SEASON_POOL_BPS ?? 3000);
  return Number.isFinite(n) && n >= 0 && n <= 10_000 ? Math.floor(n) : 3000;
};

export interface SeasonPool { take: SeasonTake; poolBps: number; poolUsd: number }

export async function seasonPool(season: number | string): Promise<SeasonPool> {
  const take = await seasonTake(season);
  const poolBps = seasonPoolBps();
  return { take, poolBps, poolUsd: (take.usd * poolBps) / 10_000 };
}

// ---------------------------------------------------------------- the points in a season

export interface SeasonPoints {
  total: number;
  participants: number;
  median: number;
  p90: number;
  top10Share: number;
}

export async function seasonPoints(season: number | string): Promise<SeasonPoints> {
  const s = typeof season === "number" ? season : Number(season);
  const { rows: [r] } = await pool.query<{
    total: string; participants: string; median: string | null; p90: string | null; top10: string;
  }>(
    `with per as (select address, sum(amount) as points from points where season = $1 group by 1)
     select coalesce(sum(points), 0) as total,
            count(*) as participants,
            percentile_cont(0.5) within group (order by points) as median,
            percentile_cont(0.9) within group (order by points) as p90,
            (select coalesce(sum(points), 0) from (select points from per order by points desc limit 10) t) as top10
     from per`,
    [s],
  );
  const total = Number(r?.total ?? 0);
  return {
    total,
    participants: Number(r?.participants ?? 0),
    median: Number(r?.median ?? 0),
    p90: Number(r?.p90 ?? 0),
    top10Share: total > 0 ? Number(r?.top10 ?? 0) / total : 0,
  };
}

// ---------------------------------------------------------------- the calculator

/// HoodStaking's five tiers, longest first, exactly as its constructor writes them. The weight is
/// what the chain emits on Staked and what the indexer folds into the dollar value it scores, so a
/// calculator that wants to agree with the indexer has to use the same ladder.
export const LOCK_TIERS = [
  { days: 180, weightBps: 25_000 },
  { days: 90, weightBps: 20_000 },
  { days: 30, weightBps: 15_000 },
  { days: 7, weightBps: 12_500 },
  { days: 0, weightBps: 10_000 },
] as const;

export const weightForLockDays = (days: number): number =>
  (LOCK_TIERS.find((t) => days >= t.days) ?? LOCK_TIERS[LOCK_TIERS.length - 1]!).weightBps;

export interface EstimateInput {
  season?: number;
  address?: string | null;
  launches: number;
  buyUsd: number;
  sellUsd: number;
  stakeUsd: number;
  lockDays: number;
  /// Overrides the wallet's own rolling 30 day volume, for "what if I were Gold" on the front end.
  currentVolumeUsd?: number;
}

/// One arm of the estimate: everything scored at a single rank.
export interface EstimateArm {
  rank: string;
  multiplier: number;
  points: { launch: number; buy: number; sell: number; stake: number; total: number };
  projectedPoints: number;
  seasonTotalAfter: number;
  sharePpm: number;
  estimateUsd: number;
}

export interface Estimate {
  season: number;
  rank: string;
  multiplier: number;
  points: { launch: number; buy: number; sell: number; stake: number; total: number };
  existingPoints: number;
  projectedPoints: number;
  seasonTotalAfter: number;
  sharePpm: number;
  poolUsd: number;
  poolBps: number;
  estimateUsd: number;
  lockMultiplier: number;
  /// How many days of being locked the stake figure was scored over.
  stakeDays: number;
  /// The same activity scored at the rank the wallet holds today, and at the rank this activity
  /// would reach. The real answer is between them, because every trade is scored when it lands.
  low: EstimateArm;
  high: EstimateArm;
  assumptions: string[];
}

export async function estimate(input: EstimateInput): Promise<Estimate> {
  const s = await getSeason(input.season ?? (await currentSeason()));
  const address = input.address ? input.address.toLowerCase() : null;

  // Rank is bought with rolling 30 day volume, and `award` reads that volume as it stands when the
  // trade lands. So a season of trading is not scored at one rank: the first dollars are scored at
  // the rank the wallet holds today and the last ones at the rank the trading itself unlocked. One
  // number would be wrong in one direction or the other, so the estimate returns both arms and the
  // front end shows the band.
  const baseVolume = input.currentVolumeUsd ?? (address ? await volumeUsd30d(address) : 0);
  const rankNow: Rank = rankFor(baseVolume);
  const rankAfter: Rank = rankFor(baseVolume + input.buyUsd + input.sellUsd);
  const lock = lockMultiplier(weightForLockDays(input.lockDays));

  // Locking pays for time, so the calculator has to know how long. A fixed tier says it itself; a
  // flexible lock earns at 1x for as long as it is left alone, which nobody can know, so it is
  // scored over a month and the assumption says so. Either way only the days that fall inside this
  // season count towards this season's pool, because that is the pool being divided.
  const DAY_MS = 86_400_000;
  const seasonDaysLeft = s.ends ? Math.max(0, (new Date(s.ends).getTime() - Date.now()) / DAY_MS) : null;
  const heldDays = input.lockDays > 0 ? input.lockDays : (seasonDaysLeft ?? STAKE_MONTH_DAYS);
  const stakeDays = seasonDaysLeft === null ? heldDays : Math.min(heldDays, seasonDaysLeft);
  const stakeMonths = stakeDays / STAKE_MONTH_DAYS;

  const [{ rows: [mine] }, season, money] = await Promise.all([
    pool.query<{ points: string }>(
      `select coalesce(sum(amount), 0) as points from points where address = $1 and season = $2`,
      [address ?? "", s.id],
    ),
    seasonPoints(s.id),
    seasonPool(s.id),
  ]);
  const existingPoints = address ? Number(mine?.points ?? 0) : 0;

  const arm = (rank: Rank): EstimateArm => {
    const launch = input.launches * POINTS.launch * rank.multiplier;
    const buy = input.buyUsd * POINTS.perDollarBuy * rank.multiplier;
    const sell = input.sellUsd * POINTS.perDollarSell * rank.multiplier;
    const stake = input.stakeUsd * lock * POINTS.perDollarStakedPerMonth * stakeMonths * rank.multiplier;
    const added = launch + buy + sell + stake;
    const projectedPoints = existingPoints + added;
    // The denominator has to grow with the numerator. A calculator that divides new points by
    // yesterday's season total tells everybody they own more of it than they do.
    const seasonTotalAfter = season.total + added;
    const share = seasonTotalAfter > 0 ? projectedPoints / seasonTotalAfter : 0;
    return {
      rank: rank.name,
      multiplier: rank.multiplier,
      points: { launch, buy, sell, stake, total: added },
      projectedPoints,
      seasonTotalAfter,
      sharePpm: Math.round(share * 1_000_000),
      estimateUsd: money.poolUsd * share,
    };
  };

  const low = arm(rankNow);
  const high = rankAfter.name === rankNow.name ? low : arm(rankAfter);

  const nextRank = RANKS.find((r) => r.minVolumeUsd > baseVolume + input.buyUsd + input.sellUsd) ?? null;
  const assumptions = [
    `The season pool is ${(money.poolBps / 100).toFixed(money.poolBps % 100 === 0 ? 0 : 2)}% of what the protocol earned this season, a figure the treasury sets per season rather than a rate anybody is owed.`,
    low === high
      ? `Your rank comes from rolling 30 day volume, so it can fall as well as rise. This activity keeps you at ${rankNow.name} (${rankNow.multiplier}x).`
      : `Rank comes from rolling 30 day volume and every trade is scored at the rank you held when it landed. The low number scores all of this at ${rankNow.name} (${rankNow.multiplier}x), the high number at ${rankAfter.name} (${rankAfter.multiplier}x), which this much volume would reach. The real answer is in between and moves towards the high end the earlier in the season you trade.`,
    nextRank
      ? `${Math.round(nextRank.minVolumeUsd - (baseVolume + input.buyUsd + input.sellUsd)).toLocaleString("en-US")} dollars more of 30 day volume would reach ${nextRank.name} (${nextRank.multiplier}x).`
      : `This is the top rank, so the multiplier here is the highest there is.`,
    input.stakeUsd > 0
      ? (input.lockDays > 0
          ? `Locking pays ${POINTS.perDollarStakedPerMonth} points per dollar per ${STAKE_MONTH_DAYS} days it stays locked, times the lock multiplier, credited as it is earned rather than when you lock. This scores ${Math.round(stakeDays)} days${stakeDays < heldDays ? `, which is all that is left of the season` : ``}.`
          : `A flexible lock earns at 1x for exactly as long as you leave it; this scores ${Math.round(stakeDays)} days of it. Locking pays ${POINTS.perDollarStakedPerMonth} points per dollar per ${STAKE_MONTH_DAYS} days, credited as it is earned.`)
      : `Locking pays ${POINTS.perDollarStakedPerMonth} points per dollar per ${STAKE_MONTH_DAYS} days it stays locked, times the lock multiplier.`,
    `Everyone else's points count in the same total, so your share falls whenever somebody else earns, and the pool grows only if the protocol earns more.`,
    `Nothing here is a promise or an offer. It is what today's numbers would pay if the season ended today.`,
  ];

  return {
    season: s.id,
    rank: low.rank,
    multiplier: low.multiplier,
    points: low.points,
    existingPoints,
    projectedPoints: low.projectedPoints,
    seasonTotalAfter: low.seasonTotalAfter,
    sharePpm: low.sharePpm,
    poolUsd: money.poolUsd,
    poolBps: money.poolBps,
    estimateUsd: low.estimateUsd,
    lockMultiplier: lock,
    stakeDays,
    low,
    high,
    assumptions,
  };
}
