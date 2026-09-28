"use client";

import Link from "next/link";
import { assetOf, big, isMissing, usePot, type PotReason } from "@/lib/bag";
import { ago, fmt } from "@/lib/format";
import { Figure, Prov } from "@/components/Provenance";

/// What this launch's holders have been paid so far, by reason, from the pot's own deposits. The
/// total is the indexer's sum of HoldersPaid events, so it is measured; a launch with no pot gets
/// a dash and the reason, never a zero that looks like a payout that did not happen.
///
/// `pot` and `paidToHolders` come off the token row when the API carries them. Undefined means
/// the API predates pots, null means the launch has none, and the route decides the rest.

const REASONS: { key: PotReason; label: string }[] = [
  { key: "dividends", label: "creator's dividends leg" },
  { key: "payday", label: "payday slice" },
  { key: "slash", label: "creator slash" },
  { key: "lp_fees", label: "pool fees" },
];

export function HoldersPaid({ token, pot, paidToHolders, decimals, symbol }: {
  token: string;
  pot?: string | null;
  paidToHolders?: string | null;
  decimals: number;
  symbol: string;
}) {
  const query = usePot(pot === null ? null : token);
  const data = query.data;
  const unit = data ? assetOf(data.asset, data) : { symbol, decimals };
  const total = data ? big(data.totalDeposited) : paidToHolders != null ? big(paidToHolders) : null;

  const reason = pot === null
    ? "this launch has no pot: it was printed before the Bag went live"
    : query.isError
      ? isMissing(query.error) ? "the pot is not indexed on this deployment yet" : "the indexer did not answer"
      : query.isLoading && total == null ? "reading the pot" : undefined;

  const legs = data
    ? REASONS.map((r) => ({ ...r, amount: big(data.byReason?.[r.key]) })).filter((r) => r.amount > 0n)
    : [];

  return (
    <div className="holders-paid">
      <div className="holders-paid-head">
        <Figure
          label="paid to holders so far"
          value={total == null ? null : `${fmt(total, unit.decimals, 4)} ${unit.symbol}`}
          kind="measured"
          reason={reason}
        />
        {data && (
          <div className="holders-paid-pushes dim">
            {big(data.totalPaid) > 0n ? (
              <>
                <span className="mono">{fmt(big(data.totalPaid), unit.decimals, 4)} {unit.symbol}</span> already pushed to wallets
                {data.pushes?.count_24h > 0 && <>, {data.pushes.count_24h} pushes in the last day</>}
                {data.pushes?.last_ts && <>, the last one {ago(data.pushes.last_ts)} ago</>}.
              </>
            ) : total != null && total > 0n ? (
              <>Nothing has been pushed to wallets yet. The keeper pays every pot above the dust floor every five minutes.</>
            ) : (
              <>Nothing has been booked for holders yet. The creator's dividends leg, a Payday slice or a creator slash puts money here.</>
            )}
          </div>
        )}
      </div>
      {legs.length > 0 && (
        <ul className="holders-paid-legs" aria-label="Paid to holders, by reason">
          {legs.map((l) => (
            <li key={l.key}>
              <span>{l.label}</span>
              <b className="mono">{fmt(l.amount, unit.decimals, 4)} {unit.symbol}</b>
            </li>
          ))}
        </ul>
      )}
      {data && (
        <p className="holders-paid-link">
          <Prov kind="measured" />
          <span className="prov-sep">·</span>
          <Link href={`/bag?token=${token}&tab=pots`}>every deposit and every push, on the tape →</Link>
        </p>
      )}
    </div>
  );
}
