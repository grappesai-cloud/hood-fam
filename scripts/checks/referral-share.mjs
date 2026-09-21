#!/usr/bin/env node
/// Does a referral pay what it says, and only for what it should?
///
/// The rule is three sentences: the person who brought a trader earns a tenth of what that trader
/// earns by trading, it is paid on top rather than out of their share, and it counts only trades
/// made after the two wallets were tied together. Each of those is a place this could quietly go
/// wrong — paying the referee's points to the referrer, paying twice on a re-read, or paying for a
/// history the referrer had nothing to do with — so each is checked against the real award path
/// rather than against a copy of it.
///
///   DATABASE_URL=... node scripts/checks/referral-share.mjs
///
/// It writes into the database it is pointed at and cleans up after itself, so point it at a test
/// database, never at production.

import { award, REFERRAL_SHARE } from "../../apps/api/dist/points.js";
import { pool } from "../../apps/api/dist/db.js";

const REFERRER = "0x00000000000000000000000000000000000000a1";
const REFEREE = "0x00000000000000000000000000000000000000b2";

let passed = 0;
const failures = [];
const check = (name, ok, detail) => {
  if (ok) { passed += 1; console.log(`  ok   ${name}`); return; }
  failures.push(name);
  console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
};

const paid = async () => {
  const { rows } = await pool.query(
    `select coalesce(sum(amount), 0) as points from points where address = $1 and kind = 'referral'`,
    [REFERRER],
  );
  return Number(rows[0].points);
};

async function cleanup() {
  await pool.query(`delete from points where address in ($1,$2)`, [REFERRER, REFEREE]);
  await pool.query(`delete from referrals where referee = $1`, [REFEREE]);
}

await cleanup();
const boundAt = new Date(Date.now() - 60 * 60 * 1000);
await pool.query(`insert into referrals (referee, referrer, bound_at) values ($1,$2,$3)`, [REFEREE, REFERRER, boundAt]);

// A trade after the binding pays the referrer a tenth of what the trader earned.
const before = await paid();
const earned = await award({ address: REFEREE, kind: "trade_buy", usd: 1000, ref: "check:after", ts: new Date() });
const afterFirst = await paid();
check("the referrer is paid a tenth of the trade", Math.abs((afterFirst - before) - earned.amount * REFERRAL_SHARE) < 0.01,
  { earned: earned.amount, paid: afterFirst - before });

// The referee keeps everything they earned: the share is on top, not out of it.
const { rows: refereeRows } = await pool.query(
  `select coalesce(sum(amount), 0) as points from points where address = $1 and kind in ('trade_buy','trade_sell')`,
  [REFEREE],
);
check("the referee loses nothing to it", Math.abs(Number(refereeRows[0].points) - earned.amount) < 0.01,
  { referee: Number(refereeRows[0].points), earned: earned.amount });

// The same trade read again pays nothing again: the ref carries the trade's own ref.
await award({ address: REFEREE, kind: "trade_buy", usd: 1000, ref: "check:after", ts: new Date() });
check("a re-read of the same trade pays nothing twice", Math.abs(await paid() - afterFirst) < 0.01);

// A trade from before the two were tied together pays nobody.
await award({ address: REFEREE, kind: "trade_buy", usd: 5000, ref: "check:before", ts: new Date(boundAt.getTime() - 1000) });
check("a trade from before the binding pays nothing", Math.abs(await paid() - afterFirst) < 0.01, await paid());

// A wallet nobody brought pays nobody.
const orphan = await award({ address: "0x00000000000000000000000000000000000000c3", kind: "trade_sell", usd: 500, ref: "check:orphan", ts: new Date() });
const { rows: orphanRows } = await pool.query(`select count(*)::int as n from points where kind = 'referral' and ref = 'referral:check:orphan'`);
check("an unreferred wallet pays nobody", orphanRows[0].n === 0 && orphan.amount > 0);

await pool.query(`delete from points where ref = 'check:orphan' or address = '0x00000000000000000000000000000000000000c3'`);
await cleanup();
await pool.end();

console.log(`\n${passed} checks passed${failures.length ? `, ${failures.length} FAILED: ${failures.join(", ")}` : ""}`);
process.exit(failures.length ? 1 : 0);
