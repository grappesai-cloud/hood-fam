import {
  concat,
  encodeFunctionData,
  encodePacked,
  getContractAddress,
  keccak256,
  size,
  stringToBytes,
  zeroAddress,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";

/// Safe v1.4.1 on Robinhood Chain.
///
/// hood.fam ships no multisig of its own. The protocol owner and treasury are a Safe, and any user
/// may be one: a team launching together, a DAO holding a position, a creator whose fee stream
/// lands in a shared account. It is the canonical deployment, already on 4663, byte for byte the
/// code Safe runs on Base (the code hashes below are checked before anything builds on it), and
/// Safe{Wallet} at app.safe.global supports the chain under the short name `robinhood`.

export const safeContracts = {
  safeL2: "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762",
  proxyFactory: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67",
  fallbackHandler: "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99",
  multiSendCallOnly: "0x9641d764fc13c8B624c04430C7356C1C7C8102e2",
} as const;

export const safeCodeHashes = {
  safeL2: "0xb1f926978a0f44a2c0ec8fe822418ae969bd8c3f18d61e5103100339894f81ff",
  proxyFactory: "0x50c3cdc4074750a7a974204a716c999edd37482f907608d960b2b025ee0b3317",
  fallbackHandler: "0x7c6007a5d711cea8dfd5d91f5940ec29c7f200fe511eb1fc1397b367af3c42f9",
  multiSendCallOnly: "0xecd5bd14a08c5d2122379900b2f272bdf107a7e92423c10dd5fe3254386c9939",
} as const;

/// Safe{Wallet}'s name for 4663, and its transaction service. Reads need no key; proposing a
/// transaction to the service does (SAFE_API_KEY, from developer.safe.global).
export const SAFE_SHORT_NAME = "robinhood";
export const SAFE_TX_SERVICE = "https://api.safe.global/tx-service/robinhood";

export const safeAbi = [
  { type: "function", name: "setup", stateMutability: "nonpayable", inputs: [{ name: "_owners", type: "address[]" }, { name: "_threshold", type: "uint256" }, { name: "to", type: "address" }, { name: "data", type: "bytes" }, { name: "fallbackHandler", type: "address" }, { name: "paymentToken", type: "address" }, { name: "payment", type: "uint256" }, { name: "paymentReceiver", type: "address" }], outputs: [] },
  { type: "function", name: "execTransaction", stateMutability: "payable", inputs: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }, { name: "operation", type: "uint8" }, { name: "safeTxGas", type: "uint256" }, { name: "baseGas", type: "uint256" }, { name: "gasPrice", type: "uint256" }, { name: "gasToken", type: "address" }, { name: "refundReceiver", type: "address" }, { name: "signatures", type: "bytes" }], outputs: [{ name: "success", type: "bool" }] },
  { type: "function", name: "getTransactionHash", stateMutability: "view", inputs: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }, { name: "operation", type: "uint8" }, { name: "safeTxGas", type: "uint256" }, { name: "baseGas", type: "uint256" }, { name: "gasPrice", type: "uint256" }, { name: "gasToken", type: "address" }, { name: "refundReceiver", type: "address" }, { name: "_nonce", type: "uint256" }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "nonce", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getOwners", stateMutability: "view", inputs: [], outputs: [{ type: "address[]" }] },
  { type: "function", name: "getThreshold", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "isOwner", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "VERSION", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "event", name: "ExecutionSuccess", inputs: [{ name: "txHash", type: "bytes32", indexed: false }, { name: "payment", type: "uint256", indexed: false }] },
  { type: "event", name: "ExecutionFailure", inputs: [{ name: "txHash", type: "bytes32", indexed: false }, { name: "payment", type: "uint256", indexed: false }] },
] as const;

export const safeProxyFactoryAbi = [
  { type: "function", name: "createProxyWithNonce", stateMutability: "nonpayable", inputs: [{ name: "_singleton", type: "address" }, { name: "initializer", type: "bytes" }, { name: "saltNonce", type: "uint256" }], outputs: [{ name: "proxy", type: "address" }] },
  { type: "function", name: "proxyCreationCode", stateMutability: "pure", inputs: [], outputs: [{ type: "bytes" }] },
  { type: "event", name: "ProxyCreation", inputs: [{ name: "proxy", type: "address", indexed: true }, { name: "singleton", type: "address", indexed: false }] },
] as const;

export const multiSendAbi = [
  { type: "function", name: "multiSend", stateMutability: "payable", inputs: [{ name: "transactions", type: "bytes" }], outputs: [] },
] as const;

/// The `acceptOwnership()` every hood.fam Ownable2Step contract has, and its two reads.
export const ownable2StepAbi = [
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "pendingOwner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "acceptOwnership", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "transferOwnership", stateMutability: "nonpayable", inputs: [{ name: "newOwner", type: "address" }], outputs: [] },
] as const;

export const SAFE_CALL = 0;
export const SAFE_DELEGATECALL = 1;

export interface SafeCall {
  to: Address;
  value?: bigint;
  data?: Hex;
}

/// One Safe transaction, exactly the fields its EIP-712 hash covers. hood.fam never asks for a gas
/// refund, so the four refund fields are always zero; a nonzero `safeTxGas` would also change what
/// a failure means (the Safe would record it and move on instead of reverting), so it is zero too.
export interface SafeTransaction {
  to: Address;
  value: bigint;
  data: Hex;
  operation: 0 | 1;
  safeTxGas: bigint;
  baseGas: bigint;
  gasPrice: bigint;
  gasToken: Address;
  refundReceiver: Address;
  nonce: bigint;
}

export interface SafeInfo {
  address: Address;
  owners: Address[];
  threshold: number;
  nonce: bigint;
  version: string;
}

type Reader = Pick<PublicClient, "readContract" | "getCode">;

// ---------------------------------------------------------------- creating one

/// What `setup` is called with: the owners, the threshold, the compatibility fallback handler (so
/// the Safe can answer EIP-1271 and receive NFTs), and nothing else.
export function safeInitializer(owners: readonly Address[], threshold: number): Hex {
  if (owners.length === 0) throw new Error("a Safe needs at least one owner");
  if (threshold < 1 || threshold > owners.length) throw new Error(`threshold ${threshold} does not fit ${owners.length} owners`);
  if (new Set(owners.map((o) => o.toLowerCase())).size !== owners.length) throw new Error("the same owner is listed twice");
  return encodeFunctionData({
    abi: safeAbi,
    functionName: "setup",
    args: [owners as Address[], BigInt(threshold), zeroAddress, "0x", safeContracts.fallbackHandler, zeroAddress, 0n, zeroAddress],
  });
}

/// The address the factory will give these owners, before anything is sent. The same owners,
/// threshold and salt give the same address on every chain that has the canonical factory.
export async function predictSafeAddress(
  client: Pick<PublicClient, "readContract">,
  owners: readonly Address[],
  threshold: number,
  saltNonce = 0n,
): Promise<Address> {
  const creationCode = await client.readContract({
    address: safeContracts.proxyFactory, abi: safeProxyFactoryAbi, functionName: "proxyCreationCode",
  });
  const salt = keccak256(encodePacked(["bytes32", "uint256"], [keccak256(safeInitializer(owners, threshold)), saltNonce]));
  const bytecode = concat([creationCode, encodePacked(["uint256"], [BigInt(safeContracts.safeL2)])]);
  return getContractAddress({ opcode: "CREATE2", from: safeContracts.proxyFactory, salt, bytecode });
}

/// Calldata that creates the Safe, for whoever pays the gas. It does not need to be an owner.
export function createSafeCall(owners: readonly Address[], threshold: number, saltNonce = 0n): SafeCall {
  return {
    to: safeContracts.proxyFactory,
    data: encodeFunctionData({
      abi: safeProxyFactoryAbi,
      functionName: "createProxyWithNonce",
      args: [safeContracts.safeL2, safeInitializer(owners, threshold), saltNonce],
    }),
  };
}

/// True when all four Safe contracts at the canonical addresses are exactly v1.4.1.
export async function safeContractsAreCanonical(client: Pick<PublicClient, "getCode">): Promise<boolean> {
  const names = Object.keys(safeContracts) as (keyof typeof safeContracts)[];
  const codes = await Promise.all(names.map((n) => client.getCode({ address: safeContracts[n] })));
  return names.every((n, i) => codes[i] !== undefined && keccak256(codes[i]!) === safeCodeHashes[n]);
}

// ---------------------------------------------------------------- reading one

/// Owners, threshold and nonce, or null when the address is not a Safe (no code, or code that
/// does not answer like one). An EOA is a normal answer, not an error.
export async function readSafe(client: Reader, address: Address): Promise<SafeInfo | null> {
  const code = await client.getCode({ address });
  if (!code || code === "0x") return null;
  try {
    const [owners, threshold, nonce, version] = await Promise.all([
      client.readContract({ address, abi: safeAbi, functionName: "getOwners" }),
      client.readContract({ address, abi: safeAbi, functionName: "getThreshold" }),
      client.readContract({ address, abi: safeAbi, functionName: "nonce" }),
      client.readContract({ address, abi: safeAbi, functionName: "VERSION" }),
    ]);
    if (threshold === 0n) return null;
    return { address, owners: [...owners], threshold: Number(threshold), nonce, version };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- building a transaction

/// MultiSendCallOnly's packed encoding: operation, to, value, length, data, back to back.
export function encodeMultiSend(calls: readonly SafeCall[]): Hex {
  const packed = concat(
    calls.map((c) => {
      const data = c.data ?? "0x";
      return encodePacked(["uint8", "address", "uint256", "uint256", "bytes"], [SAFE_CALL, c.to, c.value ?? 0n, BigInt(size(data)), data]);
    }),
  );
  return encodeFunctionData({ abi: multiSendAbi, functionName: "multiSend", args: [packed] });
}

/// One call goes as itself. Several go as one MultiSendCallOnly batch, reached by DELEGATECALL so
/// each call comes from the Safe: one round of signatures, all or nothing. CallOnly cannot itself
/// delegatecall, so a batch can never be turned into something that rewrites the Safe.
export function buildSafeTransaction(calls: readonly SafeCall[], nonce: bigint): SafeTransaction {
  if (calls.length === 0) throw new Error("nothing to send");
  const base = { safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: zeroAddress, refundReceiver: zeroAddress, nonce };
  if (calls.length === 1) {
    const [c] = calls;
    return { ...base, to: c!.to, value: c!.value ?? 0n, data: c!.data ?? "0x", operation: SAFE_CALL };
  }
  return { ...base, to: safeContracts.multiSendCallOnly, value: 0n, data: encodeMultiSend(calls), operation: SAFE_DELEGATECALL };
}

/// The EIP-712 message an owner signs. Safe v1.4.1's domain is the chain and the Safe itself.
export function safeTypedData(safe: Address, chainId: number, tx: SafeTransaction) {
  return {
    domain: { chainId, verifyingContract: safe },
    types: {
      SafeTx: [
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "data", type: "bytes" },
        { name: "operation", type: "uint8" },
        { name: "safeTxGas", type: "uint256" },
        { name: "baseGas", type: "uint256" },
        { name: "gasPrice", type: "uint256" },
        { name: "gasToken", type: "address" },
        { name: "refundReceiver", type: "address" },
        { name: "nonce", type: "uint256" },
      ],
    } as const,
    primaryType: "SafeTx" as const,
    message: { ...tx },
  };
}

/// The hash the Safe will check, read from the Safe itself rather than recomputed, so a signer
/// can never sign a hash the contract does not agree with.
export async function safeTransactionHash(client: Pick<PublicClient, "readContract">, safe: Address, tx: SafeTransaction): Promise<Hex> {
  return client.readContract({
    address: safe, abi: safeAbi, functionName: "getTransactionHash",
    args: [tx.to, tx.value, tx.data, tx.operation, tx.safeTxGas, tx.baseGas, tx.gasPrice, tx.gasToken, tx.refundReceiver, tx.nonce],
  });
}

export interface SafeSignature {
  signer: Address;
  data: Hex;
}

/// An owner's signature over the transaction, as a plain ECDSA signature (v 27 or 28).
export async function signSafeTransaction(
  wallet: WalletClient<Transport, Chain | undefined, Account>,
  safe: Address,
  chainId: number,
  tx: SafeTransaction,
): Promise<SafeSignature> {
  const data = await wallet.signTypedData({ account: wallet.account, ...safeTypedData(safe, chainId, tx) });
  return { signer: wallet.account.address, data };
}

/// Safe wants signatures ordered by signer address, ascending, with no repeats.
export function packSafeSignatures(signatures: readonly SafeSignature[]): Hex {
  const sorted = [...signatures].sort((a, b) => (BigInt(a.signer) < BigInt(b.signer) ? -1 : 1));
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.signer.toLowerCase() === sorted[i - 1]!.signer.toLowerCase()) throw new Error(`${sorted[i]!.signer} signed twice`);
  }
  return concat(sorted.map((s) => s.data));
}

/// Sends a fully signed transaction. Anyone may do this; the executor pays gas and gains nothing.
export async function executeSafeTransaction(
  wallet: WalletClient<Transport, Chain | undefined, Account>,
  safe: Address,
  tx: SafeTransaction,
  signatures: readonly SafeSignature[],
): Promise<Hex> {
  return wallet.writeContract({
    address: safe, abi: safeAbi, functionName: "execTransaction", chain: wallet.chain,
    args: [tx.to, tx.value, tx.data, tx.operation, tx.safeTxGas, tx.baseGas, tx.gasPrice, tx.gasToken, tx.refundReceiver, packSafeSignatures(signatures)],
  });
}

// ---------------------------------------------------------------- Safe{Wallet}

/// A batch file for Safe{Wallet}'s Transaction Builder (Apps -> Transaction Builder -> drag the file
/// in). The signers see every call decoded before they sign, and nothing here needs an API key.
/// The checksum is the one the Transaction Builder recomputes on import; with it right, the file
/// opens without the "this batch was modified" warning.
export interface SafeBatchFile {
  version: "1.0";
  chainId: string;
  createdAt: number;
  meta: { name: string; description?: string; txBuilderVersion: string; createdFromSafeAddress: string; createdFromOwnerAddress: string; checksum?: string };
  transactions: { to: string; value: string; data: string }[];
}

export function safeBatchFile(args: {
  safe: Address;
  chainId: number;
  calls: readonly SafeCall[];
  name: string;
  description?: string;
  createdAt?: number;
}): SafeBatchFile {
  const file: SafeBatchFile = {
    version: "1.0",
    chainId: String(args.chainId),
    createdAt: args.createdAt ?? Date.now(),
    meta: {
      name: args.name,
      ...(args.description ? { description: args.description } : {}),
      txBuilderVersion: "1.18.3",
      createdFromSafeAddress: args.safe,
      createdFromOwnerAddress: "",
    },
    transactions: args.calls.map((c) => ({ to: c.to, value: (c.value ?? 0n).toString(), data: c.data ?? "0x" })),
  };
  file.meta.checksum = batchFileChecksum(file);
  return file;
}

/// The Transaction Builder's own checksum: keys sorted at every level, the batch name nulled, then
/// keccak over the serialisation. Reimplemented from safe-react-apps `tx-builder/src/lib/checksum.ts`.
export function batchFileChecksum(file: SafeBatchFile): Hex {
  const { checksum: _drop, ...meta } = file.meta;
  return keccak256(stringToBytes(serializeForChecksum({ ...file, meta: { ...meta, name: null } })));
}

export function serializeForChecksum(json: unknown): string {
  const replacer = (_: string, value: unknown) => (value === undefined ? null : value);
  if (Array.isArray(json)) return `[${json.map((el) => serializeForChecksum(el)).join(",")}]`;
  if (typeof json === "object" && json !== null) {
    const keys = Object.keys(json).sort();
    let acc = `{${JSON.stringify(keys, replacer)}`;
    for (const k of keys) acc += `${serializeForChecksum((json as Record<string, unknown>)[k])},`;
    return `${acc}}`;
  }
  return `${JSON.stringify(json, replacer)}`;
}

/// Where a signer goes to see and sign the Safe's queue.
export const safeQueueUrl = (safe: Address) => `https://app.safe.global/transactions/queue?safe=${SAFE_SHORT_NAME}:${safe}`;
export const safeHomeUrl = (safe: Address) => `https://app.safe.global/home?safe=${SAFE_SHORT_NAME}:${safe}`;
/// Opens hood.fam inside Safe{Wallet} as a Safe App, connected as `safe`.
export const safeAppUrl = (safe: Address, appUrl: string) =>
  `https://app.safe.global/apps/open?safe=${SAFE_SHORT_NAME}:${safe}&appUrl=${encodeURIComponent(appUrl)}`;

// ---------------------------------------------------------------- the transaction service

export interface SafeTxStatus {
  safeTxHash: Hex;
  executed: boolean;
  /// The chain transaction that executed it, once one has.
  transactionHash?: Hex;
  successful?: boolean;
  confirmations: number;
  confirmationsRequired: number;
}

/// Where a proposed transaction stands, from Safe's service. Null when the service has never seen
/// it (not proposed yet, or proposed somewhere else).
export async function safeTxStatus(safeTxHash: Hex, opts: { apiKey?: string; fetch?: typeof fetch } = {}): Promise<SafeTxStatus | null> {
  const f = opts.fetch ?? fetch;
  const res = await f(`${SAFE_TX_SERVICE}/api/v1/multisig-transactions/${safeTxHash}/`, {
    headers: opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {},
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Safe transaction service answered ${res.status}`);
  const body = (await res.json()) as {
    isExecuted: boolean; transactionHash: Hex | null; isSuccessful: boolean | null;
    confirmations?: unknown[]; confirmationsRequired: number;
  };
  return {
    safeTxHash,
    executed: body.isExecuted,
    transactionHash: body.transactionHash ?? undefined,
    successful: body.isSuccessful ?? undefined,
    confirmations: body.confirmations?.length ?? 0,
    confirmationsRequired: body.confirmationsRequired,
  };
}

/// Puts a signed transaction in the Safe's queue on Safe{Wallet}, where the other owners see it and
/// add their signatures. Needs an API key: the service accepts reads from anyone, writes only from
/// a registered key.
export async function proposeSafeTransaction(args: {
  safe: Address;
  tx: SafeTransaction;
  safeTxHash: Hex;
  signature: SafeSignature;
  apiKey: string;
  origin?: string;
  fetch?: typeof fetch;
}): Promise<void> {
  const f = args.fetch ?? fetch;
  const { tx } = args;
  const res = await f(`${SAFE_TX_SERVICE}/api/v1/safes/${args.safe}/multisig-transactions/`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${args.apiKey}` },
    body: JSON.stringify({
      to: tx.to, value: tx.value.toString(), data: tx.data, operation: tx.operation,
      safeTxGas: tx.safeTxGas.toString(), baseGas: tx.baseGas.toString(), gasPrice: tx.gasPrice.toString(),
      gasToken: tx.gasToken, refundReceiver: tx.refundReceiver, nonce: tx.nonce.toString(),
      contractTransactionHash: args.safeTxHash, sender: args.signature.signer, signature: args.signature.data,
      origin: args.origin ?? "hood.fam",
    }),
  });
  if (!res.ok) throw new Error(`Safe transaction service refused the proposal (${res.status}): ${await res.text()}`);
}
