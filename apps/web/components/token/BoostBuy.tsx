"use client";

import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { zeroAddress, type Address } from "viem";
import { useAccount, useReadContract, useReadContracts, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { BAG_KEYS, useBoosts } from "@/lib/bag";
import { hoodBoostsAbi, hourEpochNow } from "@/lib/bagAbi";
import { bagAddresses } from "@/lib/config";
import { fmt, shortAddress } from "@/lib/format";
import { BoostBadge } from "./BoostBadge";

/// Buying a slot on the board. The contract is the source for what is free and what it costs:
/// `boosted(hour)` is every slot of the hour, address(0) where nothing sits, and `slotPrice()`
/// is what the buyer pays. The indexer only lends the symbols of whoever holds the other slots.

function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

function hourLabel(hour: number): string {
  return new Date(hour * 3_600_000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function BoostBuy({ token, symbol, boosted }: { token: Address; symbol: string; boosted?: boolean }) {
  const { address } = useAccount();
  const queryClient = useQueryClient();
  const contract = bagAddresses.boosts;
  const [open, setOpen] = useState(false);
  const [which, setWhich] = useState<"this" | "next">("this");
  const [slot, setSlot] = useState<number | null>(null);
  const [error, setError] = useState<string>();
  const [hash, setHash] = useState<`0x${string}` | undefined>();
  const [now, setNow] = useState(() => Date.now() / 1000);
  const { writeContractAsync, isPending } = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash });

  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => setNow(Date.now() / 1000), 1_000);
    return () => clearInterval(t);
  }, [open]);

  useEffect(() => {
    if (!receipt.isSuccess) return;
    void queryClient.invalidateQueries({ queryKey: ["boosts"] });
    void queryClient.invalidateQueries({ queryKey: ["tokens"] });
    void queryClient.invalidateQueries({ queryKey: ["token", token] });
    void queryClient.invalidateQueries({ queryKey: BAG_KEYS.bag });
  }, [receipt.isSuccess, queryClient, token]);

  const { data: shape } = useReadContracts({
    contracts: [
      { address: contract, abi: hoodBoostsAbi, functionName: "SLOTS" },
      { address: contract, abi: hoodBoostsAbi, functionName: "slotPrice" },
      { address: contract, abi: hoodBoostsAbi, functionName: "epoch" },
    ],
    query: { enabled: Boolean(contract), refetchInterval: 30_000 },
  });
  const s = (shape ?? []) as { result?: unknown; status?: string }[];
  const slots = Number((s[0]?.result as number | undefined) ?? 0);
  const price = (s[1]?.result as bigint | undefined) ?? null;
  const hour = s[2]?.result != null ? Number(s[2].result as bigint) : hourEpochNow();
  const target = which === "this" ? hour : hour + 1;
  const hourEndsIn = (hour + 1) * 3600 - now;

  const { data: taken, refetch } = useReadContract({
    address: contract, abi: hoodBoostsAbi, functionName: "boosted", args: [BigInt(target)],
    query: { enabled: Boolean(contract) && open, refetchInterval: 10_000 },
  });
  const held = useMemo(() => ((taken as readonly Address[] | undefined) ?? []).map((a) => a.toLowerCase()), [taken]);
  const alreadyHere = held.includes(token.toLowerCase());

  // Symbols for the slots that are taken, so the chooser says who sits there rather than an address.
  const listed = useBoosts(open && which === "next" ? target : undefined);
  const symbolOf = (holder: string): string => {
    const rows = which === "this" ? listed.data?.slots : listed.data?.slots ?? listed.data?.next?.slots;
    const row = rows?.find((r) => r.token?.toLowerCase() === holder);
    return row?.symbol ? `$${row.symbol}` : shortAddress(holder);
  };

  async function buy() {
    if (!contract || slot == null || price == null) return;
    setError(undefined);
    try {
      setHash(await writeContractAsync({
        address: contract, abi: hoodBoostsAbi, functionName: "buy",
        args: [token, BigInt(target), slot], value: price,
      }));
    } catch (e) {
      const err = e as { shortMessage?: string; message?: string };
      setError(err.shortMessage ?? err.message ?? String(e));
    }
  }

  const count = slots > 0 ? slots : held.length;

  return (
    <div className="panel boost-buy p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="font-semibold">Boost this launch</h3>
        {boosted && <BoostBadge />}
      </div>
      <p className="mt-1 text-xs dim">
        You pay {price != null ? `${fmt(price, 18, 5)} ETH` : "the slot price"}, you get ${symbol} pinned to the top of the board for an hour.
        The house keeps all of it, through the Bag.
      </p>

      {!contract ? (
        <p className="mt-2 text-xs dim">Boosts are not wired on this deployment yet.</p>
      ) : !open ? (
        <button className="btn btn-ghost mt-3 w-full text-xs" onClick={() => setOpen(true)}>
          {boosted ? "boost the next hour too" : "boost this launch"}
        </button>
      ) : (
        <div className="boost-chooser">
          <div className="boost-hours" role="tablist" aria-label="Which hour">
            <button type="button" role="tab" aria-selected={which === "this"} className={which === "this" ? "active" : ""} onClick={() => { setWhich("this"); setSlot(null); }}>
              this hour <small>{clock(hourEndsIn)} left</small>
            </button>
            <button type="button" role="tab" aria-selected={which === "next"} className={which === "next" ? "active" : ""} onClick={() => { setWhich("next"); setSlot(null); }}>
              next hour <small>from {hourLabel(hour + 1)}</small>
            </button>
          </div>

          {count === 0 ? (
            <p className="text-xs dim">Reading the slots.</p>
          ) : (
            <div className="boost-slots" role="radiogroup" aria-label="Free slots">
              {Array.from({ length: count }, (_, i) => {
                const holder = held[i] && held[i] !== zeroAddress ? held[i]! : null;
                const mine = holder === token.toLowerCase();
                return (
                  <button
                    key={i}
                    type="button"
                    role="radio"
                    aria-checked={slot === i}
                    disabled={Boolean(holder)}
                    className={`boost-slot${holder ? " taken" : ""}${mine ? " mine" : ""}${slot === i ? " picked" : ""}`}
                    onClick={() => setSlot(i)}
                    title={holder ? (mine ? "your slot" : `held by ${symbolOf(holder)}`) : `slot ${i + 1} is free`}
                  >
                    <b>{i + 1}</b>
                    <small>{holder ? (mine ? "yours" : symbolOf(holder)) : "free"}</small>
                  </button>
                );
              })}
            </div>
          )}

          {alreadyHere && <p className="text-xs dim">${symbol} already holds a slot for {which === "this" ? "this hour" : "the next hour"}. One slot per token per hour.</p>}
          {held.length > 0 && !held.some((h) => h === zeroAddress) && !alreadyHere && (
            <p className="text-xs dim">Every slot for {which === "this" ? "this hour" : "the next hour"} is taken. Try the other one.</p>
          )}

          <div className="grid grid-cols-2 gap-2">
            <button className="btn btn-ghost text-xs" onClick={() => { setOpen(false); setSlot(null); setError(undefined); }}>close</button>
            <button className="btn text-xs" disabled={!address || slot == null || price == null || alreadyHere || isPending || receipt.isLoading}
              onClick={buy}>
              {isPending || receipt.isLoading ? "buying" : price != null ? `buy slot ${slot != null ? slot + 1 : ""} for ${fmt(price, 18, 5)} ETH` : "buy"}
            </button>
          </div>
          {!address && <p className="text-xs dim">Connect a wallet to buy a slot.</p>}
          {error && <p className="break-words text-xs text-[var(--color-red)]">{error}</p>}
          {receipt.isSuccess && (
            <p className="text-xs text-[var(--color-lime)]">
              Bought. ${symbol} sits on the board {which === "this" ? "until the hour ends" : `from ${hourLabel(hour + 1)}`}.
              <button type="button" className="ml-1 underline" onClick={() => void refetch()}>refresh</button>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
