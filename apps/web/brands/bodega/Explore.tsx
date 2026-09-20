"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type TokenRow } from "@/lib/api";
import { useLive } from "@/lib/live";
import { Artwork } from "@/components/Artwork";
import { ago, compact, imageUrl, launchProgress, pairDecimals, pairSymbol } from "@/lib/format";

/// The shelves, worded as a customer would ask for them. The queries underneath are the ones the
/// default board sends, so the shop is the same market seen from the other side of the counter.
const SHELVES = [
  { key: "new", label: "just arrived", query: "sort=new" },
  { key: "busy", label: "busy today", query: "sort=volume" },
  { key: "nearly", label: "nearly in the pool", query: "sort=progress&status=graduating" },
  { key: "pool", label: "in the pool", query: "sort=graduated&status=graduated" },
] as const;

type ShelfKey = (typeof SHELVES)[number]["key"];

/// Bodega's front page: a shelf, not a board.
///
/// One launch to a row, read left to right the way a price label is read: the picture, the name,
/// and then a sentence saying where the thing has got to. No gauge, no percentage bar, no tape.
/// Everything a chart would have shown is spelled out, because the reader this page is for would
/// have to be taught the chart first, and there is no reason to make them learn one to buy a coin.
export function Explore() {
  const [shelf, setShelf] = useState<ShelfKey>("new");
  const [q, setQ] = useState("");
  const query = SHELVES.find((s) => s.key === shelf)?.query ?? "sort=new";

  // A launch or a trade anywhere on the chain changes what this board is showing, so the board
  // is told rather than asked: the stream refreshes these same queries, and the timers stay as the
  // fallback for a reader whose stream never connected.
  useLive();

  const stats = useQuery({
    queryKey: ["stats"],
    queryFn: () =>
      api<{ launches: string; graduated: string; volume_24h: string; trades: string; traders: string }>("/stats"),
  });
  const tokens = useQuery({
    queryKey: ["tokens", shelf, q],
    queryFn: () =>
      api<{ tokens: TokenRow[] }>(`/tokens?${query}&limit=60${q ? `&q=${encodeURIComponent(q)}` : ""}`),
  });

  const rows = tokens.data?.tokens ?? [];

  return (
    <div className="bd-explore">
      <section className="bd-lede">
        <h1>What is on the shelf</h1>
        <p>
          This is a shop, not a trading screen. Every coin below was opened by somebody on Robinhood
          Chain, and each one comes with a sentence saying where it has got to, so you can see what
          it is without reading a chart.
        </p>
        {stats.data && (
          <p className="bd-lede-count">
            {stats.data.launches} coins have been opened here so far, and {stats.data.graduated} of
            them have made it into a pool of their own.
          </p>
        )}
      </section>

      <section className="bd-controls" aria-label="Find a coin">
        <label className="bd-search">
          <span className="bd-search-label">Search</span>
          <input
            aria-label="Search by name or ticker"
            placeholder="a name, or a ticker"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
        <div className="bd-filters" role="group" aria-label="Which shelf">
          {SHELVES.map((s) => (
            <button
              key={s.key}
              type="button"
              className="bd-filter"
              aria-pressed={shelf === s.key}
              onClick={() => setShelf(s.key)}
            >
              {s.label}
            </button>
          ))}
        </div>
      </section>

      {tokens.isError ? (
        <Note
          title="The list is not coming through"
          body="Our reader of the chain is not answering just now. Nothing on the chain has changed because of it, and the shelf fills back in on its own the moment the connection is back."
        />
      ) : tokens.isLoading ? (
        <ul className="bd-shelf" aria-label="Looking along the shelf">
          {[0, 1, 2, 3, 4].map((i) => (
            <li key={i} className="bd-row-wait">
              <span className="bd-wait-art" />
              <span className="bd-wait-text">
                <span />
                <span />
              </span>
            </li>
          ))}
        </ul>
      ) : rows.length ? (
        <>
          <p className="bd-shelf-count">
            {rows.length === 1 ? "One coin on this shelf." : `${rows.length} coins on this shelf.`}
          </p>
          <ul className="bd-shelf">
            {rows.map((t) => (
              <li key={t.token}>
                <Link className="bd-row" href={`/token/${t.token}`}>
                  <span className="bd-row-art">
                    <Artwork src={imageUrl(t.image)} symbol={t.symbol} size={72} rounded="" />
                  </span>
                  <span className="bd-row-text">
                    <span className="bd-row-name">
                      {t.name} <span className="bd-row-ticker">{t.symbol}</span>
                    </span>
                    <span className="bd-row-say">{placeSentence(t)}</span>
                    <span className="bd-row-worth">{worthSentence(t)}</span>
                    <span className="bd-row-go">look at it</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      ) : q ? (
        <Note
          title="Nothing by that name"
          body="No coin in the shop is called that. A shorter word finds more, and the ticker works as well as the name."
        />
      ) : (
        <Note
          title="This shelf is empty"
          body="Nothing here yet. The first coin anybody opens turns up on this shelf as soon as the block lands, and it is yours to open if you want it."
          action={
            <Link className="bd-note-action" href="/launch">
              open the first one
            </Link>
          }
        />
      )}
    </div>
  );
}

/// What the page says when it has nothing to show. A sentence and a way out, set like the rest of
/// the page: no illustration, because an empty shelf is not an event.
function Note({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="bd-note">
      <h2>{title}</h2>
      <p>{body}</p>
      {action}
    </div>
  );
}

/// Where a launch has got to, in one sentence a stranger can read.
///
/// The same three facts a card would have drawn as a badge, a bar and a timestamp: which side of
/// the pool it is on, how far along it is if it is still on the curve, and how long it has been
/// here. Said, rather than plotted.
function placeSentence(t: TokenRow): string {
  const opened = `Opened ${plainAge(ago(t.launched_at))} ago.`;
  if (t.status === "graduated") return `Already in the pool, trading freely. ${opened}`;
  if (t.status === "sold_out") return `Sold out on the curve and waiting on its pool. ${opened}`;
  if (t.trades_total === 0) return `Brand new, nobody has bought any yet. ${opened}`;
  const pct = Math.round(launchProgress(t) * 100);
  if (pct >= 90) return `Nearly there, ${pct}% of the way to its pool. ${opened}`;
  if (pct === 0) return `Just started on its way to the pool. ${opened}`;
  return `${pct}% of the way to its pool. ${opened}`;
}

/// `ago` answers a trading screen, in letters: 12m, 5h, 3d. Here the same fact is spelled out, so
/// there is nothing to decode before the sentence makes sense.
function plainAge(short: string): string {
  const n = short.slice(0, -1);
  const unit = short.slice(-1);
  const word = unit === "s" ? "second" : unit === "m" ? "minute" : unit === "h" ? "hour" : "day";
  return `${n} ${word}${n === "1" ? "" : "s"}`;
}

/// What the whole thing is worth, in words where words carry it. "About two million" is a size a
/// person already knows; "1.98M" is a reading taken off an instrument, and this front is for the
/// people who would rather not be handed the instrument.
function worthSentence(t: TokenRow): string {
  const decimals = pairDecimals(t.pair_token);
  // The same sum the cards do, worked the same way, so no two places in this app ever quote one
  // launch at two different sizes.
  const mcap = (BigInt(t.price || "0") * BigInt(t.total_supply || "0")) / 10n ** 18n;
  if (mcap === 0n) return "Nobody has paid anything for it yet.";
  const words = inWords(Number(mcap) / 10 ** decimals);
  const figure = words ?? compact(mcap, decimals);
  return `Worth about ${figure} ${pairSymbol(t.pair_token)} altogether.`;
}

const SMALL = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
const UNITS = ["thousand", "million", "billion"];

/// A size in words, or nothing when the number is too small or too odd to have one.
function inWords(n: number): string | null {
  if (!Number.isFinite(n) || n < 1000) return null;
  let value = n;
  let unit = -1;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit++;
  }
  let rounded = Math.round(value * 10) / 10;
  // Rounding can carry: 999,900 is 999.9 thousand before it and a round million after it.
  if (rounded >= 1000 && unit < UNITS.length - 1) {
    rounded = Math.round((rounded / 1000) * 10) / 10;
    unit++;
  }
  const count = Number.isInteger(rounded) && rounded <= 12 ? SMALL[rounded] : String(rounded);
  return `${count} ${UNITS[unit]}`;
}
