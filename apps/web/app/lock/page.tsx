"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useReadContract } from "wagmi";
import { zeroAddress, type Address } from "viem";
import { hoodStakingAbi, LOCK_TIERS } from "@hood/sdk";
import { api, type TokenRow } from "@/lib/api";
import { addresses, EXPLORER } from "@/lib/config";
import { brand } from "@/brands/current";
import { StakePanel } from "@/components/StakePanel";
import { compact, shortAddress } from "@/lib/format";
import { VaultEarnings, VAULT_NOT_OPEN, type VaultResponse } from "@/components/portfolio/VaultEarnings";
import { ProvenanceKey } from "@/components/Provenance";

/// The Vault.
///
/// There is one coin on this pad that pays for being held, and this is where it is held. The page
/// answers the questions somebody arriving from a token page has: what do I lock, what feeds it,
/// what has it paid so far, and how long is worth locking for. None of it is a promise: the feeds
/// are the Bag's fixed rules, the earnings are what the indexer read off the chain, and the tiers
/// are what the contract has.

/// What the Bag sends the Vault. Fixed at deploy; these are the splits in BagTypes.sol, said plainly.
const FEEDS = [
  { what: "30 bps of every trade", how: "The platform takes 1% of every trade on every machine. 70 bps of it enter the Bag, and 30 of those 70 come here, every block." },
  { what: "A quarter of every graduation fee", how: "A curve that fills pays 10% of its raise into the Bag. A quarter of that is the Vault's." },
  { what: "Half the house coin's own leg", how: "The house coin's creator leg goes entirely to the Bag: half here, half to the burn clock. The house keeps nothing from its own coin." },
  { what: "Jeet and whale taxes, when a creator routes them here", how: "A launch with \"lockers eat the jeets\" on sends its jeet and whale dump taxes to the Vault instead of to its holders." },
] as const;

export default function LockPage() {
  const { data: house } = useReadContract({
    address: addresses.staking, abi: hoodStakingAbi, functionName: "houseToken",
  });
  const houseToken = (house as Address | undefined) ?? zeroAddress;
  const open = houseToken !== zeroAddress;

  const { data: tokens } = useQuery({
    queryKey: ["tokens", "payers"],
    queryFn: () => api<{ tokens: TokenRow[] }>("/tokens?limit=200"),
    refetchInterval: 30_000,
  });
  const payers = (tokens?.tokens ?? []).filter((t) => (t.split_stakers_bps ?? 0) > 0);
  const coin = (tokens?.tokens ?? []).find((t) => t.token.toLowerCase() === houseToken.toLowerCase());

  // The Vault's own totals. An API from before the Bag has no /vault route; the section then
  // shows a dash with the reason, not a zero.
  const vault = useQuery({
    queryKey: ["vault"],
    queryFn: () => api<VaultResponse>("/vault"),
    refetchInterval: 30_000,
    retry: false,
  });

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-8">
      <p className="eyebrow">{brand.name}</p>
      <h1 className="page-title">The Vault</h1>
      <p className="page-lede">
        You lock the house coin, you get a share of what the Bag sends the Vault: a slice of every
        trade on the board, of every graduation, and of the house coin&apos;s own trades, paid every
        block in the asset it arrived in. Longer lock, bigger share, and nothing can take a
        position out early, including us.
      </p>
      {!open && <p className="mt-3 text-sm dim">{VAULT_NOT_OPEN}</p>}

      <div className="mt-6 grid gap-4 md:grid-cols-[minmax(0,1fr)_320px]">
        <div className="grid gap-4">
        <VaultEarnings scope="vault" n="01 / PAID IN" title="What the Vault has been paid"
          rows={vault.data?.rewards} held={vault.data?.held} houseCoin={open ? houseToken : null} />

        <section className="panel p-4">
          <h2 className="font-semibold">What feeds the Vault</h2>
          <p className="mt-1 text-xs dim">Four taps, fixed when the Bag was deployed. No owner can move them.</p>
          <ol className="vault-feeds mt-3">
            {FEEDS.map((f) => (
              <li key={f.what}><strong>{f.what}</strong><span>{f.how}</span></li>
            ))}
          </ol>
        </section>

        <section className="panel p-4">
          <h2 className="font-semibold">Tiers, as the contract has them</h2>
          <p className="mt-1 text-xs dim">
            Your weight is your amount times the tier&apos;s multiplier. 180 days at 2.5x is the top
            tier; a 365-day lock earns the same 2.5x, and the contract refuses anything longer.
          </p>
          <div className="tier-list mt-3">
            {LOCK_TIERS.map((t) => (
              <div key={t.seconds} className={t.multiplier === 2.5 ? "tier top" : "tier"}>
                <span className="mono">{t.multiplier}x</span>
                <span>{t.label}{t.multiplier === 2.5 ? ", the top tier" : ""}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="panel p-4">
          <h2 className="font-semibold">Launches that also pay lockers</h2>
          <p className="mt-1 text-xs dim">
            On top of the Bag, a curve launch can point part of its own fee split at lockers. Chosen at launch, once.
          </p>
          {!open ? (
            <p className="mt-2 text-sm dim">
              Until the house coin is named on chain no launch can point its split here, so this list
              is empty by design rather than by accident.
            </p>
          ) : payers.length === 0 ? (
            <p className="mt-2 text-sm dim">
              Nothing on the board pays lockers through its split yet. The Bag&apos;s taps above pay regardless.
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
        <ProvenanceKey />
        </div>

        <StakePanel />
      </div>
    </main>
  );
}
