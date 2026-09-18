"use client";

import type { Address } from "viem";
import { useReadContract } from "wagmi";
import { hoodBridgeFactoryAbi } from "@hood/sdk";
import { addresses } from "@/lib/config";
import { NotDeployed, OwnerHeader, WriteError, deployedAt, useOwnership, useOwnerWrite } from "./owner";
import { Fact } from "./ui";

/// The bridge factory only has an owner to hand over here. Routes and peers are per token and are
/// set from the bridge tools, not from this page.
export function BridgePanel() {
  const bridge = deployedAt(addresses.bridgeFactory);
  if (!bridge) {
    return <NotDeployed title="bridge factory" note="NEXT_PUBLIC_BRIDGE_FACTORY is empty, so no token can leave the chain." />;
  }
  return <Bridge bridge={bridge} />;
}

function Bridge({ bridge }: { bridge: Address }) {
  const ownership = useOwnership(bridge, hoodBridgeFactoryAbi);
  const { send, pending, error, writeContractAsync } = useOwnerWrite();

  const { data: adapterCount } = useReadContract({
    address: bridge,
    abi: hoodBridgeFactoryAbi,
    functionName: "adapterCount",
    query: { refetchInterval: 30_000 },
  });

  return (
    <section className="panel space-y-3 p-4">
      <OwnerHeader
        title="bridge factory"
        contract={bridge}
        ownership={ownership}
        accepting={pending === "accept"}
        onAccept={() =>
          void send("accept", () =>
            writeContractAsync({ address: bridge, abi: hoodBridgeFactoryAbi, functionName: "acceptOwnership" }),
          )
        }
      />

      <div className="grid grid-cols-2 gap-2">
        <Fact label="adapters deployed" value={Number((adapterCount as bigint | undefined) ?? 0n)} />
        <Fact label="handover" value={ownership.isPendingOwner ? "waiting for you" : "nothing to accept"} />
      </div>

      <WriteError error={error} />
    </section>
  );
}
