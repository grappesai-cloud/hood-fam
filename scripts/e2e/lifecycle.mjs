// The deployment rehearsal: the whole system, from nothing to a claimed airdrop, against a local
// anvil fork of chain 4663, asserting the wiring after every step.
//
//   node scripts/e2e/lifecycle.mjs                # the whole thing
//   node scripts/e2e/lifecycle.mjs --wiring-only  # only the wiring, against addresses from env
//
// It starts its own anvil and its own api, on its own ports and its own database, so it never
// argues with a stack somebody already has up. See scripts/e2e/README.md.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import {
  createPublicClient, createWalletClient, decodeEventLog, encodeAbiParameters, formatEther, http,
  keccak256, parseAbi, parseAbiItem, parseAbiParameters, parseEther, toHex, zeroAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  buildSwap, createDirectClient, createHoodClient, hoodCurveAbi, hoodFeeRouterAbi, hoodSeasonDropAbi,
  hoodStakingAbi, layerZero, pairs, robinhood, uniswapV4, universalRouterAbi,
} from "../../packages/sdk/dist/index.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const WIRING_ONLY = process.argv.includes("--wiring-only");

// Forks of 4663 age out: a node that has pruned the state under a block answers "historical state
// is not available" and every call on the fork fails. So this always forks at head and never pins
// a block, which also means two runs are never against the same state.
const FORK_RPC = process.env.HOOD_RPC ?? "https://rpc.mainnet.chain.robinhood.com";
const ANVIL_PORT = Number(process.env.E2E_ANVIL_PORT ?? 8555);
const RPC = `http://127.0.0.1:${ANVIL_PORT}`;
const API_PORT = Number(process.env.E2E_API_PORT ?? 8199);
const API = `http://127.0.0.1:${API_PORT}`;
const PG_ADMIN = process.env.E2E_PG ?? "postgres://hood:hood@127.0.0.1:55444/postgres";
const DB_NAME = process.env.E2E_DB ?? "hood_rehearsal";
const DB_URL = PG_ADMIN.replace(/\/[^/]*$/, `/${DB_NAME}`);
const ADMIN_TOKEN = process.env.E2E_ADMIN_TOKEN ?? "rehearsal-token-0123456789abcdef";
// The Chainlink feed on 4663 answers on a fork, so this is only the floor under it. Points stop
// growing without a price, and a season with no points has no drop to claim.
const ETH_USD_FALLBACK = process.env.HOOD_ETH_USD ?? "4000";

const USDG = pairs.usdg.address;
const LAUNCH_FEE = parseEther("0.0005");

// ---------------------------------------------------------------- the checklist

const results = [];
let currentStep = "start";

const step = (title) => {
  currentStep = title;
  console.log(`\n--- ${title}`);
};

/// Records an assertion and prints it as it happens. A failure prints the whole checklist and
/// leaves with a non-zero code straight away: a rehearsal that carries on after a broken step is
/// only telling you about the damage downstream of the first one.
function check(name, ok, detail = "") {
  results.push({ step: currentStep, name, ok: Boolean(ok), detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) {
    summary();
    process.exit(1);
  }
}

function summary() {
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n================ checklist (${passed}/${results.length}) ================`);
  let seen = "";
  for (const r of results) {
    if (r.step !== seen) { console.log(`\n  ${r.step}`); seen = r.step; }
    console.log(`    ${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `  ${r.detail}` : ""}`);
  }
  console.log(`\n${passed === results.length ? "REHEARSAL OK" : "REHEARSAL FAILED"}: ${passed} of ${results.length} assertions passed`);
}

// ---------------------------------------------------------------- processes

const runDir = join(process.env.E2E_RUN_DIR ?? tmpdir(), `hood-rehearsal-${process.pid}`);
mkdirSync(runDir, { recursive: true });
const children = [];

function cleanup() {
  if (process.env.E2E_KEEP === "1") {
    console.log(`\nE2E_KEEP=1: anvil is still on ${RPC}, the api on ${API}, logs in ${runDir}`);
    return;
  }
  for (const c of children) { try { c.kill("SIGKILL"); } catch {} }
}
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { cleanup(); process.exit(130); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function background(name, cmd, args, env) {
  const out = openSync(join(runDir, `${name}.log`), "a");
  const child = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", out, out] });
  child.on("exit", (code) => { if (code) console.error(`${name} exited with ${code}, see ${runDir}/${name}.log`); });
  children.push(child);
  return child;
}

/// A foreground command whose output we need. Failure is fatal and prints the tail of the log,
/// because everything after a failed deployment would be noise.
function sh(name, cmd, args, env = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    console.error(`\n${name} failed (${r.status})\n${(r.stdout ?? "").slice(-4000)}\n${(r.stderr ?? "").slice(-4000)}`);
    check(`${name} succeeds`, false, `exit ${r.status}`);
  }
  return r.stdout ?? "";
}

// ---------------------------------------------------------------- chain helpers

const chain = { ...robinhood, rpcUrls: { default: { http: [RPC] } } };
// cacheTime 0 matters more than it looks: viem caches eth_blockNumber for a polling interval, and
// anvil only mines when this script sends something, so a cached head makes "has the indexer caught
// up" answer yes while the last few blocks are still unread. The short poll is for the receipts.
const publicClient = createPublicClient({ chain, transport: http(RPC), cacheTime: 0, pollingInterval: 100 });

// The roles a real deployment has. NOT anvil's own accounts: on 4663 every well known test key
// (0xac09..., 0x59c6..., 0x5de4...) already carries an EIP-7702 delegation to a sweeper, so an
// address that looks like an empty wallet is really a contract that forwards every wei it is paid.
// A launch fee "sent to the treasury" would vanish on arrival and the rehearsal would be testing
// somebody else's sweeper. These keys are derived for this harness, checked for code, then funded.
const ROLES = ["deployer", "owner", "treasury", "creator", "alice", "bob", "carol", "keeper"];
const wallets = [];
let deployer, owner, treasury, creator, alice, bob, carol, keeper;

async function openWallets() {
  for (const role of ROLES) {
    for (let n = 0; ; n++) {
      const key = keccak256(toHex(`hood.fam deployment rehearsal:${role}:${n}`));
      const account = privateKeyToAccount(key);
      const code = await publicClient.getCode({ address: account.address });
      if (code && code !== "0x") continue; // occupied on the fork, try the next derivation
      await rpc("anvil_setBalance", [account.address, `0x${parseEther("100000").toString(16)}`]);
      wallets.push({ role, key, account, address: account.address, client: createWalletClient({ account, chain, transport: http(RPC) }) });
      break;
    }
  }
  [deployer, owner, treasury, creator, alice, bob, carol, keeper] = wallets;
  const funded = await Promise.all(wallets.map((w) => balanceOf(zeroAddress, w.address)));
  check("eight role wallets with no code on them, funded",
    funded.every((b) => b === parseEther("100000")), wallets.map((w) => `${w.role} ${w.address.slice(0, 8)}`).join(" "));
}

const wait = async (hash) => {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`);
  return receipt;
};
const rpc = (method, params = []) => publicClient.request({ method, params });
/// Deadlines come off the chain's clock, not this machine's: anvil's timestamps drift ahead of the
/// wall clock as soon as blocks are mined faster than one a second, and the router refuses a
/// deadline that is already behind it.
const deadline = async (seconds = 3600) => BigInt((await publicClient.getBlock()).timestamp) + BigInt(seconds);
const mine = (n) => rpc("anvil_mine", [`0x${n.toString(16)}`]);
const warp = async (seconds) => { await rpc("anvil_increaseTime", [`0x${seconds.toString(16)}`]); await mine(1); };

const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
]);
const balanceOf = (token, who) =>
  token === zeroAddress ? publicClient.getBalance({ address: who })
    : publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] });

const boughtEvent = parseAbiItem("event Bought(address indexed buyer, address indexed to, uint256 pairIn, uint256 tokensOut, uint256 fee)");
const soldEvent = parseAbiItem("event Sold(address indexed seller, address indexed to, uint256 tokensIn, uint256 pairOut, uint256 fee)");

/// The first event of a kind in a receipt, from a given contract. Decoding rather than trusting a
/// number we passed in is the whole difference between a rehearsal and a script.
function eventIn(receipt, address, abi) {
  for (const log of receipt.logs) {
    if (!same(log.address, address)) continue;
    try { return decodeEventLog({ abi: [abi], data: log.data, topics: log.topics }).args; } catch {}
  }
  return null;
}

const read = (address, abi, functionName, args = []) =>
  publicClient.readContract({ address, abi, functionName, args });

/// A write from a named wallet, simulated first so a revert is a readable error rather than a
/// receipt with status 0.
async function send(w, address, abi, functionName, args = [], value) {
  const { request } = await publicClient.simulateContract({ address, abi, functionName, args, value, account: w.account });
  return wait(await w.client.writeContract(request));
}

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

// ---------------------------------------------------------------- the api

async function api(path, init = {}) {
  const r = await fetch(API + path, init);
  return { status: r.status, body: await r.json().catch(() => null) };
}
const adminGet = (path) => api(path, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
const adminPost = (path, body) =>
  api(path, { method: "POST", headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });

// ================================================================ 1. the fork

async function startAnvil() {
  step("1. an anvil fork of 4663 at head");
  let reachable = false;
  try { reachable = (await rpc("eth_chainId")) !== undefined; } catch { reachable = false; }

  // The public RPC rate limits, and anvil reads state from it before it will even serve genesis, so
  // a start can die on a 429 through no fault of ours. One account instead of ten is nine fewer
  // accounts to fetch, and a failed start is worth retrying rather than reporting.
  for (let attempt = 1; attempt <= 3 && !reachable; attempt++) {
    const anvil = background(`anvil-${attempt}`, "anvil", [
      "--fork-url", FORK_RPC,
      // no --fork-block-number on purpose: see the note at the top of this file
      "--port", String(ANVIL_PORT),
      "--chain-id", "4663",
      "--accounts", "1",
    ]);
    for (let i = 0; i < 120; i++) {
      if (anvil.exitCode !== null) break;
      try { await rpc("eth_chainId"); reachable = true; break; } catch { await sleep(500); }
    }
    if (!reachable) await sleep(4000);
  }
  check("anvil answers on " + RPC, reachable, `logs in ${runDir}`);

  const chainId = Number(await rpc("eth_chainId"));
  check("the fork carries chain id 4663", chainId === 4663, String(chainId));

  const head = await publicClient.getBlockNumber();
  check("the fork is at head", head > 60_000_000n, `block ${head}`);

  // The whole point of forking rather than mocking: the real Uniswap v4 deployment is there.
  const pm = await publicClient.getCode({ address: uniswapV4.poolManager });
  check("the real PoolManager has code on the fork", Boolean(pm) && pm !== "0x", uniswapV4.poolManager);
  const lz = await publicClient.getCode({ address: layerZero.endpoint });
  check("the LayerZero endpoint is at 0x6F47..., not the canonical address", Boolean(lz) && lz !== "0x", layerZero.endpoint);
  await openWallets();
  return head;
}

// ================================================================ 2. the deployment

function parseDeployment(out) {
  const book = {};
  for (const line of out.split("\n")) {
    const m = line.match(/^\s{2}(\w+)\s+(0x[0-9a-fA-F]{40})\s*$/);
    if (m) book[m[1]] = m[2];
    const b = line.match(/^\s{2}start block\s+(\d+)\s*$/);
    if (b) book.startBlock = BigInt(b[1]);
  }
  return book;
}

async function deploy() {
  step("2. the deployment, through the repo's own scripts");
  const env = {
    PRIVATE_KEY: deployer.key, OWNER: owner.address, TREASURY: treasury.address,
    // keeps this run's broadcast artefacts out of the repo's own broadcast directory
    FOUNDRY_BROADCAST: join(runDir, "broadcast"),
  };
  const main = sh("forge script Deploy.s.sol", "forge",
    ["script", "script/Deploy.s.sol", "--rpc-url", RPC, "--broadcast", "--slow"], env);
  const book = parseDeployment(main);
  const wanted = ["factory", "deployer", "staking", "feeRouter", "graduator", "bridge", "portal", "directDeployer", "tokenImpl", "buyback"];
  check("Deploy.s.sol printed every address", wanted.every((k) => book[k]), wanted.filter((k) => !book[k]).join(",") || "all ten");
  check("Deploy.s.sol printed a start block", typeof book.startBlock === "bigint", String(book.startBlock));

  const drop = sh("forge script DeploySeasonDrop.s.sol", "forge",
    ["script", "script/DeploySeasonDrop.s.sol", "--rpc-url", RPC, "--broadcast", "--slow"], env);
  const dropBook = parseDeployment(drop);
  check("DeploySeasonDrop.s.sol printed the drop address", Boolean(dropBook.seasonDrop), dropBook.seasonDrop);

  const a = {
    factory: book.factory, bytecodeDeployer: book.deployer, staking: book.staking, feeRouter: book.feeRouter,
    graduator: book.graduator, bridge: book.bridge, portal: book.portal, directDeployer: book.directDeployer,
    tokenImpl: book.tokenImpl, buyback: book.buyback, seasonDrop: dropBook.seasonDrop, startBlock: book.startBlock,
  };

  // Ownable2Step: the deploy script only names a pending owner. A deployment where nobody accepted
  // is a deployment the discarded key still owns, which is exactly what section 3e warns about.
  const twoStep = parseAbi([
    "function acceptOwnership()", "function pendingOwner() view returns (address)", "function owner() view returns (address)",
  ]);
  for (const [name, address] of [["factory", a.factory], ["bridge", a.bridge], ["portal", a.portal]]) {
    check(`${name} names the owner as pending and the deployer as owner until it is accepted`,
      same(await read(address, twoStep, "pendingOwner"), owner.address)
      && same(await read(address, twoStep, "owner"), deployer.address));
    await send(owner, address, twoStep, "acceptOwnership");
  }
  return a;
}

// ================================================================ the wiring

/// Everything a real deploy wants checked once the dust settles: who owns what, who holds whose
/// address, what got registered, and whether the economics hash still pins the presets that were
/// announced. Pointed at a live deployment with --wiring-only and the addresses in the environment.
export async function checkWiring({ client, a, owner: ownerAddress, treasury: treasuryAddress }) {
  const factoryAbi = parseAbi([
    "function owner() view returns (address)", "function pendingOwner() view returns (address)",
    "function treasury() view returns (address)", "function feeRouter() view returns (address)",
    "function staking() view returns (address)", "function graduationHandler() view returns (address)",
    "function portal() view returns (address)", "function deployer() view returns (address)",
    "function launchFee() view returns (uint256)", "function configCount() view returns (uint256)",
    "function pairAllowed(address) view returns (bool)", "function lockThreshold(address) view returns (uint256)",
    "function previewLaunchEconomics(uint256,address) view returns (bytes32)",
    "function getConfig(uint256) view returns ((uint256,uint16,uint256,uint256,uint16,uint16,uint16,uint24,int24,bool))",
  ]);
  const get = (address, abi, fn, args = []) => client.readContract({ address, abi, functionName: fn, args });

  // ---- ownership and the treasury, on every contract that has one
  check("factory owner is OWNER", same(await get(a.factory, factoryAbi, "owner"), ownerAddress));
  check("factory has no pending owner left", same(await get(a.factory, factoryAbi, "pendingOwner"), zeroAddress));
  check("factory treasury is TREASURY", same(await get(a.factory, factoryAbi, "treasury"), treasuryAddress));

  const portalAbi = parseAbi([
    "function owner() view returns (address)", "function pendingOwner() view returns (address)",
    "function treasury() view returns (address)", "function registry() view returns (address)",
    "function buybackModule() view returns (address)", "function tokenImplementation() view returns (address)",
    "function deployer() view returns (address)", "function poolManager() view returns (address)",
    "function positionManager() view returns (address)", "function permit2() view returns (address)",
    "function launchFee() view returns (uint256)", "function launchEnabled() view returns (bool)",
    "function whitelistOnly() view returns (bool)", "function quoteAllowed(address) view returns (bool)",
    "function canLaunch(address) view returns (bool)", "function expectedHookFlags() view returns (uint160)",
  ]);
  check("portal owner is OWNER", same(await get(a.portal, portalAbi, "owner"), ownerAddress));
  check("portal has no pending owner left", same(await get(a.portal, portalAbi, "pendingOwner"), zeroAddress));
  check("portal treasury is TREASURY", same(await get(a.portal, portalAbi, "treasury"), treasuryAddress));

  const bridgeAbi = parseAbi([
    "function owner() view returns (address)", "function pendingOwner() view returns (address)",
    "function factory() view returns (address)", "function lzEndpoint() view returns (address)",
  ]);
  check("bridge owner is OWNER", same(await get(a.bridge, bridgeAbi, "owner"), ownerAddress));
  check("bridge has no pending owner left", same(await get(a.bridge, bridgeAbi, "pendingOwner"), zeroAddress));

  if (a.seasonDrop) {
    const dropAbi = parseAbi([
      "function owner() view returns (address)", "function pendingOwner() view returns (address)",
      "function treasury() view returns (address)", "function MIN_WINDOW() view returns (uint64)",
    ]);
    check("season drop owner is OWNER from the first block", same(await get(a.seasonDrop, dropAbi, "owner"), ownerAddress));
    check("season drop has no pending owner", same(await get(a.seasonDrop, dropAbi, "pendingOwner"), zeroAddress));
    check("season drop treasury is TREASURY", same(await get(a.seasonDrop, dropAbi, "treasury"), treasuryAddress));
    check("season drop enforces a 30 day claim window", Number(await get(a.seasonDrop, dropAbi, "MIN_WINDOW")) === 30 * 86400);
  }

  // ---- the addresses each contract holds for the others
  check("factory.feeRouter points at the fee router", same(await get(a.factory, factoryAbi, "feeRouter"), a.feeRouter));
  check("factory.staking points at the staking contract", same(await get(a.factory, factoryAbi, "staking"), a.staking));
  check("factory.graduationHandler points at the graduator", same(await get(a.factory, factoryAbi, "graduationHandler"), a.graduator));
  check("factory.portal points at the portal", same(await get(a.factory, factoryAbi, "portal"), a.portal));
  if (a.bytecodeDeployer) {
    check("factory.deployer points at the bytecode holder", same(await get(a.factory, factoryAbi, "deployer"), a.bytecodeDeployer));
  }

  const routerAbi = parseAbi(["function factory() view returns (address)", "function staking() view returns (address)"]);
  check("feeRouter.factory points back at the factory", same(await get(a.feeRouter, routerAbi, "factory"), a.factory));
  check("feeRouter.staking points at the staking contract", same(await get(a.feeRouter, routerAbi, "staking"), a.staking));
  check("staking.factory points back at the factory", same(await get(a.staking, routerAbi, "factory"), a.factory));

  const gradAbi = parseAbi([
    "function factory() view returns (address)", "function poolManager() view returns (address)",
    "function positionManager() view returns (address)", "function universalRouter() view returns (address)",
    "function permit2() view returns (address)", "function stateView() view returns (address)",
  ]);
  check("graduator.factory points back at the factory", same(await get(a.graduator, gradAbi, "factory"), a.factory));
  check("graduator holds the 4663 PoolManager", same(await get(a.graduator, gradAbi, "poolManager"), uniswapV4.poolManager));
  check("graduator holds the 4663 PositionManager", same(await get(a.graduator, gradAbi, "positionManager"), uniswapV4.positionManager));
  check("graduator holds the forked UniversalRouter", same(await get(a.graduator, gradAbi, "universalRouter"), uniswapV4.universalRouter));
  check("graduator holds Permit2", same(await get(a.graduator, gradAbi, "permit2"), uniswapV4.permit2));
  check("graduator holds the StateView", same(await get(a.graduator, gradAbi, "stateView"), uniswapV4.stateView));

  check("bridge.factory points back at the factory", same(await get(a.bridge, bridgeAbi, "factory"), a.factory));
  check("bridge holds the 4663 LayerZero endpoint, not the canonical one",
    same(await get(a.bridge, bridgeAbi, "lzEndpoint"), layerZero.endpoint), layerZero.endpoint);

  check("portal.registry points at the factory", same(await get(a.portal, portalAbi, "registry"), a.factory));
  check("portal.buybackModule points at the buyback module", same(await get(a.portal, portalAbi, "buybackModule"), a.buyback));
  check("portal.tokenImplementation points at the clone implementation", same(await get(a.portal, portalAbi, "tokenImplementation"), a.tokenImpl));
  check("portal.deployer points at the direct deployer", same(await get(a.portal, portalAbi, "deployer"), a.directDeployer));
  check("portal holds the 4663 PoolManager", same(await get(a.portal, portalAbi, "poolManager"), uniswapV4.poolManager));
  check("portal holds the 4663 PositionManager", same(await get(a.portal, portalAbi, "positionManager"), uniswapV4.positionManager));
  check("portal holds Permit2", same(await get(a.portal, portalAbi, "permit2"), uniswapV4.permit2));
  check("portal expects hook addresses ending in 0xCC", Number(await get(a.portal, portalAbi, "expectedHookFlags")) === 0xcc);

  const directDeployerAbi = parseAbi(["function portal() view returns (address)"]);
  check("directDeployer.portal is initialized to the portal", same(await get(a.directDeployer, directDeployerAbi, "portal"), a.portal));

  const buybackAbi = parseAbi(["function portal() view returns (address)", "function poolManager() view returns (address)"]);
  check("buyback module points back at the portal", same(await get(a.buyback, buybackAbi, "portal"), a.portal));
  check("buyback module holds the 4663 PoolManager", same(await get(a.buyback, buybackAbi, "poolManager"), uniswapV4.poolManager));

  // ---- the presets and the pairs that were registered
  const launchFee = await get(a.factory, factoryAbi, "launchFee");
  check("the launch fee is the one section 1 announces", launchFee === LAUNCH_FEE, `${formatEther(launchFee)} ETH`);
  const configCount = Number(await get(a.factory, factoryAbi, "configCount"));
  check("three presets are registered", configCount === 3, String(configCount));

  const configs = [];
  for (let i = 0; i < configCount; i++) configs.push(await get(a.factory, factoryAbi, "getConfig", [BigInt(i)]));
  const expected = [
    { startCap: parseEther("1"), graduationCap: parseEther("10"), liquidityBps: 9000 },
    { startCap: parseEther("2"), graduationCap: parseEther("40"), liquidityBps: 9500 },
    { startCap: 5_000_000_000n, graduationCap: 50_000_000_000n, liquidityBps: 9000 },
  ];
  for (let i = 0; i < Math.min(configCount, expected.length); i++) {
    const c = configs[i];
    check(`preset ${i} matches section 2 and is enabled`,
      c[9] === true && c[2] === expected[i].startCap && c[3] === expected[i].graduationCap && c[4] === expected[i].liquidityBps,
      `start ${c[2]} graduation ${c[3]} liquidity ${c[4]}bps`);
    check(`preset ${i} prints a billion tokens with four fifths on the curve`, c[0] === 10n ** 27n && c[1] === 8000);
    check(`preset ${i} splits the fee 30/70 between protocol and creator`, c[5] === 30 && c[6] === 70);
  }

  check("the native pair is allowed", (await get(a.factory, factoryAbi, "pairAllowed", [zeroAddress])) === true);
  check("the native copycat lock threshold is 25 ETH",
    (await get(a.factory, factoryAbi, "lockThreshold", [zeroAddress])) === parseEther("25"));
  check("USDG is allowed as a pair", (await get(a.factory, factoryAbi, "pairAllowed", [USDG])) === true);
  check("the USDG copycat lock threshold is 100,000 USDG",
    (await get(a.factory, factoryAbi, "lockThreshold", [USDG])) === 100_000_000_000n);
  check("USDG is allowed as a direct quote asset", (await get(a.portal, portalAbi, "quoteAllowed", [USDG])) === true);
  check("the direct launch gate is open to everybody",
    (await get(a.portal, portalAbi, "launchEnabled")) === true
    && (await get(a.portal, portalAbi, "whitelistOnly")) === false
    && (await get(a.portal, portalAbi, "canLaunch", [ownerAddress])) === true);
  check("the portal charges the same launch fee as the factory",
    (await get(a.portal, portalAbi, "launchFee")) === LAUNCH_FEE);

  // ---- the econ hash pin
  // Recomputed here from what the chain says, rather than read and trusted: if the pin and the
  // presets ever disagree, every launch that pinned its economics starts reverting, and the only
  // way to know that before a creator finds out is to hash the same fields independently.
  const pinned = await get(a.factory, factoryAbi, "previewLaunchEconomics", [0n, zeroAddress]);
  const c0 = configs[0];
  const local = keccak256(encodeAbiParameters(
    parseAbiParameters("uint256, address, uint256, uint16, uint256, uint256, uint16, uint16, uint16, uint24, int24, uint256, address, address, address"),
    [0n, zeroAddress, c0[0], c0[1], c0[2], c0[3], c0[4], c0[5], c0[6], c0[7], c0[8], launchFee,
      await get(a.factory, factoryAbi, "feeRouter"), await get(a.factory, factoryAbi, "staking"),
      await get(a.factory, factoryAbi, "graduationHandler")],
  ));
  check("the econ hash pins exactly the preset, the fee and the three modules", pinned === local, pinned);
  const again = await get(a.factory, factoryAbi, "previewLaunchEconomics", [0n, zeroAddress]);
  check("the econ hash is stable between two reads", again === pinned);
  const usdgPin = await get(a.factory, factoryAbi, "previewLaunchEconomics", [0n, USDG]);
  check("the econ hash is per pair, so a USDG launch cannot reuse an ETH pin", usdgPin !== pinned);
}

// ================================================================ 5. the curve machine

async function curveMachine(a) {
  step("5. the curve machine: launch, trade, stake, graduate, collect");
  const addresses = { factory: a.factory, feeRouter: a.feeRouter, staking: a.staking, graduator: a.graduator, bridgeFactory: a.bridge };
  const hood = (w) => createHoodClient({ publicClient, walletClient: w.client, addresses });

  const treasuryBefore = await balanceOf(zeroAddress, treasury.address);
  const firstBuy = parseEther("0.2");
  const { hash } = await hood(creator).launch({
    name: "Rehearsal Fam", symbol: "RFAM", feeModel: "staking", description: "the fam takes the fee", firstBuy,
  });
  const { token, curve, receipt: launchReceipt } = await hood(creator).launchResult(hash);
  check("the curve launch landed a token and a curve", Boolean(token) && Boolean(curve), `${token} / ${curve}`);

  const launch = await hood(creator).getLaunch(token);
  check("the registry knows the launch and its fee model", launch.exists && launch.feeModel === "staking" && same(launch.creator, creator.address));
  // Only one of the two things the treasury earns here is pushed to it. The flat launch fee is sent
  // by the factory inside this transaction; the protocol's thirty of the hundred bps the first buy
  // paid as a trading fee is BOOKED on the curve as protocolClaimable and pulled later by anybody
  // calling claimProtocol. That is deliberate, and it is the same decision the direct machine's
  // splitter makes: a push to an address that reverts, or that forwards every wei it is paid,
  // would otherwise be able to freeze a launch. The fee is read off the event, because the curve
  // spends what it can absorb and refunds the rest.
  const firstBuyEvent = eventIn(launchReceipt, curve, boughtEvent);
  const protocolCut = (firstBuyEvent.fee * 30n) / 100n;
  const treasuryTook = (await balanceOf(zeroAddress, treasury.address)) - treasuryBefore;
  check("the launch fee reached the treasury inside the launch transaction",
    treasuryTook === LAUNCH_FEE,
    `${formatEther(treasuryTook)} ETH`);
  const booked = await read(curve, hoodCurveAbi, "protocolClaimable");
  check("the protocol's cut of the first buy is booked on the curve, not pushed",
    booked === protocolCut,
    `${formatEther(booked)} ETH booked, 30 of the 100 bps the first buy paid`);
  // Permissionless on purpose: the keeper does it, and if the keeper dies anybody can.
  const beforeClaim = await balanceOf(zeroAddress, treasury.address);
  await send(alice, curve, hoodCurveAbi, "claimProtocol");
  check("anybody can push the booked protocol fee to the treasury",
    (await balanceOf(zeroAddress, treasury.address)) - beforeClaim === booked
      && (await read(curve, hoodCurveAbi, "protocolClaimable")) === 0n,
    `${formatEther(booked)} ETH claimed by a wallet that is not the treasury`);
  const creatorBag = await balanceOf(token, creator.address);
  check("the creator's first buy landed in the creator's wallet, not the factory's", creatorBag > 0n,
    `${formatEther(creatorBag)} RFAM for ${formatEther(firstBuy)} ETH`);

  // ---- several buys and sells, from separate funded wallets
  for (const [w, amount] of [[alice, "0.5"], [bob, "0.4"], [carol, "0.3"], [alice, "0.6"]]) {
    await wait(await hood(w).buy(curve, parseEther(amount)));
  }
  for (const w of [alice, bob]) {
    const bag = await balanceOf(token, w.address);
    const { pairOut } = await hood(w).quoteSell(curve, bag / 4n);
    const sold = eventIn(await wait(await hood(w).sell(curve, bag / 4n)), curve, soldEvent);
    check(`the curve paid ${w.role} exactly what it quoted for a sell`, sold.pairOut === pairOut,
      `${formatEther(pairOut)} ETH for a quarter of the bag`);
  }
  const state = await hood(creator).getCurveState(curve);
  check("six trades moved the curve", state.sold > 0n && state.reserve > 0n,
    `${formatEther(state.sold)} sold, ${formatEther(state.reserve)} ETH reserve`);
  const accrued = await read(a.feeRouter, hoodFeeRouterAbi, "accrued", [token]);
  check("the trades booked a creator fee in the router", accrued > 0n, `${formatEther(accrued)} ETH`);

  // ---- staking: stake, flush into the model, claim, unstake
  const weight7 = await hood(bob).weightFor(7 * 86400);
  check("a seven day lock is worth 1.25x", weight7 === 12500, String(weight7));
  const bobBag = await balanceOf(token, bob.address);
  const stakeAmount = bobBag / 2n;
  const stakeReceipt = await wait(await hood(bob).stake(token, stakeAmount, 7 * 86400));
  const stakedLog = stakeReceipt.logs.find((l) => same(l.address, a.staking));
  const positionId = BigInt(stakedLog.topics[1]);
  const position = await hood(bob).getStakePosition(positionId);
  check("the stake is recorded against the staker, locked and weighted",
    same(position.owner, bob.address) && position.amount === stakeAmount && position.weightBps === 12500,
    `position ${positionId}, ${formatEther(stakeAmount)} RFAM`);

  const stakingBefore = await balanceOf(zeroAddress, a.staking);
  await send(keeper, a.feeRouter, hoodFeeRouterAbi, "flush", [token]);
  check("the flush emptied the router's book for this token",
    (await read(a.feeRouter, hoodFeeRouterAbi, "accrued", [token])) === 0n);
  check("the flush moved the fee into the staking contract, which is what this fee model means",
    (await balanceOf(zeroAddress, a.staking)) - stakingBefore === accrued, `${formatEther(accrued)} ETH`);
  const pending = await read(a.staking, hoodStakingAbi, "pending", [positionId]);
  check("the staker can claim the fee that just arrived", pending > 0n, `${formatEther(pending)} ETH pending`);

  const bobEthBefore = await balanceOf(zeroAddress, bob.address);
  const claimReceipt = await send(bob, a.staking, hoodStakingAbi, "claim", [positionId]);
  const claimGas = claimReceipt.gasUsed * claimReceipt.effectiveGasPrice;
  const claimed = (await balanceOf(zeroAddress, bob.address)) - bobEthBefore + claimGas;
  check("the claim paid the staker in the pair asset", claimed === pending, `${formatEther(claimed)} ETH`);
  check("nothing is left pending right after a claim",
    (await read(a.staking, hoodStakingAbi, "pending", [positionId])) === 0n);

  let lockHeld = false;
  try {
    await publicClient.simulateContract({ address: a.staking, abi: hoodStakingAbi, functionName: "unstake", args: [positionId], account: bob.account });
  } catch { lockHeld = true; }
  check("a locked position refuses to unstake before its time", lockHeld);

  // ---- graduation into the locked pool
  const remaining = (await hood(carol).getCurveState(curve)).remaining;
  const { pairIn } = await hood(carol).quoteBuyExactOut(curve, remaining);
  await wait(await hood(carol).buyExactOut(curve, remaining, (pairIn * 12n) / 10n));
  check("buying the rest of the curve sold it out", (await hood(carol).getCurveState(curve)).phase === "sold");

  await send(keeper, curve, parseAbi(["function finalize()"]), "finalize");
  const gradAbi = parseAbi([
    "function isGraduated(address) view returns (bool)",
    "function positionOf(address) view returns ((address,address,uint24,int24,address) key, uint256 tokenId)",
    "function collect(address)",
  ]);
  check("the curve graduated when anybody finalized it", (await read(a.graduator, gradAbi, "isGraduated", [token])) === true);
  const [poolKey, tokenId] = await read(a.graduator, gradAbi, "positionOf", [token]);
  const positionOwner = await read(uniswapV4.positionManager, parseAbi(["function ownerOf(uint256) view returns (address)"]), "ownerOf", [tokenId]);
  check("the graduated position is held by the graduator, which has no way to give it back",
    tokenId > 0n && same(positionOwner, a.graduator), `position ${tokenId}`);

  const stateViewAbi = parseAbi([
    "function getSlot0(bytes32) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
    "function getLiquidity(bytes32) view returns (uint128)",
  ]);
  const key = { currency0: poolKey[0], currency1: poolKey[1], fee: poolKey[2], tickSpacing: poolKey[3], hooks: poolKey[4] };
  const poolId = keccak256(encodeAbiParameters(
    parseAbiParameters("address, address, uint24, int24, address"),
    [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]));
  const [sqrtPriceX96] = await read(uniswapV4.stateView, stateViewAbi, "getSlot0", [poolId]);
  const liquidity = await read(uniswapV4.stateView, stateViewAbi, "getLiquidity", [poolId]);
  check("the real pool is open, priced and holds the graduated liquidity",
    sqrtPriceX96 > 0n && liquidity > 0n, `sqrtPrice ${sqrtPriceX96}, liquidity ${liquidity}`);
  check("the graduator kept nothing for itself",
    (await balanceOf(token, a.graduator)) === 0n && (await balanceOf(zeroAddress, a.graduator)) === 0n);

  // ---- a real swap on the graduated pool, then a permissionless collect
  const amountIn = parseEther("0.25");
  const { commands, inputs } = buildSwap({
    key, zeroForOne: same(key.currency0, zeroAddress), amountIn, minAmountOut: 0n,
    tokenIn: zeroAddress, tokenOut: token,
  });
  const args = [commands, inputs, await deadline()];
  const gas = await publicClient.estimateContractGas({
    address: uniswapV4.universalRouter, abi: universalRouterAbi, functionName: "execute", args, value: amountIn, account: alice.account,
  });
  const swapperBefore = await balanceOf(token, alice.address);
  await wait(await alice.client.writeContract({
    address: uniswapV4.universalRouter, abi: universalRouterAbi, functionName: "execute", args, value: amountIn, gas: (gas * 13n) / 10n,
  }));
  const gained = (await balanceOf(token, alice.address)) - swapperBefore;
  check("anybody can swap the graduated pool through the forked UniversalRouter", gained > 0n,
    `${formatEther(amountIn)} ETH bought ${formatEther(gained)} RFAM`);

  await send(carol, a.graduator, gradAbi, "collect", [token]);
  const collected = await read(a.feeRouter, hoodFeeRouterAbi, "accrued", [token]);
  check("a permissionless collect brought the pool fee back into the fee model", collected > 0n, `${formatEther(collected)} ETH`);

  const pendingAfter = await read(a.staking, hoodStakingAbi, "pending", [positionId]);
  await send(keeper, a.feeRouter, hoodFeeRouterAbi, "flush", [token]);
  check("flushing the collected fee pays the stakers again",
    (await read(a.staking, hoodStakingAbi, "pending", [positionId])) > pendingAfter);

  return { token, curve, positionId, stakeAmount, holders: [creator, alice, bob, carol] };
}

// ================================================================ 6. the direct machine

async function directMachine(a) {
  step("6. the direct machine: portal launch, hook taxes, splitter, buyback");
  const direct = (w) => createDirectClient({
    publicClient, walletClient: w.client,
    addresses: { portal: a.portal, deployer: a.directDeployer, buybackModule: a.buyback },
  });

  const SUPPLY = 1_000_000_000;
  const SPACING = 200;
  const tickFor = (fdv) => Math.round(Math.log(SUPPLY / fdv) / Math.log(1.0001) / SPACING) * SPACING;
  const RESTRICTION_BLOCKS = 12;
  const SNIPE_BPS = 5000;
  const SNIPE_SECONDS = 60;

  const salt = await direct(creator).hookSalt();
  check("a hook salt was mined to an address ending in 0xCC", (BigInt(salt.hook) & 0x3fffn) === 0xccn,
    `${salt.hook} in ${salt.attempts} attempts`);

  const initialBuy = parseEther("0.1");
  const launched = await direct(creator).launch({
    name: "Rehearsal Direct", symbol: "RDIR", logo: "ipfs://rdir", description: "the supply is the liquidity",
    socials: { twitter: "@rdir", website: "https://hood.fam" },
    tickStart: tickFor(10), tickBond: tickFor(100), restrictionBlocks: RESTRICTION_BLOCKS,
    snipeTaxBps: SNIPE_BPS, snipeDecaySeconds: SNIPE_SECONDS, initialBuy, salt: salt.salt,
  });
  const receipt = await wait(launched.hash);
  const log = receipt.logs.find((l) => same(l.address, a.portal) && l.topics.length >= 4);
  const token = `0x${log.topics[1].slice(26)}`;
  const row = await direct(creator).getLaunch(token);
  check("the portal registered the launch with its four contracts",
    row.exists && same(row.hook, salt.hook) && row.splitter !== zeroAddress && row.locker !== zeroAddress,
    `hook ${row.hook} splitter ${row.splitter} locker ${row.locker}`);
  check("the pool was opened inside the launch transaction, so nobody could open it first",
    (await direct(creator).poolKey(row.locker)).hooks.toLowerCase() === row.hook.toLowerCase());
  const taxedEvent = parseAbiItem("event Taxed(bool isBuy, uint256 fee, uint256 volume)");
  // `volume` is what the pool moved in the quote, which sits on a different side of the fee for
  // each direction: a buy is taxed off the input before the swap, a sell out of what the pool pays.
  const rateOf = (r) => {
    const t = eventIn(r, row.hook, taxedEvent);
    return Number(t.isBuy ? (t.fee * 10_000n) / (t.fee + t.volume) : (t.fee * 10_000n) / t.volume);
  };
  const creatorBag = await balanceOf(token, creator.address);
  check("the creator's first buy went through the hook at the base rate, not the snipe rate",
    creatorBag > 0n && rateOf(receipt) === 500,
    `${formatEther(creatorBag)} RDIR at ${rateOf(receipt)}bps`);

  // ---- the snipe surcharge window
  const openTax = await direct(creator).taxes(row.hook);
  check("the surcharge is live the moment the pool opens",
    openTax.snipeBps > 0 && openTax.buyBps === openTax.baseBuyBps + openTax.snipeBps,
    `${openTax.buyBps}bps = ${openTax.baseBuyBps} base + ${openTax.snipeBps} snipe`);

  const poolKey = await direct(creator).poolKey(row.locker);
  const tokenIsZero = same(poolKey.currency0, token);
  const swapThrough = async (w, amountIn, tokenIn, tokenOut) => {
    const { commands, inputs } = buildSwap({
      key: poolKey, zeroForOne: same(tokenIn, poolKey.currency0), amountIn, minAmountOut: 0n, tokenIn, tokenOut,
    });
    const args = [commands, inputs, await deadline()];
    const value = tokenIn === zeroAddress ? amountIn : 0n;
    // A hooked pool's gas moves with the clock: the surcharge decays between the estimate and the
    // block that executes it. Wallets pad estimates; a script has to pad its own.
    const gas = await publicClient.estimateContractGas({
      address: uniswapV4.universalRouter, abi: universalRouterAbi, functionName: "execute", args, value, account: w.account,
    });
    return wait(await w.client.writeContract({
      address: uniswapV4.universalRouter, abi: universalRouterAbi, functionName: "execute", args, value, gas: (gas * 13n) / 10n,
    }));
  };
  // The opening window caps a wallet's buy and its holding; a whale trying to take the open is the
  // exact thing it exists to refuse.
  let windowHeld = false;
  const whaleDeadline = await deadline();
  try {
    await publicClient.estimateContractGas({
      address: uniswapV4.universalRouter, abi: universalRouterAbi, functionName: "execute",
      args: (() => { const s = buildSwap({ key: poolKey, zeroForOne: !tokenIsZero, amountIn: parseEther("5"), minAmountOut: 0n, tokenIn: zeroAddress, tokenOut: token }); return [s.commands, s.inputs, whaleDeadline]; })(),
      value: parseEther("5"), account: bob.account,
    });
  } catch { windowHeld = true; }
  check("the opening window refuses a buy over the cap", windowHeld, "5 ETH inside the restriction blocks");

  const snipeReceipt = await swapThrough(alice, parseEther("0.05"), zeroAddress, token);
  const snipeRate = rateOf(snipeReceipt);
  check("a buy inside the window paid the surcharge", snipeRate > openTax.baseBuyBps + 1000, `${snipeRate}bps taken`);

  // ---- past the window and past the decay
  const endBlock = Number(row.restrictionsEndBlock);
  const at = Number(await publicClient.getBlockNumber());
  if (endBlock >= at) await mine(endBlock - at + 1);
  await warp(SNIPE_SECONDS + 1);
  const calm = await direct(creator).taxes(row.hook);
  check("the surcharge decays to nothing", calm.snipeBps === 0 && calm.buyBps === calm.baseBuyBps, `${calm.buyBps}bps`);

  const calmReceipt = await swapThrough(bob, parseEther("1"), zeroAddress, token);
  const calmRate = rateOf(calmReceipt);
  check("a buy after the decay pays only the launch's own tax", Math.abs(calmRate - calm.baseBuyBps) <= 1,
    `${calmRate}bps against a base of ${calm.baseBuyBps}`);
  await swapThrough(carol, parseEther("2"), zeroAddress, token);

  // The sell goes through the SDK's own path, which quotes on the chain's quoter and walks the
  // Permit2 dance the router needs: the part a wallet does and a raw encoder skips.
  const aliceBag = await balanceOf(token, alice.address);
  const sellQuote = await direct(alice).quote({ token, side: "sell", amountIn: aliceBag / 2n, slippageBps: 500 });
  check("the chain's quoter prices a sell through the hook", sellQuote.amountOut > 0n, `${formatEther(sellQuote.amountOut)} ETH out`);
  const sell = await direct(alice).swap({ token, side: "sell", amountIn: aliceBag / 2n, slippageBps: 500 });
  const sellReceipt = await wait(sell.hash);
  check("a sell through the hook is taxed on the way out", rateOf(sellReceipt) >= calm.baseSellBps - 1,
    `${rateOf(sellReceipt)}bps against a base of ${calm.baseSellBps}`);

  // ---- the splitter: the four way split, the protocol's tenth, the buyback
  await send(keeper, row.hook, parseAbi(["function flushClaims()"]), "flushClaims");
  check("the tax held as claims was realised into the splitter",
    (await direct(creator).claimsHeld(row.hook)) === 0n && (await direct(creator).unaccounted(row.splitter, row.quote)) > 0n);

  const sweptEvent = parseAbiItem("event Swept(uint256 total, uint256 protocol, uint256 creator, uint256 buyback, uint256 dividends, uint256 liquidity)");
  const swept = eventIn(await send(keeper, row.splitter, parseAbi(["function sweep()"]), "sweep"), row.splitter, sweptEvent);
  const buckets = await direct(creator).buckets(row.splitter);
  const rest = swept.total - swept.protocol;
  check("the protocol's tenth came off the top first", swept.protocol === (swept.total * 1000n) / 10000n,
    `${formatEther(swept.protocol)} of ${formatEther(swept.total)} ETH`);
  check("the rest split four ways exactly as the launch declared",
    swept.creator === (rest * BigInt(buckets.allocations.creatorBps)) / 10000n
    && swept.buyback === (rest * BigInt(buckets.allocations.buybackBps)) / 10000n
    && swept.dividends === (rest * BigInt(buckets.allocations.dividendsBps)) / 10000n
    && swept.creator + swept.buyback + swept.dividends + swept.liquidity === rest,
    `${buckets.allocations.creatorBps}/${buckets.allocations.buybackBps}/${buckets.allocations.dividendsBps}/${buckets.allocations.liquidityBps} bps`);

  const holderDividends = await direct(creator).pendingDividends(row.splitter, bob.address);
  check("a holder has dividends waiting", holderDividends > 0n, `${formatEther(holderDividends)} ETH for one holder`);
  const bobBefore = await balanceOf(zeroAddress, bob.address);
  await send(keeper, row.splitter, parseAbi(["function claimDividends(address) returns (uint256)"]), "claimDividends", [bob.address]);
  check("anybody can push a holder's dividends to the holder",
    (await balanceOf(zeroAddress, bob.address)) - bobBefore === holderDividends);

  const creatorEth = await balanceOf(zeroAddress, creator.address);
  const creatorClaim = buckets.creatorClaimable;
  const claimReceipt = await send(creator, row.splitter, parseAbi(["function claim(address) returns (uint256)"]), "claim", [creator.address]);
  check("the creator's bucket pays the creator",
    (await balanceOf(zeroAddress, creator.address)) - creatorEth + claimReceipt.gasUsed * claimReceipt.effectiveGasPrice === creatorClaim,
    `${formatEther(creatorClaim)} ETH`);

  const protocolClaimable = await direct(creator).protocolClaimable(row.splitter);
  const treasuryBefore = await balanceOf(zeroAddress, treasury.address);
  check("nothing reached the treasury before somebody pulled it", protocolClaimable === swept.protocol);
  await send(keeper, row.splitter, parseAbi(["function claimProtocol() returns (uint256)"]), "claimProtocol");
  check("claimProtocol pays the portal's current treasury",
    (await balanceOf(zeroAddress, treasury.address)) - treasuryBefore === protocolClaimable,
    `${formatEther(protocolClaimable)} ETH`);

  const supplyBefore = await read(token, erc20Abi, "totalSupply");
  const expectedBurn = await direct(keeper).quoteBuyback(token);
  check("the buyback module quotes what a run would burn", expectedBurn > 0n, `${formatEther(expectedBurn)} RDIR`);
  await send(keeper, a.buyback, parseAbi(["function run(address,uint256) returns (uint256)"]), "run", [token, 1n]);
  const supplyAfter = await read(token, erc20Abi, "totalSupply");
  check("one permissionless buyback run bought and burned", supplyAfter < supplyBefore,
    `${formatEther(supplyBefore - supplyAfter)} RDIR burned`);

  await send(keeper, row.splitter, parseAbi(["function pushLiquidity() returns (uint256)"]), "pushLiquidity");
  await send(keeper, row.locker, parseAbi(["function deepen()"]), "deepen");
  await send(keeper, row.locker, parseAbi(["function harvestFees()"]), "harvestFees");
  const status = await direct(creator).graduationStatus(token);
  check("the launch reports its distance to bonding",
    status.progressBps >= 0 && status.progressBps <= 10000, `${status.progressBps}bps, bonded ${status.bonded}`);

  return { token, hook: row.hook, splitter: row.splitter, locker: row.locker };
}

// ================================================================ 7. the lock runs out

/// Kept out of section 5 on purpose: jumping the fork seven days forward puts its clock far ahead
/// of this machine's, and the SDK signs its router calls with a deadline ten minutes past the wall
/// clock. So the jump happens once every swap in the rehearsal is behind us.
async function lockExpiry(a, curve) {
  step("7. the seven day lock runs out");
  await warp(7 * 86400 + 60);
  const before = await balanceOf(curve.token, bob.address);
  await send(bob, a.staking, hoodStakingAbi, "unstake", [curve.positionId]);
  check("the stake came back once the lock ran out",
    (await balanceOf(curve.token, bob.address)) - before === curve.stakeAmount, `${formatEther(curve.stakeAmount)} RFAM`);
}

// ================================================================ 4 and 8. the indexer and the read api

async function startApi(a) {
  step("4. the indexer and the read api start following the fork");
  const distIndex = join(ROOT, "apps/api/dist/index.js");
  check("the api is built", existsSync(distIndex), "apps/api/dist/index.js");
  const newestSrc = Math.max(...readdirSync(join(ROOT, "apps/api/src")).map((f) => statSync(join(ROOT, "apps/api/src", f)).mtimeMs));
  if (newestSrc > statSync(distIndex).mtimeMs) console.warn("warning: apps/api/src is newer than apps/api/dist; run npm run build -w @hood/api");

  // A run against a database that already holds rows proves nothing, so this one is thrown away and
  // made again every time. It is never the deployment's own database: E2E_DB names its own.
  const admin = new pg.Client({ connectionString: PG_ADMIN });
  await admin.connect();
  await admin.query(`drop database if exists ${DB_NAME} with (force)`);
  await admin.query(`create database ${DB_NAME}`);
  await admin.end();
  const fresh = new pg.Client({ connectionString: DB_URL });
  await fresh.connect();
  const { rows: tables } = await fresh.query(`select count(*)::int as n from pg_tables where schemaname = 'public'`);
  await fresh.end();
  check("an empty database was created for this run", tables[0].n === 0, DB_NAME);

  background("api", process.execPath, [distIndex], {
    DATABASE_URL: DB_URL,
    HOOD_RPC: RPC,
    HOOD_FACTORY: a.factory, HOOD_FEE_ROUTER: a.feeRouter, HOOD_STAKING: a.staking, HOOD_GRADUATOR: a.graduator,
    HOOD_BRIDGE_FACTORY: a.bridge, HOOD_PORTAL: a.portal, HOOD_DIRECT_DEPLOYER: a.directDeployer,
    HOOD_BUYBACK_MODULE: a.buyback, HOOD_SEASON_DROP: a.seasonDrop,
    HOOD_START_BLOCK: String(a.startBlock),
    HOOD_ETH_USD: ETH_USD_FALLBACK,
    HOOD_POLL_MS: "300", HOOD_LOG_CHUNK: "5000",
    // No confirmation lag here. On mainnet the indexer stays a dozen blocks behind the head, because
    // everything it writes accumulates and a reorged block would leave numbers nothing recomputes.
    // An anvil fork mines only when this script sends something and never reorgs, so the lag would
    // only mean the indexer can never reach a head that has stopped moving.
    HOOD_CONFIRMATIONS: "0",
    HOOD_ADMIN_TOKEN: ADMIN_TOKEN,
    PORT: String(API_PORT), INDEXER: "1", API: "1",
    LOG_LEVEL: "warn", NODE_ENV: "development", TRUST_PROXY: "false", RATE_LIMIT_TRUST_LOCAL: "1",
    SEASON_POOL_BPS: "3000", LAUNCH_POINTS_MIN_USD: "1000",
    ANTHROPIC_API_KEY: "", OPENROUTER_API_KEY: "", RELAY_API_KEY: "",
  });

  let up = false;
  for (let i = 0; i < 120; i++) {
    const h = await api("/health").catch(() => ({ status: 0 }));
    if (h.status === 200) { up = true; break; }
    await sleep(500);
  }
  check("the api answers /health", up, API);
}

async function waitForIndexer() {
  const head = await publicClient.getBlockNumber();
  for (let i = 0; i < 240; i++) {
    const h = await api("/health");
    if (h.body?.indexedBlock != null && BigInt(h.body.indexedBlock) >= head) return head;
    await sleep(500);
  }
  check("the indexer caught up with the fork", false, `head ${head}`);
}

async function checkApi(a, curve, direct) {
  const head = await waitForIndexer();
  check("the indexer caught up with the fork", true, `block ${head}`);

  // ---- the chain's own numbers, read off the fork rather than remembered
  const [buys, sells] = await Promise.all([
    publicClient.getLogs({ address: curve.curve, event: boughtEvent, fromBlock: a.startBlock, toBlock: head }),
    publicClient.getLogs({ address: curve.curve, event: soldEvent, fromBlock: a.startBlock, toBlock: head }),
  ]);
  const onChainTrades = buys.length + sells.length;
  const onChainVolume = buys.reduce((s, l) => s + l.args.pairIn, 0n) + sells.reduce((s, l) => s + l.args.pairOut, 0n);

  const row = await api(`/tokens/${curve.token}`);
  check("the api knows the curve token", row.status === 200 && same(row.body.token, curve.token), curve.token);
  check("the api's trade count is the chain's trade count",
    Number(row.body.trades_total) === onChainTrades, `${row.body.trades_total} = ${onChainTrades}`);
  check("the api's total volume is the sum of the pair legs on chain",
    BigInt(row.body.volume_total) === onChainVolume, `${formatEther(onChainVolume)} ETH`);
  check("the api calls the graduated token graduated", row.body.status === "graduated" && row.body.phase === 2);

  const trades = await api(`/tokens/${curve.token}/trades?limit=500`);
  check("the trade feed has one row per event", trades.body.trades.length === onChainTrades, String(trades.body.trades.length));

  // ---- holders, each one checked against the token contract itself
  const holders = await api(`/tokens/${curve.token}/holders`);
  const wrong = [];
  for (const h of holders.body.holders) {
    const onChain = await balanceOf(curve.token, h.address);
    if (onChain !== BigInt(h.balance)) wrong.push(`${h.address} api ${h.balance} chain ${onChain}`);
  }
  check("every holder balance the api serves matches the token contract",
    wrong.length === 0 && holders.body.holders.length > 0,
    wrong.length ? wrong.join(" | ") : `${holders.body.holders.length} holders`);
  for (const w of curve.holders) {
    const onChain = await balanceOf(curve.token, w.address);
    const served = holders.body.holders.find((h) => same(h.address, w.address));
    if (onChain > 0n) check(`the api lists ${w.address.slice(0, 8)} with the chain's balance`,
      served && BigInt(served.balance) === onChain, formatEther(onChain));
  }

  // ---- the direct launch, which is a different set of events entirely
  const directRow = await api(`/tokens/${direct.token}`);
  check("the api knows the direct launch and its own contracts",
    directRow.status === 200 && directRow.body.mode === "direct" && same(directRow.body.hook, direct.hook)
    && same(directRow.body.splitter, direct.splitter) && same(directRow.body.locker, direct.locker),
    direct.token);
  check("the api counted the direct pool's swaps", Number(directRow.body.trades_total) > 0
    && BigInt(directRow.body.volume_total) > 0n, `${directRow.body.trades_total} trades`);
  check("the api carries the direct launch's tax shape",
    directRow.body.buy_tax_bps === 500 && directRow.body.sell_tax_bps === 500 && directRow.body.snipe_tax_bps === 5000);

  const stats = await api("/stats");
  check("the api counts both launches and one graduation",
    Number(stats.body.launches) === 2 && Number(stats.body.graduated) >= 1,
    `${stats.body.launches} launches, ${stats.body.graduated} graduated`);

  // ---- points, which is the number the season drop is paid against
  const board = await api("/leaderboard?limit=250");
  check("the leaderboard has the wallets that traded", board.body.rows.length > 0, `${board.body.rows.length} wallets`);
  const top = board.body.rows[0];
  const point = await api(`/points/${top.address}`);
  check("the leaderboard and the wallet's own points agree",
    Math.abs(point.body.points - top.points) < 0.01, `${top.address.slice(0, 8)} has ${top.points} points`);
  check("the creator earned the 500 for printing a token that actually traded",
    (await api(`/points/${creator.address}`)).body.breakdown.some((b) => b.kind === "launch"),
    creator.address);
  const totals = board.body.rows.reduce((s, r) => s + r.points, 0);
  check("every wallet on the board has points and none of them is a system contract",
    totals > 0 && board.body.rows.every((r) => r.points > 0 && !same(r.address, a.factory) && !same(r.address, a.portal)
      && !same(r.address, a.buyback) && !same(r.address, uniswapV4.universalRouter)),
    `${totals.toFixed(0)} points across the board`);

  const overview = await adminGet("/admin/overview");
  check("the admin overview reports the deployment the process actually holds",
    overview.status === 200 && same(overview.body.contracts.factory, a.factory) && same(overview.body.contracts.portal, a.portal),
    `${overview.body?.blocksBehind} blocks behind`);
  return board.body.rows;
}

// ================================================================ 9. the season drop

async function seasonDrop(a) {
  step("9. the season, the tree, the funded drop and a claim");
  const seasons = await adminGet("/admin/seasons");
  check("the api opened season 1 by itself", seasons.status === 200 && seasons.body.current === 1);

  const opened = await adminPost("/admin/seasons", { name: "Season 2" });
  check("opening season 2 closed season 1 at the same instant",
    opened.status === 200 && opened.body.season.id === 2, opened.body?.season?.starts);
  const after = await adminGet("/admin/seasons");
  check("season 1 now has an end", after.body.seasons.find((s) => s.id === 1)?.ends !== null);

  const snap = await adminPost("/admin/seasons/1/snapshot");
  check("season 1 froze a board with wallets on it", snap.status === 200 && snap.body.rows > 0, `${snap.body?.rows} rows`);

  const POOL = parseEther("1");
  const built = await adminPost("/admin/airdrop/1/build", { poolWei: POOL.toString() });
  check("the tree was built over every wallet that earned a point",
    built.status === 200 && /^0x[0-9a-f]{64}$/.test(built.body.root ?? ""), built.body?.root);
  check("the tree is funded to the wei", built.body.total === POOL.toString(), `${formatEther(POOL)} ETH`);
  check("the list has claimants", Number(built.body.claims) > 0, `${built.body?.claims} wallets`);

  const board = await api("/leaderboard?season=1&limit=250");
  const claimant = board.body.rows[0]?.address;
  check("season 1's frozen board names a wallet to pay", Boolean(claimant), `${board.body.rows.length} on the board`);
  const proof = await api(`/airdrop/1/proof/${claimant}`);
  check("the proof route serves a wallet its row", proof.status === 200 && proof.body.root === built.body.root,
    `${claimant.slice(0, 8)} gets ${formatEther(BigInt(proof.body.amount))} ETH`);
  check("the proof verifies locally against the published root",
    StandardMerkleTree.verify(built.body.root, ["uint256", "address", "uint256"],
      [String(proof.body.season), proof.body.address, proof.body.amount], proof.body.proof));

  const latest = await publicClient.getBlock();
  const claimDeadline = BigInt(latest.timestamp) + BigInt(31 * 86400);
  let tooShort = false;
  try {
    await publicClient.simulateContract({
      address: a.seasonDrop, abi: hoodSeasonDropAbi, functionName: "openDrop",
      args: [1n, built.body.root, zeroAddress, POOL, BigInt(latest.timestamp) + 86400n],
      value: POOL, account: owner.account,
    });
  } catch { tooShort = true; }
  check("a claim window under thirty days is refused", tooShort);

  await send(owner, a.seasonDrop, hoodSeasonDropAbi, "openDrop", [1n, built.body.root, zeroAddress, POOL, claimDeadline], POOL);
  const drop = await read(a.seasonDrop, hoodSeasonDropAbi, "drops", [1n]);
  check("the drop is open, funded and pinned to the published root",
    drop[0] === built.body.root && drop[2] === POOL && (await balanceOf(zeroAddress, a.seasonDrop)) === POOL,
    `${formatEther(POOL)} ETH held`);

  const amount = BigInt(proof.body.amount);
  check("the contract agrees the row would pay",
    (await read(a.seasonDrop, hoodSeasonDropAbi, "isClaimable", [1n, proof.body.address, amount, proof.body.proof])) === true);

  const before = await balanceOf(zeroAddress, proof.body.address);
  // The keeper pays somebody else's claim: the contract always pays `account`, never the caller.
  await send(keeper, a.seasonDrop, hoodSeasonDropAbi, "claim", [1n, proof.body.address, amount, proof.body.proof]);
  check("the claim paid the wallet on the list, not the wallet that sent it",
    (await balanceOf(zeroAddress, proof.body.address)) - before === amount, `${formatEther(amount)} ETH`);
  check("the contract records the claim", (await read(a.seasonDrop, hoodSeasonDropAbi, "claimed", [1n, proof.body.address])) === true);

  let twice = false;
  try {
    await publicClient.simulateContract({
      address: a.seasonDrop, abi: hoodSeasonDropAbi, functionName: "claim",
      args: [1n, proof.body.address, amount, proof.body.proof], account: keeper.account,
    });
  } catch { twice = true; }
  check("the same row cannot be claimed twice", twice);
  check("what is left is exactly the pool minus that claim",
    (await read(a.seasonDrop, hoodSeasonDropAbi, "unclaimed", [1n])) === POOL - amount, formatEther(POOL - amount) + " ETH");
}

// ================================================================ the run

const started = Date.now();

if (WIRING_ONLY) {
  // The other half of this file's value: the same wiring checks against a real deployment.
  step("the wiring, against the addresses in the environment");
  const need = (k) => { const v = process.env[k]; if (!v) { check(`${k} is set`, false); } return v; };
  const client = createPublicClient({ chain: robinhood, transport: http(FORK_RPC) });
  await checkWiring({
    client,
    a: {
      factory: need("HOOD_FACTORY"), feeRouter: need("HOOD_FEE_ROUTER"), staking: need("HOOD_STAKING"),
      graduator: need("HOOD_GRADUATOR"), bridge: need("HOOD_BRIDGE_FACTORY"), portal: need("HOOD_PORTAL"),
      directDeployer: need("HOOD_DIRECT_DEPLOYER"), tokenImpl: need("HOOD_TOKEN_IMPLEMENTATION"),
      buyback: need("HOOD_BUYBACK_MODULE"), bytecodeDeployer: process.env.HOOD_BYTECODE_DEPLOYER,
      seasonDrop: process.env.HOOD_SEASON_DROP,
    },
    owner: need("OWNER"), treasury: need("TREASURY"),
  });
} else {
  await startAnvil();
  const a = await deploy();
  step("3. the wiring a real deploy would want checked");
  await checkWiring({ client: publicClient, a, owner: owner.address, treasury: treasury.address });
  await startApi(a);
  const curve = await curveMachine(a);
  const direct = await directMachine(a);
  await lockExpiry(a, curve);
  step("8. the api's own numbers, against the chain");
  await checkApi(a, curve, direct);
  await seasonDrop(a);
  console.log(`\naddresses: ${JSON.stringify(a, (_, v) => (typeof v === "bigint" ? v.toString() : v), 1)}`);
}

summary();
console.log(`took ${((Date.now() - started) / 1000).toFixed(0)}s, logs in ${runDir}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
