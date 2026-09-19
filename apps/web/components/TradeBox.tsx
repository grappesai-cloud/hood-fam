"use client";

import { useQueryClient } from "@tanstack/react-query";

import { useEffect, useMemo, useState } from "react";
import { parseUnits, formatUnits, maxUint256, zeroAddress, type Address } from "viem";
import { useAccount, useReadContract, useWaitForTransactionReceipt, useWriteContract, useBalance, useReadContracts } from "wagmi";
import { hoodCurveAbi } from "@hood/sdk";
import { fmt, pairDecimals, pairSymbol } from "@/lib/format";

const erc20 = [
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

export function TradeBox({ token, curve, pairToken, symbol, phase }: {
  token: Address; curve: Address; pairToken: Address; symbol: string; phase: number;
}) {
  const { address } = useAccount();
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

  const isNative = pairToken === zeroAddress;
  const pairDec = pairDecimals(pairToken);
  const pairSym = pairSymbol(pairToken);

  const amountWei = useMemo(() => {
    try { return parseUnits(amount || "0", side === "buy" ? pairDec : 18); } catch { return 0n; }
  }, [amount, side, pairDec]);

  const { data: nativeBalance } = useBalance({ address, query: { enabled: Boolean(address) && isNative } });
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
  const pairBalance = isNative ? (nativeBalance?.value ?? 0n) : ((reads?.[2]?.result as bigint | undefined) ?? 0n);
  const pairAllowance = isNative ? maxUint256 : ((reads?.[3]?.result as bigint | undefined) ?? 0n);

  const { data: quote } = useReadContract({
    address: curve,
    abi: hoodCurveAbi,
    functionName: side === "buy" ? "quoteBuy" : "quoteSell",
    args: [amountWei],
    query: { enabled: amountWei > 0n && phase === 0, refetchInterval: 5000 },
  });

  const out = side === "buy"
    ? ((quote as readonly bigint[] | undefined)?.[0] ?? 0n)
    : ((quote as readonly bigint[] | undefined)?.[0] ?? 0n);
  const fee = side === "buy"
    ? ((quote as readonly bigint[] | undefined)?.[2] ?? 0n)
    : ((quote as readonly bigint[] | undefined)?.[1] ?? 0n);
  const minOut = (out * BigInt(10_000 - slippage * 100)) / 10_000n;

  const needsApproval = side === "buy" ? pairAllowance < amountWei : tokenAllowance < amountWei;
  const balance = side === "buy" ? pairBalance : tokenBalance;
  const tooMuch = amountWei > balance;

  async function submit() {
    setError(undefined);
    try { await submitInner(); } catch (e) {
      const err = e as { shortMessage?: string; message?: string };
      setError(err.shortMessage ?? err.message ?? String(e));
    }
  }

  async function submitInner() {
    if (!address) return;
    if (needsApproval) {
      const h = await writeContractAsync({
        address: side === "buy" ? pairToken : token,
        abi: erc20, functionName: "approve", args: [curve, maxUint256],
      });
      setHash(h);
      return;
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
          <button key={s} onClick={() => { setSide(s); setAmount(""); }}
            className={`side-tab flex-1 rounded-lg border px-3 py-2 text-sm font-semibold ${
              side === s ? (s === "buy" ? "side-tab-buy" : "side-tab-sell") : "dim"
            }`}>
            {s}
          </button>
        ))}
      </div>

      <label className="mb-1 block text-xs dim">
        {side === "buy" ? `spend ${pairSym}` : `sell ${symbol}`}
      </label>
      <input className="input mono" inputMode="decimal" placeholder="0.0"
        value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} />

      <div className="mt-1 flex justify-between text-xs dim">
        <span>balance {fmt(balance, side === "buy" ? pairDec : 18, 4)}</span>
        <button className="hover:text-[var(--color-text)]"
          onClick={() => setAmount(formatUnits(balance, side === "buy" ? pairDec : 18))}>
          max
        </button>
      </div>

      <div className="mt-3 space-y-1 text-xs">
        <Row label="you get" value={`${fmt(out, side === "buy" ? 18 : pairDec, 4)} ${side === "buy" ? symbol : pairSym}`} />
        <Row label="fee" value={`${fmt(fee, pairDec, 6)} ${pairSym}`} />
        <Row label={`min out (${slippage}% slip)`} value={fmt(minOut, side === "buy" ? 18 : pairDec, 4)} />
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

      <button className="btn mt-4 w-full" disabled={!address || amountWei === 0n || tooMuch || isPending || receipt.isLoading}
        onClick={submit}>
        {!address ? "connect a wallet"
          : tooMuch ? "not enough balance"
          : needsApproval ? `approve ${side === "buy" ? pairSym : symbol}`
          : isPending || receipt.isLoading ? "waiting"
          : side === "buy" ? `buy ${symbol}` : `sell ${symbol}`}
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
