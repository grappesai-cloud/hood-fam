import {
  BaseError, ContractFunctionRevertedError, createPublicClient, encodeFunctionData, erc20Abi, http,
  type Address, type Hash, type Hex, type PrivateKeyAccount,
} from "viem";
import { hoodCurveAbi, hoodTokenLockAbi, robinhood } from "@hood/sdk";

/// Every transaction the team desk sends, signed in this tab by a team wallet's own key.
///
/// Each function here is one ordinary thing a holder does with their own wallet: take a lock out,
/// move tokens, sell back to the curve, move ETH. Each one is simulated before it is signed, so a
/// refusal comes back as the contract's reason and not as a failed transaction that still cost gas,
/// and each one waits for its receipt before returning, so the caller can run a wallet's steps one
/// after another without two of them fighting over a nonce.
///
/// The transaction is filled in here (nonce, gas, fees), signed by the local account and handed to
/// the node as raw bytes. Not through viem's wallet client: that first asks the node to fill the
/// transaction itself with eth_fillTransaction, which the same-origin proxy refuses, so every send
/// would start with a refused request and a console error before falling back to this same path.

/// Where the signed bytes go. The same endpoint the rest of the app reads through; the same-origin
/// proxy relays eth_sendRawTransaction and nothing that would ask the node to sign.
export function rpcUrl(): string {
  const raw = process.env.NEXT_PUBLIC_RPC || "/api/rpc";
  return /^https?:\/\//i.test(raw) ? raw : new URL(raw, window.location.origin).toString();
}

function reader() {
  return createPublicClient({ chain: robinhood, transport: http(rpcUrl()) });
}


/// What the desk shows while a step runs: a word for the step, and its hash once there is one.
export type Report = (step: string, hash?: Hash) => void;

/// The sale floor: 3% under the quote taken just before the sale is signed.
export const SELL_SLIPPAGE_BPS = 300n;

async function settle(hash: Hash): Promise<void> {
  const receipt = await reader().waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== "success") throw new Error("The transaction reverted on chain.");
}

/// Fill, sign, relay, wait. The gas limit is the estimate plus a tenth, the room an Orbit chain's
/// L1 component needs when the L1 price moves between estimate and inclusion; unused gas is not
/// charged. `gas` and `fees` are passed in only by the sweep, whose value was worked out from them.
async function transact(
  account: PrivateKeyAccount,
  tx: { to: Address; data?: Hex; value?: bigint; gas?: bigint; fees?: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } },
  step: string,
  report: Report,
): Promise<void> {
  const client = reader();
  const [nonce, price, gas] = await Promise.all([
    client.getTransactionCount({ address: account.address, blockTag: "pending" }),
    tx.fees ?? client.estimateFeesPerGas(),
    tx.gas ?? client.estimateGas({ account: account.address, to: tx.to, data: tx.data, value: tx.value }).then((g) => (g * 11n) / 10n),
  ]);
  report(step);
  const serializedTransaction = await account.signTransaction({
    type: "eip1559", chainId: robinhood.id, nonce, to: tx.to, data: tx.data, value: tx.value ?? 0n, gas,
    maxFeePerGas: price.maxFeePerGas, maxPriorityFeePerGas: price.maxPriorityFeePerGas,
  });
  const hash = await client.sendRawTransaction({ serializedTransaction });
  report(step, hash);
  await settle(hash);
}

export async function withdrawLock(account: PrivateKeyAccount, lock: Address, id: bigint, report: Report): Promise<void> {
  const client = reader();
  await client.simulateContract({ account, address: lock, abi: hoodTokenLockAbi, functionName: "withdraw", args: [id] });
  await transact(account, { to: lock, data: encodeFunctionData({ abi: hoodTokenLockAbi, functionName: "withdraw", args: [id] }) }, "withdrawing", report);
}

/// `amount` null means everything the wallet holds when the transfer is signed, read then and not
/// from the table, which may be a refresh behind.
export async function sendTokens(
  account: PrivateKeyAccount, token: Address, to: Address, amount: bigint | null, report: Report,
): Promise<void> {
  const client = reader();
  const value = amount ?? await client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
  if (value <= 0n) throw new Error("This wallet holds none of the token.");
  await client.simulateContract({ account, address: token, abi: erc20Abi, functionName: "transfer", args: [to, value] });
  await transact(account, { to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, value] }) }, "sending", report);
}

/// A sale back to the curve of `pct` percent of what the wallet holds right now. The approval is
/// for exactly the amount sold, never unlimited, and is skipped when one already covers it.
export async function sellOnCurve(
  account: PrivateKeyAccount, token: Address, curve: Address, pct: number, report: Report,
): Promise<void> {
  const client = reader();
  const held = await client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
  const tokensIn = pct >= 100 ? held : (held * BigInt(Math.round(pct * 100))) / 10_000n;
  if (tokensIn <= 0n) throw new Error("Nothing to sell.");

  const allowance = await client.readContract({
    address: token, abi: erc20Abi, functionName: "allowance", args: [account.address, curve],
  });
  if (allowance < tokensIn) {
    await client.simulateContract({ account, address: token, abi: erc20Abi, functionName: "approve", args: [curve, tokensIn] });
    await transact(account, { to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [curve, tokensIn] }) }, "approving", report);
  }

  // Quoted after the approval lands, as close to the sale as the page can get it.
  const [pairOut] = await client.readContract({ address: curve, abi: hoodCurveAbi, functionName: "quoteSell", args: [tokensIn] });
  if (pairOut === 0n) throw new Error("The curve cannot take that many back right now.");
  const minPairOut = (pairOut * (10_000n - SELL_SLIPPAGE_BPS)) / 10_000n;
  const args = [tokensIn, minPairOut, account.address] as const;
  await client.simulateContract({ account, address: curve, abi: hoodCurveAbi, functionName: "sell", args });
  await transact(account, { to: curve, data: encodeFunctionData({ abi: hoodCurveAbi, functionName: "sell", args }) }, "selling", report);
}

/// What sweeping a wallet would move, and what it keeps back for the sweep's own gas. The gas limit
/// gets a tenth on top of the estimate, and the reserve is that limit at the highest fee the
/// transaction may pay, so the sweep cannot fail for want of gas; the unspent part of the reserve
/// is the dust left behind.
export async function sweepPlan(from: Address, to: Address) {
  const client = reader();
  const [balance, estimate, fees] = await Promise.all([
    client.getBalance({ address: from }),
    client.estimateGas({ account: from, to, value: 1n }),
    client.estimateFeesPerGas(),
  ]);
  const gas = (estimate * 11n) / 10n;
  const reserve = gas * fees.maxFeePerGas;
  return { balance, gas, reserve, value: balance > reserve ? balance - reserve : 0n, fees };
}

export async function sweepEth(account: PrivateKeyAccount, to: Address, report: Report): Promise<void> {
  const plan = await sweepPlan(account.address, to);
  if (plan.value <= 0n) throw new Error("The balance does not cover the gas of the sweep.");
  // The fees the reserve was priced at are the fees signed, so the reserve covers the worst case.
  await transact(account, { to, value: plan.value, gas: plan.gas, fees: plan.fees }, "sweeping", report);
}

/// The quote the confirmation screen shows. Each wallet is quoted alone, against the curve as it
/// is now; sold one after another, the later ones get less, which the screen says.
export async function quoteSale(token: Address, curve: Address, wallet: Address, pct: number) {
  const client = reader();
  const held = await client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [wallet] });
  const tokensIn = pct >= 100 ? held : (held * BigInt(Math.round(pct * 100))) / 10_000n;
  if (tokensIn === 0n) return { tokensIn, pairOut: 0n };
  const [pairOut] = await client.readContract({ address: curve, abi: hoodCurveAbi, functionName: "quoteSell", args: [tokensIn] });
  return { tokensIn, pairOut };
}

/// The contract errors a desk action runs into, said the way the person pressing the button needs
/// to hear them. Anything else comes back under its own name.
const REVERTS: Record<string, string> = {
  StillLocked: "The lock has not opened yet.",
  NotOwner: "This wallet does not own that lock.",
  NoLock: "There is no such lock, or it was already withdrawn.",
  Slippage: "The price moved more than 3% before the sale landed. Nothing was sold.",
  NotTrading: "The curve is closed; this token trades in its pool now.",
  NothingBought: "The curve cannot take that many back.",
};

/// One sentence for the row. viem's short message on a revert is only "reverted"; the decoded error
/// name sits further down the cause chain, and that name is the useful part.
export function reason(e: unknown): string {
  if (e instanceof BaseError) {
    const revert = e.walk((x) => x instanceof ContractFunctionRevertedError);
    const name = revert instanceof ContractFunctionRevertedError ? revert.data?.errorName ?? revert.reason : undefined;
    if (name) return REVERTS[name] ?? `Refused by the contract: ${name}.`;
    return e.shortMessage;
  }
  if (e instanceof Error) return e.message;
  return String(e);
}
