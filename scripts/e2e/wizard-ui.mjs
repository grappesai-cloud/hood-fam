// The launch wizard, in a real browser, against a real fork of 4663.
//
//   node scripts/e2e/wizard-ui.mjs [--keep]
//
// `lifecycle.mjs` proves the system from the outside: scripts, contracts, indexer, API. This proves
// the half a person actually touches. It leaves that rehearsal's fork and API standing (E2E_KEEP=1),
// builds the app against the addresses it deployed, opens it in Chrome with the EIP-1193 shim in
// place of a wallet, and then fills the form in and presses the button: a token is printed on the
// fork, the app follows it to its page, and a buy goes through the curve. Screenshots at each step.
//
// Nothing here is mocked: the contracts are the repo's own deploy scripts against live 4663 state,
// and the numbers on screen come back from the indexer that read them off the fork.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, formatEther, getAddress, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/// anvil's FIRST account, because the rehearsal starts anvil with one account to keep the fork
/// light: any other address has no key there, and `personal_sign` for it comes back as invalid
/// parameters, which is what the chat's signature login needs.
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
import { hoodFactoryAbi } from "../../packages/sdk/dist/index.js";
import puppeteer from "/Users/alexandrucojanu/dating-app/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const WEB = join(ROOT, "apps/web");
const SHOTS = process.env.SHOT_DIR ?? mkdtempSync(join(tmpdir(), "hood-wizard-"));
const WEB_PORT = 4793;
const keep = process.argv.includes("--keep");

let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
  ok ? passed++ : failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (t) => console.log(`\n${t}`);

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...opts, encoding: "utf8" });
    let out = "";
    child.stdout?.on("data", (d) => { out += d; });
    child.stderr?.on("data", (d) => { out += d; });
    child.on("close", (status) => resolve({ status, out }));
  });
}

mkdirSync(SHOTS, { recursive: true });
let server;
let browser;

try {
  step("1. the rehearsal, left standing");
  const rehearsal = await run("node", ["scripts/e2e/lifecycle.mjs"], { cwd: ROOT, env: { ...process.env, E2E_KEEP: "1" } });
  const summary = rehearsal.out.match(/REHEARSAL OK: (\d+) of (\d+)/);
  check("the deployment rehearsal passed on a fork of 4663", rehearsal.status === 0 && Boolean(summary), summary ? `${summary[1]} of ${summary[2]} assertions` : rehearsal.out.slice(-400));
  // Read the E2E_KEEP line specifically: "logs in ..." also appears earlier inside brackets.
  const kept = rehearsal.out.match(/E2E_KEEP=1: anvil is still on (\S+?),? the api on (\S+?),? logs in (\S+)/);
  const rpc = kept?.[1];
  const api = kept?.[2];
  const runDir = kept?.[3];
  check("its fork and api are still up", Boolean(rpc && api), `${rpc} ${api}`);

  // The addresses come from the broadcast the deploy script wrote, not from parsing prose.
  const broadcast = join(runDir, "broadcast/Deploy.s.sol/4663/run-latest.json");
  const txs = JSON.parse(readFileSync(broadcast, "utf8")).transactions;
  const at = (name) => {
    const tx = txs.find((t) => t.contractName === name && t.transactionType === "CREATE");
    return tx ? getAddress(tx.contractAddress) : undefined;
  };
  const addresses = {
    factory: at("HoodFactory"), feeRouter: at("HoodFeeRouter"), staking: at("HoodStaking"),
    graduator: at("UniswapV4Graduator"), bridge: at("HoodBridgeFactory"), portal: at("HoodPortal"),
    directDeployer: at("HoodDirectDeployer"), buyback: at("HoodBuybackModule"),
  };
  check("the deployed addresses were read off the broadcast", Object.values(addresses).every(Boolean), addresses.factory);

  const client = createPublicClient({ transport: http(rpc), pollingInterval: 200 });

  // The browser needs a wallet that can both send and SIGN: the chat logs in with a signature, and
  // an impersonated address has no key anywhere to sign with. So it uses one of anvil's own
  // accounts, whose key anvil holds, after clearing the 7702 delegation 4663 carries on those
  // addresses (a sweeper that forwards every wei paid to them). Clearing it is local to the fork.
  const wallet = privateKeyToAccount(KEY).address;
  await client.request({ method: "anvil_setCode", params: [wallet, "0x"] });
  check("the browser's wallet is a clean key, delegation cleared", !(await client.getCode({ address: wallet })), wallet);
  await client.request({ method: "anvil_setBalance", params: [wallet, "0x56BC75E2D63100000"] }); // 100 ETH
  check("it is funded on the fork", (await client.getBalance({ address: wallet })) === parseEther("100"));

  step("2. the app, built against that fork");
  const env = {
    ...process.env,
    NEXT_PUBLIC_API_URL: api,
    NEXT_PUBLIC_RPC: rpc,
    NEXT_PUBLIC_FACTORY: addresses.factory,
    NEXT_PUBLIC_FEE_ROUTER: addresses.feeRouter,
    NEXT_PUBLIC_STAKING: addresses.staking,
    NEXT_PUBLIC_GRADUATOR: addresses.graduator,
    NEXT_PUBLIC_BRIDGE_FACTORY: addresses.bridge,
    NEXT_PUBLIC_PORTAL: addresses.portal,
    NEXT_PUBLIC_DIRECT_DEPLOYER: addresses.directDeployer,
    NEXT_PUBLIC_BUYBACK_MODULE: addresses.buyback,
    NEXT_PUBLIC_SITE_URL: `http://127.0.0.1:${WEB_PORT}`,
    NEXT_PUBLIC_DEMO: "",
  };
  const build = await run("npx", ["--no-install", "next", "build"], { cwd: WEB, env });
  check("the app builds with the fork's addresses", build.status === 0, build.status === 0 ? "" : build.out.slice(-400));
  server = spawn("npx", ["--no-install", "next", "start", "-p", String(WEB_PORT)], { cwd: WEB, env, stdio: "ignore" });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${WEB_PORT}/`)).ok) break; } catch { /* starting */ }
    await sleep(500);
  }

  step("3. the wizard, in the browser");
  browser = await puppeteer.launch({ headless: "new", executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  const page = await browser.newPage();
  // What the wallet was asked for, and anything the app shouted: a harness has no console to watch.
  const console_ = [];
  page.on("console", (m) => console_.push(`${m.type()}: ${m.text()}`.slice(0, 300)));
  page.on("pageerror", (e) => console_.push(`pageerror: ${e.message}`.slice(0, 300)));
  await page.setViewport({ width: 1440, height: 1600 });
  const shim = readFileSync(join(ROOT, "scripts/e2e/provider-shim.js"), "utf8");
  await page.evaluateOnNewDocument(`window.__HOOD_SHIM = ${JSON.stringify({ rpc, account: wallet })};`);
  await page.evaluateOnNewDocument(shim);

  await page.goto(`http://127.0.0.1:${WEB_PORT}/launch`, { waitUntil: "networkidle2", timeout: 90_000 });
  await sleep(1500);
  const text = await page.evaluate(() => document.body.innerText);
  check("the wizard is there, not the 'not configured' notice", !/not configured on this deployment/i.test(text) && /The token/i.test(text));

  // Connect, then fill the form the way a person does.
  await page.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find((b) => /^connect$/i.test(b.textContent.trim()));
    button?.click();
  });
  await sleep(2500);
  check("the wallet is connected", /0x[0-9a-fA-F]{4}/.test(await page.evaluate(() => document.querySelector(".wallet-button")?.textContent ?? "")));

  const ticker = `RUN${Math.floor(Math.random() * 900 + 100)}`;
  await page.evaluate((name, symbol) => {
    const setValue = (el, value) => {
      const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, "value").set;
      setter.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const inputs = [...document.querySelectorAll("input")];
    const nameInput = inputs.find((i) => i.placeholder === "Hood Fam");
    const tickerInput = inputs.find((i) => i.placeholder === "FAM");
    if (nameInput) setValue(nameInput, name);
    if (tickerInput) setValue(tickerInput, symbol);
  }, "Rehearsal Coin", ticker);
  await sleep(1200);
  await page.screenshot({ path: join(SHOTS, "wizard-1-filled.png") });

  const before = await client.getBalance({ address: wallet });
  const pressed = await page.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find((b) => /create the token/i.test(b.textContent));
    if (!button || button.disabled) return button ? "disabled" : "missing";
    button.click();
    return "clicked";
  });
  check("the create button is live once the form is filled", pressed === "clicked", pressed);

  // The app redirects to the token page as soon as the receipt lands.
  let onToken = false;
  for (let i = 0; i < 60 && !onToken; i++) {
    await sleep(1000);
    onToken = /\/token\/0x[0-9a-fA-F]{40}/.test(page.url());
  }
  check("the launch went through and the app followed it to its page", onToken, page.url());
  const token = page.url().match(/\/token\/(0x[0-9a-fA-F]{40})/)?.[1];
  const spent = before - (await client.getBalance({ address: wallet }));
  check("the wallet paid for it", spent > 0n, `${formatEther(spent)} ETH`);

  const launch = await client.readContract({
    address: addresses.factory, abi: hoodFactoryAbi, functionName: "getLaunch", args: [token],
  }).catch((e) => { console.log(`       getLaunch: ${e.shortMessage ?? e.message}`); return null; });
  check("the chain says it is a real launch, created by that wallet", Boolean(launch?.exists) && launch.creator.toLowerCase() === wallet.toLowerCase(), token);

  await sleep(4000);
  await page.screenshot({ path: join(SHOTS, "wizard-2-token-page.png") });
  const tokenText = await page.evaluate(() => document.body.innerText);
  check("its page carries the ticker the form was given", tokenText.includes(ticker), ticker);

  step("4. a buy on the curve, from the same page");
  await page.evaluate(() => {
    const setValue = (el, value) => {
      const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, "value").set;
      setter.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    // The panel's first input is the amount. Do not touch the Buy/Sell tabs: switching side clears
    // it, which is how this harness first managed to press "buy" with an empty field.
    const amount = [...document.querySelectorAll(".trade-panel input")][0];
    if (amount) setValue(amount, "0.25");
  });
  await sleep(800);
  const bought = await page.evaluate((symbol) => {
    // The submit button names the token ("buy RUN456"); the bare "Buy" is the side tab.
    const button = [...document.querySelectorAll(".trade-panel button")]
      .find((b) => b.textContent.trim().toLowerCase() === `buy ${symbol.toLowerCase()}` && !b.disabled);
    if (!button) return false;
    button.click();
    return true;
  }, ticker);
  check("the trade box takes an amount and the buy button is live", bought);

  let held = 0n;
  for (let i = 0; i < 40 && held === 0n; i++) {
    await sleep(1000);
    held = await client.readContract({
      address: token, abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }],
      functionName: "balanceOf", args: [wallet],
    });
  }
  check("the buy landed and the wallet holds the token", held > 0n, `${formatEther(held)} tokens`);

  // The page's own counters come from the indexer, not from the wallet: the trade is only real to a
  // reader once it has been read off the chain and written down. This is the step between them.
  let detail = null;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    detail = await fetch(`${api}/tokens/${token}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (detail && Number(detail.trades_total ?? 0) > 0) break;
  }
  check("the indexer saw the trade and the api reports it", Number(detail?.trades_total ?? 0) > 0, `${detail?.trades_total ?? "?"} trades, ${detail?.holders ?? "?"} holders`);

  await page.reload({ waitUntil: "networkidle2" });
  await sleep(3000);
  const tape = await page.evaluate(() => {
    const section = [...document.querySelectorAll("section, div")].find((el) => /^tape\b/i.test(el.textContent.trim()));
    return section?.textContent ?? "";
  });
  check("the tape shows the trade", /buy/i.test(tape) && !/no trades yet/i.test(tape), tape.replace(/\s+/g, " ").slice(0, 90));
  await page.screenshot({ path: join(SHOTS, "wizard-3-after-buy.png") });

  step("5. the room: a signature login, a message, and the live stream");
  const stream = await fetch(`${api}/stream?tokens=${token}`, { headers: { accept: "text/event-stream" } });
  check("the api serves the live stream", stream.ok && (stream.headers.get("content-type") ?? "").includes("text/event-stream"));
  const reader = stream.body.getReader();
  let streamed = "";
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        streamed += new TextDecoder().decode(value);
      }
    } catch { /* closed at the end of the run */ }
  })();

  const said = `first words on ${ticker}`;
  const posted = await page.evaluate(async (text) => {
    const box = document.querySelector(".chat-composer textarea, .chat-composer input");
    if (!box) return "no composer";
    const setter = Object.getOwnPropertyDescriptor(box.constructor.prototype, "value").set;
    setter.call(box, text);
    box.dispatchEvent(new Event("input", { bubbles: true }));
    const button = [...document.querySelectorAll(".chat-composer button")].find((b) => !b.disabled);
    if (!button) return "no button";
    button.click();
    return "clicked";
  }, said);
  check("the chat composer takes a message and its button is live", posted === "clicked", posted);

  let room = [];
  for (let i = 0; i < 40 && room.length === 0; i++) {
    await sleep(1000);
    room = await fetch(`${api}/chat/${token}`).then((r) => (r.ok ? r.json() : { messages: [] })).then((b) => b.messages ?? []).catch(() => []);
  }
  check("the message is in the room, signed in with a wallet signature", room.some((m) => m.body === said), room[0]?.body ?? "nothing posted");
  if (!room.some((m) => m.body === said)) {
    console.log("        wallet calls:", console_.filter((l) => l.includes("[shim]")).slice(-6).join(" | "));
    console.log("        page errors:", console_.filter((l) => /error|Error/.test(l) && !l.includes("404")).slice(-4).join(" | "));
    console.log("        on screen:", (await page.evaluate(() => document.querySelector(".chat-error, .chat-composer")?.textContent ?? "")).slice(0, 200));
  }
  const mine = room.find((m) => m.body === said);
  check("it carries who said it, from the chain", Boolean(mine) && mine.author.toLowerCase() === wallet.toLowerCase() && mine.holdingBps > 0, mine ? `${mine.rank}, ${mine.holdingBps} bps, creator ${mine.isCreator}` : "");
  check("it went out on the live stream", streamed.includes(said), streamed.split("\n").filter((l) => l.startsWith("event:")).join(" ").slice(0, 80));
  await page.screenshot({ path: join(SHOTS, "wizard-5-chat.png") });
  await reader.cancel().catch(() => {});

  await page.goto(`http://127.0.0.1:${WEB_PORT}/`, { waitUntil: "networkidle2" });
  await sleep(3000);
  const board = await page.evaluate(() => document.body.innerText);
  check("the new launch shows up on the board", board.includes(ticker));
  await page.screenshot({ path: join(SHOTS, "wizard-4-board.png") });

  console.log(`\nscreenshots in ${SHOTS}`);
} catch (e) {
  failed++;
  console.error(e);
} finally {
  if (!keep) {
    server?.kill();
    await browser?.close().catch(() => {});
    // The rehearsal's own anvil and api were left up by E2E_KEEP; stop them too.
    await run("bash", ["-lc", "lsof -tiTCP:8555 -sTCP:LISTEN | xargs kill 2>/dev/null; lsof -tiTCP:8199 -sTCP:LISTEN | xargs kill 2>/dev/null; true"]);
  } else {
    console.log(`\n--keep: the app is on http://127.0.0.1:${WEB_PORT}, the fork and api are still up`);
    await browser?.close().catch(() => {});
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
