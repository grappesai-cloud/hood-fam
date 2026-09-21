#!/usr/bin/env node
// Publish the source of a deployment, through Sourcify.
//
//   node scripts/verify-sourcify.mjs <name>=<address> [...]
//   node scripts/verify-sourcify.mjs --deployment            (every address in the env, see below)
//
// Not through the explorer's own API: robinhoodchain.blockscout.com sits behind a Cloudflare
// challenge, so a command line POST gets an HTML interstitial rather than an answer. Sourcify
// supports 4663, Blockscout reads from Sourcify, and Sourcify forwards to Etherscan as well, so one
// submission reaches every explorer a reader is likely to open.
//
// It sends the standard JSON input the compiler was actually given (`forge verify-contract
// --show-standard-json-input`), which is what makes the match exact rather than partial.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCIFY = process.env.SOURCIFY ?? "https://sourcify.dev/server";
const CHAIN = process.env.CHAIN_ID ?? "4663";

/// Every contract a deployment puts on chain, and where its source lives.
const CONTRACTS = {
  factory: "src/HoodFactory.sol:HoodFactory",
  deployer: "src/HoodDeployer.sol:HoodDeployer",
  staking: "src/HoodStaking.sol:HoodStaking",
  feeRouter: "src/HoodFeeRouter.sol:HoodFeeRouter",
  graduator: "src/graduation/UniswapV4Graduator.sol:UniswapV4Graduator",
  bridge: "src/omnichain/HoodBridgeFactory.sol:HoodBridgeFactory",
  portal: "src/direct/HoodPortal.sol:HoodPortal",
  directDeployer: "src/direct/HoodDirectDeployer.sol:HoodDirectDeployer",
  tokenImplementation: "src/direct/HoodLaunchToken.sol:HoodLaunchToken",
  buyback: "src/direct/HoodBuybackModule.sol:HoodBuybackModule",
  seasonDrop: "src/HoodSeasonDrop.sol:HoodSeasonDrop",
  firstBuyLock: "src/HoodTokenLock.sol:HoodTokenLock",
  // A launch's own pair, once one exists: the factory clones these per token.
  token: "src/HoodToken.sol:HoodToken",
  curve: "src/HoodCurve.sol:HoodCurve",
};

/// The env names a deploy already uses, so `--deployment` needs no arguments.
const FROM_ENV = {
  factory: "HOOD_FACTORY", deployer: "HOOD_DEPLOYER", staking: "HOOD_STAKING",
  feeRouter: "HOOD_FEE_ROUTER", graduator: "HOOD_GRADUATOR", bridge: "HOOD_BRIDGE_FACTORY",
  portal: "HOOD_PORTAL", directDeployer: "HOOD_DIRECT_DEPLOYER",
  tokenImplementation: "HOOD_TOKEN_IMPLEMENTATION", buyback: "HOOD_BUYBACK_MODULE",
  seasonDrop: "HOOD_SEASON_DROP", firstBuyLock: "HOOD_FIRST_BUY_LOCK",
};

const args = process.argv.slice(2);
const targets = args.includes("--deployment")
  ? Object.entries(FROM_ENV).flatMap(([name, key]) => (process.env[key] ? [[name, process.env[key]]] : []))
  : args.map((a) => a.split("="));

if (targets.length === 0) {
  console.error("nothing to verify: pass name=0x... pairs, or --deployment with the HOOD_* addresses set");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;

for (const [name, address] of targets) {
  const identifier = CONTRACTS[name];
  if (!identifier) {
    console.log(`${name.padEnd(20)} unknown contract, skipped`);
    failed++;
    continue;
  }
  const already = await fetch(`${SOURCIFY}/v2/contract/${CHAIN}/${address}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (already?.match) {
    console.log(`${name.padEnd(20)} ${address}  already ${already.match}`);
    continue;
  }

  const stdJsonInput = JSON.parse(execFileSync("forge", ["verify-contract", "--show-standard-json-input", address, identifier], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
  const artifact = JSON.parse(readFileSync(`${ROOT}out/${identifier.split(":")[0].split("/").pop()}/${identifier.split(":")[1]}.json`, "utf8"));
  const compilerVersion = artifact.metadata.compiler.version;

  const submitted = await fetch(`${SOURCIFY}/v2/verify/${CHAIN}/${address}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stdJsonInput, compilerVersion, contractIdentifier: identifier }),
  });
  const body = await submitted.json().catch(() => ({}));
  if (!body.verificationId) {
    console.log(`${name.padEnd(20)} ${address}  REFUSED  ${JSON.stringify(body).slice(0, 200)}`);
    failed++;
    continue;
  }

  let result = null;
  for (let i = 0; i < 40; i++) {
    await sleep(3000);
    result = await fetch(`${SOURCIFY}/v2/verify/${body.verificationId}`).then((r) => r.json()).catch(() => null);
    if (result?.isJobCompleted) break;
  }
  const match = result?.contract?.match ?? result?.error?.customCode ?? "unknown";
  const ok = match === "exact_match" || match === "match";
  console.log(`${name.padEnd(20)} ${address}  ${ok ? match : `FAILED (${match})`}`);
  if (!ok) failed++;
}

console.log(`\nsource: https://repo.sourcify.dev/${CHAIN}/`);
process.exit(failed ? 1 : 0);
