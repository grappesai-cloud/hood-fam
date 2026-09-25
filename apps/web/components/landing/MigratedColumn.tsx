"use client";

import { useQuery } from "@tanstack/react-query";
import { api, type TokenRow } from "@/lib/api";
import { ago } from "@/lib/format";
import { isMissing } from "@/lib/bag";
import { Prov } from "@/components/Provenance";
import { BoostBadge } from "@/components/token/BoostBadge";
import { TokenLine } from "./TokenLine";

/// Column two: the coins that left the curve for the pool, by the day's volume, and above them the
/// coins that bought this hour on the board. Both queries sit under the "tokens" key on purpose:
/// lib/live.ts refreshes that family on every trade, graduation and bag event (a boost is a bag
/// event), so a migration or a boost lands here off the stream, and the timer carries a reader whose
/// stream never connected.

export function MigratedColumn({ className }: { className?: string }) {
  const graduated = useQuery({
    queryKey: ["tokens", "desk", "graduated"],
    queryFn: () => api<{ tokens: TokenRow[] }>("/tokens?status=graduated&sort=volume&limit=30"),
    refetchInterval: 30_000,
    retry: false,
  });
  const boosts = useQuery({
    queryKey: ["tokens", "desk", "boost"],
    queryFn: () => api<{ tokens: TokenRow[] }>("/tokens?sort=boost&limit=12"),
    refetchInterval: 30_000,
    retry: false,
  });

  const boosted = (boosts.data?.tokens ?? []).filter((t) => t.boosted);
  const pinned = new Set(boosted.map((t) => t.token.toLowerCase()));
  // A boosted coin that also migrated is one line, in the boosted group, not two.
  const migrated = (graduated.data?.tokens ?? []).filter((t) => !pinned.has(t.token.toLowerCase()));
  const reading = graduated.isPending && boosts.isPending;
  const failed = graduated.isError && boosts.isError;
  const missing = failed && isMissing(graduated.error);

  return (
    <section className={className ? `ox-desk-col ${className}` : "ox-desk-col"} aria-labelledby="desk-migrated-title">
      <header className="ox-desk-head">
        <div className="ox-desk-title">
          <span className="ox-desk-kicker">Migrated and boosted</span>
          <h2 id="desk-migrated-title">In the pool, on the board</h2>
        </div>
        <div className="ox-desk-figure">
          {graduated.data ? (
            <strong className="mono">
              {graduated.data.tokens.length.toLocaleString("en-US")} <span className="ox-desk-unit">in the pool</span>
              {boosted.length > 0 && <><span className="ox-desk-unit">·</span>{boosted.length} <span className="ox-desk-unit">boosted</span></>}
              {" "}<Prov kind="measured" />
            </strong>
          ) : (
            <strong className="mono"><span className="figure-dash" title={graduated.isPending ? "reading the pool" : missing ? "the API does not serve the board yet" : "the API is not answering"}>—</span></strong>
          )}
          <small>Boosted this hour first, then migrated by 24h volume. Cap in the pair, and in dollars when the pair is priced.</small>
        </div>
      </header>
      <div className="ox-desk-body">
        {reading ? (
          <div className="ox-desk-skeleton" aria-label="Reading the pool"><i /><i /><i /></div>
        ) : failed ? (
          <p className="ox-desk-empty">{missing ? "The board is not served by this API yet. The pool shows up once the indexer answers." : "The pool could not be read. The API is not answering."}</p>
        ) : boosted.length + migrated.length === 0 ? (
          <p className="ox-desk-empty">No coin has migrated yet. The first curve that fills moves to the pool and lands here, and a boost bought this hour sits above it.</p>
        ) : (
          <>
            {boosted.map((t) => (
              <TokenLine key={t.token} token={t} tag={<><BoostBadge className="ox-boost-tag" /><span className="ox-line-tag boost" title="a boost holds the slot until the top of the hour">until :00</span></>} />
            ))}
            {migrated.map((t) => (
              <TokenLine key={t.token} token={t} tag={<span className="ox-line-tag migrated" title={t.graduated_at ? new Date(t.graduated_at).toLocaleString() : "the indexer did not record when"}>migrated{t.graduated_at ? ` ${ago(t.graduated_at)} ago` : ""}</span>} />
            ))}
          </>
        )}
      </div>
    </section>
  );
}
