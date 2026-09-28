// Block zero, end to end, on a local chain: deploy, a team launch through HoodBlockZero with five
// wallets (two of them locked), an outside buy after it, and the indexer and the API checked
// against the chain.
//
//   npm run build -w @hood/sdk && npm run build -w @hood/api
//   node scripts/e2e/block-zero.mjs            # E2E_KEEP=1 leaves anvil and the api up
//
// Plain anvil with chain id 4663, not a fork: DeployLocal runs the curve machine on a mock
// graduator, which is all block zero touches. Postgres: E2E_PG, default the local superuser.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createPublicClient, createWalletClient, http, parseEther, zeroAddress, erc20Abi, parseEventLogs } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { createHoodClient, hoodBlockZeroAbi, hoodCurveAbi, hoodFactoryAbi, hoodTokenLockAbi, robinhood } from "../../packages/sdk/dist/index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ANVIL_PORT = Number(process.env.E2E_ANVIL_PORT ?? 8566);
const API_PORT = Number(process.env.E2E_API_PORT ?? 8198);
const RPC = `http://127.0.0.1:${ANVIL_PORT}`;
const API = `http://127.0.0.1:${API_PORT}`;
const PG_ADMIN = process.env.E2E_PG ?? "postgres://127.0.0.1:5432/postgres";
const DB_NAME = process.env.E2E_DB ?? "hood_block_zero";
const DB_URL = PG_ADMIN.replace(/\/[^/]*$/, `/${DB_NAME}`);
const DEPLOYER = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const runDir = process.env.E2E_RUN_DIR ?? mkdtempSync(join(tmpdir(), "block-zero-"));

const children = [];
let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function cleanup() {
  if (process.env.E2E_KEEP === "1") return;
  for (const c of children) { try { c.kill("SIGKILL"); } catch {} }
}
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { cleanup(); process.exit(130); });

function background(name, cmd, args, env = {}) {
  const out = openSync(join(runDir, `${name}.log`), "a");
  const child = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", out, out] });
  children.push(child);
  return child;
}
function sh(name, cmd, args, env = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    console.error(`\n${name} failed\n${(r.stdout ?? "").slice(-3000)}\n${(r.stderr ?? "").slice(-3000)}`);
    process.exit(1);
  }
  return r.stdout ?? "";
}
async function api(path) {
  const res = await fetch(`${API}${path}`);
  return { status: res.status, body: res.status === 200 ? await res.json() : null };
}

// ---------------------------------------------------------------- chain

background("anvil", "anvil", ["--port", String(ANVIL_PORT), "--chain-id", "4663", "--silent"]);
const chain = { ...robinhood, rpcUrls: { default: { http: [RPC] } } };
const publicClient = createPublicClient({ chain, transport: http(RPC), cacheTime: 0 });
for (let i = 0; i < 50; i++) {
  try { await publicClient.getBlockNumber(); break; } catch { await sleep(200); }
}
// The indexer asks several questions at once through Multicall3, which a plain anvil does not have.
// The runtime code is the one 4663 runs, kept in the fixtures.
const multicall = readFileSync(join(ROOT, "test/fixtures/multicall3.hex"), "utf8").trim();
await publicClient.request({
  method: "anvil_setCode",
  params: ["0xcA11bde05977b3631167028862bE2a173976CA11", multicall.startsWith("0x") ? multicall : `0x${multicall}`],
});

const out = sh("DeployLocal", "forge", ["script", "script/DeployLocal.s.sol", "--rpc-url", RPC, "--broadcast", "--private-key", DEPLOYER],
  { PRIVATE_KEY: DEPLOYER });
const env = Object.fromEntries([...out.matchAll(/(HOOD_[A-Z_]+)=(0x[0-9a-fA-F]{40}|\d+)/g)].map((m) => [m[1], m[2]]));
check("the local stack deployed", Boolean(env.HOOD_FACTORY), env.HOOD_FACTORY);

const blockZero = env.HOOD_BLOCK_ZERO;
check("block zero deployed with the stack", Boolean(blockZero), blockZero);

const factory = env.HOOD_FACTORY;
const locker = await publicClient.readContract({ address: factory, abi: hoodFactoryAbi, functionName: "firstBuyLocker" });
const launchFee = await publicClient.readContract({ address: factory, abi: hoodFactoryAbi, functionName: "launchFee" });
const configCount = await publicClient.readContract({ address: factory, abi: hoodFactoryAbi, functionName: "configCount" });
let configId = -1;
for (let i = 0n; i < configCount; i++) {
  const c = await publicClient.readContract({ address: factory, abi: hoodFactoryAbi, functionName: "getConfig", args: [i] });
  if (c.enabled && c.pairToken === zeroAddress) { configId = Number(i); break; }
}
check("an ETH preset exists", configId >= 0, `#${configId}`);

// ---------------------------------------------------------------- api

const admin = new pg.Client({ connectionString: PG_ADMIN });
await admin.connect();
await admin.query(`drop database if exists ${DB_NAME} with (force)`);
await admin.query(`create database ${DB_NAME}`);
await admin.end();

background("api", process.execPath, [join(ROOT, "apps/api/dist/index.js")], {
  DATABASE_URL: DB_URL, HOOD_RPC: RPC,
  HOOD_FACTORY: factory, HOOD_FEE_ROUTER: env.HOOD_FEE_ROUTER, HOOD_STAKING: env.HOOD_STAKING,
  HOOD_GRADUATOR: env.HOOD_GRADUATOR, HOOD_BRIDGE_FACTORY: env.HOOD_BRIDGE_FACTORY, HOOD_REFERRALS: env.HOOD_REFERRALS,
  HOOD_BAG: env.HOOD_BAG, HOOD_PAYDAY: env.HOOD_PAYDAY, HOOD_BURN_CLOCK: env.HOOD_BURN_CLOCK, HOOD_BOOSTS: env.HOOD_BOOSTS,
  HOOD_GRADUATION_HOOK: env.HOOD_GRADUATION_HOOK, HOOD_BLOCK_ZERO: blockZero,
  HOOD_START_BLOCK: env.HOOD_START_BLOCK ?? "0", HOOD_ETH_USD: "3000",
  HOOD_POLL_MS: "300", HOOD_LOG_CHUNK: "5000", HOOD_CONFIRMATIONS: "0",
  PORT: String(API_PORT), INDEXER: "1", API: "1", LOG_LEVEL: "warn", NODE_ENV: "development",
  TRUST_PROXY: "false", RATE_LIMIT_TRUST_LOCAL: "1", ANTHROPIC_API_KEY: "", OPENROUTER_API_KEY: "", RELAY_API_KEY: "",
  // No chat: the alert is logged, which is what the check below reads. A short batch keeps it quick.
  TEAM_ALERT_TELEGRAM_TOKEN: "", TEAM_ALERT_TELEGRAM_CHAT: "", TEAM_ALERT_BATCH_SECONDS: "1",
});
let up = false;
for (let i = 0; i < 120 && !up; i++) {
  up = (await api("/health").catch(() => ({ status: 0 }))).status === 200;
  if (!up) await sleep(500);
}
check("the api answers /health", up, API);

// ---------------------------------------------------------------- the team launch

const lead = privateKeyToAccount(DEPLOYER);
const leadClient = createWalletClient({ account: lead, chain, transport: http(RPC) });
// Fresh wallets, as a real team launch would use.
const team = Array.from({ length: 5 }, () => privateKeyToAccount(generatePrivateKey()).address);
const locks = [0n, 30n * 86400n, 0n, 90n * 86400n, 0n];
const amounts = ["0.4", "0.3", "0.25", "0.2", "0.15"].map((a) => parseEther(a));
const GAS = parseEther("0.001");
const legs = team.map((wallet, i) => ({ wallet, pairIn: amounts[i], minTokensOut: 0n, lock: locks[i], gas: GAS }));
const total = amounts.reduce((s, a) => s + a, 0n) + GAS * BigInt(team.length);
const econ = await publicClient.readContract({
  address: factory, abi: hoodFactoryAbi, functionName: "previewLaunchEconomics", args: [BigInt(configId), zeroAddress],
});
const params = {
  name: "Block Zero", symbol: "BZERO", image: "", description: "a team launch", website: "", twitter: "", telegram: "",
  pairToken: zeroAddress, configId: BigInt(configId),
  feeSplit: { stakersBps: 0, buybackBps: 3000, liquidityBps: 2000, creatorBps: 5000 },
  creatorFeeRecipient: zeroAddress, firstBuy: 0n, firstBuyLock: 0n,
  salt: `0x${"ab".repeat(32)}`, econ,
  // The opening tax is not a setting (SnipeSchedule): the launcher and the fee recipient never pay
  // it, and a launch may name more wallets. This one names none.
  exempt: [],
};

const hash = await leadClient.writeContract({
  address: blockZero, abi: hoodBlockZeroAbi, functionName: "launch", args: [params, legs], value: launchFee + total,
});
const receipt = await publicClient.waitForTransactionReceipt({ hash });
check("the team launch mined", receipt.status === "success", `${receipt.gasUsed} gas`);
const [launched] = parseEventLogs({ abi: hoodBlockZeroAbi, logs: receipt.logs, eventName: "TeamLaunched" });
const token = launched.args.token;
const curve = launched.args.market;
const legLogs = parseEventLogs({ abi: hoodBlockZeroAbi, logs: receipt.logs, eventName: "TeamLeg" });
check("one TeamLeg per wallet", legLogs.length === 5);

// All in one block, nothing between: the curve sold exactly what the team got.
const sold = await publicClient.readContract({ address: curve, abi: hoodCurveAbi, functionName: "sold" });
check("the curve sold exactly the team's tokens", sold === launched.args.tokens, `${sold}`);

const balances = await Promise.all(team.map((w) => publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [w] })));
check("unlocked wallets hold their tokens", balances[0] > 0n && balances[2] > 0n && balances[4] > 0n);
check("every team wallet got its gas", (await Promise.all(team.map((w) => publicClient.getBalance({ address: w })))).every((b) => b === GAS));
check("the team's legs paid no opening tax", parseEventLogs({ abi: hoodCurveAbi, logs: receipt.logs, eventName: "Sniped" }).length === 0);
check("the launcher is exempt from the opening tax", await publicClient.readContract({ address: curve, abi: hoodCurveAbi, functionName: "snipeExempt", args: [lead.address] }));
check("locked wallets hold nothing in hand", balances[1] === 0n && balances[3] === 0n);
const lock1 = await publicClient.readContract({ address: locker, abi: hoodTokenLockAbi, functionName: "locks", args: [legLogs[1].args.lockId] });
check("the 30 day lock belongs to its wallet", lock1[1].toLowerCase() === team[1].toLowerCase() && lock1[2] === legLogs[1].args.tokens);
const recipient = await publicClient.readContract({ address: factory, abi: hoodFactoryAbi, functionName: "creatorFeeRecipient", args: [token] });
check("the fee stream is the launcher's", recipient.toLowerCase() === lead.address.toLowerCase());

// An outsider's buy, one second after the launch block, pays the second second's 6.18% and more
// per token than the first team wallet did. Anvil's clock is pinned for it: the block timestamp is
// whole seconds and the schedule is a table keyed on them.
const launchBlock = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
await publicClient.request({ method: "evm_setNextBlockTimestamp", params: [`0x${(launchBlock.timestamp + 1n).toString(16)}`] });
const outsider = privateKeyToAccount(generatePrivateKey());
await publicClient.request({ method: "anvil_setBalance", params: [outsider.address, "0x56BC75E2D63100000"] });
const outsiderClient = createWalletClient({ account: outsider, chain, transport: http(RPC) });
const buyHash = await outsiderClient.writeContract({
  address: curve, abi: hoodCurveAbi, functionName: "buy", args: [parseEther("0.4"), 0n, outsider.address], value: parseEther("0.4"),
});
const buyReceipt = await publicClient.waitForTransactionReceipt({ hash: buyHash });
const sniped = parseEventLogs({ abi: hoodCurveAbi, logs: buyReceipt.logs, eventName: "Sniped" });
const expectedTax = (parseEther("0.4") * 618n + 9_999n) / 10_000n;
check("the outsider paid the opening tax, 6.18% one second in", sniped.length === 1 && sniped[0].args.tax > 0n && sniped[0].args.tax <= expectedTax, sniped[0] ? `${sniped[0].args.tax} <= ${expectedTax}` : "none");
const outsiderGot = await publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [outsider.address] });
check("the first outside buy gets less than the first team wallet for the same money", outsiderGot < balances[0], `${outsiderGot} < ${balances[0]}`);

// A second wave that stands down: the line is below what the outsider bought.
const extra = privateKeyToAccount(generatePrivateKey()).address;
const waveLegs = [{ wallet: extra, pairIn: parseEther("0.05"), minTokensOut: 0n, lock: 0n, gas: 0n }];
let stoodDown = false;
try {
  await publicClient.simulateContract({
    account: lead, address: blockZero, abi: hoodBlockZeroAbi, functionName: "followUp", args: [token, waveLegs, outsiderGot - 1n], value: parseEther("0.05"),
  });
} catch (e) { stoodDown = String(e).includes("OutsidersAhead"); }
check("a second wave stands down past its line", stoodDown);
const waveHash = await leadClient.writeContract({
  address: blockZero, abi: hoodBlockZeroAbi, functionName: "followUp", args: [token, waveLegs, outsiderGot], value: parseEther("0.05"),
});
check("a second wave under its line goes through", (await publicClient.waitForTransactionReceipt({ hash: waveHash })).status === "success");

// The SDK's own launch (the MCP and agents use it) against the v4 factory: named wallets ride along.
const sdk = createHoodClient({
  publicClient, walletClient: leadClient,
  addresses: { factory, feeRouter: env.HOOD_FEE_ROUTER, staking: env.HOOD_STAKING, graduator: env.HOOD_GRADUATOR, bridgeFactory: env.HOOD_BRIDGE_FACTORY },
});
const named = privateKeyToAccount(generatePrivateKey()).address;
const { hash: sdkHash } = await sdk.launch({
  name: "SDK Launch", symbol: "SDKL", configId, firstBuy: parseEther("0.01"), exempt: [named],
});
const sdkReceipt = await publicClient.waitForTransactionReceipt({ hash: sdkHash });
check("the SDK launches on the v4 factory with named wallets", sdkReceipt.status === "success");
const [sdkLaunched] = parseEventLogs({ abi: hoodFactoryAbi, logs: sdkReceipt.logs, eventName: "Launched" });
check("the named wallet pays no opening tax", await publicClient.readContract({ address: sdkLaunched.args.curve, abi: hoodCurveAbi, functionName: "snipeExempt", args: [named] }));

// ---------------------------------------------------------------- the indexer and the api

const head = await publicClient.getBlockNumber();
for (let i = 0; i < 120; i++) {
  const h = await api("/health");
  if (h.body?.indexedBlock != null && BigInt(h.body.indexedBlock) >= head) break;
  await sleep(300);
}
const detail = await api(`/tokens/${token}`);
check("the token is indexed", detail.status === 200);
check("the row names the launcher as creator", detail.body?.creator === lead.address.toLowerCase(), detail.body?.creator);
check("the row counts six team legs, the second wave included", detail.body?.team_legs === 6, String(detail.body?.team_legs));
check("the row carries the opening tax schedule", JSON.stringify(detail.body?.opening_tax_bps) === JSON.stringify([9900, 618, 19]), JSON.stringify(detail.body?.opening_tax_bps));
check("the fee recipient is the launcher", detail.body?.fee_recipient === lead.address.toLowerCase(), detail.body?.fee_recipient);

const teamApi = await api(`/tokens/${token}/team`);
const rows = teamApi.body?.team ?? [];
check("the team route lists six wallets in order", rows.length === 6 && team.every((w, i) => rows[i].wallet === w.toLowerCase()));
check("the team route carries each wallet's gas", rows.slice(0, 5).every((r) => r.gas === GAS.toString()));
check("the locked rows carry their unlock", Boolean(rows[1]?.unlock_at) && Boolean(rows[3]?.unlock_at) && !rows[0]?.unlock_at);
check("unlocked rows show their balance", rows[0]?.balance === balances[0].toString());

const holders = await api(`/tokens/${token}/holders`);
const flagged = (holders.body?.holders ?? []).filter((h) => h.team).map((h) => h.address);
check("the holders list flags the three unlocked team wallets and the second wave's", flagged.length === 4 && [0, 2, 4].every((i) => flagged.includes(team[i].toLowerCase())) && flagged.includes(extra.toLowerCase()), flagged.join(","));
check("the outsider is not flagged", (holders.body?.holders ?? []).some((h) => h.address === outsider.address.toLowerCase() && !h.team));

const trades = await api(`/tokens/${token}/trades`);
const tradeRows = trades.body?.trades ?? trades.body ?? [];
const lockedTrade = Array.isArray(tradeRows) && tradeRows.find((t) => t.recipient === team[1].toLowerCase());
check("a locked leg's trade is handed to its wallet", Boolean(lockedTrade), lockedTrade?.trader);

const penaltiesRes = await api(`/tokens/${token}/penalties`);
const penaltyRows = penaltiesRes.body?.rows ?? [];
check("the snipe is on the snipers' wall", Array.isArray(penaltyRows) && penaltyRows.some((p) => p.kind === "snipe" && p.payer === outsider.address.toLowerCase()), `${penaltiesRes.status}`);

await new Promise((r) => setTimeout(r, 1500 + Number(process.env.TEAM_ALERT_BATCH_SECONDS ?? 1) * 1000));
const apiLog = readFileSync(join(runDir, "api.log"), "utf8");
check("the team heard about the outside buy", apiLog.includes("team alert") && apiLog.includes("$BZERO: 1 outside buy"), apiLog.includes("team alert") ? "logged" : "silent");

console.log(`\n${failures === 0 ? "all green" : `${failures} failed`}. logs in ${runDir}`);
if (process.env.E2E_KEEP === "1") {
  console.log(`kept: anvil ${RPC}, api ${API}, token ${token}, blockZero ${blockZero}`);
  console.log(JSON.stringify({ ...env, HOOD_BLOCK_ZERO: blockZero, TOKEN: token }));
}
process.exit(failures === 0 ? 0 : 1);
