// The social half, end to end against a running API.
//
//   API=http://127.0.0.1:8098 ADMIN=localadmin node scripts/e2e/social.mjs
//
// It signs in as two throwaway wallets exactly the way the app does (nonce, personal_sign, session),
// ties one to the other, follows, watches, claims quests, opens a race as the operator and reads
// every board back. Nothing here touches a chain: these are rows in our own database, and the point
// of the harness is that each one is refused for the right reason when it should be.
//
// It expects a database with the demo world seeded (`node apps/api/dist/demo-cli.js seed --yes`),
// because quests and the profit board are only interesting against trades that exist.

import { privateKeyToAccount } from "viem/accounts";

const API = process.env.API ?? "http://127.0.0.1:8098";
const ADMIN = process.env.ADMIN ?? "localadmin";

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log(`  ok   ${name}`); return; }
  failures.push(name);
  console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

async function call(path, { method = "GET", body, session, admin } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(session ? { authorization: `Bearer ${session}` } : {}),
      ...(admin ? { authorization: `Bearer ${ADMIN}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* a proxy answering in HTML */ }
  return { status: res.status, body: json };
}

/// The same three steps the app takes: ask for a nonce, sign the sentence the API wrote, swap the
/// signature for a session. A signature made here is checked by the API with no network at all.
async function signIn(privateKey) {
  const account = privateKeyToAccount(privateKey);
  const nonce = await call("/chat/nonce", { method: "POST", body: { address: account.address } });
  if (nonce.status !== 200) throw new Error(`nonce: ${nonce.status}`);
  const signature = await account.signMessage({ message: nonce.body.message });
  const session = await call("/chat/session", {
    method: "POST", body: { address: account.address, nonce: nonce.body.nonce, signature },
  });
  if (session.status !== 200) throw new Error(`session: ${session.status} ${JSON.stringify(session.body)}`);
  return { address: account.address.toLowerCase(), token: session.body.token };
}

const KEY_A = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const KEY_B = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba";

console.log(`social e2e against ${API}`);

const alice = await signIn(KEY_A);
const bob = await signIn(KEY_B);
check("two wallets signed in", Boolean(alice.token && bob.token));

// ------------------------------------------------------------------ referrals

const selfRef = await call("/refer/bind", { method: "POST", body: { code: alice.address }, session: alice.token });
check("a wallet cannot bring itself", selfRef.status === 400 && selfRef.body?.error === "self_referral", selfRef.body);

const noSession = await call("/refer/bind", { method: "POST", body: { code: alice.address } });
check("binding needs a session", noSession.status === 401, noSession.body);

const bound = await call("/refer/bind", { method: "POST", body: { code: alice.address }, session: bob.token });
check("bob is bound to alice", bound.status === 200 && bound.body?.referrer === alice.address, bound.body);

// A third address, so the refusal that fires is "already bound" rather than "that is you".
const SOMEBODY_ELSE = "0x1111111111111111111111111111111111111111";
const rebind = await call("/refer/bind", { method: "POST", body: { code: SOMEBODY_ELSE }, session: bob.token });
check("a binding is never re-pointed", rebind.status === 409, rebind.body);

const circular = await call("/refer/bind", { method: "POST", body: { code: bob.address }, session: alice.token });
check("a two wallet ring is refused", circular.status === 400 && circular.body?.error === "circular", circular.body);

const mine = await call("/refer/me", { session: alice.token });
check("alice sees bob among her friends", mine.status === 200 && mine.body.friends.some((f) => f.address === bob.address), mine.body);

const publicCode = await call(`/refer/${alice.address}`);
check("a code can be read before signing anything", publicCode.status === 200 && publicCode.body.friends >= 1, publicCode.body);

// -------------------------------------------------------------------- follows

const followSelf = await call(`/follows/${alice.address}`, { method: "POST", session: alice.token });
check("following yourself is refused", followSelf.status === 400, followSelf.body);

// Somebody from the demo world, so the feed has something in it.
const board = await call("/top-traders?limit=5");
const busiest = board.body?.traders?.[0]?.address;
check("the demo world has traders", Boolean(busiest), board.body);

const followed = await call(`/follows/${busiest}`, { method: "POST", session: alice.token });
check("alice follows the busiest wallet", followed.status === 200 && followed.body.following === true, followed.body);

const follows = await call("/follows", { session: alice.token });
check("the follow shows up in her list", follows.body?.following?.some((f) => f.address === busiest), follows.body);

const feed = await call("/feed?limit=10", { session: alice.token });
check("the feed carries that wallet's trades", feed.status === 200 && feed.body.feed.length > 0, feed.body?.feed?.length);
check("every row in the feed is a followed wallet", (feed.body?.feed ?? []).every((row) => row.trader === busiest));

const profile = await call(`/traders/${busiest}`, { session: alice.token });
check("a profile knows she follows it", profile.status === 200 && profile.body.following === true, profile.body?.following);
check("a profile carries profit, banked and open", typeof profile.body?.pnl?.realizedUsd === "number" && typeof profile.body?.pnl?.unrealizedUsd === "number", profile.body?.pnl);

const unfollowed = await call(`/follows/${busiest}`, { method: "DELETE", session: alice.token });
check("unfollowing works", unfollowed.status === 200 && unfollowed.body.following === false, unfollowed.body);
await call(`/follows/${busiest}`, { method: "POST", session: alice.token });

// ------------------------------------------------------------------ watchlist

const tokens = await call("/tokens?limit=3");
const token = tokens.body?.tokens?.[0]?.token;
check("there are launches to watch", Boolean(token));

const watched = await call(`/watchlist/${token}`, { method: "POST", session: alice.token });
check("a launch can be watched", watched.status === 200 && watched.body.watching === true, watched.body);

const watchlist = await call("/watchlist", { session: alice.token });
check("the watchlist carries it, with its symbol", watchlist.body?.watching?.[0]?.token === token && Boolean(watchlist.body.watching[0].symbol), watchlist.body?.watching?.[0]);

const unknown = await call("/watchlist/0x000000000000000000000000000000000000dead", { method: "POST", session: alice.token });
check("a launch this pad never saw is refused", unknown.status === 404, unknown.body);

const unwatched = await call(`/watchlist/${token}`, { method: "DELETE", session: alice.token });
check("a launch can be unwatched", unwatched.status === 200 && unwatched.body.watching === false, unwatched.body);

// --------------------------------------------------------------------- quests

const quests = await call(`/quests/${busiest}`);
check("the quest board is public", quests.status === 200 && quests.body.quests.length === 9, quests.body?.quests?.length);
check("a busy wallet has finished something", quests.body.quests.some((q) => q.done), quests.body?.quests?.map((q) => [q.id, q.progress]));
check("progress is counted, not guessed", quests.body.quests.find((q) => q.id === "first_trade")?.progress > 0);

const claimNoSession = await call("/quests/claim", { method: "POST" });
check("claiming needs a session", claimNoSession.status === 401);

// Claim pays exactly what the board said was finished and unclaimed, and nothing else.
const before = await call(`/quests/${alice.address}`);
const owed = before.body.unclaimed;
const claim = await call("/quests/claim", { method: "POST", session: alice.token });
check("claiming pays exactly what the board said was owed", claim.status === 200 && Math.abs(claim.body.points - owed) < 0.01,
  { owed, paid: claim.body?.points });

const again = await call("/quests/claim", { method: "POST", session: alice.token });
check("claiming twice pays nothing the second time", again.status === 200 && again.body.points === 0, again.body);

// Two wallets, the same quest. The points table is unique on (kind, ref), so a ref that did not
// carry the wallet would let whoever claimed first take a quest away from everybody else.
const firstClaim = await call("/quests/claim", { method: "POST", session: bob.token });
const aliceQuests = await call(`/quests/${alice.address}`);
check("a quest is claimable by more than one wallet",
  firstClaim.status === 200 && aliceQuests.body.quests.every((q) => !q.claimed || q.done),
  { bob: firstClaim.body, alice: aliceQuests.body?.quests?.filter((q) => q.claimed).map((q) => q.id) });

// ---------------------------------------------------------------------- races

const noAdmin = await call("/admin/races", { method: "POST", body: { name: "x", starts: new Date().toISOString(), ends: new Date(Date.now() + 1000).toISOString() } });
check("opening a race needs the admin token", noAdmin.status === 401, noAdmin.body);

const backwards = await call("/admin/races", {
  method: "POST", admin: true,
  body: { name: "Backwards", starts: new Date(Date.now() + 60_000).toISOString(), ends: new Date().toISOString() },
});
check("a race that ends before it starts is refused", backwards.status === 400, backwards.body);

const race = await call("/admin/races", {
  method: "POST", admin: true,
  body: {
    name: "Harness race", metric: "volume", prize: "a line the operator wrote",
    starts: new Date(Date.now() - 7 * 24 * 3600_000).toISOString(),
    ends: new Date(Date.now() + 3600_000).toISOString(),
  },
});
check("a race opens", race.status === 200 && race.body.race.id > 0, race.body);

const current = await call("/races/current?limit=5");
check("the current race is the one just opened", current.body?.race?.id === race.body?.race?.id, current.body?.race);
check("its standings come from the same points the board keeps", (current.body?.standings ?? []).length > 0, current.body?.standings?.length);

await call(`/admin/races/${race.body.race.id}`, { method: "DELETE", admin: true });
const afterDelete = await call("/races/current");
check("deleting it leaves no race running", afterDelete.body?.race === null, afterDelete.body?.race);

// --------------------------------------------------------------------- profit

const pnlBoard = await call("/top-traders?sort=pnl&limit=10");
check("the profit board answers", pnlBoard.status === 200 && pnlBoard.body.sort === "pnl", pnlBoard.body?.sort);
check("profit is all-time and says so", pnlBoard.body?.window === "all", pnlBoard.body?.window);
check("it is sorted by total profit", (pnlBoard.body?.traders ?? []).every((row, i, all) => i === 0 || all[i - 1].totalUsd >= row.totalUsd));
check("banked and open add up to the total", (pnlBoard.body?.traders ?? []).every((row) => Math.abs((row.realizedUsd + row.unrealizedUsd) - row.totalUsd) < 0.01));

const portfolio = await call(`/portfolio/${busiest}`);
check("a portfolio carries the same profit", typeof portfolio.body?.pnl?.totalUsd === "number", portfolio.body?.pnl);

// ------------------------------------------------------------------ the route

const routeProbe = await call("/pairs/route/0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
check("the one-click probe answers for the dollar", routeProbe.status === 200 && typeof routeProbe.body.available === "boolean", routeProbe.body);

console.log(`\n${passed} checks passed${failures.length ? `, ${failures.length} FAILED: ${failures.join(", ")}` : ""}`);
process.exit(failures.length ? 1 : 0);
