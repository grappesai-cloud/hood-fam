"use client";

import { useState } from "react";
import { formatEther, type Address } from "viem";
import { useReadContract, useReadContracts } from "wagmi";
import { hoodPortalAbi } from "@hood/sdk";
import { directAddresses } from "@/lib/config";
import {
  AddressInput,
  Group,
  Locked,
  NotDeployed,
  OwnerHeader,
  WriteError,
  deployedAt,
  toWei,
  useOwnership,
  useOwnerWrite,
  validAddress,
} from "./owner";
import { Addr, Fact } from "./ui";

/// The direct machine's front door: who may launch, what it costs, where the fee lands.
export function PortalPanel() {
  const portal = deployedAt(directAddresses.portal);
  if (!portal) {
    return <NotDeployed title="portal" note="NEXT_PUBLIC_PORTAL is empty, so straight-to-the-pool launches have no door." />;
  }
  return <Portal portal={portal} />;
}

function Portal({ portal }: { portal: Address }) {
  const ownership = useOwnership(portal, hoodPortalAbi);
  const { send, pending, error, writeContractAsync } = useOwnerWrite();
  const [who, setWho] = useState("");
  const [fee, setFee] = useState("");
  const [treasury, setTreasury] = useState("");

  const { data } = useReadContracts({
    contracts: [
      { address: portal, abi: hoodPortalAbi, functionName: "launchEnabled" },
      { address: portal, abi: hoodPortalAbi, functionName: "whitelistOnly" },
      { address: portal, abi: hoodPortalAbi, functionName: "launchFee" },
      { address: portal, abi: hoodPortalAbi, functionName: "treasury" },
    ] as never,
    query: { refetchInterval: 15_000 },
  });
  const r = (data ?? []) as { result?: unknown }[];
  const launchEnabled = Boolean(r[0]?.result);
  const whitelistOnly = Boolean(r[1]?.result);
  const launchFee = (r[2]?.result as bigint | undefined) ?? 0n;
  const currentTreasury = r[3]?.result as Address | undefined;

  const { data: alreadyAllowed } = useReadContract({
    address: portal,
    abi: hoodPortalAbi,
    functionName: "whitelisted",
    args: [who as Address],
    query: { enabled: validAddress(who) },
  });

  const canWrite = ownership.isOwner && pending === null;
  const feeWei = toWei(fee);

  return (
    <section className="panel space-y-3 p-4">
      <OwnerHeader
        title="portal"
        contract={portal}
        ownership={ownership}
        accepting={pending === "accept"}
        onAccept={() =>
          void send("accept", () =>
            writeContractAsync({ address: portal, abi: hoodPortalAbi, functionName: "acceptOwnership" }),
          )
        }
      />

      <div className="grid grid-cols-2 gap-2">
        <Fact label="launches" value={launchEnabled ? "open" : "closed"} />
        <Fact label="who may launch" value={whitelistOnly ? "whitelist only" : "anybody"} />
        <Fact label="launch fee" value={`${formatEther(launchFee)} ETH`} />
        <Fact label="treasury" value={<Addr address={currentTreasury} missing="reading" />} />
      </div>

      <Locked isOwner={ownership.isOwner} />

      <Group title="the gate">
        <p className="text-xs dim">Both switches are set in one call, so flipping one keeps the other where it is.</p>
        <div className="flex flex-wrap gap-2">
          <button
            className="btn btn-ghost text-xs"
            disabled={!canWrite}
            onClick={() =>
              void send("gate", () =>
                writeContractAsync({
                  address: portal,
                  abi: hoodPortalAbi,
                  functionName: "setLaunchGate",
                  args: [!launchEnabled, whitelistOnly],
                }),
              )
            }
          >
            {pending === "gate" ? "sending" : launchEnabled ? "close launches" : "open launches"}
          </button>
          <button
            className="btn btn-ghost text-xs"
            disabled={!canWrite}
            onClick={() =>
              void send("gate-list", () =>
                writeContractAsync({
                  address: portal,
                  abi: hoodPortalAbi,
                  functionName: "setLaunchGate",
                  args: [launchEnabled, !whitelistOnly],
                }),
              )
            }
          >
            {pending === "gate-list" ? "sending" : whitelistOnly ? "open to anybody" : "whitelist only"}
          </button>
        </div>
      </Group>

      <Group title="whitelist">
        <AddressInput value={who} onChange={setWho} />
        {validAddress(who) && (
          <p className="text-xs dim">{alreadyAllowed ? "this wallet is already allowed." : "this wallet is not allowed yet."}</p>
        )}
        <div className="flex flex-wrap gap-2">
          <button
            className="btn btn-ghost text-xs"
            disabled={!canWrite || !validAddress(who)}
            onClick={() =>
              void send("allow", () =>
                writeContractAsync({
                  address: portal,
                  abi: hoodPortalAbi,
                  functionName: "setWhitelisted",
                  args: [who as Address, true],
                }),
              )
            }
          >
            {pending === "allow" ? "sending" : "allow"}
          </button>
          <button
            className="btn btn-ghost text-xs"
            disabled={!canWrite || !validAddress(who)}
            onClick={() =>
              void send("deny", () =>
                writeContractAsync({
                  address: portal,
                  abi: hoodPortalAbi,
                  functionName: "setWhitelisted",
                  args: [who as Address, false],
                }),
              )
            }
          >
            {pending === "deny" ? "sending" : "remove"}
          </button>
        </div>
      </Group>

      <Group title="launch fee">
        <input
          className="input mono"
          inputMode="decimal"
          placeholder="0.0"
          value={fee}
          onChange={(e) => setFee(e.target.value.replace(/[^0-9.]/g, ""))}
        />
        <p className="text-xs dim">In ETH. It is charged once, on the launch itself.</p>
        <button
          className="btn btn-ghost text-xs"
          disabled={!canWrite || feeWei === undefined}
          onClick={() =>
            void send("fee", () =>
              writeContractAsync({ address: portal, abi: hoodPortalAbi, functionName: "setLaunchFee", args: [feeWei!] }),
            )
          }
        >
          {pending === "fee" ? "sending" : "set fee"}
        </button>
      </Group>

      <Group title="treasury">
        <AddressInput value={treasury} onChange={setTreasury} />
        <p className="text-xs dim">
          The treasury has to be a plain wallet, or a contract you know accepts ETH. An address delegated under
          EIP-7702 can swallow the transfer, and a fee that cannot be paid out is a launch that reverts.
        </p>
        <button
          className="btn btn-ghost text-xs"
          disabled={!canWrite || !validAddress(treasury)}
          onClick={() =>
            void send("treasury", () =>
              writeContractAsync({
                address: portal,
                abi: hoodPortalAbi,
                functionName: "setTreasury",
                args: [treasury as Address],
              }),
            )
          }
        >
          {pending === "treasury" ? "sending" : "set treasury"}
        </button>
      </Group>

      <WriteError error={error} />
    </section>
  );
}
