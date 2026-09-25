"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { encodeFunctionData, erc20Abi, formatUnits, parseEther, maxUint256, zeroAddress, type Address } from "viem";
import { useAccount, useReadContract, useReadContracts, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { hoodStakingAbi } from "@hood/sdk";
import { addresses } from "@/lib/config";
import { api } from "@/lib/api";
import { fmt, LOCK_TIERS, pairSymbol, timeUntil } from "@/lib/format";
import { useBatch } from "@/lib/safe";
import { VAULT_NOT_OPEN } from "@/components/portfolio/VaultEarnings";

const approveAbi = [
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

interface StakeRow {
  position_id: string; token: string; owner: string; amount: string;
  unlock_at: string; weight_bps: number; active: boolean; claimed: string; symbol: string;
}

/// The room.
///
/// One coin is lockable on this pad: the house coin. Locking it takes a share of the stakers leg
/// of EVERY launch, so this panel is about the board as a whole rather than about whichever token
/// happens to be on screen. Longer lock, bigger share, and the share is paid in whatever the
/// launches that paid were trading against, which is why a position can owe in two currencies.
export function StakePanel() {
  const { address } = useAccount();
  const [amount, setAmount] = useState("");
  const [lock, setLock] = useState(0);
  const [beneficiary, setBeneficiary] = useState("");
  const { writeContractAsync, isPending } = useWriteContract();
  const [hash, setHash] = useState<`0x${string}` | undefined>();
  const [error, setError] = useState<string>();
  const receipt = useWaitForTransactionReceipt({ hash });
  const { canBatch, batch } = useBatch();
  const queryClient = useQueryClient();
  useEffect(() => {
    if (receipt.isSuccess) void queryClient.invalidateQueries();
  }, [receipt.isSuccess, queryClient]);

  const { data: house } = useReadContract({
    address: addresses.staking, abi: hoodStakingAbi, functionName: "houseToken",
  });
  const token = (house as Address | undefined) ?? zeroAddress;
  const named = token !== zeroAddress;

  const { data: coin } = useReadContracts({
    contracts: [
      { address: token, abi: erc20Abi, functionName: "symbol" },
      { address: token, abi: erc20Abi, functionName: "balanceOf", args: [address ?? zeroAddress] },
      { address: token, abi: approveAbi, functionName: "allowance", args: [address ?? zeroAddress, addresses.staking] },
      { address: addresses.staking, abi: hoodStakingAbi, functionName: "staked" },
    ] as never,
    query: { enabled: named },
  });
  const c = (coin ?? []) as { result?: unknown }[];
  const symbol = (c[0]?.result as string | undefined) ?? "";
  const balance = (c[1]?.result as bigint | undefined) ?? 0n;
  const allowance = (c[2]?.result as bigint | undefined) ?? 0n;
  const lockedTotal = (c[3]?.result as bigint | undefined) ?? 0n;

  const positions = useQuery({
    queryKey: ["stakes", address],
    queryFn: () => api<{ positions: StakeRow[] }>(`/stakes/${address}`),
    enabled: Boolean(address),
  });
  const mine = (positions.data?.positions ?? []).filter((p) => p.active);

  const wei = (() => { try { return parseEther(amount || "0"); } catch { return 0n; } })();
  const needsApproval = allowance < wei;

  async function stake() {
    setError(undefined);
    try { await stakeInner(); } catch (e) {
      const err = e as { shortMessage?: string; message?: string };
      setError(err.shortMessage ?? err.message ?? String(e));
    }
  }

  async function stakeInner() {
    if (!address || !named) return;
    if (needsApproval) {
      // One transaction for a wallet that batches: approve, then lock. See TradeBox.
      if (canBatch) {
        const lockData = beneficiary
          ? encodeFunctionData({ abi: hoodStakingAbi, functionName: "stakeFor", args: [beneficiary as Address, wei, BigInt(lock)] })
          : encodeFunctionData({ abi: hoodStakingAbi, functionName: "stake", args: [wei, BigInt(lock)] });
        const id = await batch([
          { to: token, data: encodeFunctionData({ abi: approveAbi, functionName: "approve", args: [addresses.staking, maxUint256] }) },
          { to: addresses.staking, data: lockData },
        ]);
        if (id) return setHash(id);
      }
      return setHash(await writeContractAsync({ address: token, abi: approveAbi, functionName: "approve", args: [addresses.staking, maxUint256] }));
    }
    setHash(await writeContractAsync(
      beneficiary
        ? { address: addresses.staking, abi: hoodStakingAbi, functionName: "stakeFor", args: [beneficiary as Address, wei, BigInt(lock)] }
        : { address: addresses.staking, abi: hoodStakingAbi, functionName: "stake", args: [wei, BigInt(lock)] },
    ));
  }

  // Before the coin has been named there is nothing to lock and nothing to promise. Say that,
  // rather than showing a form that every wallet would bounce.
  if (!named) {
    return (
      <div className="panel space-y-2 p-4">
        <h3 className="font-semibold">The Vault is not open yet</h3>
        <p className="text-xs dim">{VAULT_NOT_OPEN}</p>
        <p className="text-xs dim">
          Locking here is one coin: the house coin. Until it is named on chain nothing can be
          locked, and the Vault&apos;s share of every trade is held inside the Bag, not lost.
        </p>
      </div>
    );
  }

  return (
    <div className="panel space-y-3 p-4">
      <div>
        <h3 className="font-semibold">Lock {symbol}</h3>
        <p className="text-xs dim">
          You lock {symbol}, the Vault pays you every block from what the Bag sends it. Longer lock, bigger share.
        </p>
      </div>

      <div className="flex items-center justify-between text-xs">
        <span className="dim">locked by everyone</span>
        <span className="mono">{fmt(lockedTotal)} {symbol}</span>
      </div>

      <input className="input mono" placeholder="0.0" inputMode="decimal"
        value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} />
      <div className="flex items-center justify-between text-xs">
        <span className="dim">you hold {fmt(balance)} {symbol}</span>
        <button className="underline" onClick={() => setAmount(formatUnits(balance, 18))}>max</button>
      </div>

      <div className="flex flex-wrap gap-2">
        {LOCK_TIERS.map((t) => (
          <button key={t.seconds} onClick={() => setLock(t.seconds)}
            className={`rounded-lg border px-2.5 py-1.5 text-xs ${
              lock === t.seconds ? "border-[var(--color-lime)] text-[var(--color-lime)]" : "border-[var(--color-line)] dim"
            }`}>
            {t.label} · {t.multiplier}x
          </button>
        ))}
      </div>
      <p className="text-xs dim">
        180 days at 2.5x is the top tier. A 365-day lock earns the same 2.5x; the contract refuses anything longer.
      </p>

      <details className="text-xs dim">
        <summary className="cursor-pointer">send a stake to someone else</summary>
        <input className="input mono mt-2" placeholder="0x..." value={beneficiary}
          onChange={(e) => setBeneficiary(e.target.value.trim())} />
        <p className="mt-1">They earn from minute one and cannot sell before the lock ends.</p>
      </details>

      <button className="btn w-full" disabled={!address || wei === 0n || isPending || receipt.isLoading} onClick={stake}>
        {needsApproval ? `approve ${symbol}` : beneficiary ? "send the stake" : "lock"}
      </button>
      {error && <p className="break-words text-xs text-[var(--color-red)]">{error}</p>}

      {mine.length > 0 && (
        <div className="space-y-2 pt-2">
          <h4 className="text-xs dim">your positions</h4>
          {mine.map((p) => (
            <Position key={p.position_id} p={p} symbol={symbol} setHash={setHash} />
          ))}
        </div>
      )}
    </div>
  );
}

/// A pointer, for every token that is not the house coin: this is not where locking happens.
export function LockElsewhere({ token }: { token: Address }) {
  const { data: house } = useReadContract({
    address: addresses.staking, abi: hoodStakingAbi, functionName: "houseToken",
  });
  const houseToken = (house as Address | undefined) ?? zeroAddress;
  if (houseToken === zeroAddress || houseToken.toLowerCase() === token.toLowerCase()) return null;
  return (
    <div className="panel space-y-2 p-4">
      <h3 className="font-semibold">Locking is one coin</h3>
      <p className="text-xs dim">
        This token cannot be locked, and neither can any other launch. The Vault is paid by the
        Bag out of every trade on the board, and it pays whoever locked the house coin.
      </p>
      <Link className="btn btn-ghost w-full text-xs" href="/lock">go to the Vault</Link>
    </div>
  );
}

function Position({ p, symbol, setHash }: { p: StakeRow; symbol: string; setHash: (h: `0x${string}`) => void }) {
  const { writeContractAsync } = useWriteContract();
  const unlocked = new Date(p.unlock_at).getTime() <= Date.now();
  // Two launches paired against different things pay in different currencies, so what a position
  // is owed is a list, not a number.
  const { data: pending } = useReadContract({
    address: addresses.staking, abi: hoodStakingAbi, functionName: "pendingAll",
    args: [BigInt(p.position_id)], query: { refetchInterval: 10_000 },
  });
  const [assets, amounts] = (pending as [readonly Address[], readonly bigint[]] | undefined) ?? [[], []];
  const owed = assets.map((asset, i) => ({ asset, amount: amounts[i] ?? 0n })).filter((x) => x.amount > 0n);

  return (
    <div className="flex items-center gap-2 rounded-lg border border-[var(--color-line)] p-2 text-xs">
      <div className="flex-1">
        <div className="mono">{fmt(BigInt(p.amount))} {symbol || p.symbol}</div>
        <div className="dim">
          {p.weight_bps / 10_000}x · {unlocked ? "unlocked" : `locked ${timeUntil(new Date(p.unlock_at).getTime() / 1000)}`}
        </div>
      </div>
      <div className="mono text-right">
        {owed.length === 0 ? <div>0</div> : owed.map((o) => (
          <div key={o.asset}>{fmt(o.amount, o.asset === zeroAddress ? 18 : 6, 6)} {pairSymbol(o.asset)}</div>
        ))}
        <div className="dim">claimable</div>
      </div>
      <button className="btn btn-ghost !px-2 !py-1 text-xs"
        onClick={async () => setHash(await writeContractAsync({
          address: addresses.staking, abi: hoodStakingAbi, functionName: "claim", args: [BigInt(p.position_id)],
        }))}>
        claim
      </button>
      {unlocked && (
        <button className="btn btn-ghost !px-2 !py-1 text-xs"
          onClick={async () => setHash(await writeContractAsync({
            address: addresses.staking, abi: hoodStakingAbi, functionName: "unstake", args: [BigInt(p.position_id)],
          }))}>
          unstake
        </button>
      )}
    </div>
  );
}
