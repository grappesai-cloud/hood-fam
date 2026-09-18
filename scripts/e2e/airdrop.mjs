// The season drop against a running API: the economics answer with numbers, the calculator is
// honest about the denominator, and a published tree's proofs verify here rather than on trust.
//
//   API=http://127.0.0.1:8099 HOOD_ADMIN_TOKEN=... node scripts/e2e/airdrop.mjs
//
// It needs the admin token for the build and snapshot routes. It writes one thing to the database
// (a drop for the season with the most points, which replaces any earlier build of that season)
// and re-freezes that season's snapshot if it had none.
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";

const API = process.env.API ?? "http://127.0.0.1:8099";
const TOKEN = process.env.HOOD_ADMIN_TOKEN ?? process.env.SUPPORT_ADMIN_TOKEN ?? "";
const ENCODING = ["uint256", "address", "uint256"];

let failed = 0;
const ok = (cond, msg) => {
  if (cond) console.log("ok   ", msg);
  else { console.error("FAIL ", msg); failed++; }
};
const skip = (msg) => console.log("skip ", msg);

const j = async (path, init) => {
  const r = await fetch(API + path, init);
  return { status: r.status, body: await r.json().catch(() => null) };
};
const admin = (path, init = {}) =>
  j(path, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${TOKEN}`, "content-type": "application/json" } });
const post = (path, body) =>
  j(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const num = (x) => typeof x === "number" && Number.isFinite(x);

// ---- 0. what the stack has ----
const seasons = await j("/seasons");
ok(seasons.status === 200 && Array.isArray(seasons.body?.seasons) && seasons.body.seasons.length > 0,
  `the stack has ${seasons.body?.seasons?.length ?? 0} seasons`);
if (seasons.status !== 200) process.exit(1);

const economics = [];
for (const s of seasons.body.seasons) {
  const r = await j(`/airdrop/season/${s.id}`);
  if (r.status === 200) economics.push(r.body);
}
ok(economics.length === seasons.body.seasons.length, "every season answers /airdrop/season/:season");

// ---- 1. the economics answer with numbers ----
const any = economics[0];
ok(
  any && num(any.pool?.poolUsd) && num(any.pool?.poolBps) && num(any.pool?.take?.usd) && Array.isArray(any.pool.take.byAsset),
  `season ${any?.season}: pool ${any?.pool?.poolBps} bps of a take of ${any?.pool?.take?.usd} usd across ${any?.pool?.take?.byAsset?.length} assets`,
);
ok(
  any && num(any.points?.total) && num(any.points?.participants) && num(any.points?.top10Share),
  `season ${any?.season}: ${any?.points?.participants} wallets, ${any?.points?.total} points, top ten hold ${(100 * (any?.points?.top10Share ?? 0)).toFixed(1)}%`,
);
for (const e of economics) {
  const derived = (e.pool.take.usd * e.pool.poolBps) / 10_000;
  if (Math.abs(derived - e.pool.poolUsd) > 1e-9) { ok(false, `season ${e.season}: poolUsd is take times poolBps`); break; }
}
ok(true, "poolUsd is exactly the take times the pool bps in every season");
for (const a of any?.pool?.take?.byAsset ?? []) {
  ok(/^0x[0-9a-f]{40}$/.test(a.asset) && typeof a.amountWei === "string" && num(a.usd) && num(a.decimals),
    `take row ${a.symbol}: ${a.amountWei} (${a.usd} usd)`);
}

// ---- 2. the estimate is monotonic ----
const rich = economics.slice().sort((a, b) => b.points.total - a.points.total)[0];
const lean = economics.slice().sort((a, b) => a.points.total - b.points.total)[0];

const est = (over) => post("/airdrop/estimate", { season: rich.season, launches: 0, buyUsd: 0, sellUsd: 0, stakeUsd: 0, lockDays: 0, ...over });

const zero = await est({});
ok(zero.status === 200 && zero.body.points.total === 0 && Array.isArray(zero.body.assumptions) && zero.body.assumptions.length >= 4,
  `an empty estimate is zero points and still prints ${zero.body?.assumptions?.length} assumptions`);

let previous = -1;
let monotonic = true;
const ladder = [0, 100, 1_000, 10_000, 100_000, 1_000_000];
for (const v of ladder) {
  const r = await est({ buyUsd: v, sellUsd: v, currentVolumeUsd: 0 });
  if (r.status !== 200 || r.body.points.total < previous) monotonic = false;
  previous = r.body?.points?.total ?? previous;
}
ok(monotonic, `points never fall as volume climbs (${ladder[0]} to ${ladder[ladder.length - 1]} usd a side, ending at ${previous} points)`);

const lockLadder = [0, 7, 30, 90, 180];
let lockPrev = -1;
let lockMono = true;
for (const d of lockLadder) {
  const r = await est({ stakeUsd: 1000, lockDays: d });
  if (r.status !== 200 || r.body.points.stake < lockPrev) lockMono = false;
  lockPrev = r.body?.points?.stake ?? lockPrev;
}
ok(lockMono, `a longer lock never pays less (0 to 180 days ends at ${lockPrev} stake points)`);

const launched = await est({ launches: 3 });
ok(launched.status === 200 && launched.body.points.launch > 0 && launched.body.points.launch === 3 * 500 * launched.body.multiplier,
  `three launches are 3 x 500 x the rank multiplier (${launched.body?.points?.launch})`);

// the denominator grows with the numerator
const big = await est({ buyUsd: 1_000_000 });
ok(big.status === 200 && big.body.seasonTotalAfter > rich.points.total && big.body.sharePpm < 1_000_000,
  `adding ${big.body?.points?.total} points moves the season total to ${big.body?.seasonTotalAfter}, share ${big.body?.sharePpm} ppm`);

// ---- 3. the same points buy less of a bigger season ----
if (rich.points.total > lean.points.total) {
  const inRich = await post("/airdrop/estimate", { season: rich.season, launches: 0, buyUsd: 10_000, sellUsd: 0, stakeUsd: 0, lockDays: 0, currentVolumeUsd: 0 });
  const inLean = await post("/airdrop/estimate", { season: lean.season, launches: 0, buyUsd: 10_000, sellUsd: 0, stakeUsd: 0, lockDays: 0, currentVolumeUsd: 0 });
  ok(inRich.status === 200 && inLean.status === 200 && inRich.body.points.total === inLean.body.points.total,
    "the same inputs earn the same points in either season");
  ok(inRich.body.sharePpm < inLean.body.sharePpm,
    `the same points are ${inRich.body.sharePpm} ppm of season ${rich.season} (${rich.points.total} points) but ${inLean.body.sharePpm} ppm of season ${lean.season} (${lean.points.total} points)`);
} else {
  skip("every season holds the same number of points, so the share comparison has nothing to compare");
}

// ---- 4. the input is clamped ----
for (const [body, why] of [
  [{ buyUsd: -1 }, "a negative dollar figure"],
  [{ launches: 101 }, "more than a hundred launches"],
  [{ buyUsd: 100_000_001 }, "more than a hundred million dollars"],
  [{ stakeUsd: 1e9 }, "a billion staked"],
  [{ lockDays: -5 }, "a negative lock"],
  [{ address: "not-an-address" }, "a malformed address"],
  [{ launches: 1.5 }, "a fractional launch"],
]) {
  const r = await post("/airdrop/estimate", { launches: 0, buyUsd: 0, sellUsd: 0, stakeUsd: 0, lockDays: 0, ...body });
  ok(r.status === 400, `estimate rejects ${why} (${r.status}${r.body?.error ? ": " + r.body.error : ""})`);
}

// ---- 5. a build needs the admin token ----
const anon = await post(`/admin/airdrop/${rich.season}/build`, { poolWei: "1000000000000000000" });
ok(anon.status === 401, "a build without the admin token is 401");
if (!TOKEN) { console.error("FAIL  HOOD_ADMIN_TOKEN is not set, the rest of the harness cannot run"); process.exit(1); }

// ---- 6. a build needs a snapshot ----
const state = await admin("/admin/seasons");
ok(state.status === 200, "the admin season list answers");
const unsnapped = (state.body?.seasons ?? []).find((s) => !s.snapshot);
if (unsnapped) {
  const r = await admin(`/admin/airdrop/${unsnapped.id}/build`, { method: "POST", body: JSON.stringify({ poolWei: "1000000000000000000" }) });
  ok(r.status === 400 && /snapshot/i.test(r.body?.error ?? ""), `a build over the unsettled season ${unsnapped.id} is 400: "${r.body?.error}"`);
} else {
  skip("every season is snapshotted, so there is nothing to refuse");
}
const missing = await admin(`/admin/airdrop/999999/build`, { method: "POST", body: JSON.stringify({ poolWei: "1000000000000000000" }) });
ok(missing.status === 404, "a build for a season that does not exist is 404");
const badPool = await admin(`/admin/airdrop/${rich.season}/build`, { method: "POST", body: JSON.stringify({ pool: "-5" }) });
ok(badPool.status === 400, `a negative pool is 400 ("${badPool.body?.error}")`);

// ---- 7. a build after a snapshot ----
if (rich.points.participants === 0) {
  console.error("FAIL  no season has any points, so there is nothing to build a drop from");
  process.exit(1);
}
const richState = (state.body?.seasons ?? []).find((s) => s.id === rich.season);
if (!richState?.snapshot) {
  const snap = await admin(`/admin/seasons/${rich.season}/snapshot`, { method: "POST", body: "{}" });
  ok(snap.status === 200, `season ${rich.season} snapshotted (${snap.body?.rows} rows) so it can be settled`);
}

const POOL = 1_000_000_000_000_000_000n;
const built = await admin(`/admin/airdrop/${rich.season}/build`, { method: "POST", body: JSON.stringify({ poolWei: POOL.toString() }) });
ok(built.status === 200 && /^0x[0-9a-f]{64}$/.test(built.body?.root ?? ""), `season ${rich.season} built: root ${built.body?.root}`);
ok(built.body?.total === POOL.toString(), `the tree is funded to the wei (${built.body?.total})`);
ok(Number(built.body?.claims) > 0 && built.body.claims === built.body.stats?.included,
  `${built.body?.claims} wallets on the list, ${built.body?.stats?.belowFloor} under the floor, ${built.body?.stats?.remainderWei} wei of remainder to the largest`);

const shown = await j(`/airdrop/season/${rich.season}`);
ok(shown.body?.drop?.root === built.body.root && shown.body.drop.total === built.body.total,
  "the season route now shows the published drop");

// ---- 8. the proofs verify here, not on trust ----
const board = await j(`/leaderboard?season=${rich.season}&limit=250`);
const addresses = (board.body?.rows ?? []).map((r) => r.address);
ok(addresses.length > 0, `${addresses.length} addresses on season ${rich.season}'s board`);

const fetched = [];
for (const a of addresses) {
  const r = await j(`/airdrop/${rich.season}/proof/${a}`);
  if (r.status === 200) fetched.push(r.body);
}
ok(fetched.length > 0, `the proof route served ${fetched.length} of ${addresses.length} addresses`);
ok(fetched.every((p) => p.claimed === null), "claimed is null on every proof: the chain knows, we do not");
ok(fetched.every((p) => p.root === built.body.root), "every proof cites the published root");

let verified = 0;
for (const p of fetched) {
  if (StandardMerkleTree.verify(built.body.root, ENCODING, [String(p.season), p.address, p.amount], p.proof)) verified++;
}
ok(verified === fetched.length, `${verified} of ${fetched.length} proofs verify locally against ${built.body.root}`);

if (fetched.length === Number(built.body.claims)) {
  const rebuilt = StandardMerkleTree.of(fetched.map((p) => [String(p.season), p.address, p.amount]), ENCODING);
  ok(rebuilt.root === built.body.root, `a tree rebuilt from the served proofs has the same root (${rebuilt.root})`);
  const sum = fetched.reduce((a, p) => a + BigInt(p.amount), 0n);
  ok(sum === POOL, `the served amounts sum to the pool exactly (${sum})`);
} else {
  skip(`the board shows ${fetched.length} of ${built.body.claims} claims, so the whole tree cannot be rebuilt from it`);
}

const noSuch = await j(`/airdrop/${rich.season}/proof/0x000000000000000000000000000000000000dEaD`);
ok(noSuch.status === 404, "an address that is not on the list is 404");
const badAddr = await j(`/airdrop/${rich.season}/proof/nonsense`);
ok(badAddr.status === 400, "a malformed address on the proof route is 400");

// ---- 9. a floor leaves fewer wallets but the same total ----
if (Number(built.body.claims) > 1) {
  const floor = (POOL / BigInt(built.body.claims)).toString();
  const f = await admin(`/admin/airdrop/${rich.season}/build`, { method: "POST", body: JSON.stringify({ poolWei: POOL.toString(), min: floor }) });
  ok(f.status === 200 && f.body.total === POOL.toString() && f.body.claims <= Number(built.body.claims),
    `a floor of ${floor} wei leaves ${f.body?.claims} wallets and still totals ${f.body?.total}`);
  // put the season back the way the first build left it
  await admin(`/admin/airdrop/${rich.season}/build`, { method: "POST", body: JSON.stringify({ poolWei: POOL.toString() }) });
} else {
  skip("only one wallet on the list, so the floor has nothing to drop");
}

console.log(failed === 0 ? "\nall good" : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
