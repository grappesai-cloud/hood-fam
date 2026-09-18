#!/usr/bin/env node
/// What locking is worth, checked against the code that decides it.
///
/// The rule changed: a lock used to be paid once, when it was opened, which the flexible tier made
/// farmable (it unlocks in the block it locks, so lock, get paid, unlock, repeat). It is now paid
/// for the time it is kept. These are the properties that have to hold for that to be true, run
/// against a throwaway database with the real modules, not a reimplementation of them:
///
///   1. a position pays for the time it has been open, at ten per dollar per thirty days
///   2. running the accrual again right away pays nothing
///   3. an hour later it pays for that hour, into the same day's row rather than a new one
///   4. a lock that has expired is worth 1x from the moment it expired, demoted or not
///   5. the loop is dead: open and close inside a second and the whole thing is worth nothing
///   6. closing a position pays for the part of the day it was still open
///
/// Usage: node scripts/checks/points-accrual.mjs [postgres url]

const DB = process.argv[2] ?? "postgres://hood:hood@127.0.0.1:55444/hood_points";

process.env.DATABASE_URL = DB;
process.env.HOOD_ETH_USD = "2000";
// Nothing here should depend on a chain being reachable, and a test that quietly prices itself off
// a live feed is a test that changes answer every day.
process.env.HOOD_RPC = "http://127.0.0.1:1";
process.env.STAKE_ACCRUAL_MIN_MINUTES = "60";

const { pool, migrate } = await import("../../apps/api/dist/db.js");
const { accrueStakePoints, settleStake } = await import("../../apps/api/dist/stake-accrual.js");
const { POINTS, STAKE_MONTH_DAYS } = await import("../../apps/api/dist/points.js");

const DAY = 86_400_000;
const HOUR = 3_600_000;
const ONE = 10n ** 18n;

const checks = [];
const near = (a, b, tolerance = 0.01) => Math.abs(a - b) <= Math.abs(b) * tolerance + 0.01;
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? `   ${detail}` : ""}`);
}

async function reset() {
  await migrate();
  await pool.query("truncate points, stakes, trades, balances, launches, seasons restart identity cascade");
  await pool.query("insert into seasons (id, name, starts) values (1, 'Season 1', now() - interval '30 days')");
  // One token, priced so that a position is worth a round number of dollars: price is pair wei per
  // whole token, so 1e15 wei a token times 1000 tokens is 1 ETH, which is 2000 dollars here.
  await pool.query(
    `insert into launches (token, curve, creator, fee_recipient, pair_token, config_id, fee_model,
       name, symbol, launched_at, block, tx, price, total_supply)
     values ('0xtok','0xcur','0xcre','0xcre','0x0000000000000000000000000000000000000000',0,0,
             'Test','TEST', now() - interval '40 days', 1, '0xtx', $1, $2)`,
    [(10n ** 15n).toString(), (1_000_000n * ONE).toString()],
  );
}

async function position(id, { openedMsAgo, lockDays, weightBps, tokens = 1000n }) {
  const created = new Date(Date.now() - openedMsAgo);
  await pool.query(
    `insert into stakes (position_id, token, owner, amount, unlock_at, weight_bps, active, claimed, created_at)
     values ($1,'0xtok','0xowner',$2,$3,$4,true,0,$5)`,
    [id, (tokens * ONE).toString(), new Date(created.getTime() + lockDays * DAY), weightBps, created],
  );
}

const pointsOf = async () =>
  Number((await pool.query("select coalesce(sum(amount),0) as p from points where kind = 'stake'")).rows[0].p);
const rowsOf = async () =>
  Number((await pool.query("select count(*) as n from points where kind = 'stake'")).rows[0].n);

// Dollars locked: 1000 tokens at 1e15 wei each is 1 ETH, and HOOD_ETH_USD says an ETH is 2000.
const DOLLARS = 2000;
// Nothing has traded, so every wallet is Wood, whose multiplier is the one every figure below carries.
const RANK = 1.5;
const expected = (days, lockMultiplier) =>
  DOLLARS * POINTS.perDollarStakedPerMonth * (days / STAKE_MONTH_DAYS) * lockMultiplier * RANK;

// 1 + 2: two days of a 30 day lock, and nothing for asking twice.
await reset();
await position(1, { openedMsAgo: 2 * DAY, lockDays: 30, weightBps: 15_000 });
const first = await accrueStakePoints();
const afterTwoDays = await pointsOf();
check("two days of a 30 day lock pay for two days",
  near(afterTwoDays, expected(2, 1.5)),
  `${afterTwoDays.toFixed(0)} points, expected ${expected(2, 1.5).toFixed(0)}`);
check("one position credited", first.credited === 1, `credited ${first.credited}`);

await accrueStakePoints();
check("running it again immediately pays nothing", near(await pointsOf(), afterTwoDays, 0));

// 3: an hour later, into the same row.
const inAnHour = new Date(Date.now() + HOUR);
await accrueStakePoints(inAnHour);
const afterHour = await pointsOf();
check("an hour later pays for the hour",
  near(afterHour - afterTwoDays, expected(1 / 24, 1.5)),
  `${(afterHour - afterTwoDays).toFixed(2)} points for the hour`);
check("the day keeps one row per position", (await rowsOf()) === 1, `${await rowsOf()} rows`);

// 4: a lock that ran out two days ago pays the tier up to expiry and 1x after it, with nobody
// having called demote.
await reset();
await position(2, { openedMsAgo: 4 * DAY, lockDays: 2, weightBps: 25_000 });
await accrueStakePoints();
const blended = await pointsOf();
check("an expired lock is worth 1x after it expires, demoted or not",
  near(blended, expected(2, 2.5) + expected(2, 1)),
  `${blended.toFixed(0)} points, expected ${(expected(2, 2.5) + expected(2, 1)).toFixed(0)}`);

// 5: the loop that used to pay ten per dollar a time.
await reset();
await position(3, { openedMsAgo: 900, lockDays: 0, weightBps: 10_000 });
await accrueStakePoints();
check("lock and unlock in the same second is worth nothing", (await pointsOf()) === 0,
  `${(await pointsOf()).toFixed(4)} points`);
// Closing it pays for the second it existed, which is the whole point: the old rule paid
// dollars * 10 * multiplier * rank up front, so the same loop was worth thirty thousand points a
// turn. Anything under a thousandth of that is dead as a strategy.
const settled = await settleStake(3, new Date());
const oldRule = DOLLARS * POINTS.perDollarStakedPerMonth * 1 * RANK;
check("the old lock-unlock-relock loop is worth nothing now",
  settled < oldRule / 1000 && settled < 1,
  `${settled.toFixed(4)} points a turn, where the old rule paid ${oldRule.toFixed(0)}`);

// 6: a position closed six hours in is paid for six hours, even though the hourly pass never ran.
await reset();
await position(4, { openedMsAgo: 6 * HOUR, lockDays: 90, weightBps: 20_000 });
const paid = await settleStake(4, new Date());
check("closing a position pays for the time it was open",
  near(paid, expected(6 / 24, 2)),
  `${paid.toFixed(2)} points, expected ${expected(6 / 24, 2).toFixed(2)}`);

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
await pool.end();
process.exit(failed.length ? 1 : 0);
