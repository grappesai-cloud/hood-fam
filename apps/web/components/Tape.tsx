"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { EXPLORER } from "@/lib/config";
import { useLive, type LiveTrade } from "@/lib/live";
import { ago, fmt, pairDecimals, pairSymbol, shortAddress } from "@/lib/format";

/// The tape: who bought, who sold, how much, how long ago.
///
/// It reads the same trades the page has always read, on the same key and the same timer, and the
/// stream is laid on top: a trade that arrives while somebody is watching is prepended and lit for
/// a moment, and the next read of the indexer confirms it rather than duplicating it. Nothing here
/// waits for the stream, so a tape with no stream behind it is the tape this page had before.

interface IndexedTrade {
  side: string;
  trader: string;
  pair_amount: string;
  token_amount: string;
  price: string;
  ts: string;
  tx: string;
}

interface Line {
  key: string;
  side: string;
  trader: string;
  token: bigint;
  pair: bigint;
  at: string;
  tx: string;
  /// It landed while this page was open, which is worth a second of light.
  arrived: boolean;
}

const KEEP = 40;

/// The indexer's read of the tape. The chat borrows it to tell whether the connected wallet has
/// ever traded this launch, which is one of the two things that earn the right to post.
export function useTrades(token: string) {
  return useQuery({
    queryKey: ["trades", token],
    queryFn: () => api<{ trades: IndexedTrade[] }>(`/tokens/${token}/trades?limit=40`),
    refetchInterval: 6000,
  });
}

/// An amount off the wire is a string somebody else wrote, and `BigInt("")` throws. A tape that
/// cannot render one line should not take the page down with it.
function big(value: string | undefined): bigint {
  try {
    return BigInt(value ?? "0");
  } catch {
    return 0n;
  }
}

/// One transaction can carry more than one fill, so the amount is part of what makes a line unique.
const lineKey = (tx: string, amount: string) => `${(tx ?? "").toLowerCase()}:${amount}`;

export function Tape({ token, symbol, pairToken }: { token: string; symbol: string; pairToken: string }) {
  const [arrived, setArrived] = useState<LiveTrade[]>([]);
  const trades = useTrades(token);

  const live = useLive({
    tokens: [token],
    onTrade: (trade) =>
      setArrived((seen) => {
        const key = lineKey(trade.tx, trade.tokenAmount);
        return [trade, ...seen.filter((t) => lineKey(t.tx, t.tokenAmount) !== key)].slice(0, KEEP);
      }),
  });

  const dec = pairDecimals(pairToken);
  const sym = pairSymbol(pairToken);

  const streamed: Line[] = arrived.map((t) => ({
    key: lineKey(t.tx, t.tokenAmount),
    side: t.side,
    trader: t.trader,
    token: big(t.tokenAmount),
    pair: big(t.pairAmount),
    at: t.at,
    tx: t.tx,
    arrived: true,
  }));
  const pushed = new Set(streamed.map((l) => l.key));
  // The two lists meet in the middle: everything the stream brought is newer than everything the
  // indexer has, and a trade in both is one line, keyed the same way, so it keeps its place and its
  // highlight is not played twice.
  const lines = [
    ...streamed,
    ...(trades.data?.trades ?? [])
      .map((t) => ({
        key: lineKey(t.tx, t.token_amount),
        side: t.side,
        trader: t.trader,
        token: big(t.token_amount),
        pair: big(t.pair_amount),
        at: t.ts,
        tx: t.tx,
        arrived: false,
      }))
      .filter((l) => !pushed.has(l.key)),
  ].slice(0, KEEP);

  // One transaction can carry two fills of exactly the same size, and React drops a row whose key
  // it has already seen. What the lines are matched on stays what it is; what they are drawn under
  // carries the occurrence behind it.
  const used = new Map<string, number>();
  const rows = lines.map((l) => {
    const seen = (used.get(l.key) ?? 0) + 1;
    used.set(l.key, seen);
    return { ...l, id: seen === 1 ? l.key : `${l.key}#${seen}` };
  });

  return (
    <section className="panel trade-tape p-4">
      <div className="tape-head">
        <h3>Tape</h3>
        {live && (
          <span className="tape-live">
            <i className="live-indicator" aria-hidden="true" /> live
          </span>
        )}
      </div>
      <div className="tape-lines">
        {rows.map((l) => (
          <a
            key={l.id}
            className={l.arrived ? "tape-line is-new" : "tape-line"}
            href={`${EXPLORER}/tx/${l.tx}`}
            target="_blank"
            rel="noreferrer"
          >
            <span className={l.side === "buy" ? "tape-side is-buy" : "tape-side is-sell"}>{l.side}</span>
            <span className="tape-who mono dim">{shortAddress(l.trader)}</span>
            <span className="tape-amount mono">
              {fmt(l.token)} {symbol}
            </span>
            <span className="tape-pair mono dim">
              {fmt(l.pair, dec, 4)} {sym}
            </span>
            <span className="tape-age dim">{ago(l.at)}</span>
          </a>
        ))}
        {!rows.length && <p className="dim">no trades yet</p>}
      </div>
    </section>
  );
}
