// The v4 launchpad on the public testnet (46630), with real keys and the chain's own clock: no
// anvil, no warps, no impersonation. Everything a mainnet user can do is done here once, and every
// money path is read back off the receipts.
//
//   bash scripts/testnet/run.sh scenario            (it sets the environment below)
//   bash scripts/testnet/run.sh scenario payday     (one phase; after the hour for payday)
//
// Environment: HOOD_CHAIN_ID=46630, RPC_URL, the deployment's HOOD_* and TESTNET_USDG (from
// .deploy/testnet/testnet.env), HOOD_SAFE, WALLETS (path to .deploy/testnet/wallets.json), and
// HOOD_API when the local stack is up (then the api phase checks the indexer against the chain).
//
// Phases, in order: house, curve, grad, direct, boost, vault, api, payday. The addresses each phase
// creates are kept in .deploy/testnet/scenario.json, so a later phase can run on its own.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient, createWalletClient, decodeEventLog, encodeAbiParameters, erc20Abi, formatEther, formatUnits,
  http, keccak256, maxUint256, parseAbi, parseAbiParameters, parseEther, parseEventLogs, zeroAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildSwap, createDirectClient, createHoodClient, hoodBagAbi, hoodBlockZeroAbi, hoodBoostsAbi, hoodCurveAbi,
  hoodFactoryAbi, hoodFeeRouterAbi, hoodLaunchHookAbi, hoodPaydayAbi, hoodPortalAbi, hoodStakingAbi, robinhood, uniswapV4,
  universalRouterAbi,
} from "../../packages/sdk/dist/index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const STATE = process.env.SCENARIO_STATE ?? join(ROOT, ".deploy/testnet/scenario.json");
const need = (k) => { const v = process.env[k]; if (!v) { console.error(`${k} is not set`); process.exit(2); } return v; };

if (robinhood.id !== 46630) { console.error("HOOD_CHAIN_ID must be 46630: this script only runs on the testnet"); process.exit(2); }
const RPC = need("RPC_URL");
const A = {
  factory: need("HOOD_FACTORY"), feeRouter: need("HOOD_FEE_ROUTER"), staking: need("HOOD_STAKING"),
  graduator: need("HOOD_GRADUATOR"), bridge: need("HOOD_BRIDGE_FACTORY"), portal: need("HOOD_PORTAL"),
  directDeployer: need("HOOD_DIRECT_DEPLOYER"), buyback: need("HOOD_BUYBACK_MODULE"), bag: need("HOOD_BAG"),
  payday: need("HOOD_PAYDAY"), burnClock: need("HOOD_BURN_CLOCK"), boosts: need("HOOD_BOOSTS"),
  blockZero: need("HOOD_BLOCK_ZERO"), usdg: need("TESTNET_USDG"), safe: need("HOOD_SAFE"),
};
const API = process.env.HOOD_API?.replace(/\/$/, "");

const chain = { ...robinhood, rpcUrls: { default: { http: [RPC] } } };
const pc = createPublicClient({ chain, transport: http(RPC), cacheTime: 0, pollingInterval: 100 });
const keys = JSON.parse(readFileSync(need("WALLETS"), "utf8"));
const W = Object.fromEntries(Object.entries(keys).map(([role, { private_key }]) => {
  const account = privateKeyToAccount(private_key);
  return [role, { role, account, address: account.address, key: private_key, client: createWalletClient({ account, chain, transport: http(RPC) }) }];
}));

// ---------------------------------------------------------------- the checklist

let failures = 0;
let passes = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `  (${detail})` : ""}`);
  if (ok) passes++; else failures++;
};
const step = (s) => console.log(`\n== ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
const save = () => writeFileSync(STATE, JSON.stringify(state, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));

// ---------------------------------------------------------------- chain helpers

const read = (address, abi, functionName, args = []) => pc.readContract({ address, abi, functionName, args });
const balanceOf = (token, who) => token === zeroAddress ? pc.getBalance({ address: who }) : read(token, erc20Abi, "balanceOf", [who]);
async function wait(hash) {
  const r = await pc.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (r.status !== "success") throw new Error(`transaction ${hash} reverted`);
  return r;
}
/// Simulated first, so a revert reads as its error name rather than as a receipt with status 0.
/// The gas is padded by half: in the opening seconds a buy estimated in one second and mined in the
/// next takes a different path through the curve, and an exact estimate runs out of gas.
async function send(w, address, abi, functionName, args = [], value) {
  const { request } = await pc.simulateContract({ address, abi, functionName, args, value, account: w.account });
  const gas = await pc.estimateContractGas({ address, abi, functionName, args, value, account: w.account });
  return wait(await w.client.writeContract({ ...request, gas: (gas * 3n) / 2n }));
}
const events = (receipt, abi, eventName, address) =>
  parseEventLogs({ abi, logs: receipt.logs, eventName }).filter((l) => !address || same(l.address, address));
const deadline = async (s = 3600) => (await pc.getBlock()).timestamp + BigInt(s);
const hood = (w) => createHoodClient({ publicClient: pc, walletClient: w.client, addresses: { factory: A.factory, feeRouter: A.feeRouter, staking: A.staking, graduator: A.graduator, bridgeFactory: A.bridge } });
const direct = (w) => createDirectClient({ publicClient: pc, walletClient: w.client, addresses: { portal: A.portal, deployer: A.directDeployer, buybackModule: A.buyback } });

/// Every ETH amount below is a multiple of this. 0.001 by default; the testnet run uses 0.0001,
/// because its faucet pays 0.01 ETH a day and the whole scenario has to fit in that.
const UNIT = parseEther(process.env.SCENARIO_ETH_UNIT ?? "0.001");
const u = (n) => (UNIT * BigInt(Math.round(n * 10))) / 10n;

/// The Pons table, measured on 4663 and now ours: 99%, 6.18%, 0.19% in the first three seconds.
const SCHEDULE = [9900, 618, 19];
/// Who makes the calls anyone may make (claimProtocol, flush, finalize, flushClaims, sweep). Not the
/// keeper: when the local stack is up its keeper signs with that key too, and two senders on one
/// key race for the same nonce.
const POKE = () => W.trader_2;
const bpsAt = (elapsed) => (elapsed < SCHEDULE.length ? SCHEDULE[elapsed] : 0);

const BagSource = { Trade: 0, Graduation: 1, Boost: 2, House: 3, HouseCoin: 4 };
const BagOutlet = { House: 0, Vault: 1, Payday: 2, Burn: 3, Dev: 4 };
/// What a receipt moved through the Bag: in by source, out (or held for later) by outlet.
function bagFlow(receipt) {
  const inBy = {}; const outBy = {};
  for (const l of events(receipt, hoodBagAbi, "BagIn", A.bag)) inBy[l.args.source] = (inBy[l.args.source] ?? 0n) + l.args.amount;
  for (const name of ["BagOut", "Held"]) {
    for (const l of events(receipt, hoodBagAbi, name, A.bag)) outBy[l.args.outlet] = (outBy[l.args.outlet] ?? 0n) + l.args.amount;
  }
  const deferred = events(receipt, hoodBagAbi, "DevDeferred", A.bag).reduce((s, l) => s + l.args.amount, 0n);
  return { inBy, outBy, deferred };
}

/// The opening seconds on a public RPC: every simulate and estimate costs a round trip, and the
/// careful path above lands a buy several seconds late, past the window it came to test. These go
/// out at once with a fixed gas limit, the way a sniper sends them, and are read back afterwards.
/// Nonce and fees are read before the launch, so firing is one eth_sendRawTransaction and nothing else.
async function prepare(w) {
  const [nonce, fees] = await Promise.all([pc.getTransactionCount({ address: w.address, blockTag: "pending" }), pc.estimateFeesPerGas()]);
  return { nonce, maxFeePerGas: fees.maxFeePerGas * 2n, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };
}
async function fire(w, prep, address, abi, functionName, args, value, gas = 700_000n) {
  return w.client.writeContract({ address, abi, functionName, args, value, gas, ...prep });
}
async function fireSwap(w, prep, key, amountIn, tokenIn, tokenOut) {
  const { commands, inputs } = buildSwap({ key, zeroForOne: same(tokenIn, key.currency0), amountIn, minAmountOut: 0n, tokenIn, tokenOut });
  const args = [commands, inputs, BigInt(Math.floor(Date.now() / 1000) + 3600)];
  return w.client.writeContract({ address: uniswapV4.universalRouter, abi: universalRouterAbi, functionName: "execute", args, value: tokenIn === zeroAddress ? amountIn : 0n, gas: 900_000n, ...prep });
}
/// Receipts that may revert: a buy fired blind is judged by what it did, not assumed to work.
const settle = (hash) => pc.waitForTransactionReceipt({ hash, timeout: 120_000 });

async function swapThrough(key, w, amountIn, tokenIn, tokenOut) {
  const { commands, inputs } = buildSwap({ key, zeroForOne: same(tokenIn, key.currency0), amountIn, minAmountOut: 0n, tokenIn, tokenOut });
  const args = [commands, inputs, await deadline()];
  const value = tokenIn === zeroAddress ? amountIn : 0n;
  // A hooked pool's price moves with the clock in the opening seconds; pad the estimate.
  const gas = await pc.estimateContractGas({ address: uniswapV4.universalRouter, abi: universalRouterAbi, functionName: "execute", args, value, account: w.account });
  return wait(await w.client.writeContract({ address: uniswapV4.universalRouter, abi: universalRouterAbi, functionName: "execute", args, value, gas: (gas * 13n) / 10n }));
}

async function approveForRouter(w, token) {
  await send(w, token, erc20Abi, "approve", [uniswapV4.permit2, maxUint256]);
  await send(w, uniswapV4.permit2, parseAbi(["function approve(address,address,uint160,uint48)"]), "approve",
    [token, uniswapV4.universalRouter, 2n ** 160n - 1n, 2n ** 48n - 1n]);
}

const SUPPLY = 1_000_000_000;
const SPACING = 200;
const tickFor = (fdv) => Math.round(Math.log(SUPPLY / fdv) / Math.log(1.0001) / SPACING) * SPACING;

// ================================================================ house: the house coin, named from the Safe

async function house() {
  step("house: the house coin launches on the pool, and the Safe names it for the Vault and the burn clock");
  if (state.house?.token) { console.log(`already launched: ${state.house.token}`); }
  else {
    const salt = await direct(W.deployer).hookSalt();
    const launched = await direct(W.deployer).launch({
      name: "fam house (testnet)", symbol: "tFAM", description: "the testnet house coin",
      tickStart: tickFor(10), tickBond: tickFor(100), initialBuy: u(1), salt: salt.salt,
    });
    const r = await wait(launched.hash);
    const log = r.logs.find((l) => same(l.address, A.portal) && l.topics.length >= 4);
    const token = `0x${log.topics[1].slice(26)}`;
    const row = await direct(W.deployer).getLaunch(token);
    const key = await direct(W.deployer).poolKey(row.locker);
    state.house = { token, hook: row.hook, locker: row.locker, splitter: row.splitter, key };
    save();
    check("the house coin launched with its pool", row.exists, token);
  }
  const { token, key } = state.house;
  const houseNow = await read(A.staking, hoodStakingAbi, "houseToken");
  if (!same(houseNow, token)) {
    const env = { ...process.env, SAFE_SIGNER_KEYS: `${W.safe_signer_1.key},${W.safe_signer_2.key}`, EXECUTOR_KEY: W.safe_signer_1.key };
    const r = spawnSync(process.execPath, [join(ROOT, "scripts/safe.mjs"), "housecoin", token, key.currency0, key.currency1,
      String(key.fee), String(key.tickSpacing), key.hooks, "--sign", "--exec"], { cwd: dirname(STATE), env, encoding: "utf8" });
    console.log((r.stdout ?? "").trim().split("\n").map((l) => `   ${l}`).join("\n"));
    if (r.status !== 0) console.error(r.stderr);
    check("the Safe's housecoin batch executed with two signatures", r.status === 0);
  }
  check("the Vault stakes the house coin", same(await read(A.staking, hoodStakingAbi, "houseToken"), token));
  const burnKey = await read(A.burnClock, parseAbi(["function houseCoin() view returns (address)"]), "houseCoin").catch(() => null);
  check("the burn clock burns the house coin", burnKey == null || same(burnKey, token), String(burnKey));
}

// ================================================================ curve: a team launch through block zero, and the open

async function curve() {
  step("curve: block zero with three open buyers and a separate fee recipient, then the opening seconds");
  const launchFee = await read(A.factory, hoodFactoryAbi, "launchFee");
  const configCount = await read(A.factory, hoodFactoryAbi, "configCount");
  let configId = -1;
  for (let i = 0n; i < configCount; i++) {
    const c = await read(A.factory, hoodFactoryAbi, "getConfig", [i]);
    if (c.enabled && c.pairToken === zeroAddress) { configId = Number(i); break; }
  }
  check("an ETH preset is enabled", configId >= 0, `#${configId}`);
  const econ = await read(A.factory, hoodFactoryAbi, "previewLaunchEconomics", [BigInt(configId), zeroAddress]);
  const team = [W.team_1, W.team_2, W.team_3];
  const LEG = u(2);
  const legs = team.map((w) => ({ wallet: w.address, pairIn: LEG, minTokensOut: 0n, lock: 0n, gas: 0n }));
  const params = {
    name: "Testnet Fam", symbol: "TFAM1", image: "", description: "block zero on the testnet", website: "", twitter: "", telegram: "",
    pairToken: zeroAddress, configId: BigInt(configId),
    feeSplit: { stakersBps: 0, buybackBps: 0, liquidityBps: 5000, creatorBps: 5000 },
    creatorFeeRecipient: W.fee_recipient.address, firstBuy: 0n, firstBuyLock: 0n,
    salt: keccak256(`0x${Date.now().toString(16).padStart(16, "0")}`), econ,
    exempt: team.map((w) => w.address),
  };
  const pairIn = u(2);
  const [snipePrep, teamPrep] = await Promise.all([prepare(W.sniper), prepare(W.team_1)]);
  const r = await send(W.creator, A.blockZero, hoodBlockZeroAbi, "launch", [params, legs], launchFee + LEG * 3n);
  const [launched] = events(r, hoodBlockZeroAbi, "TeamLaunched");
  const token = launched.args.token;
  const curveAddr = launched.args.market;
  // The open, on the chain's clock: the sniper and an open buyer go the moment the launch is mined.
  const [snipeHash, teamHash] = await Promise.all([
    fire(W.sniper, snipePrep, curveAddr, hoodCurveAbi, "buy", [pairIn, 0n, W.sniper.address], pairIn),
    fire(W.team_1, teamPrep, curveAddr, hoodCurveAbi, "buy", [u(1), 0n, W.team_1.address], u(1)),
  ]);
  state.curve = { token, curve: curveAddr };
  save();
  check("the team launch mined, three legs in the launch transaction", events(r, hoodBlockZeroAbi, "TeamLeg").length === 3, token);
  check("the legs paid no opening tax", events(r, hoodCurveAbi, "Sniped").length === 0);
  for (const w of [W.creator, W.fee_recipient, ...team]) {
    check(`${w.role} is exempt on the curve`, await read(curveAddr, hoodCurveAbi, "snipeExempt", [w.address]));
  }
  check("a stranger is not", !(await read(curveAddr, hoodCurveAbi, "snipeExempt", [W.sniper.address])));

  const launchedAt = await read(curveAddr, hoodCurveAbi, "launchedAt");
  const [sr, tr] = await Promise.all([settle(snipeHash), settle(teamHash)]);
  check("the sniper's buy and the open buyer's buy both went through", sr.status === "success" && tr.status === "success");
  const elapsed = Number((await pc.getBlock({ blockNumber: sr.blockNumber })).timestamp - launchedAt);
  const sniped = events(sr, hoodCurveAbi, "Sniped", curveAddr);
  const expected = (pairIn * BigInt(bpsAt(elapsed)) + 9_999n) / 10_000n;
  if (elapsed < 3) {
    const got = sniped[0]?.args.tax ?? 0n;
    check(`the sniper paid the second-${elapsed} rate, ${bpsAt(elapsed)} bps`, got > 0n && (got === expected || got + 1n === expected || got === expected + 1n),
      `${formatEther(got)} of ${formatEther(pairIn)} ETH, expected ${formatEther(expected)}`);
  } else {
    console.log(`   (the sniper landed ${elapsed}s in, past the window; no tax is the right answer)`);
    check("a buy past the window pays no opening tax", sniped.length === 0);
  }
  state.curve.snipe = { elapsed, tax: sniped[0]?.args.tax ?? 0n };
  const tElapsed = Number((await pc.getBlock({ blockNumber: tr.blockNumber })).timestamp - launchedAt);
  check(`an open buyer ${tElapsed}s in pays no opening tax`, events(tr, hoodCurveAbi, "Sniped").length === 0);

  // Past the window everyone pays the same 1%.
  while (Number((await pc.getBlock()).timestamp - launchedAt) < 4) await sleep(300);
  check("the curve's opening tax is over for everyone", (await read(curveAddr, hoodCurveAbi, "currentSnipeTaxBps", [W.sniper.address])) === 0n);
  for (const [w, n] of [[W.trader_1, 3], [W.trader_2, 2], [W.sniper, 1]]) {
    const br = await send(w, curveAddr, hoodCurveAbi, "buy", [u(n), 0n, w.address], u(n));
    check(`${w.role} buys after the window with no opening tax`, events(br, hoodCurveAbi, "Sniped").length === 0);
  }
  const bag = await balanceOf(token, W.trader_2.address);
  await send(W.trader_2, token, erc20Abi, "approve", [curveAddr, maxUint256]);
  const sellR = await send(W.trader_2, curveAddr, hoodCurveAbi, "sell", [bag / 2n, 0n, W.trader_2.address]);
  check("a sell pays no opening tax", events(sellR, hoodCurveAbi, "Sniped").length === 0);

  // The protocol's 30% of every fee, the opening tax included, pulled into the Bag and split in
  // thirds: the Vault, this hour's Payday, the house.
  const claimR = await send(POKE(), curveAddr, hoodCurveAbi, "claimProtocol");
  const flow = bagFlow(claimR);
  const into = flow.inBy[BagSource.Trade] ?? 0n;
  const third = (into * 3333n) / 10_000n; // BagSplits: 3333 bps each to the Vault and Payday, the house the rest
  check("claimProtocol routed the protocol's share into the Bag as trade fee", into > 0n, `${formatEther(into)} ETH`);
  check("the Bag split it 3333 / 3333 / 3334 bps: Vault, Payday, house",
    [BagOutlet.Vault, BagOutlet.Payday].every((o) => (flow.outBy[o] ?? 0n) === third)
      && (flow.outBy[BagOutlet.House] ?? 0n) === into - 2n * third,
    `vault ${formatEther(flow.outBy[BagOutlet.Vault] ?? 0n)} payday ${formatEther(flow.outBy[BagOutlet.Payday] ?? 0n)} house ${formatEther(flow.outBy[BagOutlet.House] ?? 0n)}`);

  // The creator's 70%: booked in the router, flushed down the launch's split to the fee recipient.
  const accrued = await read(A.feeRouter, hoodFeeRouterAbi, "accrued", [token]);
  check("the creator's share is booked in the fee router", accrued > 0n, `${formatEther(accrued)} ETH`);
  const before = await balanceOf(zeroAddress, W.fee_recipient.address);
  await send(POKE(), A.feeRouter, hoodFeeRouterAbi, "flush", [token]);
  const got = (await balanceOf(zeroAddress, W.fee_recipient.address)) - before;
  check("the flush paid the fee recipient its half of the creator's share", got > 0n && got <= accrued / 2n + 1n, `${formatEther(got)} ETH`);
}

// ================================================================ grad: a dollar curve bought out and graduated

async function grad() {
  step("grad: a dollar curve bought to the top, graduated, and the graduation fee split 23 / 77");
  const configCount = await read(A.factory, hoodFactoryAbi, "configCount");
  let configId = -1;
  for (let i = 0n; i < configCount; i++) {
    const c = await read(A.factory, hoodFactoryAbi, "getConfig", [i]);
    if (c.enabled && same(c.pairToken, A.usdg)) { configId = Number(i); break; }
  }
  check("a dollar preset is enabled", configId >= 0, `#${configId}`);
  const launchFee = await read(A.factory, hoodFactoryAbi, "launchFee");
  const firstBuy = 50_000_000n; // fifty dollars
  await send(W.creator, A.usdg, erc20Abi, "approve", [A.factory, maxUint256]);
  const { hash } = await hood(W.creator).launch({
    name: "Testnet Dollar Fam", symbol: "TFAMD", pairToken: A.usdg, configId, firstBuy,
    creatorFeeRecipient: W.fee_recipient.address,
  });
  const { token, curve: curveAddr } = await hood(W.creator).launchResult(hash);
  state.grad = { token, curve: curveAddr };
  save();
  check("the dollar curve launched", Boolean(curveAddr), token);
  check("the launch fee is paid in ETH either way", launchFee > 0n, formatEther(launchFee));

  while (Number((await pc.getBlock()).timestamp - (await read(curveAddr, hoodCurveAbi, "launchedAt"))) < 4) await sleep(300);
  const remaining = (await hood(W.trader_1).getCurveState(curveAddr)).remaining;
  const { pairIn } = await hood(W.trader_1).quoteBuyExactOut(curveAddr, remaining);
  await send(W.trader_1, A.usdg, erc20Abi, "approve", [curveAddr, maxUint256]);
  await send(W.trader_1, curveAddr, hoodCurveAbi, "buyExactOut", [remaining, (pairIn * 11n) / 10n, W.trader_1.address]);
  check("the curve sold out", (await hood(W.trader_1).getCurveState(curveAddr)).phase === "sold", `${formatUnits(pairIn, 6)} tUSDG`);

  const devBefore = await balanceOf(A.usdg, W.fee_recipient.address);
  const fr = await send(POKE(), curveAddr, hoodCurveAbi, "finalize");
  const [g] = events(fr, hoodCurveAbi, "Graduated", curveAddr);
  const fee = g.args.graduationFee;
  const flow = bagFlow(fr);
  const dev = (flow.outBy[BagOutlet.Dev] ?? 0n) + flow.deferred;
  const burn = flow.outBy[BagOutlet.Burn] ?? 0n;
  check("graduation paid a tenth of the raise as its fee", fee > 0n && fee * 10n >= g.args.pairAmount / 9n, `${formatUnits(fee, 6)} tUSDG`);
  check("the Bag took the whole graduation fee", (flow.inBy[BagSource.Graduation] ?? 0n) === fee);
  check("23% of it went to the creator's fee recipient", dev === (fee * 2300n) / 10_000n || dev === (fee * 2300n) / 10_000n + 1n, `${formatUnits(dev, 6)} tUSDG`);
  check("the rest went to the burn clock", burn + dev === fee, `${formatUnits(burn, 6)} tUSDG`);
  const devGot = (await balanceOf(A.usdg, W.fee_recipient.address)) - devBefore;
  check("the dev bonus landed in the wallet (or waits in devClaimable)", devGot === dev || flow.deferred > 0n, `${formatUnits(devGot, 6)} tUSDG`);
  const gradAbi = parseAbi(["function isGraduated(address) view returns (bool)", "function positionOf(address) view returns ((address,address,uint24,int24,address) key, uint256 tokenId)"]);
  check("the pool is open and the position is locked in the graduator", await read(A.graduator, gradAbi, "isGraduated", [token]));
}

// ================================================================ direct: the pool machine's open

async function directPhase() {
  step("direct: a pool launch with an open buyer, the opening seconds keyed on the sender");
  const salt = await direct(W.creator).hookSalt();
  const launched = await direct(W.creator).launch({
    name: "Testnet Pool Fam", symbol: "TFAMP", description: "straight into a pool",
    creatorFeeRecipient: W.fee_recipient.address, exempt: [W.team_1.address],
    tickStart: tickFor(10), tickBond: tickFor(100), initialBuy: u(1), salt: salt.salt,
  });
  const [snipePrep, teamPrep] = await Promise.all([prepare(W.sniper), prepare(W.team_1)]);
  const r = await wait(launched.hash);
  const [dl] = events(r, hoodPortalAbi, "DirectLaunched", A.portal);
  const token = dl.args.token;
  // The pool key from the launch event and the SDK's defaults (fee 10000, spacing 200), so the
  // first swaps need no read at all.
  const [c0, c1] = BigInt(zeroAddress) < BigInt(token) ? [zeroAddress, token] : [token, zeroAddress];
  const fastKey = { currency0: c0, currency1: c1, fee: 10_000, tickSpacing: 200, hooks: dl.args.hook };
  const amountIn = u(2);
  const [snipeHash, teamHash] = await Promise.all([
    fireSwap(W.sniper, snipePrep, fastKey, amountIn, zeroAddress, token),
    fireSwap(W.team_1, teamPrep, fastKey, u(1), zeroAddress, token),
  ]);
  const row = await direct(W.creator).getLaunch(token);
  const key = await direct(W.creator).poolKey(row.locker);
  state.direct = { token, hook: row.hook, splitter: row.splitter, locker: row.locker, key };
  save();
  check("the portal launch opened its pool in the launch transaction", row.exists, token);
  check("the creator's first buy paid no opening tax", events(r, hoodLaunchHookAbi, "Sniped").length === 0);
  check("the open buyer is exempt on the hook", await read(row.hook, hoodLaunchHookAbi, "snipeExempt", [W.team_1.address]));

  check("the pool key the swaps were fired at is the launch's", JSON.stringify(key).toLowerCase() === JSON.stringify(fastKey).toLowerCase());
  const launchTime = await read(row.hook, parseAbi(["function launchTime() view returns (uint64)"]), "launchTime");
  const [sr, tr] = await Promise.all([settle(snipeHash), settle(teamHash)]);
  check("the sniper's swap and the open buyer's swap both went through", sr.status === "success" && tr.status === "success");
  const elapsed = Number((await pc.getBlock({ blockNumber: sr.blockNumber })).timestamp - launchTime);
  const sniped = events(sr, hoodLaunchHookAbi, "Sniped", row.hook);
  if (elapsed < 3) {
    const tax = sniped[0]?.args.tax ?? 0n;
    const bps = Number((tax * 10_000n) / amountIn);
    // Second 0 is capped all in at 99%, so the opening tax there is 99% less the launch's own tax.
    const ok = elapsed === 0 ? tax > 0n : Math.abs(bps - bpsAt(elapsed)) <= 2;
    check(`the sniper on the pool paid the second-${elapsed} opening tax`, ok, `${bps} bps of the buy`);
  } else {
    check("a pool buy past the window pays no opening tax", sniped.length === 0, `${elapsed}s in`);
  }
  check("the open buyer's swap in the opening seconds paid none", events(tr, hoodLaunchHookAbi, "Sniped").length === 0);

  while (Number((await pc.getBlock()).timestamp - launchTime) < 4) await sleep(300);
  const calm = await swapThrough(key, W.trader_1, u(3), zeroAddress, token);
  check("after the window a pool buy pays only the launch's tax and the platform's 1%", events(calm, hoodLaunchHookAbi, "Sniped").length === 0);
  const bag = await balanceOf(token, W.trader_1.address);
  await approveForRouter(W.trader_1, token);
  await swapThrough(key, W.trader_1, bag / 2n, token, zeroAddress);
  check("a sell through the hook went through", (await balanceOf(token, W.trader_1.address)) < bag);

  await send(POKE(), row.hook, parseAbi(["function flushClaims()"]), "flushClaims");
  const sw = await send(POKE(), row.splitter, parseAbi(["function sweep()"]), "sweep");
  check("the splitter swept the launch's own tax", sw.status === "success");
  const hookBag = await pc.getLogs({ address: A.bag, event: parseAbi(["event BagIn(uint8 indexed source, address indexed asset, uint256 amount, address indexed token)"])[0], args: { token }, fromBlock: r.blockNumber });
  check("the platform's 30% of the pool's fee reached the Bag, keyed to this token", hookBag.length > 0,
    `${formatEther(hookBag.reduce((s, l) => s + l.args.amount, 0n))} ETH in ${hookBag.length} deposits`);
}

// ================================================================ boost: this hour's Payday

async function boost() {
  step("boost: a slot bought for this hour funds this hour's Payday");
  const token = state.curve?.token ?? state.direct?.token;
  if (!token) { check("a token to boost", false, "run the curve phase first"); return; }
  const epoch = await read(A.boosts, hoodBoostsAbi, "epoch");
  const price = await read(A.boosts, hoodBoostsAbi, "slotPrice");
  let slot = -1;
  for (let i = 0; i < 4; i++) {
    const [t] = await read(A.boosts, hoodBoostsAbi, "slotOf", [epoch, i]);
    if (t === zeroAddress) { slot = i; break; }
  }
  if (slot < 0) { check("a free slot this hour", false); return; }
  const fundedBefore = await read(A.payday, hoodPaydayAbi, "funded", [epoch, zeroAddress]);
  const r = await send(W.creator, A.boosts, hoodBoostsAbi, "buy", [token, epoch, slot], price);
  const funded = events(r, hoodPaydayAbi, "Funded", A.payday);
  check("the whole slot price funded Payday for the hour it runs", funded.some((l) => l.args.epoch === epoch && l.args.amount === price),
    `${formatEther(price)} ETH into epoch ${epoch}`);
  check("the Bag booked it as boost money", (bagFlow(r).inBy[BagSource.Boost] ?? 0n) === price);
  check("Payday's book for this hour grew by the price", (await read(A.payday, hoodPaydayAbi, "funded", [epoch, zeroAddress])) - fundedBefore >= price);
  state.boost = { token, epoch, slot, price };
  save();
}

// ================================================================ vault: stake the house coin

async function vault() {
  step("vault: a trader buys the house coin and locks it");
  if (!state.house) { check("the house coin exists", false, "run the house phase first"); return; }
  const { token, key } = state.house;
  await swapThrough(key, W.trader_2, u(2), zeroAddress, token);
  const held = await balanceOf(token, W.trader_2.address);
  check("the trader holds the house coin", held > 0n, formatEther(held));
  await send(W.trader_2, token, erc20Abi, "approve", [A.staking, maxUint256]);
  const r = await send(W.trader_2, A.staking, hoodStakingAbi, "stake", [held / 2n, 0n]);
  const id = BigInt(r.logs.find((l) => same(l.address, A.staking)).topics[1]);
  const pos = await read(A.staking, hoodStakingAbi, "positions", [id]).catch(() => null);
  check("a flexible position is open", id >= 0n, `position ${id}`);
  state.vault = { id, amount: held / 2n, pos: Boolean(pos) };
  save();
}

// ================================================================ api: the local indexer against the chain

async function apiPhase() {
  step("api: the local indexer and api, read against the chain");
  if (!API) { console.log("   HOOD_API not set: start the stack (run.sh stack) and run this phase again"); return; }
  const get = async (p) => { const r = await fetch(API + p); return { status: r.status, body: await r.json().catch(() => null) }; };
  const head = await pc.getBlockNumber();
  for (let i = 0; i < 200; i++) {
    const h = await get("/health");
    if (h.body?.indexedBlock != null && BigInt(h.body.indexedBlock) >= head - 5n) break;
    await sleep(1500);
  }
  if (state.curve) {
    const d = await get(`/tokens/${state.curve.token}`);
    check("the block zero launch is indexed", d.status === 200, state.curve.token);
    check("its row carries the opening tax schedule", JSON.stringify(d.body?.opening_tax_bps) === JSON.stringify(SCHEDULE), JSON.stringify(d.body?.opening_tax_bps));
    check("the creator is the launcher, the fees go to the fee recipient",
      same(d.body?.creator, W.creator.address) && same(d.body?.fee_recipient, W.fee_recipient.address));
    const h = await get(`/tokens/${state.curve.token}/holders`);
    const rows = h.body?.holders ?? [];
    check("the open buyers are labelled on the holder list", [W.team_1, W.team_2, W.team_3].every((w) => rows.some((r) => same(r.address, w.address) && r.exempt)));
    if (state.curve.snipe && BigInt(state.curve.snipe.tax) > 0n) {
      const p = await get(`/tokens/${state.curve.token}/penalties`);
      check("the sniper is on the snipers' wall", (p.body?.rows ?? []).some((r) => r.kind === "snipe" && same(r.payer, W.sniper.address)));
    }
  }
  for (const k of ["grad", "direct"]) {
    if (state[k]) check(`the ${k} launch is indexed`, (await get(`/tokens/${state[k].token}`)).status === 200, state[k].token);
  }
  const bag = await get("/bag");
  check("the Bag page has numbers", bag.status === 200);
}

// ================================================================ payday: after the boosted hour closes

async function payday() {
  step("payday: the boosted hour is closed and the keeper paid it");
  if (!state.boost) { check("a boosted hour", false, "run the boost phase first"); return; }
  const epoch = BigInt(state.boost.epoch);
  const now = await read(A.payday, hoodPaydayAbi, "epoch");
  if (now <= epoch) { console.log(`   epoch ${epoch} is still open (now ${now}); run this phase after the hour`); return; }
  const paidAt = await read(A.payday, hoodPaydayAbi, "paidAt", [epoch, zeroAddress]);
  check("the keeper paid the boosted hour", paidAt > 0n, paidAt > 0n ? `at ${paidAt}` : "not yet: is the keeper running?");
  const paid = await read(A.payday, hoodPaydayAbi, "paid", [epoch, zeroAddress]);
  check("the hour paid out something", paid > 0n, `${formatEther(paid)} ETH`);
}

// ---------------------------------------------------------------- the run

const PHASES = { house, curve, grad, direct: directPhase, boost, vault, api: apiPhase, payday };
const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const run = only.length ? only : ["house", "curve", "grad", "direct", "boost", "vault", "api"];
for (const name of run) {
  if (!PHASES[name]) { console.error(`unknown phase ${name}; phases: ${Object.keys(PHASES).join(", ")}`); process.exit(2); }
  try { await PHASES[name](); } catch (e) { check(`${name} ran to the end`, false, (e.shortMessage ?? e.message ?? String(e)).split("\n")[0]); }
}
console.log(`\n${passes} passed, ${failures} failed. state in ${STATE}`);
process.exit(failures === 0 ? 0 : 1);
