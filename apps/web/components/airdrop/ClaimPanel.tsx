"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { zeroAddress, type Address } from "viem";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { fmt, shortAddress } from "@/lib/format";
import { getOrNull, weiOf, when, type Proof } from "./data";
import { useSeasonAirdrop } from "./SeasonFacts";
import { Broken, Quiet, Row } from "./ui";

/// The one function this page calls on chain. The generated SDK will carry the full ABI once the
/// contract is deployed; until then this is the only entry the page needs.
const seasonDropAbi = [
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [
      { name: "season", type: "uint256" },
      { name: "account", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "proof", type: "bytes32[]" },
    ],
    outputs: [],
  },
] as const;

/// A configured zero address is a placeholder in the env, not a deployment.
const configured = process.env.NEXT_PUBLIC_SEASON_DROP;
const SEASON_DROP: Address | undefined =
  configured && configured.toLowerCase() !== zeroAddress ? (configured as Address) : undefined;

/// What the season owes this wallet, if anything. The proof comes from the API and the money comes
/// from the contract, so a missing contract and a missing proof are two different quiet lines.
export function ClaimPanel({ season }: { season: number }) {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [sent, setSent] = useState(false);

  const pool = useSeasonAirdrop(season);
  const proof = useQuery({
    queryKey: ["airdrop", "proof", season, address],
    queryFn: () => getOrNull<Proof>(`/airdrop/${season}/proof/${address}`),
    enabled: Boolean(address && SEASON_DROP),
    refetchInterval: false,
  });

  const drop = pool.data?.drop ?? null;
  const asset = pool.data?.pool.take.byAsset.find(
    (a) => drop && a.asset.toLowerCase() === drop.asset.toLowerCase(),
  );
  const decimals = asset?.decimals ?? 18;
  const symbol = asset?.symbol ?? "";
  const p = proof.data ?? null;
  const claimed = Boolean(p?.claimed) || sent;

  async function claim() {
    if (!address || !SEASON_DROP || !p) return;
    setError(undefined);
    setPending(true);
    try {
      const hash = await writeContractAsync({
        address: SEASON_DROP,
        abi: seasonDropAbi,
        functionName: "claim",
        args: [
          BigInt(season),
          address,
          weiOf(p.amount),
          p.proof.map((node) => node as `0x${string}`),
        ],
      });
      await publicClient?.waitForTransactionReceipt({ hash });
      setSent(true);
      await queryClient.invalidateQueries();
    } catch (e) {
      const err = e as { shortMessage?: string; message?: string };
      setError(err.shortMessage ?? err.message ?? String(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="panel space-y-3 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-semibold">your claim</h2>
        {drop && <span className="text-xs dim">dropped {when(drop.generatedAt)}</span>}
      </div>

      {!SEASON_DROP && (
        <Quiet>Not deployed yet. There is nothing to claim against until the season drop contract is live.</Quiet>
      )}

      {SEASON_DROP && !address && <Quiet>Connect a wallet to see whether this season owes you anything.</Quiet>}

      {SEASON_DROP && address && (
        <>
          {proof.isLoading && <Quiet>reading</Quiet>}
          {proof.isError && <Broken>could not read your claim for this season.</Broken>}
          {!proof.isLoading && !proof.isError && !p && drop === null && (
            <Quiet>This season has not been split yet, so there is nothing to claim.</Quiet>
          )}
          {!proof.isLoading && !proof.isError && !p && drop !== null && (
            <Quiet>Nothing to claim for this season.</Quiet>
          )}

          {p && (
            <>
              <div>
                <div className="mono text-2xl font-bold leading-none">
                  {fmt(weiOf(p.amount), decimals, 6)} {symbol}
                </div>
                <p className="mt-1.5 text-xs dim">
                  {claimed ? "already claimed." : "yours to take, whenever you want it."}
                </p>
              </div>
              <div className="space-y-1">
                <Row label="season" value={p.season} />
                <Row label="root" value={shortAddress(p.root)} />
                <Row label="contract" value={shortAddress(SEASON_DROP)} />
              </div>
              <button className="btn w-full text-sm" disabled={pending || claimed} onClick={() => void claim()}>
                {pending ? "claiming" : claimed ? "claimed" : "claim"}
              </button>
            </>
          )}
          {error && <Broken>{error}</Broken>}
        </>
      )}
    </section>
  );
}
