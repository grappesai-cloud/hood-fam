// The app, inside a Safe, in a real browser.
//
//   node scripts/e2e/safe-ui.mjs [--keep]
//
// Starts a local 4663 with the real Safe code, deploys the local wiring, hands the factory to a
// 2-of-2 Safe, builds and serves the app pointed at that chain, and then drives it through
// scripts/e2e/safe-app-harness.html, which stands in for Safe{Wallet}: the app connects as the Safe,
// the "accept ownership" button proposes instead of sending, the page says a transaction is waiting
// for the other signers, and when the harness executes it the app picks the receipt up and the
// panel turns over to the Safe as owner. Screenshots land in the scratchpad.
//
// --keep leaves anvil and the server running (with the harness still in public/) to poke at by hand.

import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, encodeFunctionData, getAddress, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import puppeteer from "/Users/alexandrucojanu/dating-app/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js";
import {
  createSafeCall, hoodFactoryAbi, ownable2StepAbi, predictSafeAddress, readSafe, robinhood, safeContracts,
} from "../../packages/sdk/dist/index.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const WEB = join(ROOT, "apps/web");
const SHOTS = process.env.SHOT_DIR ?? mkdtempSync(join(tmpdir(), "hood-safe-ui-"));
const PORT = 8548;
const WEB_PORT = 4791;
const RPC = `http://127.0.0.1:${PORT}`;
const keep = process.argv.includes("--keep");

const KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
];
const [deployer, o1, o2] = KEYS.map((k) => privateKeyToAccount(k));
const chain = { ...robinhood, rpcUrls: { default: { http: [RPC] } } };
const client = createPublicClient({ chain, transport: http(RPC), pollingInterval: 100 });
const wallet = createWalletClient({ account: deployer, chain, transport: http(RPC) });

let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
  ok ? passed++ : failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const same = (a, b) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());

const anvil = spawn("anvil", ["--port", String(PORT), "--chain-id", "4663", "--silent"], { stdio: "ignore" });
let server;
const harnessCopy = join(WEB, "public/safe-harness.html");
const cleanup = () => {
  if (keep) return;
  anvil.kill();
  server?.kill();
  rmSync(harnessCopy, { force: true });
};
process.on("exit", cleanup);

try {
  for (let i = 0; i < 60; i++) {
    try { await client.getBlockNumber(); break; } catch { await sleep(100); }
  }

  console.log("\n1. a local 4663 with the real Safe code and the wiring deployed");
  for (const [key, file] of Object.entries({ safeL2: "SafeL2", proxyFactory: "SafeProxyFactory", fallbackHandler: "CompatibilityFallbackHandler", multiSendCallOnly: "MultiSendCallOnly" })) {
    await client.request({ method: "anvil_setCode", params: [safeContracts[key], readFileSync(join(ROOT, "test/fixtures/safe-1.4.1", `${file}.hex`), "utf8").trim()] });
  }
  // Multicall3, because every read the app makes is batched through it: wagmi builds its client
  // with `batch: { multicall: true }`, so on a chain without it at the canonical address every
  // read comes back as empty data. It is on 4663; a bare anvil needs it put there.
  await client.request({ method: "anvil_setCode", params: ["0xcA11bde05977b3631167028862bE2a173976CA11", readFileSync(join(ROOT, "test/fixtures/multicall3.hex"), "utf8").trim()] });
  const broadcast = mkdtempSync(join(tmpdir(), "hood-safe-ui-bc-"));
  const deploy = spawnSync("forge", ["script", "script/DeployLocal.s.sol", "--rpc-url", RPC, "--broadcast", "--slow"], {
    cwd: ROOT, encoding: "utf8", env: { ...process.env, PRIVATE_KEY: KEYS[0], FOUNDRY_BROADCAST: broadcast },
  });
  const addr = (key) => {
    const m = `${deploy.stdout}`.match(new RegExp(`${key}=(0x[0-9a-fA-F]{40})`));
    return m ? getAddress(m[1]) : undefined;
  };
  const factory = addr("HOOD_FACTORY");
  check("the wiring deployed", deploy.status === 0 && Boolean(factory), factory ?? `${deploy.stdout}`.slice(-300));

  const owners = [o1.address, o2.address];
  const safe = await predictSafeAddress(client, owners, 2, 0n);
  const create = createSafeCall(owners, 2, 0n);
  await client.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ to: create.to, data: create.data }) });
  await client.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ to: safe, value: parseEther("1") }) });
  check("a 2 of 2 Safe exists", Boolean(await readSafe(client, safe)), safe);

  await client.waitForTransactionReceipt({
    hash: await wallet.sendTransaction({ to: factory, data: encodeFunctionData({ abi: ownable2StepAbi, functionName: "transferOwnership", args: [safe] }) }),
  });
  check("the factory is waiting for the Safe", same(await client.readContract({ address: factory, abi: hoodFactoryAbi, functionName: "pendingOwner" }), safe));

  console.log("\n2. the app, built against that chain");
  const env = {
    ...process.env,
    NEXT_PUBLIC_RPC: RPC,
    NEXT_PUBLIC_FACTORY: factory,
    NEXT_PUBLIC_FEE_ROUTER: addr("HOOD_FEE_ROUTER") ?? "",
    NEXT_PUBLIC_STAKING: addr("HOOD_STAKING") ?? "",
    NEXT_PUBLIC_GRADUATOR: addr("HOOD_GRADUATOR") ?? "",
    NEXT_PUBLIC_BRIDGE_FACTORY: addr("HOOD_BRIDGE_FACTORY") ?? "",
    NEXT_PUBLIC_API_URL: `http://127.0.0.1:${WEB_PORT}/nothing-here`,
    NEXT_PUBLIC_SITE_URL: `http://127.0.0.1:${WEB_PORT}`,
    NEXT_PUBLIC_DEMO: "",
    // The harness stands in for Safe{Wallet}, so the app has to accept it as one.
    NEXT_PUBLIC_SAFE_APP_ORIGINS: `http://127.0.0.1:${WEB_PORT}`,
  };
  const build = spawnSync("npx", ["--no-install", "next", "build"], { cwd: WEB, encoding: "utf8", env });
  check("next build", build.status === 0, build.status === 0 ? "" : `${build.stdout}${build.stderr}`.slice(-500));

  mkdirSync(join(WEB, "public"), { recursive: true });
  copyFileSync(join(ROOT, "scripts/e2e/safe-app-harness.html"), harnessCopy);
  server = spawn("npx", ["--no-install", "next", "start", "-p", String(WEB_PORT)], { cwd: WEB, env, stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${WEB_PORT}/`)).ok) break; } catch { /* starting */ }
    await sleep(500);
  }

  const headers = await fetch(`http://127.0.0.1:${WEB_PORT}/`).then((r) => r.headers);
  check("only Safe{Wallet} and the app itself may frame it", (headers.get("content-security-policy") ?? "").includes("frame-ancestors 'self' https://app.safe.global"));
  check("X-Frame-Options no longer contradicts that", !headers.get("x-frame-options"));
  const manifest = await fetch(`http://127.0.0.1:${WEB_PORT}/manifest.json`);
  const manifestBody = await manifest.json();
  check("the Safe App manifest is served with CORS", manifest.headers.get("access-control-allow-origin") === "*" && manifestBody.name === "hood.fam" && manifestBody.iconPath === "icon.svg");

  console.log("\n3. the app inside the Safe");
  const browser = await puppeteer.launch({ headless: "new", executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", args: ["--no-sandbox"] });
  const page = await browser.newPage();
  const console_ = [];
  page.on("console", (m) => console_.push(`${m.type()}: ${m.text()}`.slice(0, 300)));
  page.on("pageerror", (e) => console_.push(`pageerror: ${e.message}`.slice(0, 300)));
  await page.setViewport({ width: 1280, height: 1400 });
  const url = `http://127.0.0.1:${WEB_PORT}/safe-harness.html?safe=${safe}&rpc=${encodeURIComponent(RPC)}&owners=${owners.join(",")}&threshold=2&delay=7000&app=${encodeURIComponent("/admin")}`;
  await page.goto(url, { waitUntil: "networkidle2", timeout: 60_000 });

  // The admin page keeps its server half behind a token in the tab. The owner half is the chain and
  // needs no token, so this puts one in and lets the panels render.
  const frame = page.frames().find((f) => f.url().includes("/admin"));
  await frame.evaluate(() => sessionStorage.setItem("hood.admin", "harness"));
  await frame.goto(`http://127.0.0.1:${WEB_PORT}/admin`, { waitUntil: "networkidle2" });
  await sleep(4000);

  const connected = await frame.evaluate(() => document.body.innerText);
  check("the app connected as the Safe, with no Connect button", /Safe 2\/2/.test(connected) && !/^Connect$/m.test(connected), connected.split("\n").find((l) => l.includes("Safe")) ?? "");
  if (!/Safe 2\/2/.test(connected)) {
    console.log("        harness log:", await page.evaluate(() => document.getElementById("log").textContent.slice(0, 400)).catch(() => "?"));
    console.log("        console:", console_.filter((l) => !l.includes("404")).slice(-14).join(" | "));
  }
  await page.screenshot({ path: join(SHOTS, "safe-1-connected.png") });

  const clicked = await frame.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "accept ownership");
    if (!button) return false;
    button.click();
    return true;
  });
  check("the factory panel offers the Safe the pending ownership", clicked);

  await sleep(3500);
  const waiting = await frame.evaluate(() => document.body.innerText);
  check("the app says it is waiting in the Safe", /waiting in your Safe/i.test(waiting), waiting.split("\n").find((l) => /waiting in your Safe/i.test(l)) ?? waiting.slice(0, 200));
  check("the harness was asked to propose exactly one call", (await page.evaluate(() => window.harness.sent.length)) === 1);
  await page.screenshot({ path: join(SHOTS, "safe-2-waiting.png") });

  // The harness executes after its delay; the app should pick the receipt up by itself.
  let owned = false;
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    owned = same(await client.readContract({ address: factory, abi: hoodFactoryAbi, functionName: "owner" }), safe);
    if (owned) break;
  }
  check("the transaction went through as the Safe", owned);

  let settled = "";
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    settled = await frame.evaluate(() => document.body.innerText);
    if (/owner[\s\S]{0,80}· you/i.test(settled)) break;
  }
  check("the panel now reads the Safe as the owner", /· you/.test(settled));
  let stripGone = false;
  for (let i = 0; i < 15 && !stripGone; i++) {
    await sleep(1000);
    stripGone = await frame.evaluate(() => !/waiting in your Safe/i.test(document.body.innerText));
  }
  check("the waiting strip clears once it is mined", stripGone);
  await page.screenshot({ path: join(SHOTS, "safe-3-owned.png") });

  await browser.close();
  console.log(`\nscreenshots in ${SHOTS}`);
} catch (e) {
  failed++;
  console.error(e);
} finally {
  if (!keep) cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
