// The multisig, end to end, on a local chain that answers as 4663 and runs the real Safe v1.4.1
// code (the fixtures the Solidity suite uses, installed at the canonical addresses). No RPC, no
// fork, nothing public: it starts its own anvil on its own port and stops it at the end.
//
//   node scripts/e2e/safe.mjs            (after `forge build` and `npm run build -w @hood/sdk`)
//
// What it proves, in order:
//   1. script/DeploySafe.s.sol creates the Safe where the SDK predicted, refuses a 1-of-N and a
//      deployer who is also a signer, and does nothing the second time.
//   2. script/Deploy.s.sol refuses an EOA owner on 4663 and deploys with the Safe as OWNER and
//      TREASURY; DeploySeasonDrop gives the Safe the drop from block one.
//   3. `npm run safe -- accept` takes every contract in one signed batch, and writes a Transaction
//      Builder file whose checksum validates; `call` runs an owner switch; one signer is refused.
//   4. A second Safe, as a user: launches a token with its first buy, sells with approve+sell as
//      one transaction, stakes with approve+stake as one transaction.

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  http,
  keccak256,
  parseEther,
  stringToBytes,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildSafeTransaction,
  createSafeCall,
  executeSafeTransaction,
  hoodCurveAbi,
  hoodFactoryAbi,
  hoodStakingAbi,
  predictSafeAddress,
  readSafe,
  robinhood,
  safeContracts,
  safeContractsAreCanonical,
  serializeForChecksum,
  signSafeTransaction,
} from "../../packages/sdk/dist/index.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PORT = 8547;
const RPC = `http://127.0.0.1:${PORT}`;
const chain = { ...robinhood, rpcUrls: { default: { http: [RPC] } } };
const client = createPublicClient({ chain, transport: http(RPC), pollingInterval: 100 });

// anvil's default accounts
const KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b1d0b1e5b0de5c46e9f4d3e1a4c1",
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
];
const [deployer, s1, s2, s3, t1, t2, alice] = KEYS.map((k) => privateKeyToAccount(k));
const wallet = (account) => createWalletClient({ account, chain, transport: http(RPC) });

let failed = 0;
let passed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
  ok ? passed++ : failed++;
};
const step = (title) => console.log(`\n${title}`);
const same = (a, b) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());

function run(cmd, args, env = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout}\n${r.stderr}` };
}

const broadcastDir = mkdtempSync(join(tmpdir(), "hood-safe-e2e-"));
const forge = (script, env) =>
  run("forge", ["script", script, "--rpc-url", RPC, "--broadcast", "--slow"], { FOUNDRY_BROADCAST: broadcastDir, ...env });
const logged = (out, label) => {
  const m = out.match(new RegExp(`${label}\\s*(0x[0-9a-fA-F]{40})`));
  return m ? getAddress(m[1]) : undefined;
};

const anvil = spawn("anvil", ["--port", String(PORT), "--chain-id", "4663", "--silent"], { stdio: "ignore" });
const stop = () => anvil.kill();
process.on("exit", stop);

try {
  for (let i = 0; i < 50; i++) {
    try { await client.getBlockNumber(); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }

  step("0. the chain: 4663, with Safe v1.4.1 at its canonical addresses");
  const fixtures = { safeL2: "SafeL2", proxyFactory: "SafeProxyFactory", fallbackHandler: "CompatibilityFallbackHandler", multiSendCallOnly: "MultiSendCallOnly" };
  for (const [key, file] of Object.entries(fixtures)) {
    const code = readFileSync(join(ROOT, "test/fixtures/safe-1.4.1", `${file}.hex`), "utf8").trim();
    await client.request({ method: "anvil_setCode", params: [safeContracts[key], code] });
  }
  check("chain id is 4663", (await client.getChainId()) === 4663);
  check("the Safe code is exactly canonical v1.4.1", await safeContractsAreCanonical(client));

  step("1. script/DeploySafe.s.sol");
  const owners = [s1.address, s2.address, s3.address];
  const predicted = await predictSafeAddress(client, owners, 2, 0n);
  const safeEnv = { PRIVATE_KEY: KEYS[0], SAFE_OWNERS: owners.join(","), SAFE_THRESHOLD: "2" };

  const single = forge("script/DeploySafe.s.sol", { ...safeEnv, SAFE_THRESHOLD: "1" });
  check("refuses a 1-of-N Safe", !single.ok && single.out.includes("one key with extra steps"));
  const selfSigner = forge("script/DeploySafe.s.sol", { ...safeEnv, SAFE_OWNERS: [deployer.address, s2.address].join(",") });
  check("refuses a deployer who is also a signer", !selfSigner.ok && selfSigner.out.includes("must not be a signer"));

  const created = forge("script/DeploySafe.s.sol", safeEnv);
  const safeAddress = logged(created.out, "created");
  check("creates the Safe", created.ok && Boolean(safeAddress), created.ok ? safeAddress : created.out.slice(-400));
  check("where the SDK predicted", same(safeAddress, predicted), predicted);
  const info = await readSafe(client, predicted);
  check("2 of 3, the three signers", info?.threshold === 2 && owners.every((o) => info.owners.some((x) => same(x, o))));
  const nonceBefore = await client.getTransactionCount({ address: deployer.address });
  const again = forge("script/DeploySafe.s.sol", safeEnv);
  check("a second run finds it and sends nothing", again.ok && again.out.includes("exists") && (await client.getTransactionCount({ address: deployer.address })) === nonceBefore);

  step("2. script/Deploy.s.sol with the Safe as OWNER and TREASURY");
  const eoaOwned = forge("script/Deploy.s.sol", { PRIVATE_KEY: KEYS[0], OWNER: s1.address, TREASURY: s1.address });
  check("refuses an EOA owner on 4663", !eoaOwned.ok && eoaOwned.out.includes("OWNER is not a Safe"));

  const deployed = forge("script/Deploy.s.sol", { PRIVATE_KEY: KEYS[0], OWNER: predicted, TREASURY: predicted });
  check("deploys with the Safe", deployed.ok, deployed.ok ? "" : deployed.out.slice(-600));
  const factory = logged(deployed.out, "factory");
  const portal = logged(deployed.out, "portal");
  const bridge = logged(deployed.out, "bridge");
  check("printed the factory, portal and bridge", Boolean(factory && portal && bridge));
  check("told the operator how to accept", deployed.out.includes("npm run safe -- accept"));
  const pending = await client.readContract({ address: factory, abi: hoodFactoryAbi, functionName: "pendingOwner" });
  check("the factory is waiting for the Safe", same(pending, predicted));
  check("the factory's treasury is the Safe", same(await client.readContract({ address: factory, abi: hoodFactoryAbi, functionName: "treasury" }), predicted));

  const dropRun = forge("script/DeploySeasonDrop.s.sol", { PRIVATE_KEY: KEYS[0], OWNER: predicted, TREASURY: predicted });
  const drop = logged(dropRun.out, "seasonDrop");
  check("the season drop is the Safe's from block one", dropRun.ok && same(await client.readContract({ address: drop, abi: hoodFactoryAbi, functionName: "owner" }), predicted));

  step("3. npm run safe -- accept / call");
  const cliEnv = { RPC_URL: RPC, HOOD_SAFE: predicted, HOOD_FACTORY: factory, HOOD_PORTAL: portal, HOOD_BRIDGE_FACTORY: bridge, HOOD_SEASON_DROP: drop };
  const outDir = mkdtempSync(join(tmpdir(), "hood-safe-batch-"));
  const acceptFile = join(outDir, "accept.json");

  const info1 = run("node", ["scripts/safe.mjs", "info"], cliEnv);
  check("info sees three contracts waiting", info1.ok && (info1.out.match(/WAITING for this Safe/g) ?? []).length === 3, info1.ok ? "" : info1.out.slice(-300));

  const lone = run("node", ["scripts/safe.mjs", "accept", "--exec", "--out", acceptFile], { ...cliEnv, SAFE_SIGNER_KEYS: KEYS[1] });
  check("one signer cannot execute", !lone.ok && lone.out.includes("the Safe needs 2"));
  check("nothing moved", same(await client.readContract({ address: factory, abi: hoodFactoryAbi, functionName: "owner" }), deployer.address));

  const accepted = run("node", ["scripts/safe.mjs", "accept", "--sign", "--exec", "--out", acceptFile], { ...cliEnv, SAFE_SIGNER_KEYS: `${KEYS[2]},${KEYS[3]}`, EXECUTOR_KEY: KEYS[6] });
  check("two signers accept everything in one batch", accepted.ok && accepted.out.includes("one batch of 3"), accepted.ok ? "" : accepted.out.slice(-400));
  for (const [name, address] of [["factory", factory], ["portal", portal], ["bridge", bridge]]) {
    check(`${name} is owned by the Safe`, same(await client.readContract({ address, abi: hoodFactoryAbi, functionName: "owner" }), predicted));
  }
  check("the drop was already the Safe's and was left out", accepted.out.includes("drop        already owned by the Safe"));

  const batch = JSON.parse(readFileSync(acceptFile, "utf8"));
  const { checksum, ...meta } = batch.meta;
  check("the batch file names 4663 and three calls", batch.chainId === "4663" && batch.transactions.length === 3);
  check("its checksum validates as the Transaction Builder checks it", checksum === keccak256(stringToBytes(serializeForChecksum({ ...batch, meta: { ...meta, name: null } }))));

  const fee = run("node", ["scripts/safe.mjs", "call", "factory", "setLaunchFee(uint256)", "1000000000000000", "--sign", "--exec", "--out", join(outDir, "fee.json")], { ...cliEnv, SAFE_SIGNER_KEYS: `${KEYS[1]},${KEYS[3]}` });
  check("call runs an owner switch", fee.ok && (await client.readContract({ address: factory, abi: hoodFactoryAbi, functionName: "launchFee" })) === 1000000000000000n, fee.ok ? "" : fee.out.slice(-300));
  const stranger = run("node", ["scripts/safe.mjs", "call", "factory", "setLaunchFee(uint256)", "1", "--sign"], { ...cliEnv, SAFE_SIGNER_KEYS: KEYS[6] });
  check("a key that is not a signer is refused", !stranger.ok && stranger.out.includes("is not an owner"));

  step("4. a Safe as a user: launch, sell, stake");
  // The curve launch opens its Uniswap v4 pool in the launch transaction, and this chain has no
  // Uniswap: the user half runs on the local wiring, whose graduator is a stand-in.
  const local = forge("script/DeployLocal.s.sol", { PRIVATE_KEY: KEYS[0] });
  const lf = logged(local.out, "HOOD_FACTORY=");
  const ls = logged(local.out, "HOOD_STAKING=");
  const lr = logged(local.out, "HOOD_FEE_ROUTER=");
  check("local wiring deployed", local.ok && Boolean(lf && ls && lr), local.ok ? "" : local.out.slice(-300));

  const teamOwners = [t1.address, t2.address];
  const team = await predictSafeAddress(client, teamOwners, 2, 7n);
  const make = createSafeCall(teamOwners, 2, 7n);
  await client.waitForTransactionReceipt({ hash: await wallet(alice).sendTransaction({ to: make.to, data: make.data }) });
  await client.waitForTransactionReceipt({ hash: await wallet(alice).sendTransaction({ to: team, value: parseEther("3") }) });
  check("a stranger created the team's Safe where predicted", Boolean(await readSafe(client, team)));
  check("the Safe accepted plain ETH", (await client.getBalance({ address: team })) === parseEther("3"));

  // Two team signers sign, a stranger executes: the shape of every Safe transaction below.
  const exec = async (calls) => {
    const s = await readSafe(client, team);
    const tx = buildSafeTransaction(calls, s.nonce);
    const sigs = [await signSafeTransaction(wallet(t1), team, 4663, tx), await signSafeTransaction(wallet(t2), team, 4663, tx)];
    const hash = await executeSafeTransaction(wallet(alice), team, tx, sigs);
    return client.waitForTransactionReceipt({ hash });
  };

  const fee0 = await client.readContract({ address: lf, abi: hoodFactoryAbi, functionName: "launchFee" });
  const econ = await client.readContract({ address: lf, abi: hoodFactoryAbi, functionName: "previewLaunchEconomics", args: [0n, "0x0000000000000000000000000000000000000000"] });
  const firstBuy = parseEther("0.3");
  const launchData = encodeFunctionData({
    abi: hoodFactoryAbi, functionName: "launch",
    args: [{
      name: "Team Coin", symbol: "TEAM", image: "", description: "launched by a 2 of 2 Safe", website: "", twitter: "", telegram: "",
      pairToken: "0x0000000000000000000000000000000000000000", configId: 0n, feeSplit: { stakersBps: 10_000, buybackBps: 0, liquidityBps: 0, creatorBps: 0 }, creatorFeeRecipient: team,
      firstBuy, salt: keccak256(stringToBytes("team")), econ,
    }],
  });
  const launched = await exec([{ to: lf, value: fee0 + firstBuy, data: launchData }]);
  const log = launched.logs.find((l) => same(l.address, lf) && l.topics.length === 4);
  const token = log && getAddress(`0x${log.topics[1].slice(26)}`);
  const curve = log && getAddress(`0x${log.topics[2].slice(26)}`);
  check("the Safe launched, and is the creator", Boolean(token) && same(`0x${log.topics[3].slice(26)}`, team));
  const held = await client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [team] });
  check("its first buy landed in the Safe", held > 0n, String(held));

  const toSell = held / 4n;
  const ethBefore = await client.getBalance({ address: team });
  const sold = await exec([
    { to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [curve, toSell] }) },
    { to: curve, data: encodeFunctionData({ abi: hoodCurveAbi, functionName: "sell", args: [toSell, 0n, team] }) },
  ]);
  check("approve + sell as one Safe transaction", sold.status === "success" && (await client.getBalance({ address: team })) > ethBefore);

  const rest = await client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [team] });
  const staked = await exec([
    { to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [ls, rest] }) },
    { to: ls, data: encodeFunctionData({ abi: hoodStakingAbi, functionName: "stake", args: [token, rest, BigInt(30 * 86400)] }) },
  ]);
  check("approve + stake as one Safe transaction", staked.status === "success" && (await client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [team] })) === 0n);
} catch (e) {
  failed++;
  console.error(e);
} finally {
  stop();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
