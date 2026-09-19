"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useEffect, useMemo, useState } from "react";
import { parseUnits, formatUnits, maxUint256, zeroAddress, type Address } from "viem";
import { useAccount, useBalance, usePublicClient, useReadContract, useReadContracts, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { hoodLaunchHookAbi, minOutFromQuote, quoteDirectSwap } from "@hood/sdk";
import { uniswapV4 } from "@hood/sdk";
import { buildSwap, universalRouterAbi } from "@/lib/direct";
import { fmt, pairDecimals, pairSymbol } from "@/lib/format";

const erc20 = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

/// The UniversalRouter never pulls an ERC-20 itself: it asks Permit2 to. So selling needs the
/// token approved to Permit2, and Permit2 told that the router may spend it. Both once.
const permit2Abi = [
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }, { type: "address" }], outputs: [{ type: "uint160" }, { type: "uint48" }, { type: "uint48" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "address" }, { type: "uint160" }, { type: "uint48" }], outputs: [] },
] as const;
const MAX_UINT160 = (1n << 160n) - 1n;
const MAX_UINT48 = (1n << 48n) - 1n;

/// A buy in the chain's own currency keeps a sliver back for gas: a few padded swaps' worth.
const GAS_RESERVE = 500_000_000_000_000n; // 0.0005 ETH

/// Trading a direct launch means swapping the real pool, with the launch's hook in the path. The
/// tax is not a number in our database: it is read from the hook, live, and it is what the trade
/// will actually pay this second.
/// Trades any launch's v4 pool through the UniversalRouter. With a hook it is a direct launch and
/// the live tax is shown; without one it is a graduated curve token, taxed by nobody.
export function DirectTradeBox({ token, hook, quote, symbol, poolFee, tickSpacing }: {
  token: Address; hook?: Address; quote: Address; symbol: string; poolFee: number; tickSpacing: number;
}) {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [slippage, setSlippage] = useState(5);
  const { writeContractAsync, isPending } = useWriteContract();
  const [hash, setHash] = useState<`0x${string}` | undefined>();
  const [error, setError] = useState<string>();
  const receipt = useWaitForTransactionReceipt({ hash });
  const queryClient = useQueryClient();
  useEffect(() => {
    // the transaction landed: every number on this page is stale until it is read again
    if (receipt.isSuccess) void queryClient.invalidateQueries();
  }, [receipt.isSuccess, queryClient]);

  const isNative = quote === zeroAddress;
  const qDec = pairDecimals(quote);
  const qSym = pairSymbol(quote);
  const tokenIsZero = token.toLowerCase() < quote.toLowerCase();

  const hooked = Boolean(hook && hook !== zeroAddress);
  const { data: taxes } = useReadContracts({
    contracts: [
      { address: hook ?? zeroAddress, abi: hoodLaunchHookAbi, functionName: "currentTaxBps", args: [side === "buy"] },
      { address: hook ?? zeroAddress, abi: hoodLaunchHookAbi, functionName: "currentSnipeBps" },
      { address: hook ?? zeroAddress, abi: hoodLaunchHookAbi, functionName: "bonded" },
    ] as never,
    query: { refetchInterval: 2_000, enabled: hooked },
  });
  const taxRows = (taxes ?? []) as { result?: unknown }[];
  const taxBps = Number((taxRows[0]?.result as bigint | undefined) ?? 0n);
  const snipeBps = Number((taxRows[1]?.result as bigint | undefined) ?? 0n);

  const { data: nativeBalance } = useBalance({ address, query: { enabled: Boolean(address) && isNative } });
  const { data: reads } = useReadContracts({
    contracts: [
      { address: token, abi: erc20, functionName: "balanceOf", args: [address ?? zeroAddress] },
      { address: token, abi: erc20, functionName: "allowance", args: [address ?? zeroAddress, uniswapV4.permit2 as Address] },
      { address: uniswapV4.permit2 as Address, abi: permit2Abi, functionName: "allowance", args: [address ?? zeroAddress, token, uniswapV4.universalRouter as Address] },
    ] as never,
    query: { enabled: Boolean(address), refetchInterval: 6_000 },
  });
  const readRows = (reads ?? []) as { result?: unknown }[];
  const tokenBalance = (readRows[0]?.result as bigint | undefined) ?? 0n;
  const tokenToPermit2 = (readRows[1]?.result as bigint | undefined) ?? 0n;
  const permit = (readRows[2]?.result as readonly [bigint, number, number] | undefined) ?? [0n, 0, 0];
  const balance = side === "buy" ? (nativeBalance?.value ?? 0n) : tokenBalance;

  const amountWei = useMemo(() => {
    try { return parseUnits(amount || "0", side === "buy" ? qDec : 18); } catch { return 0n; }
  }, [amount, side, qDec]);

  const permitOk = permit[0] >= amountWei && Number(permit[1]) > Math.floor(Date.now() / 1000);
  const needsTokenApproval = side === "sell" && tokenToPermit2 < amountWei;
  const needsPermit = side === "sell" && !needsTokenApproval && !permitOk;
  const needsApproval = needsTokenApproval || needsPermit;

  const buying = side === "buy";
  const key = useMemo(() => ({
    currency0: (tokenIsZero ? token : quote) as Address,
    currency1: (tokenIsZero ? quote : token) as Address,
    fee: poolFee,
    tickSpacing,
    hooks: (hook ?? zeroAddress) as Address,
  }), [token, quote, tokenIsZero, poolFee, tickSpacing, hook]);
  const zeroForOne = buying ? !tokenIsZero : tokenIsZero;
  const tokenIn = buying ? quote : token;
  const tokenOut = buying ? token : quote;
  const outDec = buying ? 18 : qDec;
  const outSym = buying ? symbol : qSym;
  /// What a percentage button can spend: the whole balance, less the gas a buy in ETH will need.
  const spendable = buying && isNative ? (balance > GAS_RESERVE ? balance - GAS_RESERVE : 0n) : balance;

  // The floor is a real number: the chain's own quoter runs this exact swap, hook and tax
  // included, and the slippage sits under that. No quote, no trade; a zero floor is a gift to
  // whoever sees the transaction first.
  const quoteQuery = useQuery({
    queryKey: ["direct-quote", token, side, amountWei.toString()],
    queryFn: () => quoteDirectSwap({ publicClient: publicClient as never, poolKey: key, tokenIn, amountIn: amountWei }),
    enabled: Boolean(publicClient) && amountWei > 0n,
    refetchInterval: 3_000,
    retry: false,
  });
  const expectedOut = quoteQuery.data?.amountOut ?? 0n;
  const minOut = minOutFromQuote(expectedOut, slippage * 100);
  const quoteError = quoteQuery.error
    ? ((quoteQuery.error as { shortMessage?: string; message?: string }).shortMessage ?? quoteQuery.error.message)
    : quoteQuery.isSuccess && expectedOut === 0n ? "the pool returns nothing for this amount" : undefined;
  const quoteReady = amountWei > 0n && expectedOut > 0n && !quoteQuery.isError;
  const showOut = (v: bigint) => (quoteError ? "no quote" : quoteQuery.data ? `${fmt(v, outDec, 4)} ${outSym}` : "quoting");

  async function submit() {
    if (!address) return;
    setError(undefined);
    try {
      await submitInner();
    } catch (e) {
      // A write that fails silently is a trade box that lies. Show the wallet's or the chain's words.
      const err = e as { shortMessage?: string; message?: string };
      setError(err.shortMessage ?? err.message ?? String(e));
    }
  }

  async function submitInner() {
    if (!address) return;
    if (needsTokenApproval) {
      setHash(await writeContractAsync({
        address: token, abi: erc20, functionName: "approve",
        args: [uniswapV4.permit2 as Address, maxUint256],
      }));
      return;
    }
    if (needsPermit) {
      setHash(await writeContractAsync({
        address: uniswapV4.permit2 as Address, abi: permit2Abi, functionName: "approve",
        args: [token, uniswapV4.universalRouter as Address, MAX_UINT160, Number(MAX_UINT48)],
      }));
      return;
    }
    if (!quoteReady) throw new Error(quoteError ?? "no quote yet, try again in a second");
    const { commands, inputs } = buildSwap({
      key,
      zeroForOne,
      amountIn: amountWei,
      minAmountOut: minOut, // the quote less the slippage chosen below; the router reverts under it
      tokenIn,
      tokenOut,
    });
    // A hooked pool's gas moves with the clock: the opening surcharge decays between the wallet's
    // estimate and the block that executes the swap. Estimate here and send with a third more,
    // so the swap does not die inside the hook's own bookkeeping.
    const request = {
      address: uniswapV4.universalRouter as Address,
      abi: universalRouterAbi,
      functionName: "execute" as const,
      args: [commands, inputs, BigInt(Math.floor(Date.now() / 1000) + 600)] as const,
      value: buying && isNative ? amountWei : 0n,
    };
    const estimate = await publicClient!.estimateContractGas({ ...request, account: address });
    setHash(await writeContractAsync({ ...request, gas: (estimate * 13n) / 10n }));
  }

  return (
    <div className="panel trade-panel p-4">
      <div className="trade-heading"><span>TRADE / POOL</span><strong>$<span>{symbol}</span></strong></div>
      <div className="mb-3 flex gap-2">
        {(["buy", "sell"] as const).map((s) => (
          <button key={s} onClick={() => { setSide(s); setAmount(""); }}
            className={`side-tab flex-1 rounded-lg border px-3 py-2 text-sm font-semibold ${
              side === s ? (s === "buy" ? "side-tab-buy" : "side-tab-sell") : "dim"
            }`}>
            {s}
          </button>
        ))}
      </div>

      <label className="mb-1 block text-xs dim">{side === "buy" ? `spend ${qSym}` : `sell ${symbol}`}</label>
      <input className="input mono" inputMode="decimal" placeholder="0.0"
        value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} />
      <div className="mt-1 flex items-center justify-between text-xs dim">
        <span>balance {fmt(balance, side === "buy" ? qDec : 18, 4)}</span>
        <div className="flex gap-1">
          {[25, 50, 75, 100].map((p) => (
            <button key={p} className="rounded border border-[var(--color-line)] px-1.5 py-0.5 hover:text-[var(--color-text)]"
              onClick={() => setAmount(formatUnits((spendable * BigInt(p)) / 100n, side === "buy" ? qDec : 18))}>
              {p}%
            </button>
          ))}
        </div>
      </div>

      {amountWei > 0n && (
        <div className="mt-2 space-y-1 text-xs">
          <div className="flex justify-between">
            <span className="dim">you receive, about</span>
            <span className="mono">{showOut(expectedOut)}</span>
          </div>
          <div className="flex justify-between">
            <span className="dim">minimum received</span>
            <span className="mono">{showOut(minOut)}</span>
          </div>
          {quoteError && <p className="break-words text-[var(--color-red)]">no quote, so no trade: {quoteError}</p>}
        </div>
      )}

      <div className="mt-3 space-y-1 text-xs">
        {hooked && (
        <div className="flex justify-between">
          <span className="dim">tax right now</span>
          <span className="mono">{(taxBps / 100).toFixed(2)}%</span>
        </div>
        )}
        {snipeBps > 0 && (
          <div className="flex justify-between text-[var(--color-red)]">
            <span>snipe surcharge, still falling</span>
            <span className="mono">{(snipeBps / 100).toFixed(2)}%</span>
          </div>
        )}
        <div className="flex justify-between">
          <span className="dim">pool fee</span>
          <span className="mono">{(poolFee / 10_000).toFixed(2)}%</span>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2 text-xs dim">
        slippage
        {[1, 5, 10].map((s) => (
          <button key={s} onClick={() => setSlippage(s)}
            className={`rounded border px-2 py-0.5 ${slippage === s ? "border-[var(--color-lime)] text-[var(--color-lime)]" : "border-[var(--color-line)]"}`}>
            {s}%
          </button>
        ))}
      </div>

      <button className="btn mt-4 w-full"
        disabled={!address || amountWei === 0n || amountWei > balance || isPending || receipt.isLoading || (!needsApproval && !quoteReady)}
        onClick={submit}>
        {!address ? "connect a wallet"
          : amountWei > balance ? "not enough balance"
          : needsTokenApproval ? `approve ${symbol}`
          : needsPermit ? `allow the router (once)`
          : isPending || receipt.isLoading ? "waiting"
          : amountWei > 0n && quoteError ? "no quote"
          : amountWei > 0n && !quoteReady ? "quoting"
          : side === "buy" ? `buy ${symbol}` : `sell ${symbol}`}
      </button>

      {snipeBps > 0 && (
        <p className="mt-2 text-xs dim">
          The opening surcharge is still burning off. Waiting a few seconds costs you nothing.
        </p>
      )}
      {error && <p className="mt-2 break-words text-xs text-[var(--color-red)]">{error}</p>}
      {receipt.isSuccess && <p className="mt-2 text-xs text-[var(--color-lime)]">done</p>}
    </div>
  );
}
