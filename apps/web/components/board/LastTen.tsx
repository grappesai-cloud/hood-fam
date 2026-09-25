"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { api, type TokenRow } from "@/lib/api";
import { ago, imageUrl, pairSymbol } from "@/lib/format";
import { Artwork } from "@/components/Artwork";

/// The ten launches that share the hour. Every Payday sends a tenth of the pot into the pots of
/// the ten most recent launches that have one, split equally, so a fresh launch earns from the
/// whole board's hour before it has traded much. This row is those ten, right now, newest first.
/// It reads `pot` off the board's own rows; a row without one is a launch printed before the Bag.

export function LastTen({ variant = "hood" }: { variant?: "hood" | "ox" }) {
  const query = useQuery({
    queryKey: ["tokens", "lastten"],
    queryFn: () => api<{ tokens: TokenRow[] }>("/tokens?sort=new&limit=40"),
    refetchInterval: 60_000,
    retry: false,
  });
  const all = query.data?.tokens ?? [];
  const known = all.some((t) => t.pot !== undefined);
  const rows = all.filter((t) => t.pot).slice(0, 10);

  if (query.isLoading || query.isError) return null;

  return (
    <section className={`lastten ${variant === "ox" ? "ox-lastten" : ""}`} aria-labelledby="lastten-title">
      <div className="lastten-head">
        <div>
          <span className="lastten-kicker">Every launch pays the last ten</span>
          <h2 id="lastten-title">These ten share the hour</h2>
        </div>
        <p>A tenth of every Payday pot is split equally into the pots of the ten most recent launches. You print a launch, you get a slice of every hour until ten more come after you.</p>
      </div>
      {rows.length === 0 ? (
        <p className="lastten-empty">
          {known
            ? "No launch has a pot yet. The next one printed gets a share of every hour."
            : "The board's API does not report pots yet, so the ten cannot be named here."}
        </p>
      ) : (
        <ol className="lastten-row">
          {rows.map((t, i) => (
            <li key={t.token}>
              <Link href={`/token/${t.token}`} className="lastten-card">
                <b className="lastten-rank">{i + 1}</b>
                <Artwork src={imageUrl(t.image)} symbol={t.symbol} size={40} rounded="rounded-lg" />
                <span className="lastten-id">
                  <strong>${t.symbol}</strong>
                  <small>paid in {pairSymbol(t.pair_token, t)} · {ago(t.launched_at)} ago</small>
                </span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
