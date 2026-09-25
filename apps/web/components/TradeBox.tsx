"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useEffect, useMemo, useState } from "react";
import { encodeFunctionData, parseUnits, formatUnits, maxUint256, zeroAddress, type Address } from "viem";
import { useAccount, useReadContract, useWaitForTransactionReceipt, useWriteContract, useBalance, useReadContracts, usePublicClient } from "wagmi";
import { hoodCurveAbi, hoodCurveRouterAbi } from "@hood/sdk";
import { fmt, pairDecimals as knownPairDecimals, pairSymbol as knownPairSymbol } from "@/lib/format";
import { useBatch } from "@/lib/safe";
import { api, type HealthStatus, type NativeQuoteRoute, type RouteAvailability } from "@/lib/api";
import { addresses } from "@/lib/config";

const erc20 = [
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;
const GAS_RESERVE = 500_000_000_000_000n;

export function TradeBox({ token, curve, pairToken, pairDecimals, pairSymbol, symbol, phase }: {
  token: Address; curve: Address; pairToken: Address; pairDecimals?: number; pairSymbol?: string; symbol: string; phase: number;
}) {
  const { address } = useAccount();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [payWithEth, setPayWithEth] = useState(false);
  const [amount, setAmount] = useState("");
  const [slippage, setSlippage] = useState(5);
  const { writeContractAsync, isPending } = useWriteContract();
  const [hash, setHash] = useState<`0x${string}` | undefined>();
  const [error, setError] = useState<string>();
  const [isRouting, setIsRouting] = useState(false);
  const receipt = useWaitForTransactionReceipt({ hash });
  const publicClient = usePublicClient();
  const { canBatch, batch } = useBatch();
  const queryClient = useQueryClient();
  const { data: health } = useQuery({
    queryKey: ["health"],
    queryFn: () => api<HealthStatus>("/health"),
    staleTime: 60_000,
    retry: false,
  });
  useEffect(() => {
    // the transaction landed: every number on this page is stale until it is read again
    if (receipt.isSuccess) void queryClient.invalidateQueries();
  }, [receipt.isSuccess, queryClient]);

  const isNative = pairToken === zeroAddress;
  // The address proves the contract exists in this build; /health proves the API can obtain a
  // swap route. Both are required before offering a path that promises to be one click.
  // Whether ETH can reach THIS pair in one transaction. The pad answers per pair, because without
  // a routing service it builds the hop itself and there is not one for every asset. Asking here
  // is what keeps the button from appearing on a pair where it would fail at the last step.
  const { data: routeProbe } = useQuery({
    queryKey: ["route", pairToken],
    queryFn: () => api<RouteAvailability>(`/pairs/route/${pairToken}`),
    enabled: pairToken !== zeroAddress && Boolean(health?.integrations.routing),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const oneClickAvailable = Boolean(addresses.curveRouter && health?.integrations.routing && routeProbe?.available);
  const oneClick = side === "buy" && !isNative && oneClickAvailable && payWithEth;
  const pairDec = pairDecimals ?? knownPairDecimals(pairToken);
  const pairSym = pairSymbol || knownPairSymbol(pairToken);
  useEffect(() => {
    if (!oneClickAvailable && payWithEth) setPayWithEth(false);
  }, [oneClickAvailable, payWithEth]);

  const amountWei = useMemo(() => {
    try { return parseUnits(amount || "0", side === "buy" ? (oneClick ? 18 : pairDec) : 18); } catch { return 0n; }
  }, [amount, side, pairDec, oneClick]);
  const [previewAmount, setPreviewAmount] = useState(0n);
  useEffect(() => {
    const timer = window.setTimeout(() => setPreviewAmount(amountWei), 350);
    return () => window.clearTimeout(timer);
  }, [amountWei]);
  const routePreview = useQuery({
    queryKey: ["trade-route-preview", pairToken, previewAmount.toString(), slippage],
    queryFn: () => api<NativeQuoteRoute>("/pairs/route", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tokenOut: pairToken, amount: previewAmount.toString(), slippageTolerance: slippage }),
    }),
    enabled: oneClick && previewAmount > 0n && previewAmount === amountWei,
    staleTime: 10_000,
    retry: false,
  });
  const previewQuoteIn = routePreview.data && previewAmount === amountWei ? BigInt(routePreview.data.minQuoteOut) : 0n;
  const { data: routedCurveQuote } = useReadContract({
    address: curve, abi: hoodCurveAbi, functionName: "quoteBuy", args: [previewQuoteIn],
    query: { enabled: oneClick && previewQuoteIn > 0n && phase === 0, staleTime: 10_000 },
  });

  const { data: nativeBalance } = useBalance({ address, query: { enabled: Boolean(address) && (isNative || oneClick) } });
  const { data: reads } = useReadContracts({
    contracts: [
      { address: token, abi: erc20, functionName: "balanceOf", args: [address ?? zeroAddress] },
      { address: token, abi: erc20, functionName: "allowance", args: [address ?? zeroAddress, curve] },
      ...(isNative ? [] : [
        { address: pairToken, abi: erc20, functionName: "balanceOf", args: [address ?? zeroAddress] } as const,
        { address: pairToken, abi: erc20, functionName: "allowance", args: [address ?? zeroAddress, curve] } as const,
      ]),
    ],
    query: { enabled: Boolean(address), refetchInterval: 6000 },
  });

  const tokenBalance = (reads?.[0]?.result as bigint | undefined) ?? 0n;
  const tokenAllowance = (reads?.[1]?.result as bigint | undefined) ?? 0n;
  const pairBalance = (isNative || oneClick) ? (nativeBalance?.value ?? 0n) : ((reads?.[2]?.result as bigint | undefined) ?? 0n);
  const pairAllowance = isNative ? maxUint256 : ((reads?.[3]?.result as bigint | undefined) ?? 0n);

  const { data: quote } = useReadContract({
    address: curve,
    abi: hoodCurveAbi,
    functionName: side === "buy" ? "quoteBuy" : "quoteSell",
    args: [amountWei],
    query: { enabled: amountWei > 0n && phase === 0 && !oneClick, refetchInterval: 5000 },
  });

  const out = side === "buy"
    ? ((quote as readonly bigint[] | undefined)?.[0] ?? 0n)
    : ((quote as readonly bigint[] | undefined)?.[0] ?? 0n);
  const fee = side === "buy"
    ? ((quote as readonly bigint[] | undefined)?.[2] ?? 0n)
    : ((quote as readonly bigint[] | undefined)?.[1] ?? 0n);
  const minOut = (out * BigInt(10_000 - slippage * 100)) / 10_000n;

  const needsApproval = oneClick ? false : side === "buy" ? pairAllowance < amountWei : tokenAllowance < amountWei;
  const balance = side === "buy" ? pairBalance : tokenBalance;
  const spendable = side === "buy" && (isNative || oneClick)
    ? (balance > GAS_RESERVE ? balance - GAS_RESERVE : 0n) : balance;
  const tooMuch = amountWei > spendable;

  async function submit() {
    setError(undefined);
    try { await submitInner(); } catch (e) {
      const err = e as { shortMessage?: string; message?: string };
      setError(err.shortMessage ?? err.message ?? String(e));
    }
  }

  async function submitInner() {
    if (!address) return;
    if (oneClick) {
      if (!addresses.curveRouter || !publicClient) throw new Error("one-click router is not configured");
      setIsRouting(true);
      try {
        const route = await api<NativeQuoteRoute>("/pairs/route", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tokenOut: pairToken, amount: amountWei.toString(), slippageTolerance: slippage }),
        });
        const minQuote = BigInt(route.minQuoteOut);
        const curveQuote = await publicClient.readContract({
          address: curve, abi: hoodCurveAbi, functionName: "quoteBuy", args: [minQuote],
        });
        const expectedTokens = curveQuote[0];
        const minTokens = (expectedTokens * BigInt(10_000 - slippage * 100)) / 10_000n;
        if (route.routerCalldata) {
          setHash(await writeContractAsync({
            address: addresses.curveRouter,
            abi: hoodCurveRouterAbi,
            functionName: "buyWithNativeCalldata",
            args: [curve, minQuote, minTokens, address, route.routerCalldata],
            value: amountWei,
          }));
        } else if (route.commands && route.inputs) {
          // The deadline comes from the chain's own clock, not the browser's: a machine a few
          // minutes behind would sign a transaction the router refuses as already expired, and the
          // failure reads as an unknown selector rather than as a wrong clock.
          const block = await publicClient.getBlock();
          setHash(await writeContractAsync({
            address: addresses.curveRouter,
            abi: hoodCurveRouterAbi,
            functionName: "buyWithNative",
            args: [curve, minQuote, minTokens, address, route.commands, route.inputs, block.timestamp + 1800n],
            value: amountWei,
          }));
        } else {
          throw new Error("the route came back without anything to execute");
        }
      } finally {
        setIsRouting(false);
      }
      return;
    }
    if (needsApproval) {
      const approving = side === "buy" ? pairToken : token;
      // A wallet that takes a batch does the approval and the trade as one transaction. For a Safe
      // that is one round of signatures instead of two, and the approval cannot end up granted with
      // the trade behind it never made.
      if (canBatch) {
        const tradeData = side === "buy"
          ? encodeFunctionData({ abi: hoodCurveAbi, functionName: "buy", args: [amountWei, minOut, address] })
          : encodeFunctionData({ abi: hoodCurveAbi, functionName: "sell", args: [amountWei, minOut, address] });
        const id = await batch([
          { to: approving, data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [curve, maxUint256] }) },
          { to: curve, data: tradeData, value: side === "buy" && isNative ? amountWei : 0n },
        ]);
        if (id) return setHash(id);
      }
      return setHash(await writeContractAsync({ address: approving, abi: erc20, functionName: "approve", args: [curve, maxUint256] }));
    }
    if (side === "buy") {
      setHash(await writeContractAsync({
        address: curve, abi: hoodCurveAbi, functionName: "buy",
        args: [amountWei, minOut, address], value: isNative ? amountWei : 0n,
      }));
    } else {
      setHash(await writeContractAsync({
        address: curve, abi: hoodCurveAbi, functionName: "sell", args: [amountWei, minOut, address],
      }));
    }
  }

  if (phase !== 0) {
    return (
      <div className="panel p-4">
        <p className="text-sm">
          {phase === 1
            ? "The curve sold out. Anyone can open the pool now."
            : "This token graduated. Its liquidity is in a Uniswap v4 pool that nobody can pull back out."}
        </p>
      </div>
    );
  }

  return (
    <div className="panel trade-panel p-4">
      <div className="trade-heading"><span>TRADE / CURVE</span><strong>$<span>{symbol}</span></strong></div>
      <div className="mb-3 flex gap-2">
        {(["buy", "sell"] as const).map((s) => (
          <button key={s} onClick={() => { setSide(s); setAmount(""); if (s === "sell") setPayWithEth(false); }}
            className={`side-tab flex-1 rounded-lg border px-3 py-2 text-sm font-semibold ${
              side === s ? (s === "buy" ? "side-tab-buy" : "side-tab-sell") : "dim"
            }`}>
            {s}
          </button>
        ))}
      </div>

      {side === "buy" && !isNative && oneClickAvailable && (
        <div className="mb-3 grid grid-cols-2 gap-2 text-xs">
          <button className={`rounded-lg border px-2 py-2 ${!payWithEth ? "border-[var(--color-lime)] text-[var(--color-lime)]" : "border-[var(--color-line)] dim"}`}
            onClick={() => { setPayWithEth(false); setAmount(""); }}>
            pay in {pairSym}
          </button>
          <button className={`rounded-lg border px-2 py-2 ${payWithEth ? "border-[var(--color-lime)] text-[var(--color-lime)]" : "border-[var(--color-line)] dim"}`}
            onClick={() => { setPayWithEth(true); setAmount(""); }}>
            pay in ETH · 1-click
          </button>
        </div>
      )}

      <label className="mb-1 block text-xs dim">
        {side === "buy" ? `spend ${oneClick ? "ETH" : pairSym}` : `sell ${symbol}`}
      </label>
      <input className="input mono" inputMode="decimal" placeholder="0.0"
        value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} />

      <div className="mt-1 flex justify-between text-xs dim">
        <span>balance {fmt(balance, side === "buy" ? (oneClick ? 18 : pairDec) : 18, 4)}</span>
        <button className="hover:text-[var(--color-text)]"
          onClick={() => setAmount(formatUnits(spendable, side === "buy" ? (oneClick ? 18 : pairDec) : 18))}>
          max
        </button>
      </div>

      {oneClick ? (
        <div className="mt-3 space-y-1 rounded-lg border border-[var(--color-line)] p-3 text-xs">
          <strong>One transaction · ETH → {pairSym} → ${symbol}</strong>
          {routePreview.isFetching || previewAmount !== amountWei ? <p className="dim">Checking the live route…</p> : null}
          {routePreview.isError ? <p className="text-[var(--color-red)]">No executable ETH route for this amount right now. Try paying in {pairSym}.</p> : null}
          {routePreview.data && previewAmount === amountWei ? <>
            <Row label={`DEX quote into ${pairSym}`} value={`${fmt(BigInt(routePreview.data.quoteOut), pairDec, 6)} ${pairSym}`} />
            <Row label="minimum quote after swap" value={`${fmt(previewQuoteIn, pairDec, 6)} ${pairSym}`} />
            <Row label="curve fee at minimum quote" value={`${fmt((routedCurveQuote as readonly bigint[] | undefined)?.[2] ?? 0n, pairDec, 6)} ${pairSym}`} />
            <Row label="estimated minimum tokens" value={`${fmt((((routedCurveQuote as readonly bigint[] | undefined)?.[0] ?? 0n) * BigInt(10_000 - slippage * 100)) / 10_000n, 18, 4)} ${symbol}`} />
            <p className="dim">DEX pool fees are included in the route quote. The curve fee and slippage are additional; the route is refreshed before your wallet signs.</p>
          </> : null}
        </div>
      ) : (
        <div className="mt-3 space-y-1 text-xs">
          <Row label="you get" value={`${fmt(out, side === "buy" ? 18 : pairDec, 4)} ${side === "buy" ? symbol : pairSym}`} />
          <Row label="fee" value={`${fmt(fee, pairDec, 6)} ${pairSym}`} />
          <Row label={`min out (${slippage}% slip)`} value={fmt(minOut, side === "buy" ? 18 : pairDec, 4)} />
        </div>
      )}

      <div className="mt-3 flex items-center gap-2 text-xs dim">
        slippage
        {[1, 5, 10].map((s) => (
          <button key={s} onClick={() => setSlippage(s)}
            className={`rounded border px-2 py-0.5 ${slippage === s ? "border-[var(--color-lime)] text-[var(--color-lime)]" : "border-[var(--color-line)]"}`}>
            {s}%
          </button>
        ))}
      </div>

      <button className="btn mt-4 w-full" disabled={!address || amountWei === 0n || tooMuch || isPending || isRouting || receipt.isLoading || (oneClick && (!routePreview.data || previewAmount !== amountWei || !routedCurveQuote))}
        onClick={submit}>
        {!address ? "connect a wallet"
          : tooMuch ? "not enough balance"
          : needsApproval ? `approve ${side === "buy" ? pairSym : symbol}`
          : isRouting ? "finding best route"
          : isPending || receipt.isLoading ? "waiting"
          : side === "buy" ? (oneClick ? `swap + buy ${symbol}` : `buy ${symbol}`) : `sell ${symbol}`}
      </button>

      {error && <p className="mt-2 break-words text-xs text-[var(--color-red)]">{error}</p>}
      {receipt.isSuccess && <p className="mt-2 text-xs text-[var(--color-lime)]">done</p>}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="dim">{label}</span>
      <span className="mono">{value}</span>
    </div>
  );
}
