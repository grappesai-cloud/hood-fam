"use client";

import { useCallback, useState, type ReactNode } from "react";
import { isAddress, parseEther, zeroAddress, type Address } from "viem";
import { useAccount, useConnect, useDisconnect, usePublicClient, useReadContracts, useWriteContract } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { shortAddress } from "@/lib/format";
import { Addr, Row } from "./ui";

/// The owner half of the page. Everything here is a transaction signed by the connected wallet:
/// the server token has no say in it, and a wallet that is not the owner can only look.

/// A configured zero address is not a deployment, it is a placeholder in the env.
export function deployedAt(value?: string): Address | undefined {
  if (!value) return undefined;
  return value.toLowerCase() === zeroAddress ? undefined : (value as Address);
}

export const same = (a?: string, b?: string) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());

/// Wei from an ETH field, or undefined when the field cannot be read as a number.
export function toWei(value: string): bigint | undefined {
  if (!value.trim()) return undefined;
  try {
    return parseEther(value.trim());
  } catch {
    return undefined;
  }
}

/// A plain integer in the smallest unit, for the thresholds that are not denominated in ether.
export function toUnits(value: string): bigint | undefined {
  const v = value.trim();
  if (!/^[0-9]+$/.test(v)) return undefined;
  return BigInt(v);
}

export interface Ownership {
  owner?: Address;
  pendingOwner?: Address;
  isOwner: boolean;
  isPendingOwner: boolean;
}

export function useOwnership(contract: Address | undefined, abi: readonly unknown[]): Ownership {
  const { address } = useAccount();
  const { data } = useReadContracts({
    contracts: [
      { address: contract ?? zeroAddress, abi, functionName: "owner" },
      { address: contract ?? zeroAddress, abi, functionName: "pendingOwner" },
    ] as never,
    query: { enabled: Boolean(contract), refetchInterval: 15_000 },
  });
  const r = (data ?? []) as { result?: unknown }[];
  const owner = r[0]?.result as Address | undefined;
  const pendingOwner = r[1]?.result as Address | undefined;
  return {
    owner,
    pendingOwner,
    isOwner: same(owner, address),
    isPendingOwner: Boolean(pendingOwner && pendingOwner !== zeroAddress && same(pendingOwner, address)),
  };
}

/// One writer per panel: it holds the label of whatever is in flight, waits for the receipt, then
/// invalidates every read on the page so no number on screen is older than the transaction.
export function useOwnerWrite() {
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string>();

  const send = useCallback(
    async (label: string, write: () => Promise<`0x${string}`>) => {
      setError(undefined);
      setPending(label);
      try {
        const hash = await write();
        await publicClient?.waitForTransactionReceipt({ hash });
        await queryClient.invalidateQueries();
        return true;
      } catch (e) {
        const err = e as { shortMessage?: string; message?: string };
        setError(err.shortMessage ?? err.message ?? String(e));
        return false;
      } finally {
        setPending(null);
      }
    },
    [publicClient, queryClient],
  );

  return { send, pending, error, writeContractAsync };
}

export function WalletStrip() {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();

  return (
    <div className="panel flex items-center justify-between gap-3 p-3">
      <div>
        <div className="text-sm font-semibold">owner wallet</div>
        <div className="text-xs dim">
          {isConnected ? `signing as ${shortAddress(address!)}` : "nothing below can be signed until a wallet is connected"}
        </div>
      </div>
      {isConnected ? (
        <button className="btn btn-ghost text-xs" onClick={() => disconnect()}>
          disconnect
        </button>
      ) : (
        <button className="btn text-xs" disabled={isPending || !connectors[0]} onClick={() => connect({ connector: connectors[0]! })}>
          {isPending ? "connecting" : "connect"}
        </button>
      )}
    </div>
  );
}

/// The ownership line every Ownable2Step contract gets: who holds it, who is waiting for it, and
/// the one button the waiting wallet can press.
export function OwnerHeader({
  title,
  contract,
  ownership,
  onAccept,
  accepting,
}: {
  title: string;
  contract: Address;
  ownership: Ownership;
  onAccept: () => void;
  accepting: boolean;
}) {
  const { owner, pendingOwner, isOwner, isPendingOwner } = ownership;
  return (
    <>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-semibold">{title}</h2>
        <Addr address={contract} />
      </div>
      <div className="space-y-1">
        <Row
          label="owner"
          value={
            <>
              <Addr address={owner} missing="reading" />
              {isOwner && <span className="text-[var(--color-lime)]"> · you</span>}
            </>
          }
        />
        <Row
          label="pending owner"
          value={
            pendingOwner && pendingOwner !== zeroAddress ? (
              <>
                <Addr address={pendingOwner} />
                {isPendingOwner && <span className="text-[var(--color-lime)]"> · you</span>}
              </>
            ) : (
              <span className="dim">none</span>
            )
          }
        />
      </div>
      {isPendingOwner && (
        <button className="btn w-full text-xs" disabled={accepting} onClick={onAccept}>
          {accepting ? "accepting" : "accept ownership"}
        </button>
      )}
    </>
  );
}

export function NotDeployed({ title, note }: { title: string; note: string }) {
  return (
    <section className="panel space-y-1 p-4">
      <h2 className="font-semibold">{title}</h2>
      <p className="text-xs dim">not deployed. {note}</p>
    </section>
  );
}

export function Locked({ isOwner }: { isOwner: boolean }) {
  if (isOwner) return null;
  return <p className="text-xs dim">Only the current owner can send any of these, so they are switched off.</p>;
}

export function WriteError({ error }: { error?: string }) {
  if (!error) return null;
  return <p className="break-words text-xs text-[var(--color-red)]">{error}</p>;
}

export function AddressInput({
  value,
  onChange,
  placeholder = "0x...",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return <input className="input mono" placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value.trim())} />;
}

export const validAddress = (v: string) => isAddress(v);

export function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-2 rounded-lg border border-[var(--color-line)] p-2.5">
      <div className="text-sm font-semibold">{title}</div>
      {children}
    </div>
  );
}
