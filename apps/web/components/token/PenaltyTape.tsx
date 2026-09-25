"use client";

import { MoneyTape } from "@/components/MoneyTape";

/// The penalties this launch has collected, and what its pot did with them: one sentence per
/// line, who paid, how much, to how many holders, each with the transaction on it. It is the
/// money tape cut down to this launch and to the three kinds a holder cares about: a penalty
/// charged, money booked for the holders, money pushed to a wallet. The tape reads the indexer on
/// a timer and lights a line the moment the stream brings one.

const KINDS = ["penalty", "holders_paid", "pushed"];

export function PenaltyTape({ token }: { token: string }) {
  return (
    <section className="panel penalty-tape p-4">
      <div className="tape-head">
        <h3 className="font-semibold">Penalties</h3>
        <span className="mono dim text-xs">80% to holders, 20% to the Bag</span>
      </div>
      <MoneyTape
        token={token}
        kinds={KINDS}
        limit={30}
        pages={false}
        empty="Nobody has paid a penalty on this launch yet. A sniper, a jeet or a whale dump pays the holders the moment they do."
      />
    </section>
  );
}
