import type { Address, Hex, Transport } from "viem";
import type { CreateConnectorFn } from "wagmi";
import { safeTxStatus } from "@hood/sdk";

/// A Safe is a wallet with a queue in front of it. (The half of lib/safe that is plain TypeScript:
/// the wagmi config imports it, and the wagmi config is read on the server too, so nothing here may
/// be a React hook or carry "use client". The hooks are in `safe-client.ts`.)
///
///
/// When the connected account is a Safe (hood.fam opened inside Safe{Wallet} as a Safe App, or a
/// Safe connected over WalletConnect), sending a transaction does not put it on chain. It proposes
/// it: what comes back is a Safe transaction hash, and the chain transaction only exists once enough
/// owners have signed and somebody executes it, which can be seconds or days later. Everything in
/// the app that waits for a receipt asks our RPC about that hash and would wait forever.
///
/// Rather than teach thirty buttons about Safes, this module sits in the two places every write
/// already passes through. The connector records each Safe transaction hash it hands out; the
/// transport answers a receipt lookup for one of those hashes with the receipt of the transaction
/// that executed it, and with "not yet" until there is one. A button that waited for an EOA's
/// receipt now waits, correctly, for the Safe's.

// ---------------------------------------------------------------- what is waiting

export interface PendingSafeTx {
  safeTxHash: Hex;
  safe: Address;
  /// The chain transaction that executed it, once one has.
  txHash?: Hex;
  confirmations?: number;
  required?: number;
  addedAt: number;
  lastChecked: number;
}

interface SafeAppsSdkLike {
  txs: { getBySafeTxHash(hash: string): Promise<{ txHash?: string | null; detailedExecutionInfo?: { confirmations?: unknown[]; confirmationsRequired?: number } }> };
}

const pending = new Map<string, PendingSafeTx & { sdk?: SafeAppsSdkLike }>();
const listeners = new Set<() => void>();
let snapshot: PendingSafeTx[] = [];

function changed() {
  snapshot = [...pending.values()].map(({ sdk: _sdk, ...p }) => p);
  for (const l of listeners) l();
}

function track(safeTxHash: string, safe: Address, sdk?: SafeAppsSdkLike) {
  const key = safeTxHash.toLowerCase();
  if (pending.has(key)) return;
  pending.set(key, { safeTxHash: safeTxHash as Hex, safe, sdk, addedAt: Date.now(), lastChecked: 0 });
  changed();
}

export const isSafeTxHash = (hash?: string) => Boolean(hash && pending.has(hash.toLowerCase()));

/// For the places that call `waitForTransactionReceipt` themselves: an EOA's transaction gets the
/// usual three minutes, a Safe's gets as long as its signers take.
export const receiptTimeout = (hash: string) => (isSafeTxHash(hash) ? 0 : undefined);

export function dismissSafeTx(safeTxHash: string) {
  if (pending.delete(safeTxHash.toLowerCase())) changed();
}

/// For the hook in `safe-client.ts`: subscribe, and read the list as it stands.
export function subscribeToSafeTxs(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export const safeTxSnapshot = () => snapshot;

/// The executed transaction behind a Safe transaction hash, or null while it waits for signatures.
/// Inside Safe{Wallet} the parent app answers; over WalletConnect, Safe's public transaction service
/// does. Asked at most every five seconds per hash, however often the receipt poll comes round.
async function resolve(key: string): Promise<Hex | null> {
  const p = pending.get(key);
  if (!p) return null;
  if (p.txHash) return p.txHash;
  if (Date.now() - p.lastChecked < 5_000) return null;
  p.lastChecked = Date.now();
  try {
    if (p.sdk) {
      const tx = await p.sdk.txs.getBySafeTxHash(p.safeTxHash);
      if (tx.txHash) p.txHash = tx.txHash as Hex;
      p.confirmations = tx.detailedExecutionInfo?.confirmations?.length;
      p.required = tx.detailedExecutionInfo?.confirmationsRequired;
    } else {
      const s = await safeTxStatus(p.safeTxHash);
      if (s?.transactionHash) p.txHash = s.transactionHash;
      if (s) {
        p.confirmations = s.confirmations;
        p.required = s.confirmationsRequired;
      }
    }
  } catch {
    // A service that is down is a transaction that is still pending, not a failed one.
  }
  changed();
  return p.txHash ?? null;
}

// ---------------------------------------------------------------- the transport

/// Receipt and transaction lookups for a Safe transaction hash are answered for the chain
/// transaction that executed it. Everything else passes straight through.
export function safeAware(inner: Transport): Transport {
  return ((opts: Parameters<Transport>[0]) => {
    const t = inner(opts);
    const request = (async (args: { method: string; params?: unknown }) => {
      const params = args.params as unknown[] | undefined;
      const hash = typeof params?.[0] === "string" ? (params[0] as string).toLowerCase() : undefined;
      if ((args.method === "eth_getTransactionReceipt" || args.method === "eth_getTransactionByHash") && hash && pending.has(hash)) {
        const real = await resolve(hash);
        if (!real) return null;
        const result = await t.request({ ...args, params: [real] } as never);
        if (args.method === "eth_getTransactionReceipt" && result) {
          // Mined: keep it on the list a few seconds so the strip can say so, then let it go.
          setTimeout(() => dismissSafeTx(hash), 6_000);
        }
        return result;
      }
      return t.request(args as never);
    }) as typeof t.request;
    return { ...t, request };
  }) as Transport;
}

// ---------------------------------------------------------------- the connector

interface Eip1193 {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
  sdk?: SafeAppsSdkLike;
}

const safeCache = new Map<string, Promise<boolean>>();

/// Whether `address` answers like a Safe, asked through the wallet's own provider.
function isSafe(provider: Eip1193, address: string): Promise<boolean> {
  const key = address.toLowerCase();
  if (!safeCache.has(key)) {
    safeCache.set(key, (async () => {
      const code = (await provider.request({ method: "eth_getCode", params: [address, "latest"] })) as string;
      if (!code || code === "0x") return false;
      try {
        // getThreshold()
        const out = (await provider.request({ method: "eth_call", params: [{ to: address, data: "0xe75235b8" }, "latest"] })) as string;
        return BigInt(out) > 0n;
      } catch {
        return false;
      }
    })().catch(() => false));
  }
  return safeCache.get(key)!;
}

/// Wraps a connector so a Safe behind it is handled as a Safe:
/// - no gas limit goes with the transaction. The Safe provider would turn it into `safeTxGas`, and
///   with that set a failing call no longer reverts: the Safe spends its nonce, records the
///   failure and reports success, which is the one outcome a trade must never have;
/// - every hash it hands back is recorded as a Safe transaction hash, for the transport above.
export function safeTracking(connectorFn: CreateConnectorFn): CreateConnectorFn {
  return ((config: Parameters<CreateConnectorFn>[0]) => {
    const connector = connectorFn(config);
    const original = connector.getProvider.bind(connector);
    let wrapped: { inner: unknown; proxy: unknown } | undefined;

    const intercept = async (provider: Eip1193, args: { method: string; params?: unknown }) => {
      const params = args.params as Record<string, unknown>[] | undefined;
      const from = params?.[0]?.from as Address | undefined;
      const asSafe = from && (connector.id === "safe" || (await isSafe(provider, from)));
      if (!asSafe) return provider.request(args);

      if (args.method === "eth_sendTransaction") {
        const { gas: _gas, ...tx } = params![0]!;
        const hash = (await provider.request({ method: args.method, params: [tx] })) as string;
        track(hash, from, provider.sdk);
        return hash;
      }
      const result = (await provider.request(args)) as { id?: string } | string;
      const id = typeof result === "string" ? result : result?.id;
      if (id) track(id, from, provider.sdk);
      return result;
    };

    return {
      ...connector,
      async getProvider(params?: { chainId?: number }) {
        const provider = (await original(params as never)) as Eip1193 | undefined;
        if (!provider) return provider;
        if (wrapped?.inner === provider) return wrapped.proxy;
        const proxy = new Proxy(provider, {
          get(target, prop, receiver) {
            if (prop === "request") {
              return (args: { method: string; params?: unknown }) =>
                args.method === "eth_sendTransaction" || args.method === "wallet_sendCalls"
                  ? intercept(target, args)
                  : target.request(args);
            }
            const value = Reflect.get(target, prop, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        wrapped = { inner: provider, proxy };
        return proxy;
      },
    };
  }) as CreateConnectorFn;
}
