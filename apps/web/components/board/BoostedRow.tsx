"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type TokenRow } from "@/lib/api";
import { hourEpochNow } from "@/lib/bagAbi";
import { compact, imageUrl, pairDecimals, pairSymbol } from "@/lib/format";
import { Artwork } from "@/components/Artwork";
import { BoostBadge } from "@/components/token/BoostBadge";

/// The launches that bought this hour on the board, pinned above everything else. The API orders
/// `sort=boost` with the boosted rows first, and each row says so with `boosted`; the strip shows
/// only those, and says in one sentence what an empty hour means and how to fill it.

/// Boosted rows first, the rest in the order the API gave them. Stable, so a sort tab still sorts.
export function pinBoosted<T extends { boosted?: boolean }>(rows: T[]): T[] {
  if (!rows.some((r) => r.boosted)) return rows;
  return [...rows.filter((r) => r.boosted), ...rows.filter((r) => !r.boosted)];
}

function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

export function BoostedRow({ variant = "hood" }: { variant?: "hood" | "ox" }) {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() / 1000), 1_000);
    return () => clearInterval(t);
  }, []);

  // Under the "tokens" name so the stream refreshes it with the rest of the board.
  const query = useQuery({
    queryKey: ["tokens", "boost", "row"],
    queryFn: () => api<{ tokens: TokenRow[] }>("/tokens?sort=boost&limit=12"),
    refetchInterval: 30_000,
    retry: false,
  });
  const rows = (query.data?.tokens ?? []).filter((t) => t.boosted);
  const left = (hourEpochNow() + 1) * 3600 - now;

  if (query.isLoading) return null;

  return (
    <section className={`boosted-row ${variant === "ox" ? "ox-boosted-row" : ""}`} aria-label="Boosted this hour">
      <div className="boosted-row-head">
        <span className="boosted-row-kicker">Boosted this hour</span>
        <span className="mono dim">{clock(left)} left in the hour</span>
      </div>
      {rows.length === 0 ? (
        <p className="boosted-row-empty">
          Nobody bought a boost this hour. You buy a slot on a token's page, you get it pinned here until the hour ends.
        </p>
      ) : (
        <div className="boosted-row-cards">
          {rows.map((t) => {
            const dec = pairDecimals(t.pair_token, t);
            const cap = (BigInt(t.price || "0") * BigInt(t.total_supply || "0")) / 10n ** 18n;
            return (
              <Link key={t.token} href={`/token/${t.token}`} className="boosted-card">
                <Artwork src={imageUrl(t.image)} symbol={t.symbol} size={44} rounded="rounded-lg" />
                <span className="boosted-card-id">
                  <strong>${t.symbol}</strong>
                  <small>{compact(cap, dec)} {pairSymbol(t.pair_token, t)} MC</small>
                </span>
                <BoostBadge />
              </Link>
            );
          })}
        </div>
      )}
    </section>
  );
}
