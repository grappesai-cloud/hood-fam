"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import type { TokenRow } from "@/lib/api";
import { compact, imageUrl, pairDecimals, pairSymbol } from "@/lib/format";
import { Artwork } from "@/components/Artwork";
import { usdCompact } from "@/components/Provenance";

/// One coin on the desk, the way a trending list reads it: the art, the name and ticker, the cap
/// in the pair (and in dollars when the pair is priced), the day's move, and one tag saying why it
/// is on this list. The arithmetic is the board's own, so the desk and the board never disagree
/// about one coin; a figure that cannot be computed is a dash with its reason in the title.

export function capOf(token: TokenRow): bigint {
  return (BigInt(token.price || "0") * BigInt(token.total_supply || "0")) / 10n ** 18n;
}

/// Percent moved against the trade nearest to 24 hours ago, or null when there was none.
export function changeOf(token: TokenRow): number | null {
  const old = BigInt(token.price_24h_ago || "0");
  if (old <= 0n) return null;
  return Number(((BigInt(token.price || "0") - old) * 10_000n) / old) / 100;
}

export function TokenLine({ token, tag }: { token: TokenRow; tag?: ReactNode }) {
  const decimals = pairDecimals(token.pair_token, token);
  const unit = pairSymbol(token.pair_token, token);
  const cap = capOf(token);
  const price = token.usd?.usd ?? null;
  const capUsd = cap > 0n && price != null ? (Number(cap) / 10 ** decimals) * price : null;
  const change = changeOf(token);

  return (
    <Link href={`/token/${token.token}`} className="ox-line">
      <span className="ox-line-art"><Artwork src={imageUrl(token.image)} symbol={token.symbol} size={34} rounded="rounded-lg" /></span>
      <span className="ox-line-id">
        <strong>{token.name}</strong>
        <small><b>${token.symbol}</b>{tag}</small>
      </span>
      <span className="ox-line-cap">
        {cap > 0n ? (
          <>
            <strong>{compact(cap, decimals)} {unit}</strong>
            <small title={capUsd != null ? "cap in the pair times the pair's dollar price" : token.usd?.reason ?? "no dollar price for this pair"}>
              {capUsd != null ? usdCompact(capUsd) : "no dollar price"}
            </small>
          </>
        ) : (
          <>
            <strong className="figure-dash" title="no trade has set a price yet">—</strong>
            <small>no price yet</small>
          </>
        )}
      </span>
      <span
        className={change == null ? "ox-line-change dim" : change >= 0 ? "ox-line-change positive" : "ox-line-change negative"}
        title={change == null ? "no trade 24 hours ago to compare with" : "price now against the trade nearest to 24 hours ago"}
      >
        {change == null ? "—" : `${change >= 0 ? "+" : ""}${change.toFixed(1)}%`}
      </span>
    </Link>
  );
}
