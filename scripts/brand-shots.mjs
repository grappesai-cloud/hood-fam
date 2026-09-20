// Every face, built and photographed.
//
//   node scripts/brand-shots.mjs [id ...]        default: all of apps/web/brands
//
// For each brand it switches the build over (`npm run brand`), builds, serves it, and takes desktop
// and phone screenshots of the pages that differ most. The data is the live demo indexer, reached
// through a local proxy that adds the CORS header the real one only gives its own site, so the
// boards in the pictures are full rather than empty.
//
// Screenshots land in a directory printed at the end; SHOT_DIR overrides it.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "/Users/alexandrucojanu/dating-app/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WEB = join(ROOT, "apps/web");
const SHOTS = process.env.SHOT_DIR ?? mkdtempSync(join(tmpdir(), "hood-brands-"));
const UPSTREAM = process.env.SHOT_API ?? "https://api.hood.grappes.dev";
const API_PORT = 4788;
const WEB_PORT = 4789;
const PAGES = [
  ["home", "/"],
  ["launch", "/launch"],
  ["leaderboard", "/leaderboard"],
];

const ids = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync(join(WEB, "brands"), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);

mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/// Never spawnSync here: the CORS proxy below lives in this process, and a synchronous child would
/// block the event loop that answers it. The build fetches the API for the sitemap, so it would
/// wait on a proxy that cannot reply until the build it is blocking has finished.
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...opts, encoding: "utf8" });
    let out = "";
    child.stdout?.on("data", (d) => { out += d; });
    child.stderr?.on("data", (d) => { out += d; });
    child.on("close", (status) => resolve({ status, out }));
  });
}

/// The live API answers its own site only, so a browser on localhost gets no data from it. This
/// passes the same requests through and says yes to everyone, which is fine for a read-only board.
const proxy = createServer(async (req, res) => {
  try {
    const upstream = await fetch(`${UPSTREAM}${req.url}`, { headers: { accept: "application/json" } });
    const body = await upstream.text();
    res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json", "access-control-allow-origin": "*" });
    res.end(body);
  } catch (e) {
    res.writeHead(502, { "content-type": "application/json", "access-control-allow-origin": "*" });
    res.end(JSON.stringify({ error: String(e) }));
  }
});
proxy.listen(API_PORT);

const browser = await puppeteer.launch({ headless: "new", executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });

for (const id of ids) {
  console.log(`\n${id}`);
  const switched = await run("node", ["scripts/brand.mjs", id], { cwd: ROOT });
  if (switched.status !== 0) {
    console.log(`  skipped: ${switched.out.trim()}`);
    continue;
  }
  const env = {
    ...process.env,
    NEXT_PUBLIC_API_URL: `http://127.0.0.1:${API_PORT}`,
    NEXT_PUBLIC_SITE_URL: `http://127.0.0.1:${WEB_PORT}`,
    NEXT_PUBLIC_DEMO: "1",
    NEXT_PUBLIC_DEMO_WALLET: "0x248eeeb95b0579f2d42cb1e39da621c971d1e3e6",
    NEXT_PUBLIC_RPC: "https://rpc.mainnet.chain.robinhood.com",
  };
  const build = await run("npx", ["--no-install", "next", "build"], { cwd: WEB, env });
  if (build.status !== 0) {
    console.log(`  BUILD FAILED\n${build.out.split("\n").filter((l) => /error|Error|failed/i.test(l)).slice(0, 12).join("\n")}`);
    continue;
  }
  const server = spawn("npx", ["--no-install", "next", "start", "-p", String(WEB_PORT)], { cwd: WEB, env, stdio: "ignore" });
  try {
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(`http://127.0.0.1:${WEB_PORT}/`)).ok) break; } catch { /* starting */ }
      await sleep(500);
    }
    const page = await browser.newPage();
    for (const [name, path] of PAGES) {
      await page.setViewport({ width: 1440, height: 1600, deviceScaleFactor: 1 });
      await page.goto(`http://127.0.0.1:${WEB_PORT}${path}`, { waitUntil: "networkidle2", timeout: 60_000 });
      await sleep(2500);
      await page.screenshot({ path: join(SHOTS, `${id}-${name}.png`) });
    }
    // The phone is where most of a launchpad is read, so every brand gets photographed there too.
    await page.setViewport({ width: 390, height: 1600, isMobile: true, hasTouch: true });
    await page.goto(`http://127.0.0.1:${WEB_PORT}/`, { waitUntil: "networkidle2" });
    await sleep(2000);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    await page.screenshot({ path: join(SHOTS, `${id}-phone.png`) });
    console.log(`  shots taken${overflow ? "  WARNING: horizontal overflow at 390px" : ""}`);
    await page.close();
  } finally {
    server.kill();
    await sleep(500);
  }
}

await browser.close();
proxy.close();
// Leave the tree as it was found: hood is what is committed.
await run("node", ["scripts/brand.mjs", "hood"], { cwd: ROOT });
console.log(`\nscreenshots in ${SHOTS}`);
