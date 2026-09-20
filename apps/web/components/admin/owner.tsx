"use client";

import { useCallback, useState, type ReactNode } from "react";
import { isAddress, parseEther, zeroAddress, type Address } from "viem";
import { useAccount, useConnect, useDisconnect, usePublicClient, useReadContracts, useWriteContract } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { shortAddress } from "@/lib/format";
import { receiptTimeout, usePreferredConnector, useSafeInfo } from "@/lib/safe";
import { safeAppUrl, safeBatchFile, safeQueueUrl } from "@hood/sdk";
import { SITE } from "@/lib/site";
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
        // A Safe's transaction is a proposal: it is mined when its signers are done, which can be
        // days. `receiptTimeout` drops the three minute cap for those and keeps it for a plain key.
        await publicClient?.waitForTransactionReceipt({ hash, timeout: receiptTimeout(hash) });
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
  const { connect, isPending } = useConnect();
  const connector = usePreferredConnector();
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
        <button className="btn text-xs" disabled={isPending || !connector} onClick={() => connector && connect({ connector })}>
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
      {pendingOwner && pendingOwner !== zeroAddress && !isPendingOwner && (
        <SafeOwnerNote safe={pendingOwner} contract={contract} pending />
      )}
      {owner && !isOwner && <SafeOwnerNote safe={owner} contract={contract} pending={false} />}
    </>
  );
}

/// Hands the signers a Transaction Builder file. It is the path that needs no key here and no API
/// key anywhere: in Safe{Wallet}, Apps -> Transaction Builder, drop the file in, and every signer
/// reads the call before signing. `npm run safe -- accept` writes the same file for all of them at
/// once, from a terminal.
function downloadBatch(safe: Address, calls: { to: Address; data: `0x${string}` }[], name: string) {
  const file = safeBatchFile({ safe, chainId: 4663, calls, name });
  const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/// What to say when the wallet that can move this contract is a Safe rather than the one connected.
export function SafeOwnerNote({ safe, contract, pending }: { safe: Address; contract: Address; pending: boolean }) {
  const info = useSafeInfo(safe);
  const { address } = useAccount();
  if (!info) return null;
  if (same(address, safe)) return null;
  const signer = info.owners.some((o) => same(o, address));

  return (
    <div className="space-y-2 rounded-lg border border-[var(--color-line)] p-2.5 text-xs">
      <div>
        {pending ? "Waiting for a Safe" : "Owned by a Safe"}: {info.threshold} of {info.owners.length} signers.
        {signer ? " You are one of them, but a signer alone cannot send this." : " This wallet is not one of them."}
      </div>
      <div className="flex flex-wrap gap-2">
        <a className="btn btn-ghost text-xs" href={safeAppUrl(safe, `${SITE}/admin`)} target="_blank" rel="noreferrer noopener">
          open this page inside Safe{"{Wallet}"}
        </a>
        {pending && (
          <button className="btn btn-ghost text-xs"
            onClick={() => downloadBatch(safe, [{ to: contract, data: "0x79ba5097" }], "hood.fam accept ownership")}>
            download the accept batch
          </button>
        )}
        <a className="btn btn-ghost text-xs" href={safeQueueUrl(safe)} target="_blank" rel="noreferrer noopener">the Safe's queue</a>
      </div>
    </div>
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
