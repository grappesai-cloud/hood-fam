"use client";

import Link from "next/link";
import type { CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type TopTraderRow } from "@/lib/api";
import { fmt, shortAddress } from "@/lib/format";
import { assetOf, big, isMissing, useEarners, type EarnerRow } from "@/lib/bag";
import { usdCompact } from "@/components/Provenance";

/// The strip under the header: the wallets the machines paid the most this week, scrolling the way
/// a trading floor's top-traders strip does. It reads `GET /earners`; an API that does not serve
/// that route yet gets the profit board instead, labelled as what it is; an API that serves neither
/// gets no strip at all rather than an empty one.

interface Item {
  address: string;
  figure: string;
  title: string;
}

/// Two hues out of the address bytes, so a wallet is recognisable across the page without an
/// avatar service. Not identity, a colour; the bytes printed next to it are the identity.
function tone(address: string): string {
  const a = parseInt(address.slice(2, 4), 16) || 0;
  const b = parseInt(address.slice(4, 6), 16) || 0;
  const c = parseInt(address.slice(6, 8), 16) || 0;
  return `linear-gradient(135deg, hsl(${Math.round((a / 255) * 360)} 70% 58%), hsl(${Math.round((b / 255) * 360)} 65% 38%) ${60 + Math.round((c / 255) * 30)}%)`;
}

function earnerItem(row: EarnerRow): Item {
  const paid = row.paid.filter((p) => big(p.amount) > 0n).map((p) => {
    const { symbol, decimals } = assetOf(p.asset, p);
    return `${fmt(big(p.amount), decimals, decimals >= 18 ? 4 : 2)} ${symbol}`;
  });
  const figure = row.usd != null ? `+${usdCompact(row.usd)}` : paid.length ? `+${paid[0]}` : "—";
  const parts = [
    paid.length ? `got ${paid.join(" and ")}` : "got nothing yet",
    row.pushes > 0 ? `${row.pushes} pot push${row.pushes === 1 ? "" : "es"}` : null,
    row.payday > 0 ? `${row.payday} Payday${row.payday === 1 ? "" : "s"}` : null,
    row.airdrops > 0 ? `${row.airdrops} season drop claim${row.airdrops === 1 ? "" : "s"}` : null,
  ].filter(Boolean);
  return { address: row.address, figure, title: `${shortAddress(row.address)} ${parts.join(", ")} this week` };
}

function traderItem(row: TopTraderRow): Item {
  const total = Number(row.totalUsd ?? 0);
  return {
    address: row.address,
    figure: `${total >= 0 ? "+" : "-"}${usdCompact(Math.abs(total))}`,
    title: `${shortAddress(row.address)} has ${usdCompact(Math.round(row.realizedUsd ?? 0))} banked and ${usdCompact(Math.round(row.unrealizedUsd ?? 0))} still open`,
  };
}

/// A strip with three wallets on it still has to cover the width, or the marquee is three chips
/// followed by a screen of nothing. The list repeats until it is long enough to run.
function marquee(items: Item[]): Item[] {
  if (!items.length) return items;
  const out: Item[] = [];
  while (out.length < 14) out.push(...items);
  return out;
}

export function PaidTicker() {
  const earners = useEarners(7, 20);
  const noEarners = earners.isError && isMissing(earners.error);
  // The existing profit board, asked for only when the earners route is not there.
  const traders = useQuery({
    queryKey: ["top-traders", "desk-ticker"],
    queryFn: () => api<{ traders: TopTraderRow[] }>("/top-traders?sort=pnl&limit=20"),
    enabled: noEarners,
    refetchInterval: 60_000,
    retry: false,
  });

  let label: string;
  let heading: string;
  let items: Item[];
  let empty: string;
  if (earners.data) {
    label = "paid this week";
    heading = "The wallets paid the most this week";
    items = earners.data.rows.map(earnerItem);
    empty = "Nobody has been paid this week yet. The first trade on the new machine starts the tape.";
  } else if (noEarners && traders.data) {
    label = "top traders";
    heading = "Top traders by profit";
    items = traders.data.traders.map(traderItem);
    empty = "No trader has a profit on the board yet. Rankings start with the first indexed trade.";
  } else {
    // Still reading, or neither route answers: no strip, rather than a strip that says nothing.
    return null;
  }
  const run = marquee(items);

  return (
    <div className="ox-ticker" aria-label={heading}>
      <span className="ox-ticker-label"><i aria-hidden="true" /> {label}</span>
      {items.length === 0 ? (
        <span className="ox-ticker-empty">{empty}</span>
      ) : (
        <div className="ox-ticker-run" style={{ "--ox-ticker-n": run.length } as CSSProperties}>
          {[0, 1].map((pass) => (
            <div className="ox-ticker-track" key={pass} aria-hidden={pass === 1}>
              {run.map((item, i) => (
                <Link
                  key={`${pass}-${i}-${item.address}`}
                  href={`/trader/${item.address}`}
                  className="ox-ticker-item"
                  title={item.title}
                  tabIndex={pass === 1 ? -1 : undefined}
                >
                  <i className="ox-identicon" style={{ background: tone(item.address) }} aria-hidden="true" />
                  <span>{item.address.slice(0, 6)}</span>
                  <b>{item.figure}</b>
                </Link>
              ))}
            </div>
          ))}
        </div>
      )}
      <Link className="ox-ticker-action" href="/bag">The Bag <span aria-hidden="true">↗</span></Link>
    </div>
  );
}
