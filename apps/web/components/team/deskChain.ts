import {
  BaseError, ContractFunctionRevertedError, createPublicClient, encodeFunctionData, erc20Abi, http, maxUint256, parseAbi,
  zeroAddress, type Address, type Hash, type Hex, type PrivateKeyAccount,
} from "viem";
import {
  buildSwap, hoodCurveAbi, hoodLockerAbi, hoodPortalAbi, hoodTokenLockAbi, minOutFromQuote, permit2Abi, quoteDirectSwap,
  robinhood, uniswapV4, universalRouterAbi, type PoolKey,
} from "@hood/sdk";
import { directAddresses } from "@/lib/config";

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
  Slippage: "The price moved more than 3% before it landed. Nothing went through.",
  SoldOut: "The curve has sold out; the token is on its way to its pool.",
  TransactionDeadlinePassed: "The pool took too long to answer. Nothing was bought.",
  V4TooLittleReceived: "The price moved more than 3% before it landed. Nothing went through.",
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

// ---------------------------------------------------------------- buying

/// The floor under a buy: 3% under the quote taken just before it is signed, like the sale's.
export const BUY_SLIPPAGE_BPS = 300n;

/// The curve's per-wallet quote and its opening-tax read. Hand-written because the SDK's generated
/// ABI predates them; a curve from before they existed answers the plain quote and no tax.
const curveQuoteAbi = parseAbi([
  "function quoteBuyFor(uint256 pairIn, address to) view returns (uint256 tokensOut, uint256 pairSpent, uint256 fee)",
  "function currentSnipeTaxBps(address recipient) view returns (uint256)",
]);
const hookTaxAbi = parseAbi(["function currentSnipeTaxBps(address origin) view returns (uint256)"]);

export interface BuyQuote {
  tokensOut: bigint;
  /// The opening tax this wallet would pay right now, in basis points. Zero for an open buyer, and
  /// zero once the opening is over.
  taxBps: bigint;
}

/// The one sentence the desk says when a buy would be taxed. A team wallet that reads this is
/// either not on the launch's open-buyer list or is buying before the opening is over; either way
/// the desk does not sign, because a taxed team buy is a sniper's buy on the token page.
export function taxedBuyReason(taxBps: bigint): string {
  return `This wallet would pay ${Number(taxBps) / 100}% opening tax right now: it is not one of this launch's open buyers, or the opening is not over yet. Nothing was bought.`;
}

/// What `pairIn` buys for `wallet` on the curve this second, the opening tax taken when there is one.
export async function quoteCurveBuy(curve: Address, wallet: Address, pairIn: bigint): Promise<BuyQuote> {
  const client = reader();
  let taxBps = 0n;
  try {
    taxBps = await client.readContract({ address: curve, abi: curveQuoteAbi, functionName: "currentSnipeTaxBps", args: [wallet] });
  } catch { /* a curve from before the opening tax */ }
  try {
    const [tokensOut] = await client.readContract({ address: curve, abi: curveQuoteAbi, functionName: "quoteBuyFor", args: [pairIn, wallet] });
    return { tokensOut, taxBps };
  } catch {
    const [tokensOut] = await client.readContract({ address: curve, abi: hoodCurveAbi, functionName: "quoteBuy", args: [pairIn] });
    return { tokensOut, taxBps };
  }
}

/// A buy on the curve, paid by the wallet itself. The chain's own currency goes along as value; an
/// ERC-20 pair is approved to the curve for exactly this amount first, when the allowance is short.
/// Refused outright when the wallet would pay any opening tax: the curve keys the exemption on the
/// recipient, and the recipient here is always the wallet itself.
export async function buyOnCurve(
  account: PrivateKeyAccount, curve: Address, pairToken: Address, pairIn: bigint, report: Report,
): Promise<void> {
  if (pairIn <= 0n) throw new Error("Nothing to buy with.");
  const client = reader();
  const native = pairToken.toLowerCase() === zeroAddress;
  {
    const { taxBps } = await quoteCurveBuy(curve, account.address, pairIn);
    if (taxBps > 0n) throw new Error(taxedBuyReason(taxBps));
  }
  if (!native) {
    const allowance = await client.readContract({ address: pairToken, abi: erc20Abi, functionName: "allowance", args: [account.address, curve] });
    if (allowance < pairIn) {
      await client.simulateContract({ account, address: pairToken, abi: erc20Abi, functionName: "approve", args: [curve, pairIn] });
      await transact(account, { to: pairToken, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [curve, pairIn] }) }, "approving", report);
    }
  }
  // Quoted as close to the buy as the page can get it; the floor sits 3% under. The tax is read
  // again here: an approval may have taken a block, and the answer is the one that will be signed.
  const { tokensOut, taxBps } = await quoteCurveBuy(curve, account.address, pairIn);
  if (taxBps > 0n) throw new Error(taxedBuyReason(taxBps));
  if (tokensOut === 0n) throw new Error("The curve quotes nothing for that amount right now.");
  const minTokensOut = (tokensOut * (10_000n - BUY_SLIPPAGE_BPS)) / 10_000n;
  const args = [pairIn, minTokensOut, account.address] as const;
  const value = native ? pairIn : 0n;
  await client.simulateContract({ account, address: curve, abi: hoodCurveAbi, functionName: "buy", args, value });
  await transact(account, { to: curve, data: encodeFunctionData({ abi: hoodCurveAbi, functionName: "buy", args }), value }, "buying", report);
}

const MAX_UINT160 = (1n << 160n) - 1n;
const MAX_UINT48 = (1n << 48n) - 1n;

interface PoolSide {
  quote: Address;
  hook: Address;
  key: PoolKey;
}

/// The pool a direct token trades in, read from the portal's registry and the position's locker.
async function poolOf(token: Address): Promise<PoolSide> {
  const portal = directAddresses.portal;
  if (!portal) throw new Error("The direct machine is not configured on this build.");
  const client = reader();
  const row = (await client.readContract({
    address: portal, abi: hoodPortalAbi, functionName: "getLaunch", args: [token],
  })) as { exists: boolean; quote: Address; locker: Address; hook: Address };
  if (!row.exists) throw new Error("This token is not a direct launch.");
  const k = await client.readContract({ address: row.locker, abi: hoodLockerAbi, functionName: "poolKey" });
  return {
    quote: row.quote, hook: row.hook,
    key: { currency0: k.currency0, currency1: k.currency1, fee: Number(k.fee), tickSpacing: Number(k.tickSpacing), hooks: k.hooks },
  };
}

/// What `amountIn` of the quote buys for `wallet` in a direct token's pool this second, from the
/// chain's own quoter, hook and all.
export async function quotePoolBuy(token: Address, wallet: Address, amountIn: bigint): Promise<BuyQuote & { quote: Address }> {
  const side = await poolOf(token);
  const client = reader();
  const q = await quoteDirectSwap({ publicClient: client, poolKey: side.key, tokenIn: side.quote, amountIn });
  let taxBps = 0n;
  try {
    taxBps = await client.readContract({ address: side.hook, abi: hookTaxAbi, functionName: "currentSnipeTaxBps", args: [wallet] });
  } catch { /* a hook from before the opening tax */ }
  return { tokensOut: q.amountOut, taxBps, quote: side.quote };
}

/// A buy in a direct token's pool through the UniversalRouter, paid by the wallet itself. The
/// chain's own currency goes along as value. An ERC-20 quote goes through Permit2: the token is
/// approved to Permit2 and Permit2 told the router may spend it, each once, each only when short.
/// Refused outright when the wallet would pay any opening tax: the hook keys the exemption on the
/// wallet that sends the transaction, which here is the wallet itself, so a plain wallet named at
/// launch reads zero and anything else in the opening reads the schedule.
export async function buyInPool(account: PrivateKeyAccount, token: Address, amountIn: bigint, report: Report): Promise<void> {
  if (amountIn <= 0n) throw new Error("Nothing to buy with.");
  const client = reader();
  const side = await poolOf(token);
  const taxNow = async () => {
    try {
      return await client.readContract({ address: side.hook, abi: hookTaxAbi, functionName: "currentSnipeTaxBps", args: [account.address] });
    } catch { return 0n; }
  };
  {
    const taxBps = await taxNow();
    if (taxBps > 0n) throw new Error(taxedBuyReason(taxBps));
  }
  const native = side.quote.toLowerCase() === zeroAddress;
  const router = uniswapV4.universalRouter as Address;
  const permit2 = uniswapV4.permit2 as Address;
  if (!native) {
    const toPermit2 = await client.readContract({ address: side.quote, abi: erc20Abi, functionName: "allowance", args: [account.address, permit2] });
    if (toPermit2 < amountIn) {
      const args = [permit2, maxUint256] as const;
      await client.simulateContract({ account, address: side.quote, abi: erc20Abi, functionName: "approve", args });
      await transact(account, { to: side.quote, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args }) }, "approving", report);
    }
    const [allowed, expiry] = await client.readContract({
      address: permit2, abi: permit2Abi, functionName: "allowance", args: [account.address, side.quote, router],
    });
    if (allowed < amountIn || Number(expiry) <= Math.floor(Date.now() / 1000)) {
      const args = [side.quote, router, MAX_UINT160, Number(MAX_UINT48)] as const;
      await client.simulateContract({ account, address: permit2, abi: permit2Abi, functionName: "approve", args });
      await transact(account, { to: permit2, data: encodeFunctionData({ abi: permit2Abi, functionName: "approve", args }) }, "permitting", report);
    }
  }
  // Read again just before signing: the approvals above may have taken blocks.
  {
    const taxBps = await taxNow();
    if (taxBps > 0n) throw new Error(taxedBuyReason(taxBps));
  }
  const q = await quoteDirectSwap({ publicClient: client, poolKey: side.key, tokenIn: side.quote, amountIn });
  if (q.amountOut === 0n) throw new Error("The pool quotes nothing for that amount right now.");
  const minAmountOut = minOutFromQuote(q.amountOut, Number(BUY_SLIPPAGE_BPS));
  const { commands, inputs } = buildSwap({
    key: side.key, zeroForOne: q.zeroForOne, amountIn, minAmountOut, tokenIn: side.quote, tokenOut: token,
  });
  // The deadline is against the block's clock, not this machine's.
  const latest = await client.getBlock();
  const args = [commands, inputs, latest.timestamp + 600n] as const;
  const value = native ? amountIn : 0n;
  const gas = await client.estimateContractGas({ account, address: router, abi: universalRouterAbi, functionName: "execute", args, value });
  // The opening surcharge decays between the estimate and the block that runs the swap, and the
  // hook's gas moves with it; a third more keeps the swap from dying in its bookkeeping.
  await transact(
    account,
    { to: router, data: encodeFunctionData({ abi: universalRouterAbi, functionName: "execute", args }), value, gas: (gas * 13n) / 10n },
    "buying", report,
  );
}
