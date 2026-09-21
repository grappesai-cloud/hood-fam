"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useReadContract } from "wagmi";
import { zeroAddress, type Address } from "viem";
import { hoodStakingAbi } from "@hood/sdk";
import { api, type TokenRow } from "@/lib/api";
import { addresses, EXPLORER } from "@/lib/config";
import { brand } from "@/brands/current";
import { StakePanel } from "@/components/StakePanel";
import { compact, shortAddress } from "@/lib/format";

/// The room.
///
/// There is one coin on this pad that pays for being held, and this is where it is held. The page
/// exists to answer the two questions somebody arriving from a token page has: what do I lock, and
/// who pays me for it. The second one is not a promise, it is a list: every launch on the board
/// that points part of its fee at stakers, and how much of it.
export default function LockPage() {
  const { data: house } = useReadContract({
    address: addresses.staking, abi: hoodStakingAbi, functionName: "houseToken",
  });
  const houseToken = (house as Address | undefined) ?? zeroAddress;

  const { data: tokens } = useQuery({
    queryKey: ["tokens", "payers"],
    queryFn: () => api<{ tokens: TokenRow[] }>("/tokens?limit=200"),
    refetchInterval: 30_000,
  });
  const payers = (tokens?.tokens ?? []).filter((t) => (t.split_stakers_bps ?? 0) > 0);
  const coin = (tokens?.tokens ?? []).find((t) => t.token.toLowerCase() === houseToken.toLowerCase());

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-8">
      <p className="eyebrow">{brand.name}</p>
      <h1 className="page-title">One coin, the whole board</h1>
      <p className="page-lede">
        Locking is not per token here. Every launch that sends part of its trading fee to stakers
        sends it to the same room, and the room is whoever has the pad&apos;s own coin locked.
        Longer lock, bigger share, and nothing can take a position out early, including us.
      </p>

      <div className="mt-6 grid gap-4 md:grid-cols-[minmax(0,1fr)_320px]">
        <section className="panel p-4">
          <h2 className="font-semibold">Who pays this room</h2>
          {houseToken === zeroAddress ? (
            <p className="mt-2 text-sm dim">
              The coin has not been named on chain yet. Until it is, no launch can point its fee
              here, so this list stays empty by design rather than by accident.
            </p>
          ) : payers.length === 0 ? (
            <p className="mt-2 text-sm dim">
              Nothing on the board pays stakers yet. A creator chooses that at launch, once, and it
              cannot be changed afterwards.
            </p>
          ) : (
            <div className="mt-3 space-y-1.5">
              {payers.map((t) => (
                <Link key={t.token} href={`/token/${t.token}`}
                  className="flex items-center justify-between rounded-lg border border-[var(--color-line)] px-3 py-2 text-sm">
                  <span className="truncate">
                    <span className="font-semibold">${t.symbol}</span>{" "}
                    <span className="dim">{t.name}</span>
                  </span>
                  <span className="mono text-xs">
                    {Math.round((t.split_stakers_bps ?? 0) / 100)}% of its fee
                  </span>
                </Link>
              ))}
            </div>
          )}

          {coin && (
            <div className="mt-4 border-t border-[var(--color-line)] pt-3 text-xs dim">
              The coin is{" "}
              <Link className="underline" href={`/token/${coin.token}`}>${coin.symbol}</Link>, and it
              trades on this pad like anything else. {compact(BigInt(coin.volume_total ?? "0"))} traded
              since it printed.
            </div>
          )}
          {houseToken !== zeroAddress && !coin && (
            <div className="mt-4 border-t border-[var(--color-line)] pt-3 text-xs dim">
              The coin is{" "}
              <a className="underline" href={`${EXPLORER}/address/${houseToken}`} rel="noreferrer noopener" target="_blank">
                {shortAddress(houseToken)}
              </a>, which was not launched on this pad.
            </div>
          )}
        </section>

        <StakePanel />
      </div>
    </main>
  );
}
