// Token chat and the live feed against a running API: the login handshake, who may post, what a
// message may say, how often, who may hide one, and whether a post reaches /stream.
//
//   API=http://127.0.0.1:8199 node scripts/e2e/chat.mjs
//
// It needs one launch in the database whose creator is one of the anvil accounts below, with a
// holder or a past trader among them, which is what scripts/e2e/run.mjs leaves behind. Nothing
// here touches the chain: the only signature is the login message, signed locally.
//
// It posts two or three messages as one wallet and hides one of them, so run it against a test
// stack. The per-wallet limit is thirty an hour, which is about ten runs.
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const API = process.env.API ?? "http://127.0.0.1:8199";

const KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
];
const ACCOUNTS = new Map(KEYS.map((k) => { const a = privateKeyToAccount(k); return [a.address.toLowerCase(), a]; }));

let failed = 0;
const ok = (msg) => console.log("ok  ", msg);
const check = (cond, msg) => { if (cond) ok(msg); else { failed++; console.error("FAIL:", msg); } };
const must = (cond, msg) => { if (!cond) { console.error("FAIL:", msg); process.exit(1); } ok(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const j = async (path, init = {}) => {
  const r = await fetch(API + path, init);
  return { status: r.status, headers: r.headers, body: await r.json().catch(() => null) };
};
const post = (path, body, headers = {}) =>
  j(path, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
const bearer = (session) => ({ authorization: `Bearer ${session}` });

// ---- 0. find a launch with a creator and a holder we hold the keys to ----
const listed = await j("/tokens?limit=100");
must(listed.status === 200 && Array.isArray(listed.body?.tokens), `GET /tokens answers with ${listed.body?.tokens?.length} launch(es)`);

let room = null;
for (const t of listed.body.tokens) {
  const creator = ACCOUNTS.get(String(t.creator).toLowerCase());
  if (!creator) continue;
  const [holders, trades] = await Promise.all([j(`/tokens/${t.token}/holders`), j(`/tokens/${t.token}/trades?limit=100`)]);
  const candidates = [
    ...(holders.body?.holders ?? []).map((h) => h.address),
    ...(trades.body?.trades ?? []).flatMap((x) => [x.trader, x.recipient]),
  ];
  const poster = candidates.map((a) => ACCOUNTS.get(String(a).toLowerCase())).find((a) => a && a.address !== creator.address);
  if (poster) { room = { token: t.token, symbol: t.symbol, creator, poster }; break; }
}
must(room, room
  ? `chatting in ${room.symbol} (${room.token}), creator ${room.creator.address}, poster ${room.poster.address}`
  : "no launch in the database has both its creator and a holder among the anvil accounts: run scripts/e2e/run.mjs first");

// ---- 1. the login handshake ----
const nonceFor = async (account) => {
  const r = await post("/chat/nonce", { address: account.address });
  must(r.status === 200 && r.body?.nonce && r.body?.message && r.body?.expiresAt, `POST /chat/nonce issues a nonce for ${account.address.slice(0, 10)}`);
  return r.body;
};
const login = async (account) => {
  const { nonce, message } = await nonceFor(account);
  const signature = await account.signMessage({ message });
  const r = await post("/chat/session", { address: account.address, signature, nonce });
  must(r.status === 200 && r.body?.token, `POST /chat/session signs ${account.address.slice(0, 10)} in until ${r.body?.expiresAt}`);
  return { session: r.body.token, nonce, signature };
};

const first = await nonceFor(room.poster);
check(first.message.includes(room.poster.address.toLowerCase()) && first.message.includes(first.nonce) && first.message.includes(first.expiresAt.slice(0, 10)),
  "the message to sign names the wallet, the nonce and the expiry");
check(new Date(first.expiresAt) - Date.now() <= 5 * 60 * 1000 + 2000, `the nonce expires in ${Math.round((new Date(first.expiresAt) - Date.now()) / 1000)}s`);

// a signature from the wrong wallet, over the right message
const wrongSig = await room.creator.signMessage({ message: first.message });
const wrong = await post("/chat/session", { address: room.poster.address, signature: wrongSig, nonce: first.nonce });
check(wrong.status === 401 && wrong.body?.error === "bad_signature", `a signature from another wallet is refused (${wrong.status} ${wrong.body?.error})`);

const rightSig = await room.poster.signMessage({ message: first.message });
const session = await post("/chat/session", { address: room.poster.address, signature: rightSig, nonce: first.nonce });
must(session.status === 200 && session.body?.token, "the right signature opens a session");
const poster = session.body.token;

const replay = await post("/chat/session", { address: room.poster.address, signature: rightSig, nonce: first.nonce });
check(replay.status === 400 && replay.body?.error === "unknown_nonce", `the same nonce a second time is refused (${replay.status} ${replay.body?.error})`);

// ---- 2. who may post ----
const outsider = privateKeyToAccount(generatePrivateKey());
const { session: outsiderSession } = await login(outsider);
const refused = await post(`/chat/${room.token}`, { body: "gm from nowhere" }, bearer(outsiderSession));
check(refused.status === 403 && refused.body?.error === "no_position" && typeof refused.body?.reason === "string",
  `a wallet that neither holds nor traded is refused: ${refused.status} ${refused.body?.error} "${refused.body?.reason}"`);

const anon = await post(`/chat/${room.token}`, { body: "gm" });
check(anon.status === 401 && anon.body?.error === "no_session", `posting without a session is ${anon.status} ${anon.body?.error}`);

const unknown = await post(`/chat/0x000000000000000000000000000000000000dead`, { body: "gm" }, bearer(poster));
check(unknown.status === 404 && unknown.body?.error === "unknown_token", `posting to a token that never launched is ${unknown.status} ${unknown.body?.error}`);

const stamp = Date.now();
const mine = await post(`/chat/${room.token}`, { body: `holder speaking ${stamp}` }, bearer(poster));
must(mine.status === 200 && Number.isInteger(mine.body?.id), `a holder posts (#${mine.body?.id})`);
const m = mine.body;
check(m.token === room.token.toLowerCase() && m.author === room.poster.address.toLowerCase() && m.hidden === false,
  "the message comes back keyed to its token and author, not hidden");
check(typeof m.rank === "string" && Number.isInteger(m.holdingBps) && typeof m.isCreator === "boolean" && typeof m.at === "string",
  `it carries rank ${m.rank}, holdingBps ${m.holdingBps}, isCreator ${m.isCreator}`);

// ---- 3. what a message may say ----
const tooFast = await post(`/chat/${room.token}`, { body: "twice in a second" }, bearer(poster));
check(tooFast.status === 429 && tooFast.body?.error === "too_fast" && tooFast.headers.get("retry-after"),
  `a second message inside five seconds is ${tooFast.status} ${tooFast.body?.error}, retry-after ${tooFast.headers.get("retry-after")}s`);

// Bad bodies are refused before the limiter is asked, so a typo never spends the allowance.
const empty = await post(`/chat/${room.token}`, { body: "   " }, bearer(poster));
check(empty.status === 400 && empty.body?.error === "body_empty", `an empty message is ${empty.status} ${empty.body?.error}`);
const long = await post(`/chat/${room.token}`, { body: "x".repeat(281) }, bearer(poster));
check(long.status === 400 && long.body?.error === "body_too_long", `281 characters is ${long.status} ${long.body?.error}`);
const control = await post(`/chat/${room.token}`, { body: "line one\nline two" }, bearer(poster));
check(control.status === 400 && control.body?.error === "body_control_characters", `a control character is ${control.status} ${control.body?.error}`);

// ---- 4. hiding ----
const strangerHide = await post(`/chat/${room.token}/hide/${m.id}`, {}, bearer(outsiderSession));
check(strangerHide.status === 403 && strangerHide.body?.error === "not_the_creator",
  `a stranger cannot hide: ${strangerHide.status} ${strangerHide.body?.error}`);
const anonHide = await post(`/chat/${room.token}/hide/${m.id}`, {});
check(anonHide.status === 401 && anonHide.body?.error === "no_session", `hiding without a session is ${anonHide.status} ${anonHide.body?.error}`);

const { session: creator } = await login(room.creator);
const hidden = await post(`/chat/${room.token}/hide/${m.id}`, {}, bearer(creator));
check(hidden.status === 200 && hidden.body?.ok === true, `the creator hides message #${m.id}`);

const asAnyone = await j(`/chat/${room.token}?limit=50`);
const seenByAnyone = asAnyone.body?.messages?.find((x) => x.id === m.id);
check(seenByAnyone && seenByAnyone.hidden === true && seenByAnyone.body === null,
  `a hidden message reads as { hidden: true, body: null } to everyone else`);
const asAuthor = await j(`/chat/${room.token}?limit=50`, { headers: bearer(poster) });
const seenByAuthor = asAuthor.body?.messages?.find((x) => x.id === m.id);
check(seenByAuthor && seenByAuthor.hidden === true && seenByAuthor.body === `holder speaking ${stamp}`,
  "its author still reads their own words");
check(asAnyone.headers.get("cache-control")?.includes("no-store"), `the room is never held by a shared cache (cache-control: ${asAnyone.headers.get("cache-control")})`);

const back = await post(`/chat/${room.token}/hide/${m.id}`, { hidden: false }, bearer(creator));
check(back.status === 200 && back.body?.ok === true, "the creator can put it back");
const restored = await j(`/chat/${room.token}?limit=50`);
check(restored.body?.messages?.find((x) => x.id === m.id)?.body === `holder speaking ${stamp}`, "and it reads in full again");

// ---- 5. the live feed ----
const stream = await openStream(`/stream?tokens=${room.token}`);
must(stream.res.status === 200, `GET /stream answers ${stream.res.status}`);
check(stream.res.headers.get("content-type")?.startsWith("text/event-stream"), `it is ${stream.res.headers.get("content-type")}`);
check(stream.res.headers.get("x-accel-buffering") === "no", "it tells proxies not to buffer it");
check(!stream.res.headers.get("x-ratelimit-limit"), "it is outside the global rate limit");

// The wallet limit is one message every five seconds, and one has just gone out.
await sleep(5_200);
const said = `live ${Date.now()}`;
const sent = Date.now();
const streamed = await post(`/chat/${room.token}`, { body: said }, bearer(poster));
must(streamed.status === 200, `a second message posted (#${streamed.body?.id})`);
const arrived = await stream.waitFor((e) => e.event === "message" && e.data?.id === streamed.body.id, 1000, sent);
check(arrived, arrived
  ? `it reached /stream in ${arrived.after}ms with body "${arrived.event.data.body}"`
  : "it did not reach /stream within a second");
check(arrived?.event?.data?.token === room.token.toLowerCase() && arrived?.event?.data?.rank === streamed.body.rank,
  "the streamed message is the same object the route returned");

const elsewhere = await openStream(`/stream?tokens=0x000000000000000000000000000000000000dead`);
await sleep(5_200);
const other = await post(`/chat/${room.token}`, { body: `filtered ${Date.now()}` }, bearer(poster));
must(other.status === 200, `a third message posted (#${other.body?.id})`);
check(!(await elsewhere.waitFor((e) => e.event === "message", 700)), "a stream filtered to another token does not receive it");
stream.close();
elsewhere.close();

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");

/// One SSE connection, parsed into frames. Kept at the bottom because it is plumbing, not a check.
async function openStream(path) {
  const controller = new AbortController();
  const res = await fetch(API + path, { headers: { accept: "text/event-stream" }, signal: controller.signal });
  const events = [];
  (async () => {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        let cut;
        while ((cut = buffered.indexOf("\n\n")) >= 0) {
          const frame = buffered.slice(0, cut);
          buffered = buffered.slice(cut + 2);
          const parsed = {};
          for (const line of frame.split("\n")) {
            if (line.startsWith("event:")) parsed.event = line.slice(6).trim();
            else if (line.startsWith("data:")) parsed.data = JSON.parse(line.slice(5).trim());
          }
          if (parsed.event) events.push({ ...parsed, at: Date.now() });
        }
      }
    } catch {
      // the abort at the end of the run, or the API going away: either way there is nothing to read
    }
  })();
  return {
    res,
    close: () => controller.abort(),
    async waitFor(predicate, ms, since = Date.now()) {
      const until = Date.now() + ms;
      for (;;) {
        const found = events.find(predicate);
        if (found) return { event: found, after: found.at - since };
        if (Date.now() > until) return null;
        await sleep(25);
      }
    },
  };
}
