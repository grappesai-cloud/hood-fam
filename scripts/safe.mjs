#!/usr/bin/env node
// The protocol's Safe, from a terminal.
//
//   npm run safe -- predict --owners 0xA,0xB,0xC --threshold 2 [--salt 0]
//   npm run safe -- info [<safe>]
//   npm run safe -- accept                       every hood.fam contract waiting for the Safe, one batch
//   npm run safe -- call <target> "<fn(types)>" [args...] [--value <wei>]
//   npm run safe -- referral <token> <to> <bps>  a referral leg on one launch, out of the protocol's
//                                                share (at most 5000 bps); `0x0 0` clears it
//   npm run safe -- keeper <address>             one batch: router, payday and burnClock .setKeeper
//   npm run safe -- housecoin <coin> <currency0> <currency1> <fee> <tickSpacing> <hooks>
//                                                burnClock.setHouseCoin(coin, PoolKey), plus
//                                                staking.setHouseToken(coin) while the Vault has none
//   npm run safe -- status <safeTxHash>
//
// `accept`, `call`, `referral`, `keeper` and `housecoin` always write a Transaction Builder file: in
// Safe{Wallet}, Apps -> Transaction Builder, drop the file in, and every signer sees each call
// decoded before signing. That path needs no key on this machine and no API key anywhere, and it
// is the normal one.
//
// Optional, on top of the file:
//   --sign      sign with the keys in SAFE_SIGNER_KEYS (comma separated) or --keystore <label,...>
//               (password in HOOD_KEYSTORE_PASSWORD). For rehearsals, and for signers who keep a
//               key in the hood keystore.
//   --exec      send it once the signatures reach the threshold. Gas from EXECUTOR_KEY, or the
//               first signer. Anyone may execute a fully signed Safe transaction.
//   --propose   put it in the Safe's queue on Safe{Wallet} with the first signature. Needs
//               SAFE_API_KEY (developer.safe.global): the service takes reads from anyone and writes
//               only from a registered key.
//
// Environment: RPC_URL (default: the public 4663 RPC), HOOD_SAFE (the protocol Safe), and the
// deployment's HOOD_FACTORY / HOOD_FEE_ROUTER / HOOD_PORTAL / HOOD_BRIDGE_FACTORY / HOOD_SEASON_DROP /
// HOOD_REFERRALS, plus, since the Bag: HOOD_PAYDAY / HOOD_BURN_CLOCK / HOOD_BOOSTS / HOOD_GRADUATOR /
// HOOD_GRADUATION_HOOK / HOOD_STAKING.

import { writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, encodeFunctionData, getAddress, http, isAddress, parseAbi, parseAbiItem, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildSafeTransaction,
  executeSafeTransaction,
  ownable2StepAbi,
  predictSafeAddress,
  proposeSafeTransaction,
  readSafe,
  robinhood,
  safeBatchFile,
  safeContractsAreCanonical,
  safeQueueUrl,
  safeTransactionHash,
  safeTxStatus,
  signSafeTransaction,
} from "../packages/sdk/dist/index.js";

const argv = process.argv.slice(2);
const command = argv[0];
const flags = new Set(argv.filter((a) => a.startsWith("--") && !["--owners", "--threshold", "--salt", "--value", "--out", "--keystore"].includes(a)));
const option = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const positional = (() => {
  const out = [];
  for (let i = 1; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      if (["--owners", "--threshold", "--salt", "--value", "--out", "--keystore"].includes(argv[i])) i++;
      continue;
    }
    out.push(argv[i]);
  }
  return out;
})();

const RPC = process.env.RPC_URL || robinhood.rpcUrls.default.http[0];
const chain = { ...robinhood, rpcUrls: { default: { http: [RPC] } } };
const client = createPublicClient({ chain, transport: http(RPC) });

const die = (msg) => {
  console.error(`safe: ${msg}`);
  process.exit(1);
};
const env = (name) => {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
};

/// The deployment, by the names the owner actually says.
const TARGETS = {
  factory: env("HOOD_FACTORY"),
  router: env("HOOD_FEE_ROUTER"),
  portal: env("HOOD_PORTAL"),
  bridge: env("HOOD_BRIDGE_FACTORY"),
  drop: env("HOOD_SEASON_DROP"),
  referrals: env("HOOD_REFERRALS"),
  // the Bag's side. None of these is Ownable: payday, burn and boosts ask the factory's owner,
  // the graduator too, and the hook takes no owner call at all.
  payday: env("HOOD_PAYDAY"),
  burn: env("HOOD_BURN_CLOCK"),
  boosts: env("HOOD_BOOSTS"),
  graduator: env("HOOD_GRADUATOR"),
  hook: env("HOOD_GRADUATION_HOOK"),
  staking: env("HOOD_STAKING"),
};

/// The ones with an owner of their own (Ownable2Step), which `accept` and `info` ask about.
const OWNED = ["factory", "portal", "bridge", "drop", "referrals"];

const wiringAbi = parseAbi([
  "function keeper() view returns (address)",
  "function houseCoin() view returns (address)",
  "function houseToken() view returns (address)",
  "function bag() view returns (address)",
  "function hook() view returns (address)",
  "function slotPrice() view returns (uint256)",
  "function setKeeper(address next)",
  "function setHouseToken(address token)",
  "function setHouseCoin(address coin, (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key)",
]);

function target(name) {
  if (isAddress(name)) return getAddress(name);
  const a = TARGETS[name];
  if (!a) die(`${name} is neither an address nor a configured contract (${Object.keys(TARGETS).join(", ")})`);
  return getAddress(a);
}

async function protocolSafe(explicit) {
  const address = explicit ?? env("HOOD_SAFE");
  if (!address || !isAddress(address)) die("which Safe? pass it, or set HOOD_SAFE");
  if (!(await safeContractsAreCanonical(client))) die("the Safe contracts on this chain are not the canonical v1.4.1 code; refusing");
  const info = await readSafe(client, getAddress(address));
  if (!info) die(`${address} is not a Safe on this chain`);
  return info;
}

async function signers() {
  const keys = (env("SAFE_SIGNER_KEYS") ?? "").split(",").map((k) => k.trim()).filter(Boolean);
  const accounts = keys.map((k) => privateKeyToAccount(k.startsWith("0x") ? k : `0x${k}`));
  const labels = option("--keystore");
  if (labels) {
    const { unlockWallet } = await import("../packages/sdk/dist/keystore.js");
    const password = env("HOOD_KEYSTORE_PASSWORD");
    if (!password) die("--keystore needs HOOD_KEYSTORE_PASSWORD");
    for (const label of labels.split(",")) accounts.push(unlockWallet(label.trim(), password));
  }
  return accounts;
}

const describe = (c) => `${c.label ?? c.to}${c.value ? ` (value ${c.value} wei)` : ""}`;

/// Everything `accept` and `call` share: the batch file, then optionally signatures, a proposal and
/// the execution.
async function send(safe, calls, name, description) {
  const tx = buildSafeTransaction(calls, safe.nonce);
  const safeTxHash = await safeTransactionHash(client, safe.address, tx);

  const file = safeBatchFile({ safe: safe.address, chainId: chain.id, calls, name, description });
  const out = option("--out") ?? `safe-batch-${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${safe.nonce}.json`;
  writeFileSync(out, `${JSON.stringify(file, null, 2)}\n`);

  console.log(`Safe        ${safe.address}  (${safe.threshold} of ${safe.owners.length}, nonce ${safe.nonce})`);
  for (const c of calls) console.log(`  call      ${describe(c)}`);
  console.log(`as          ${calls.length === 1 ? "one call" : `one batch of ${calls.length} (MultiSendCallOnly)`}`);
  console.log(`safeTxHash  ${safeTxHash}`);
  console.log(`batch file  ${out}   (Safe{Wallet} -> Apps -> Transaction Builder -> drop it in)`);
  console.log(`queue       ${safeQueueUrl(safe.address)}`);

  if (!flags.has("--sign") && !flags.has("--exec") && !flags.has("--propose")) return { safeTxHash };

  const accounts = await signers();
  if (accounts.length === 0) die("--sign/--exec/--propose need SAFE_SIGNER_KEYS or --keystore");
  const signatures = [];
  for (const account of accounts) {
    if (!safe.owners.some((o) => o.toLowerCase() === account.address.toLowerCase())) die(`${account.address} is not an owner of this Safe`);
    const wallet = createWalletClient({ account, chain, transport: http(RPC) });
    signatures.push(await signSafeTransaction(wallet, safe.address, chain.id, tx));
    console.log(`signed      ${account.address}`);
  }

  if (flags.has("--propose")) {
    const apiKey = env("SAFE_API_KEY");
    if (!apiKey) die("--propose needs SAFE_API_KEY");
    await proposeSafeTransaction({ safe: safe.address, tx, safeTxHash, signature: signatures[0], apiKey });
    console.log(`proposed    in the queue with ${signatures[0].signer}'s signature; the others sign in Safe{Wallet}`);
  }

  if (flags.has("--exec")) {
    if (signatures.length < safe.threshold) die(`${signatures.length} signature(s), the Safe needs ${safe.threshold}; not sending`);
    const executorKey = env("EXECUTOR_KEY");
    const executor = executorKey ? privateKeyToAccount(executorKey) : accounts[0];
    const wallet = createWalletClient({ account: executor, chain, transport: http(RPC) });
    const hash = await executeSafeTransaction(wallet, safe.address, tx, signatures.slice(0, safe.threshold));
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") die(`execution reverted: ${hash}`);
    console.log(`executed    ${hash} (block ${receipt.blockNumber})`);
  }
  return { safeTxHash };
}

// ---------------------------------------------------------------- commands

async function predict() {
  const owners = (option("--owners") ?? "").split(",").map((o) => o.trim()).filter(Boolean);
  if (owners.length === 0 || !owners.every(isAddress)) die("--owners 0xA,0xB,0xC");
  const threshold = Number(option("--threshold"));
  if (!Number.isInteger(threshold)) die("--threshold <n>");
  const salt = BigInt(option("--salt") ?? "0");
  const address = await predictSafeAddress(client, owners.map(getAddress), threshold, salt);
  const code = await client.getCode({ address });
  console.log(`${address}  ${code && code !== "0x" ? "(already created)" : "(not created yet: script/DeploySafe.s.sol)"}`);
}

async function info() {
  const safe = await protocolSafe(positional[0]);
  console.log(`Safe        ${safe.address}`);
  console.log(`version     ${safe.version}`);
  console.log(`threshold   ${safe.threshold} of ${safe.owners.length}`);
  for (const o of safe.owners) console.log(`  owner     ${o}`);
  console.log(`nonce       ${safe.nonce}`);
  console.log(`balance     ${await client.getBalance({ address: safe.address })} wei`);
  for (const [name, address] of Object.entries(TARGETS)) {
    if (!address) continue;
    if (!OWNED.includes(name)) {
      console.log(`${name.padEnd(11)} ${address}  no owner of its own (asks the factory's owner, or nobody)`);
      continue;
    }
    const [owner, pending] = await Promise.all([
      client.readContract({ address, abi: ownable2StepAbi, functionName: "owner" }),
      client.readContract({ address, abi: ownable2StepAbi, functionName: "pendingOwner" }).catch(() => zeroAddress),
    ]);
    const role = owner.toLowerCase() === safe.address.toLowerCase() ? "owned by this Safe"
      : pending.toLowerCase() === safe.address.toLowerCase() ? "WAITING for this Safe to accept"
      : `owned by ${owner}`;
    console.log(`${name.padEnd(11)} ${address}  ${role}`);
  }
  // the wiring the Safe is responsible for, read live; a dash where the contract is not configured
  const view = async (name, fn) => {
    const address = TARGETS[name];
    if (!address) return "-  (not configured)";
    try {
      const v = await client.readContract({ address: getAddress(address), abi: wiringAbi, functionName: fn });
      return typeof v === "bigint" ? `${v} wei` : v === zeroAddress ? "0x0  (unset)" : v;
    } catch (e) {
      return `?  (${e.shortMessage ?? e.message})`;
    }
  };
  console.log("");
  console.log(`router.keeper()        ${await view("router", "keeper")}`);
  console.log(`payday.keeper()        ${await view("payday", "keeper")}`);
  console.log(`burnClock.keeper()     ${await view("burn", "keeper")}`);
  console.log(`burnClock.houseCoin()  ${await view("burn", "houseCoin")}`);
  console.log(`staking.houseToken()   ${await view("staking", "houseToken")}`);
  console.log(`factory.bag()          ${await view("factory", "bag")}`);
  console.log(`portal.bag()           ${await view("portal", "bag")}`);
  console.log(`graduator.hook()       ${await view("graduator", "hook")}`);
  console.log(`boosts.slotPrice()     ${await view("boosts", "slotPrice")}`);
}

async function accept() {
  const safe = await protocolSafe(option("--safe"));
  const calls = [];
  for (const [name, address] of Object.entries(TARGETS)) {
    if (!address || !OWNED.includes(name)) continue;
    const [owner, pending] = await Promise.all([
      client.readContract({ address, abi: ownable2StepAbi, functionName: "owner" }),
      client.readContract({ address, abi: ownable2StepAbi, functionName: "pendingOwner" }).catch(() => zeroAddress),
    ]);
    if (owner.toLowerCase() === safe.address.toLowerCase()) {
      console.log(`${name.padEnd(11)} already owned by the Safe`);
    } else if (pending.toLowerCase() === safe.address.toLowerCase()) {
      calls.push({ to: getAddress(address), data: encodeFunctionData({ abi: ownable2StepAbi, functionName: "acceptOwnership" }), label: `${name}.acceptOwnership()` });
    } else {
      console.log(`${name.padEnd(11)} owned by ${owner}, pending ${pending}: not handed to this Safe, skipped`);
    }
  }
  if (calls.length === 0) return console.log("nothing is waiting for this Safe");
  await send(safe, calls, "hood.fam accept ownership", "acceptOwnership() on every hood.fam contract handed to this Safe");
}

async function call() {
  const [to, signature, ...args] = positional;
  if (!to || !signature) die('call <target> "<fn(type,...)>" [args...]');
  const safe = await protocolSafe(option("--safe"));
  const item = parseAbiItem(`function ${signature.replace(/^function\s+/, "")}`);
  const typed = item.inputs.map((input, i) => {
    const raw = args[i];
    if (raw === undefined) die(`${item.name} wants ${item.inputs.length} argument(s)`);
    if (input.type.startsWith("uint") || input.type.startsWith("int")) return BigInt(raw);
    if (input.type === "bool") return raw === "true";
    if (input.type === "address") return getAddress(raw);
    if (input.type.endsWith("[]") || input.type.startsWith("tuple")) return JSON.parse(raw);
    return raw;
  });
  const data = encodeFunctionData({ abi: [item], functionName: item.name, args: typed });
  const value = BigInt(option("--value") ?? "0");
  const label = `${to}.${item.name}(${args.join(", ")})`;
  await send(safe, [{ to: target(to), value, data, label }], `hood.fam ${item.name}`, label);
}

/// One launch's referral leg, carved out of the protocol's share. The registry refuses more than
/// half, and a referrer that cannot take a transfer blocks that launch's protocol claim until this
/// same command clears it with `0x0 0`.
async function referral() {
  const [token, to, bps] = positional;
  if (!token || !to || bps === undefined) die("referral <token> <to> <bps>   (0x0 0 clears it)");
  if (!isAddress(token)) die(`${token} is not a token address`);
  const recipient = /^0x0*$/.test(to) ? zeroAddress : to;
  if (!isAddress(recipient)) die(`${to} is not an address`);
  const n = Number(bps);
  if (!Number.isInteger(n) || n < 0 || n > 5000) die("bps is a whole number from 0 to 5000 (half of the protocol's share)");
  if (n !== 0 && recipient === zeroAddress) die("a referral with bps needs somebody to pay; 0x0 0 clears it");
  const safe = await protocolSafe(option("--safe"));
  const item = parseAbiItem("function setReferral(address token, address to, uint16 bps)");
  const data = encodeFunctionData({ abi: [item], functionName: "setReferral", args: [getAddress(token), getAddress(recipient), n] });
  const label = n === 0
    ? `referrals.setReferral(${getAddress(token)}, cleared)`
    : `referrals.setReferral(${getAddress(token)}, ${getAddress(recipient)}, ${n} bps)`;
  await send(safe, [{ to: target("referrals"), value: 0n, data, label }], "hood.fam referral", label);
}

/// The keeper wallet, on the three contracts that take one, in one batch. The factory owner is
/// the only caller each of them accepts, which is this Safe. Zero disables; a rotation is the same
/// command with the new wallet.
async function keeper() {
  const [who] = positional;
  if (!who) die("keeper <address>   (0x0 disables it)");
  const next = /^0x0*$/.test(who) ? zeroAddress : who;
  if (!isAddress(next)) die(`${who} is not an address`);
  const safe = await protocolSafe(option("--safe"));
  const data = encodeFunctionData({ abi: wiringAbi, functionName: "setKeeper", args: [getAddress(next)] });
  const calls = [];
  for (const [name, label] of [["router", "feeRouter"], ["payday", "payday"], ["burn", "burnClock"]]) {
    const address = TARGETS[name];
    if (!address) {
      console.log(`${label.padEnd(11)} not configured, skipped`);
      continue;
    }
    calls.push({ to: getAddress(address), value: 0n, data, label: `${label}.setKeeper(${getAddress(next)})` });
  }
  if (calls.length === 0) die("none of HOOD_FEE_ROUTER, HOOD_PAYDAY, HOOD_BURN_CLOCK is set");
  await send(safe, calls, "hood.fam keeper", `setKeeper(${getAddress(next)}) on ${calls.length} contract(s)`);
}

/// The house coin, once it exists: the burn clock learns the coin and the pool it buys it from,
/// and the Vault learns the coin if it has none yet. Both are once-only on chain, so the Safe sees
/// the whole PoolKey decoded before signing.
async function housecoin() {
  const [coin, currency0, currency1, fee, tickSpacing, hooks] = positional;
  if (!coin || !currency0 || !currency1 || fee === undefined || tickSpacing === undefined || !hooks) {
    die("housecoin <coin> <currency0> <currency1> <fee> <tickSpacing> <hooks>   (hooks 0x0 for a plain pool)");
  }
  for (const [name, value] of [["coin", coin], ["currency0", currency0], ["currency1", currency1]]) {
    if (!isAddress(value)) die(`${name}: ${value} is not an address`);
  }
  const hooksAddress = /^0x0*$/.test(hooks) ? zeroAddress : hooks;
  if (!isAddress(hooksAddress)) die(`hooks: ${hooks} is not an address`);
  const c0 = getAddress(currency0);
  const c1 = getAddress(currency1);
  const coinAddress = getAddress(coin);
  if (coinAddress !== c0 && coinAddress !== c1) die("the coin has to be currency0 or currency1 of the pool");
  if (BigInt(c0) >= BigInt(c1)) die("currency0 must sort below currency1, the way Uniswap v4 keys a pool");
  const feeN = Number(fee);
  const spacingN = Number(tickSpacing);
  if (!Number.isInteger(feeN) || feeN < 0 || feeN > 1_000_000) die("fee is the pool's LP fee in hundredths of a bip (3000 = 0.3%)");
  if (!Number.isInteger(spacingN) || spacingN <= 0 || spacingN > 32767) die("tickSpacing is a positive whole number");

  const safe = await protocolSafe(option("--safe"));
  const key = { currency0: c0, currency1: c1, fee: feeN, tickSpacing: spacingN, hooks: getAddress(hooksAddress) };
  const calls = [{
    to: target("burn"), value: 0n,
    data: encodeFunctionData({ abi: wiringAbi, functionName: "setHouseCoin", args: [coinAddress, key] }),
    label: `burnClock.setHouseCoin(${coinAddress}, {${c0}, ${c1}, ${feeN}, ${spacingN}, ${key.hooks}})`,
  }];
  if (TARGETS.staking) {
    const current = await client.readContract({ address: target("staking"), abi: wiringAbi, functionName: "houseToken" }).catch(() => undefined);
    if (current === zeroAddress) {
      calls.push({
        to: target("staking"), value: 0n,
        data: encodeFunctionData({ abi: wiringAbi, functionName: "setHouseToken", args: [coinAddress] }),
        label: `staking.setHouseToken(${coinAddress})`,
      });
    } else if (current && current.toLowerCase() !== coinAddress.toLowerCase()) {
      die(`the Vault already holds a different coin (${current}); refusing to name another for the burn clock`);
    } else if (current) {
      console.log("staking     already holds this coin; only the burn clock is set");
    }
  }
  await send(safe, calls, "hood.fam house coin", `the house coin ${coinAddress}: burn clock pool key${calls.length > 1 ? " and the Vault's coin" : ""}`);
}

async function status() {
  const [hash] = positional;
  if (!hash) die("status <safeTxHash>");
  const s = await safeTxStatus(hash, { apiKey: env("SAFE_API_KEY") });
  if (!s) return console.log("the Safe transaction service has not seen it (not proposed yet?)");
  console.log(`signatures  ${s.confirmations} of ${s.confirmationsRequired}`);
  console.log(s.executed ? `executed    ${s.transactionHash} ${s.successful ? "(success)" : "(FAILED)"}` : "not executed yet");
}

const commands = { predict, info, accept, call, referral, keeper, housecoin, status };
if (!commands[command]) {
  console.log("usage: npm run safe -- predict|info|accept|call|referral|keeper|housecoin|status   (see the top of scripts/safe.mjs)");
  process.exit(command ? 1 : 0);
}
await commands[command]();
