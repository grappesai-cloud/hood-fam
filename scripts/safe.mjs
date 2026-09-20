#!/usr/bin/env node
// The protocol's Safe, from a terminal.
//
//   npm run safe -- predict --owners 0xA,0xB,0xC --threshold 2 [--salt 0]
//   npm run safe -- info [<safe>]
//   npm run safe -- accept                       every hood.fam contract waiting for the Safe, one batch
//   npm run safe -- call <target> "<fn(types)>" [args...] [--value <wei>]
//   npm run safe -- status <safeTxHash>
//
// `accept` and `call` always write a Transaction Builder file: in Safe{Wallet}, Apps ->
// Transaction Builder, drop the file in, and every signer sees each call decoded before signing.
// That path needs no key on this machine and no API key anywhere, and it is the normal one.
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
// deployment's HOOD_FACTORY / HOOD_PORTAL / HOOD_BRIDGE_FACTORY / HOOD_SEASON_DROP.

import { writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, encodeFunctionData, getAddress, http, isAddress, parseAbiItem, zeroAddress } from "viem";
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
  portal: env("HOOD_PORTAL"),
  bridge: env("HOOD_BRIDGE_FACTORY"),
  drop: env("HOOD_SEASON_DROP"),
};

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
    const [owner, pending] = await Promise.all([
      client.readContract({ address, abi: ownable2StepAbi, functionName: "owner" }),
      client.readContract({ address, abi: ownable2StepAbi, functionName: "pendingOwner" }).catch(() => zeroAddress),
    ]);
    const role = owner.toLowerCase() === safe.address.toLowerCase() ? "owned by this Safe"
      : pending.toLowerCase() === safe.address.toLowerCase() ? "WAITING for this Safe to accept"
      : `owned by ${owner}`;
    console.log(`${name.padEnd(11)} ${address}  ${role}`);
  }
}

async function accept() {
  const safe = await protocolSafe(option("--safe"));
  const calls = [];
  for (const [name, address] of Object.entries(TARGETS)) {
    if (!address) continue;
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

async function status() {
  const [hash] = positional;
  if (!hash) die("status <safeTxHash>");
  const s = await safeTxStatus(hash, { apiKey: env("SAFE_API_KEY") });
  if (!s) return console.log("the Safe transaction service has not seen it (not proposed yet?)");
  console.log(`signatures  ${s.confirmations} of ${s.confirmationsRequired}`);
  console.log(s.executed ? `executed    ${s.transactionHash} ${s.successful ? "(success)" : "(FAILED)"}` : "not executed yet");
}

const commands = { predict, info, accept, call, status };
if (!commands[command]) {
  console.log("usage: npm run safe -- predict|info|accept|call|status   (see the top of scripts/safe.mjs)");
  process.exit(command ? 1 : 0);
}
await commands[command]();
