import type { Abi, Account, Address, Hash, PublicClient, TransactionReceipt, WalletClient } from "viem";
import { formatEther } from "viem";
import { log } from "./log.js";

/// One wallet, one nonce, one transaction in flight. Every loop in this process sends through this
/// queue, so two jobs can never race each other on the nonce or land a transaction the other one
/// already made pointless. A unit of work is: simulate against the current state, send, wait for
/// the receipt, one log line. In dry-run mode the unit stops after the simulation and says what it
/// would have sent.

export interface WriteRequest {
  address: Address;
  abi: Abi | readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
  /// Anything else viem's simulateContract accepts (gas, account, chain) rides along untouched.
  [extra: string]: unknown;
}

export interface Sent {
  hash: Hash;
  receipt?: TransactionReceipt;
  /// What the simulation returned: the function's return values, when it has any.
  result: unknown;
  dry: boolean;
}

/// The hash a dry run hands back instead of sending. Nothing on chain will ever have it.
export const DRY_HASH = ("0x" + "d0".repeat(32)) as Hash;

export class WriteQueue {
  private tail: Promise<unknown> = Promise.resolve();
  public sent = 0;
  public failed = 0;

  constructor(
    private readonly publicClient: PublicClient,
    private readonly walletClient: WalletClient,
    private readonly account: Account,
    public readonly dryRun: boolean,
    private readonly receiptTimeoutMs = 90_000,
  ) {}

  /// Joins the chain. Rejections are surfaced to the caller and never break the chain for the
  /// next unit.
  send(label: string, req: WriteRequest): Promise<Sent> {
    const unit = this.tail.then(() => this.execute(label, req));
    this.tail = unit.catch(() => undefined);
    return unit;
  }

  /// A transaction that is already mined, or a dry-run hash: returns at once. Anything else waits.
  async wait(hash: Hash): Promise<TransactionReceipt | undefined> {
    if (hash === DRY_HASH) return undefined;
    return this.publicClient.waitForTransactionReceipt({ hash, timeout: this.receiptTimeoutMs });
  }

  private async execute(label: string, req: WriteRequest): Promise<Sent> {
    const what = `${req.functionName}(${describeArgs(req.args)})${req.value ? ` value=${formatEther(req.value)}` : ""} to ${req.address}`;
    // Simulated inside the queue, not before it: the unit ahead of this one may have changed the
    // state the caller looked at when it decided to send.
    const { request, result } = await this.publicClient.simulateContract({
      ...(req as Record<string, unknown>),
      account: this.account,
    } as never);
    if (this.dryRun) {
      log("queue", `dry-run ${label}: would send ${what}${describeResult(result)}`);
      return { hash: DRY_HASH, result, dry: true };
    }
    let hash: Hash;
    try {
      hash = await this.walletClient.writeContract(request as never);
    } catch (e) {
      this.failed++;
      log("queue", `${label}: send failed: ${message(e)}`);
      throw e;
    }
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash, timeout: this.receiptTimeoutMs });
    if (receipt.status !== "success") {
      this.failed++;
      log("queue", `${label}: ${what} -> ${hash} REVERTED in block ${receipt.blockNumber}`);
      throw new Error(`${label}: transaction ${hash} reverted`);
    }
    this.sent++;
    log("queue", `${label}: ${what} -> ${hash} ok block ${receipt.blockNumber} gas ${receipt.gasUsed}`);
    return { hash, receipt, result, dry: false };
  }
}

/// A wallet client whose writes go through the queue. The SDK clients simulate on their own and
/// then call `writeContract` with the prepared request; this hands that request to the queue, which
/// simulates again in its turn, sends, and waits. The SDK's own `waitForTransactionReceipt` after
/// it then returns at once, because the receipt is already there.
export function queuedWallet(walletClient: WalletClient, queue: WriteQueue): WalletClient {
  const writeContract = async (request: WriteRequest & { functionName: string }) => {
    const sent = await queue.send(request.functionName, request);
    return sent.hash;
  };
  return { ...walletClient, writeContract } as unknown as WalletClient;
}

function describeArgs(args?: readonly unknown[]): string {
  if (!args || args.length === 0) return "";
  return args.map(describeArg).join(", ");
}

function describeArg(a: unknown): string {
  if (typeof a === "bigint") return a.toString();
  if (Array.isArray(a)) return a.length > 4 ? `[${a.length} items]` : `[${a.map(describeArg).join(", ")}]`;
  if (typeof a === "string") return a;
  if (a && typeof a === "object") return JSON.stringify(a, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  return String(a);
}

function describeResult(r: unknown): string {
  if (r === undefined || r === null) return "";
  return ` (simulated: ${describeArg(r)})`;
}

export function message(e: unknown): string {
  if (e instanceof Error) {
    // viem's errors carry the whole request in the message; the first line is the reason
    const first = e.message.split("\n").find((l) => l.trim().length > 0) ?? e.message;
    const short = (e as { shortMessage?: string }).shortMessage;
    return (short ?? first).slice(0, 300);
  }
  return String(e);
}
