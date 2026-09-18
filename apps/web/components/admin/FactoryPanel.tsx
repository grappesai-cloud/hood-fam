"use client";

import { useState } from "react";
import { formatEther, type Address } from "viem";
import { useReadContract, useReadContracts } from "wagmi";
import { hoodFactoryAbi } from "@hood/sdk";
import { addresses } from "@/lib/config";
import { fmt } from "@/lib/format";
import {
  AddressInput,
  Group,
  Locked,
  NotDeployed,
  OwnerHeader,
  WriteError,
  deployedAt,
  toUnits,
  toWei,
  useOwnership,
  useOwnerWrite,
  validAddress,
} from "./owner";
import { Addr, Fact } from "./ui";

interface CurvePreset {
  totalSupply: bigint;
  curveSupplyBps: number;
  startCap: bigint;
  graduationCap: bigint;
  liquidityBps: number;
  protocolFeeBps: number;
  creatorFeeBps: number;
  poolFee: number;
  tickSpacing: number;
  enabled: boolean;
}

/// The curve machine: the fee it charges, the wallet it pays, the pairs it will trade against and
/// the presets a creator gets to pick from.
export function FactoryPanel() {
  const factory = deployedAt(addresses.factory);
  if (!factory) return <NotDeployed title="factory" note="NEXT_PUBLIC_FACTORY is empty, so curve launches have nowhere to go." />;
  return <Factory factory={factory} />;
}

function Factory({ factory }: { factory: Address }) {
  const ownership = useOwnership(factory, hoodFactoryAbi);
  const { send, pending, error, writeContractAsync } = useOwnerWrite();
  const [fee, setFee] = useState("");
  const [treasury, setTreasury] = useState("");
  const [pair, setPair] = useState("");
  const [threshold, setThreshold] = useState("");

  const { data } = useReadContracts({
    contracts: [
      { address: factory, abi: hoodFactoryAbi, functionName: "launchFee" },
      { address: factory, abi: hoodFactoryAbi, functionName: "treasury" },
      { address: factory, abi: hoodFactoryAbi, functionName: "configCount" },
    ] as never,
    query: { refetchInterval: 15_000 },
  });
  const r = (data ?? []) as { result?: unknown }[];
  const launchFee = (r[0]?.result as bigint | undefined) ?? 0n;
  const currentTreasury = r[1]?.result as Address | undefined;
  const configCount = Number((r[2]?.result as bigint | undefined) ?? 0n);

  const { data: presetData } = useReadContracts({
    contracts: Array.from({ length: configCount }, (_, i) => ({
      address: factory,
      abi: hoodFactoryAbi,
      functionName: "getConfig",
      args: [BigInt(i)],
    })) as never,
    query: { enabled: configCount > 0, refetchInterval: 30_000 },
  });
  const presets = (presetData ?? []) as { result?: CurvePreset }[];

  const { data: pairAllowed } = useReadContract({
    address: factory,
    abi: hoodFactoryAbi,
    functionName: "pairAllowed",
    args: [pair as Address],
    query: { enabled: validAddress(pair) },
  });

  const canWrite = ownership.isOwner && pending === null;
  const feeWei = toWei(fee);
  const thresholdUnits = toUnits(threshold);

  return (
    <section className="panel space-y-3 p-4">
      <OwnerHeader
        title="factory"
        contract={factory}
        ownership={ownership}
        accepting={pending === "accept"}
        onAccept={() =>
          void send("accept", () =>
            writeContractAsync({ address: factory, abi: hoodFactoryAbi, functionName: "acceptOwnership" }),
          )
        }
      />

      <div className="grid grid-cols-2 gap-2">
        <Fact label="launch fee" value={`${formatEther(launchFee)} ETH`} />
        <Fact label="treasury" value={<Addr address={currentTreasury} missing="reading" />} />
      </div>

      <Locked isOwner={ownership.isOwner} />

      <Group title="launch fee">
        <input
          className="input mono"
          inputMode="decimal"
          placeholder="0.0"
          value={fee}
          onChange={(e) => setFee(e.target.value.replace(/[^0-9.]/g, ""))}
        />
        <p className="text-xs dim">In ETH, charged on every launch through this factory.</p>
        <button
          className="btn btn-ghost text-xs"
          disabled={!canWrite || feeWei === undefined}
          onClick={() =>
            void send("fee", () =>
              writeContractAsync({ address: factory, abi: hoodFactoryAbi, functionName: "setLaunchFee", args: [feeWei!] }),
            )
          }
        >
          {pending === "fee" ? "sending" : "set fee"}
        </button>
      </Group>

      <Group title="treasury">
        <AddressInput value={treasury} onChange={setTreasury} />
        <p className="text-xs dim">
          Same rule as the portal: a plain wallet, or a contract you know takes ETH. A delegated address can swallow
          the transfer and take the launch down with it.
        </p>
        <button
          className="btn btn-ghost text-xs"
          disabled={!canWrite || !validAddress(treasury)}
          onClick={() =>
            void send("treasury", () =>
              writeContractAsync({
                address: factory,
                abi: hoodFactoryAbi,
                functionName: "setTreasury",
                args: [treasury as Address],
              }),
            )
          }
        >
          {pending === "treasury" ? "sending" : "set treasury"}
        </button>
      </Group>

      <Group title="pairs">
        <AddressInput value={pair} onChange={setPair} placeholder="pair token, 0x... (zero address is ETH)" />
        {validAddress(pair) && (
          <p className="text-xs dim">{pairAllowed ? "this pair is allowed today." : "this pair is not allowed today."}</p>
        )}
        <input
          className="input mono"
          inputMode="numeric"
          placeholder="lock threshold, in the pair's smallest unit"
          value={threshold}
          onChange={(e) => setThreshold(e.target.value.replace(/[^0-9]/g, ""))}
        />
        <div className="flex flex-wrap gap-2">
          <button
            className="btn btn-ghost text-xs"
            disabled={!canWrite || !validAddress(pair) || thresholdUnits === undefined}
            onClick={() =>
              void send("pair-on", () =>
                writeContractAsync({
                  address: factory,
                  abi: hoodFactoryAbi,
                  functionName: "setPair",
                  args: [pair as Address, true, thresholdUnits!],
                }),
              )
            }
          >
            {pending === "pair-on" ? "sending" : "allow pair"}
          </button>
          <button
            className="btn btn-ghost text-xs"
            disabled={!canWrite || !validAddress(pair) || thresholdUnits === undefined}
            onClick={() =>
              void send("pair-off", () =>
                writeContractAsync({
                  address: factory,
                  abi: hoodFactoryAbi,
                  functionName: "setPair",
                  args: [pair as Address, false, thresholdUnits!],
                }),
              )
            }
          >
            {pending === "pair-off" ? "sending" : "block pair"}
          </button>
        </div>
      </Group>

      <Group title="presets">
        {configCount === 0 && <p className="text-xs dim">no presets on this factory yet.</p>}
        {presets.map((p, i) => {
          const c = p.result;
          if (!c) return null;
          return (
            <div key={i} className="flex items-center gap-2 rounded-lg border border-[var(--color-line)] p-2 text-xs">
              <div className="flex-1">
                <div className="mono">
                  #{i} · {fmt(c.totalSupply, 18, 0)} supply · {c.curveSupplyBps / 100}% on the curve
                </div>
                <div className="dim">
                  starts {fmt(c.startCap, 18, 3)} · graduates {fmt(c.graduationCap, 18, 3)} ·{" "}
                  {(c.protocolFeeBps + c.creatorFeeBps) / 100}% fee · {c.liquidityBps / 100}% to the pool
                </div>
              </div>
              <span className={c.enabled ? "text-[var(--color-lime)]" : "dim"}>{c.enabled ? "on" : "off"}</span>
              <button
                className="btn btn-ghost !px-2 !py-1 text-xs"
                disabled={!canWrite}
                onClick={() =>
                  void send(`config-${i}`, () =>
                    writeContractAsync({
                      address: factory,
                      abi: hoodFactoryAbi,
                      functionName: "setConfigEnabled",
                      args: [BigInt(i), !c.enabled],
                    }),
                  )
                }
              >
                {pending === `config-${i}` ? "sending" : c.enabled ? "disable" : "enable"}
              </button>
            </div>
          );
        })}
        <p className="text-xs dim">
          Caps are shown at eighteen decimals. A pair with six reads the same number a trillion times smaller.
        </p>
      </Group>

      <WriteError error={error} />
    </section>
  );
}
