"use client";

import { MoneyTape } from "@/components/MoneyTape";

/// Who paid this launch's opening tax, and what its pot paid its holders: one sentence per line,
/// each with the transaction on it. It is the money tape cut down to this launch and to the three
/// kinds a holder cares about: a sniper paying the opening tax (trading fee, split like the rest),
/// money booked for the holders, money pushed to a wallet. The tape reads the indexer on a timer
/// and lights a line the moment the stream brings one.

const KINDS = ["sniped", "holders_paid", "pushed"];

export function PenaltyTape({ token }: { token: string }) {
  return (
    <section className="panel penalty-tape p-4">
      <div className="tape-head">
        <h3 className="font-semibold">Snipers and payouts</h3>
        <span className="mono dim text-xs">opening tax: 70% to the creator&apos;s split, 30% to the Bag</span>
      </div>
      <MoneyTape
        token={token}
        kinds={KINDS}
        limit={30}
        pages={false}
        empty="Nobody has paid the opening tax on this launch yet. A bot that buys in its first three seconds pays up to 99%."
      />
    </section>
  );
}
