// The support desk against the fork stack: the HTTP surface without a model key, the five tools
// against real launches in the indexer, and, when ANTHROPIC_API_KEY is set, one live conversation
// that has to read a reverted transaction and explain it.
//
//   API=http://127.0.0.1:8099 DATABASE_URL=... HOOD_RPC=http://127.0.0.1:8545 node scripts/e2e/support.mjs
import { createWalletClient, createPublicClient, http, parseEther, encodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const API = process.env.API ?? "http://127.0.0.1:8099";
const RPC = process.env.HOOD_RPC ?? "http://127.0.0.1:8545";
const chain = { id: 4663, name: "robinhood", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC) });
// anvil's second account
const bob = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const wallet = createWalletClient({ account: bob, chain, transport: http(RPC) });

const assert = (cond, msg) => { if (!cond) { console.error("FAIL:", msg); process.exit(1); } console.log("ok  ", msg); };
const j = async (path, init) => { const r = await fetch(API + path, init); return { status: r.status, body: await r.json().catch(() => null) }; };

// ---- 1. the HTTP surface, model off or on ----
const status = await j("/support/status");
assert(status.status === 200 && typeof status.body.enabled === "boolean", `status endpoint answers (enabled=${status.body.enabled})`);

const bad = await j("/support/ticket", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ contact: "x" }) });
assert(bad.status === 400, "ticket without fields is rejected");

const t = await j("/support/ticket", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ contact: "@someone", subject: "buy failed", summary: "my buy reverted twice on a direct token right after launch", address: bob.address, page: "/token/0x0", transcript: [{ role: "user", content: "hi" }] }),
});
assert(t.status === 200 && Number.isInteger(t.body.id), `ticket opened #${t.body.id}`);

const noauth = await j("/support/tickets");
assert(noauth.status === 401, "ticket queue needs the admin token");
if (process.env.SUPPORT_ADMIN_TOKEN) {
  const list = await j("/support/tickets?status=open", { headers: { authorization: `Bearer ${process.env.SUPPORT_ADMIN_TOKEN}` } });
  assert(list.status === 200 && list.body.tickets.some((x) => x.id === t.body.id), "admin sees the ticket");
  const upd = await j(`/support/tickets/${t.body.id}`, { method: "PATCH", headers: { authorization: `Bearer ${process.env.SUPPORT_ADMIN_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ status: "answered", note: "replied" }) });
  assert(upd.status === 200 && upd.body.status === "answered", "admin updates the ticket");
  const wrong = await j("/support/tickets", { headers: { authorization: "Bearer nope" } });
  assert(wrong.status === 401, "wrong admin token is rejected");
}

const chatBad = await j("/support/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "assistant", content: "x" }] }) });
assert(chatBad.status === (status.body.enabled ? 400 : 503), status.body.enabled ? "chat rejects a history that does not end with the user" : "chat says 503 when the assistant is off");

// ---- 2. the tools, straight from the module ----
const support = await import("../../apps/api/dist/support.js");
const { tokens } = await j("/tokens?limit=10").then((r) => r.body);
assert(tokens.length > 0, `indexer has ${tokens.length} launches`);
const direct = tokens.find((x) => x.mode === "direct");
const curve = tokens.find((x) => x.mode === "curve");

if (curve) {
  const info = await support.lookupToken(curve.token);
  assert(info.found === 1 && info.machine === "curve" && info.live && !info.live.error, `lookup_token curve ${curve.symbol}: phase "${info.live.phase}", ${info.progressToPool} to the pool`);
}
if (direct) {
  const info = await support.lookupToken(direct.symbol.toLowerCase());
  assert(info.found >= 1, `lookup_token by ticker finds ${direct.symbol}`);
  const byAddr = await support.lookupToken(direct.token);
  assert(byAddr.found === 1 && byAddr.machine === "direct" && byAddr.live && byAddr.live.graduation, `lookup_token direct ${direct.symbol}: ${byAddr.progressToPool}, snipe now ${byAddr.live.snipeTaxNowBps} bps`);
}
const none = await support.lookupToken("definitely-not-a-token");
assert(none.found === 0, "lookup_token says so when nothing matches");

const w = await support.lookupWallet("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
assert(w.holdings.length > 0 && w.points, `lookup_wallet: ${w.holdings.length} holdings, ${w.unclaimedDividends.length} dividend rows, rank ${w.points.rank?.name ?? w.points.rank ?? "?"}`);

const cs = await support.chainStatus();
assert(typeof cs.head === "number" && cs.indexedBlock !== null, `chain_status: head ${cs.head}, indexed ${cs.indexedBlock}, ${cs.blocksBehind} behind`);

// a transaction that must fail: a direct buy over the opening-window cap is the usual support case,
// but the fork stack is past the window, so use the simplest guaranteed revert instead: a curve buy
// with minOut nobody can fill.
let revertedHash = null;
if (curve) {
  const curveAbi = (await import("../../packages/sdk/dist/abi.generated.js")).hoodCurveAbi;
  const data = encodeFunctionData({ abi: curveAbi, functionName: "buy", args: [parseEther("0.001"), 2n ** 200n, bob.address] });
  const hash = await wallet.sendTransaction({ to: curve.curve, data, value: parseEther("0.001"), gas: 400_000n });
  const rec = await pub.waitForTransactionReceipt({ hash });
  assert(rec.status === "reverted", "a curve buy with an impossible minOut reverted on chain");
  revertedHash = hash;
  const tx = await support.lookupTx(hash);
  assert(tx.status === "reverted" && tx.revert && /Slippage|slippage|TooLittle|InsufficientOutput|[A-Z][A-Za-z]+\(/.test(tx.revert.reason), `lookup_tx decoded the revert: ${tx.revert.reason} (replayed at ${tx.revert.replayedAt})`);
}
const okTx = await j(`/tokens/${tokens[0].token}/trades?limit=1`).then((r) => r.body.trades[0]?.tx);
if (okTx) {
  const tx = await support.lookupTx(okTx);
  assert(tx.status === "success" && tx.hoodContractsTouched.length >= 0, `lookup_tx reads a good trade: to ${tx.toIsHoodContract}, touched ${tx.hoodContractsTouched.join(",") || "none by address"}`);
}
const unknown = await support.lookupTx("0x" + "11".repeat(32));
assert(unknown.found === false, "lookup_tx says so for an unknown hash");

// ---- 3. one live conversation, only with a key ----
if (!process.env.ANTHROPIC_API_KEY) {
  console.log("skip live chat: ANTHROPIC_API_KEY not set");
  process.exit(0);
}
const question = revertedHash
  ? `My buy failed, here is the tx: ${revertedHash}. What went wrong and what do I do?`
  : `How do fees work on a direct token?`;
const res = await fetch(API + "/support/chat", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ messages: [{ role: "user", content: question }], address: bob.address, page: "/token/x" }),
});
assert(res.status === 200 && res.headers.get("content-type")?.startsWith("text/event-stream"), "chat streams server-sent events");
const text = await res.text();
const events = text.split("\n\n").filter(Boolean).map((f) => JSON.parse(f.replace(/^data: /, "")));
const reply = events.filter((e) => e.type === "text").map((e) => e.delta).join("");
const tools = events.filter((e) => e.type === "tool").map((e) => e.name);
const done = events.find((e) => e.type === "done");
assert(!events.some((e) => e.type === "error"), "no error event");
assert(done && done.usage.output > 0, `done, usage in=${done?.usage.input} cached=${done?.usage.cached} out=${done?.usage.output}`);
if (revertedHash) assert(tools.includes("reading the transaction"), `the assistant read the transaction (tools: ${tools.join(", ")})`);
assert(reply.length > 40, "the assistant answered");
console.log("\n--- assistant ---\n" + reply + "\n-----------------");
