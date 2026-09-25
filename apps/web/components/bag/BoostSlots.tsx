"use client";

import Link from "next/link";
import { fmt, shortAddress } from "@/lib/format";
import { Prov } from "@/components/Provenance";
import { assetOf, big, type BagBoosts } from "@/lib/bag";

/// This hour's boost slots, read only: who bought which slot and for what. Buying one is done on
/// the token page, because a boost is a thing you do to one launch.

export function BoostSlots({ boosts, missing }: { boosts: BagBoosts | null | undefined; missing: boolean }) {
  const slots = boosts?.slots ?? [];
  const taken = slots.filter((s) => s.token);
  const eth = assetOf(null);
  const price = big(boosts?.price);

  return (
    <section className="panel bag-card">
      <header className="refer-head">
        <h2>Boosts this hour</h2>
        <span className="dim text-sm">
          {price > 0n ? <>a slot costs {fmt(price, eth.decimals, 4)} {eth.symbol} <Prov kind="measured" /></> : "pinned to the top of the board"}
        </span>
      </header>
      {missing || !boosts ? (
        <p className="dim text-sm">The boosts are not wired into this API yet. The slots appear once the indexer serves them.</p>
      ) : taken.length === 0 ? (
        <p className="dim text-sm">No slot is taken this hour. The first buyer pins their launch to the top of the board until the hour ends.</p>
      ) : (
        <ol className="bag-slots">
          {slots.map((s) => (
            <li key={s.slot}>
              <span className="bag-slot-n mono">slot {s.slot}</span>
              {s.token ? (
                <>
                  <Link href={`/token/${s.token}`}>{s.symbol ? `$${s.symbol}` : shortAddress(s.token)}</Link>
                  {s.buyer && <span className="dim text-xs">paid by <Link href={`/trader/${s.buyer}`}>{shortAddress(s.buyer)}</Link></span>}
                </>
              ) : (
                <span className="dim">open</span>
              )}
            </li>
          ))}
        </ol>
      )}
      <p className="bag-fine">You pay the slot, your launch sits above the board for the hour. All of it goes to the house through the Bag.</p>
    </section>
  );
}
