"use client";

import { useEffect, useState } from "react";
import { encodeFunctionData, parseEther, maxUint256, type Address } from "viem";
import { useAccount, useReadContract, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { hoodStakingAbi } from "@hood/sdk";
import { addresses } from "@/lib/config";
import { api } from "@/lib/api";
import { fmt, LOCK_TIERS, timeUntil } from "@/lib/format";
import { useBatch } from "@/lib/safe";

const erc20 = [
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

interface StakeRow {
  position_id: string; token: string; owner: string; amount: string;
  unlock_at: string; weight_bps: number; active: boolean; claimed: string; symbol: string;
}

/// Proof of belief. Lock longer, take a bigger slice of the same fee stream.
export function StakePanel({ token, symbol, feeModel }: { token: Address; symbol: string; feeModel: number }) {
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
    // the transaction landed: every number on this page is stale until it is read again
    if (receipt.isSuccess) void queryClient.invalidateQueries();
  }, [receipt.isSuccess, queryClient]);

  const { data: allowance } = useReadContract({
    address: token, abi: erc20, functionName: "allowance",
    args: [address ?? "0x0000000000000000000000000000000000000000", addresses.staking],
    query: { enabled: Boolean(address) },
  });

  const positions = useQuery({
    queryKey: ["stakes", address],
    queryFn: () => api<{ positions: StakeRow[] }>(`/stakes/${address}`),
    enabled: Boolean(address),
  });

  // `?.positions.filter` would take the whole page down with a client side exception if the API
  // ever answered without the array, which is one field away at any time. A list that is missing
  // reads as a list that is empty.
  const mine = (positions.data?.positions ?? []).filter(
    (p) => p.token.toLowerCase() === token.toLowerCase() && p.active,
  );
  const wei = (() => { try { return parseEther(amount || "0"); } catch { return 0n; } })();
  const needsApproval = (allowance as bigint | undefined ?? 0n) < wei;

  async function stake() {
    setError(undefined);
    try { await stakeInner(); } catch (e) {
      const err = e as { shortMessage?: string; message?: string };
      setError(err.shortMessage ?? err.message ?? String(e));
    }
  }

  async function stakeInner() {
    if (!address) return;
    if (needsApproval) {
      // One transaction for a wallet that batches: approve, then lock. See TradeBox.
      if (canBatch) {
        const lockData = beneficiary
          ? encodeFunctionData({ abi: hoodStakingAbi, functionName: "stakeFor", args: [token, beneficiary as Address, wei, BigInt(lock)] })
          : encodeFunctionData({ abi: hoodStakingAbi, functionName: "stake", args: [token, wei, BigInt(lock)] });
        const id = await batch([
          { to: token, data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [addresses.staking, maxUint256] }) },
          { to: addresses.staking, data: lockData },
        ]);
        if (id) return setHash(id);
      }
      return setHash(await writeContractAsync({ address: token, abi: erc20, functionName: "approve", args: [addresses.staking, maxUint256] }));
    }
    setHash(await writeContractAsync(
      beneficiary
        ? { address: addresses.staking, abi: hoodStakingAbi, functionName: "stakeFor", args: [token, beneficiary as Address, wei, BigInt(lock)] }
        : { address: addresses.staking, abi: hoodStakingAbi, functionName: "stake", args: [token, wei, BigInt(lock)] },
    ));
  }

  return (
    <div className="panel space-y-3 p-4">
      <div>
        <h3 className="font-semibold">Stake {symbol}</h3>
        <p className="text-xs dim">
          {feeModel === 0
            ? "This token pays its trading fee to whoever locks it. Longer lock, bigger share."
            : "This token does not pay stakers, but locking still works and the vault is shared."}
        </p>
      </div>

      <input className="input mono" placeholder="0.0" inputMode="decimal"
        value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} />

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
            <Position key={p.position_id} p={p} setHash={setHash} />
          ))}
        </div>
      )}
    </div>
  );
}

function Position({ p, setHash }: { p: StakeRow; setHash: (h: `0x${string}`) => void }) {
  const { writeContractAsync } = useWriteContract();
  const unlocked = new Date(p.unlock_at).getTime() <= Date.now();
  const { data: pending } = useReadContract({
    address: addresses.staking, abi: hoodStakingAbi, functionName: "pending",
    args: [BigInt(p.position_id)], query: { refetchInterval: 10_000 },
  });

  return (
    <div className="flex items-center gap-2 rounded-lg border border-[var(--color-line)] p-2 text-xs">
      <div className="flex-1">
        <div className="mono">{fmt(BigInt(p.amount))} {p.symbol}</div>
        <div className="dim">
          {p.weight_bps / 10_000}x · {unlocked ? "unlocked" : `locked ${timeUntil(new Date(p.unlock_at).getTime() / 1000)}`}
        </div>
      </div>
      <div className="mono text-right">
        <div>{fmt((pending as bigint | undefined) ?? 0n, 18, 6)}</div>
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
