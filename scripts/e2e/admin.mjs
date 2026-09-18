// The admin surface against a running API: the token, the overview, the season flow end to end,
// the public health integrations, and the rate limit headers. Leaves a new season open and a
// snapshot of the previous one behind, so run it against a test stack.
//
//   API=http://127.0.0.1:8099 HOOD_ADMIN_TOKEN=... node scripts/e2e/admin.mjs
//
// If the API runs with RATE_LIMIT_TRUST_LOCAL=1 and this script hits it from 127.0.0.1, the
// limiter skips the request and the header check fails; run it from another address or unset it.

const API = process.env.API ?? "http://127.0.0.1:8099";
const TOKEN = process.env.HOOD_ADMIN_TOKEN ?? process.env.SUPPORT_ADMIN_TOKEN;

let failed = 0;
const ok = (msg) => console.log("ok  ", msg);
const check = (cond, msg) => { if (cond) ok(msg); else { failed++; console.error("FAIL:", msg); } };
const must = (cond, msg) => { if (!cond) { console.error("FAIL:", msg); process.exit(1); } ok(msg); };

const auth = { authorization: `Bearer ${TOKEN}` };
const j = async (path, init = {}) => {
  const r = await fetch(API + path, init);
  return { status: r.status, headers: r.headers, body: await r.json().catch(() => null) };
};
const post = (path, body, headers = auth) =>
  j(path, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });

if (!TOKEN) { console.error("FAIL: HOOD_ADMIN_TOKEN is not set"); process.exit(1); }

// ---- 1. the token ----
const anon = await j("/admin/me");
must(anon.status === 401, "GET /admin/me without a token is 401");
const wrong = await j("/admin/me", { headers: { authorization: "Bearer definitely-not-it" } });
must(wrong.status === 401, "GET /admin/me with a wrong token is 401");
const me = await j("/admin/me", { headers: auth });
must(me.status === 200 && me.body?.ok === true, "GET /admin/me with the token is { ok: true }");

// ---- 2. the overview ----
const ov = await j("/admin/overview", { headers: auth });
must(ov.status === 200 && ov.body, "GET /admin/overview answers");
const o = ov.body;
const isNumOrNull = (v) => v === null || typeof v === "number";
check(isNumOrNull(o.indexedBlock), `overview.indexedBlock = ${o.indexedBlock}`);
check(isNumOrNull(o.head), `overview.head = ${o.head}`);
check(isNumOrNull(o.blocksBehind), `overview.blocksBehind = ${o.blocksBehind}`);
check(o.integrations && ["assistant", "art", "relay"].every((k) => typeof o.integrations[k] === "boolean"),
  `overview.integrations = ${JSON.stringify(o.integrations)}`);
const CONTRACT_KEYS = ["factory", "feeRouter", "staking", "graduator", "bridgeFactory", "portal", "directDeployer", "buybackModule"];
check(o.contracts && CONTRACT_KEYS.every((k) => k in o.contracts && (o.contracts[k] === null || typeof o.contracts[k] === "string")),
  `overview.contracts has all ${CONTRACT_KEYS.length} keys (${CONTRACT_KEYS.filter((k) => o.contracts?.[k]).length} set)`);
check(typeof o.launches === "number" && typeof o.graduated === "number", `overview.launches = ${o.launches}, graduated = ${o.graduated}`);
check(typeof o.openTickets === "number", `overview.openTickets = ${o.openTickets}`);
check(typeof o.currentSeason === "number", `overview.currentSeason = ${o.currentSeason}`);

// ---- 3. seasons ----
const before = await j("/admin/seasons", { headers: auth });
must(before.status === 200 && Array.isArray(before.body?.seasons) && typeof before.body.current === "number",
  `GET /admin/seasons lists ${before.body?.seasons?.length} season(s), current ${before.body?.current}`);
const previous = before.body.current;
const nextId = Math.max(0, ...before.body.seasons.map((s) => s.id)) + 1;
const name = `Season ${nextId}`;

const badName = await post("/admin/seasons", { name: "x" });
check(badName.status === 400, "POST /admin/seasons rejects a one-letter name");
const badStarts = await post("/admin/seasons", { name, starts: "2000-01-01T00:00:00Z" });
check(badStarts.status === 400, "POST /admin/seasons rejects a start before the current season");
const anonOpen = await post("/admin/seasons", { name }, {});
check(anonOpen.status === 401, "POST /admin/seasons without a token is 401");

const opened = await post("/admin/seasons", { name });
must(opened.status === 200 && opened.body?.season?.id === nextId && opened.body.season.name === name,
  `POST /admin/seasons opened "${name}" as id ${opened.body?.season?.id}`);

const after = await j("/admin/seasons", { headers: auth });
must(after.status === 200, "GET /admin/seasons after opening");
check(after.body.current === nextId, `season ${nextId} is now current`);
const prevRow = after.body.seasons.find((s) => s.id === previous);
check(prevRow && prevRow.ends !== null && new Date(prevRow.ends) <= new Date(opened.body.season.starts),
  `season ${previous} was closed at the new season's start (${prevRow?.ends})`);
check(after.body.seasons.every((s) => typeof s.snapshot === "boolean"), "every season row carries a snapshot flag");

const snap = await post(`/admin/seasons/${previous}/snapshot`);
must(snap.status === 200 && typeof snap.body?.rows === "number", `POST /admin/seasons/${previous}/snapshot froze ${snap.body?.rows} row(s)`);
const missing = await post("/admin/seasons/999999/snapshot");
check(missing.status === 404, "snapshot of an unknown season is 404");

const frozen = await j(`/leaderboard?season=${previous}`);
must(frozen.status === 200, `GET /leaderboard?season=${previous} answers`);
if (snap.body.rows > 0) {
  check(frozen.body.frozen === true && typeof frozen.body.takenAt === "string", `leaderboard for season ${previous} is frozen (taken ${frozen.body.takenAt})`);
  check(frozen.body.rows.length === Math.min(snap.body.rows, 100), `frozen board returns ${frozen.body.rows.length} row(s)`);
  const r = frozen.body.rows[0];
  check(r && ["position", "address", "points", "volumeUsd", "launches", "rank"].every((k) => k in r), "frozen rows have the live row shape");
  check(r && r.position === 1 && frozen.body.rows.every((x, i) => x.position === i + 1), "frozen rows are numbered from 1");
} else {
  console.log("skip  season", previous, "has no points, so its snapshot is empty and cannot freeze the board (frozen =", frozen.body.frozen + ")");
  check(frozen.body.frozen === false && Array.isArray(frozen.body.rows) && frozen.body.rows.length === 0, "empty season falls back to the live (empty) board");
}
check(frozen.body.rules && frozen.body.rules.POINTS && frozen.body.rules.RANKS, "frozen response still carries the rules");

const live = await j("/leaderboard");
must(live.status === 200 && live.body.frozen === false && live.body.season === nextId, `GET /leaderboard is live (frozen: false) on season ${live.body?.season}`);

const listed = await j("/admin/seasons", { headers: auth });
check(listed.body.seasons.find((s) => s.id === previous)?.snapshot === (snap.body.rows > 0), `season list shows snapshot=${snap.body.rows > 0} for season ${previous}`);

const closed = await post(`/admin/seasons/${nextId}/close`, { ends: "2000-01-01T00:00:00Z" });
check(closed.status === 400, "closing a season before it started is 400");

// ---- 4. health ----
const health = await j("/health");
must(health.status === 200 && health.body?.ok === true, "GET /health is ok");
check(health.body.integrations && ["assistant", "art", "relay"].every((k) => typeof health.body.integrations[k] === "boolean"),
  `health.integrations = ${JSON.stringify(health.body.integrations)}`);
check(!health.headers.get("x-ratelimit-limit"), "health is outside the rate limit");

// ---- 5. rate limit headers ----
const tokens = await j("/tokens?limit=1");
must(tokens.status === 200, "GET /tokens answers");
const limit = tokens.headers.get("x-ratelimit-limit");
const remaining = tokens.headers.get("x-ratelimit-remaining");
const reset = tokens.headers.get("x-ratelimit-reset");
check(limit && remaining && reset, `tokens carries X-RateLimit-Limit=${limit} Remaining=${remaining} Reset=${reset}` +
  (limit ? "" : " (none: is RATE_LIMIT_TRUST_LOCAL=1 allow-listing this client?)"));
const adminLimit = (await j("/admin/me", { headers: auth })).headers.get("x-ratelimit-limit");
check(adminLimit === "60", `admin routes are limited to ${adminLimit}/min`);

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
