"use client";

import { useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount, useConnect, useConfig, usePublicClient } from "wagmi";
import { getConnectorClient } from "wagmi/actions";
import { numberToHex, type Address, type Hex } from "viem";
import { readSafe, robinhood, type SafeInfo } from "@hood/sdk";
import { safeTxSnapshot, subscribeToSafeTxs, type PendingSafeTx } from "./safe-core";

export * from "./safe-core";

/// The React half: what is waiting in the connected Safe, what that Safe is, and how to send a
/// wallet several calls at once. See `safe-core.ts` for the machinery underneath.

export function usePendingSafeTxs(): PendingSafeTx[] {
  return useSyncExternalStore(subscribeToSafeTxs, safeTxSnapshot, safeTxSnapshot);
}

/// The connected account, read as a Safe: its owners and threshold, or null for an ordinary wallet.
export function useSafeAccount(): { safe: SafeInfo | null; inSafeApp: boolean; loading: boolean } {
  const { address, connector } = useAccount();
  const client = usePublicClient();
  const q = useQuery({
    queryKey: ["safe-account", address],
    queryFn: () => readSafe(client!, address!),
    enabled: Boolean(address && client),
    staleTime: 5 * 60_000,
    refetchInterval: false,
  });
  return { safe: q.data ?? null, inSafeApp: connector?.id === "safe", loading: q.isLoading };
}

/// Any address, read as a Safe. The admin page uses it on the owner of each contract.
export function useSafeInfo(address?: Address) {
  const client = usePublicClient();
  return useQuery({
    queryKey: ["safe-info", address],
    queryFn: () => readSafe(client!, address!),
    enabled: Boolean(address && client),
    staleTime: 60_000,
    refetchInterval: 60_000,
  }).data ?? null;
}

export interface Call {
  to: Address;
  data: Hex;
  value?: bigint;
}

/// Several calls as one Safe transaction when the wallet can take a batch: inside Safe{Wallet} it
/// always can, so an approval and the trade behind it are signed once, together, and land together
/// or not at all. Returns the Safe transaction hash, which the receipt hooks already understand.
/// Null when this wallet cannot batch; the caller then does its steps one at a time as before.
export function useBatch() {
  const config = useConfig();
  const { address, connector } = useAccount();
  const canBatch = connector?.id === "safe";

  async function batch(calls: Call[]): Promise<Hex | null> {
    if (!canBatch || !address) return null;
    const client = await getConnectorClient(config);
    const result = (await client.request({
      method: "wallet_sendCalls",
      params: [{
        version: "2.0.0",
        chainId: numberToHex(robinhood.id),
        from: address,
        atomicRequired: true,
        calls: calls.map((c) => ({ to: c.to, data: c.data, value: numberToHex(c.value ?? 0n) })),
      }],
    } as never)) as { id: Hex } | Hex;
    return typeof result === "string" ? result : result.id;
  }

  return { canBatch, batch };
}

/// The connector a Connect button should use: the Safe when the app is running inside Safe{Wallet},
/// the browser's injected wallet when there is one, WalletConnect otherwise (a phone). Before this
/// every button took the first connector in the list, so WalletConnect could never be reached.
export function usePreferredConnector() {
  const { connectors } = useConnect();
  const framed = typeof window !== "undefined" && window.parent !== window;
  const injected = typeof window !== "undefined" && Boolean((window as { ethereum?: unknown }).ethereum);
  // Nothing at the end of this list. The injected connector exists in the config whether or not a
  // wallet was ever installed, so returning it as a fallback gave a phone a Connect button that
  // looked alive and did nothing on tap. An honest undefined disables the button and lets
  // `WalletDoor` offer the way in that does work there.
  return (
    (framed && connectors.find((c) => c.id === "safe")) ||
    (injected && connectors.find((c) => c.type === "injected")) ||
    connectors.find((c) => c.id === "walletConnect") ||
    undefined
  );
}
