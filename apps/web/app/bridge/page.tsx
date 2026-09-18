"use client";

import { useState } from "react";
import { parseEther, zeroAddress, type Address } from "viem";
import { useAccount, useReadContract, useWriteContract } from "wagmi";
import { useQuery } from "@tanstack/react-query";
import { hoodBridgeFactoryAbi, hoodOFTAdapterAbi, routes, crossChainBuyLink } from "@hood/sdk";
import { addresses } from "@/lib/config";
import { api, type TokenRow } from "@/lib/api";
import { fmt } from "@/lib/format";

const ORIGINS = [
  { id: 1, name: "Ethereum" }, { id: 8453, name: "Base" }, { id: 42161, name: "Arbitrum" },
  { id: 10, name: "Optimism" }, { id: 56, name: "BNB Chain" }, { id: 137, name: "Polygon" },
];

/// Two different journeys share this page: money coming IN from another chain, and a token going OUT.
export default function BridgePage() {
  const { address } = useAccount();
  const [tab, setTab] = useState<"in" | "out">("in");

  return (
    <div className="bridge-shell">
      <div className="bridge-story">
      <header className="page-intro">
        <div className="section-kicker">CROSS CHAIN</div>
        <h1>Bridge</h1>
        <p>
          Bring money in from wherever it sits, or send a launched token out to another chain.
        </p>
      </header>
      </div>

      <div className="bridge-workspace">
      <div className="bridge-tabs flex gap-2">
        {([["in", "buy from another chain"], ["out", "send a token out"]] as const).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`flex-1 rounded-lg border px-3 py-2 text-sm ${
              tab === k ? "bridge-tab-active border-[var(--color-lime)] text-[var(--color-lime)]" : "border-[var(--color-line)] dim"
            }`}>
            {label}
          </button>
        ))}
      </div>

      {tab === "in" ? <BuyIn address={address} /> : <SendOut address={address} />}
      </div>
    </div>
  );
}

function BuyIn({ address }: { address?: Address }) {
  const [origin, setOrigin] = useState(8453);
  const [amount, setAmount] = useState("0.05");

  return (
    <section className="panel space-y-3 p-4">
      <p className="text-sm dim">
        Relay carries the funds and lands them on Robinhood Chain in your own wallet. Once they arrive,
        buy anything on the board in one click.
      </p>
      <label className="block">
        <span className="mb-1 block text-xs dim">from</span>
        <select className="input" value={origin} onChange={(e) => setOrigin(Number(e.target.value))}>
          {ORIGINS.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      </label>
      <label className="block">
        <span className="mb-1 block text-xs dim">amount</span>
        <input className="input mono" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} />
      </label>
      <a className="btn block text-center"
        href={crossChainBuyLink({ fromChainId: origin, amount, recipient: address })}
        target="_blank" rel="noreferrer">
        continue on Relay
      </a>
      <p className="text-xs dim">
        Your wallet signs on {ORIGINS.find((o) => o.id === origin)?.name}; the funds appear here. Nothing
        custodial, and no deposit address to get wrong.
      </p>
    </section>
  );
}

function SendOut({ address }: { address?: Address }) {
  const [token, setToken] = useState("");
  const [route, setRoute] = useState<keyof typeof routes>("base");
  const [amount, setAmount] = useState("");
  const { writeContractAsync } = useWriteContract();

  const tokens = useQuery({ queryKey: ["tokens", "bridge"], queryFn: () => api<{ tokens: TokenRow[] }>("/tokens?limit=100") });

  const { data: adapter } = useReadContract({
    address: addresses.bridgeFactory, abi: hoodBridgeFactoryAbi, functionName: "adapterOf",
    args: [(token || zeroAddress) as Address],
    query: { enabled: Boolean(addresses.bridgeFactory && token) },
  });

  const hasAdapter = adapter && adapter !== zeroAddress;
  const wei = (() => { try { return parseEther(amount || "0"); } catch { return 0n; } })();

  const { data: quote } = useReadContract({
    address: (adapter as Address) ?? zeroAddress, abi: hoodOFTAdapterAbi, functionName: "quoteSend",
    args: [{
      dstEid: routes[route].eid,
      to: `0x${(address ?? zeroAddress).slice(2).padStart(64, "0")}` as `0x${string}`,
      amountLD: wei, minAmountLD: wei,
      extraOptions: "0x00030100110100000000000000000000000000030d40" as `0x${string}`,
      composeMsg: "0x" as `0x${string}`, oftCmd: "0x" as `0x${string}`,
    }, false],
    query: { enabled: Boolean(hasAdapter && wei > 0n && address) },
  });

  const fee = (quote as { nativeFee: bigint } | undefined)?.nativeFee ?? 0n;

  return (
    <section className="panel space-y-3 p-4">
      <p className="text-sm dim">
        A token leaves by being locked here and minted there, so the supply never changes. The token
        contract has no mint function at all; the lock box is the only door.
      </p>

      <label className="block">
        <span className="mb-1 block text-xs dim">token</span>
        <select className="input" value={token} onChange={(e) => setToken(e.target.value)}>
          <option value="">pick one</option>
          {tokens.data?.tokens.map((t) => <option key={t.token} value={t.token}>{t.symbol} · {t.name}</option>)}
        </select>
      </label>

      <label className="block">
        <span className="mb-1 block text-xs dim">to</span>
        <select className="input" value={route} onChange={(e) => setRoute(e.target.value as keyof typeof routes)}>
          {Object.entries(routes).map(([k, r]) => <option key={k} value={k}>{r.name}</option>)}
        </select>
      </label>

      <label className="block">
        <span className="mb-1 block text-xs dim">amount</span>
        <input className="input mono" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} />
      </label>

      {token && !hasAdapter && (
        <div className="rounded-lg border border-[var(--color-line)] p-3 text-xs dim">
          This token has no lock box yet. Anyone can deploy it, once, and it is the only one that will
          ever exist for this token.
          <button className="btn btn-ghost mt-2 w-full text-xs" disabled={!address || !addresses.bridgeFactory}
            onClick={() => writeContractAsync({
              address: addresses.bridgeFactory!, abi: hoodBridgeFactoryAbi,
              functionName: "deployAdapter", args: [token as Address],
            })}>
            deploy the lock box
          </button>
        </div>
      )}

      {hasAdapter && (
        <>
          <div className="flex justify-between text-xs">
            <span className="dim">messaging fee</span>
            <span className="mono">{fmt(fee, 18, 6)} ETH</span>
          </div>
          <button className="btn w-full" disabled={!address || wei === 0n || fee === 0n}
            onClick={() => writeContractAsync({
              address: adapter as Address, abi: hoodOFTAdapterAbi, functionName: "send",
              args: [{
                dstEid: routes[route].eid,
                to: `0x${address!.slice(2).padStart(64, "0")}` as `0x${string}`,
                amountLD: wei, minAmountLD: wei,
                extraOptions: "0x00030100110100000000000000000000000000030d40" as `0x${string}`,
                composeMsg: "0x" as `0x${string}`, oftCmd: "0x" as `0x${string}`,
              }, { nativeFee: fee, lzTokenFee: 0n }, address!],
              value: fee,
            })}>
            send to {routes[route].name}
          </button>
          <p className="text-xs dim">
            A route only works once the protocol has wired its peer and its verifiers on both ends.
            If the quote does not price, that route is not open for this token yet.
          </p>
        </>
      )}
    </section>
  );
}
