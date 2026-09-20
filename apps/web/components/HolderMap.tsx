"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { uniswapV4 } from "@hood/sdk";
import { api } from "@/lib/api";
import { addresses, directAddresses } from "@/lib/config";
import { shortAddress } from "@/lib/format";

/// Who holds it, as a picture.
///
/// A list of eight addresses and eight balances answers "who is at the top" and nothing else. The
/// question a reader actually has before they buy is whether the supply sits in one place, and a
/// shape answers that in a glance where a column of numbers does not.
///
/// The labelling is the point, not the decoration. On a launch still on its curve the biggest
/// circle by far is the curve itself, because the unsold supply lives there, and an unlabelled
/// eighty percent circle reads as a rug. Every address this app knows to be a piece of the machine
/// is named on the map and left out of the two wallet figures under it, so the number that says
/// "the largest wallet" is about a person.

interface Holder {
  address: string;
  balance: string;
}

interface Entry {
  address: string;
  balance: bigint;
  share: number;
  /// What this address is, when the app knows: the curve, the pool, the locker, the creator. Null
  /// is a wallet, which is the only kind of holder the figures below count.
  label: string | null;
  ours: boolean;
  creator: boolean;
}

/// The map is drawn to a fixed width in its own units and scaled to whatever the panel is wide, so
/// one layout serves a 360px phone and a 1440px desktop without a second set of numbers.
const WIDTH = 320;
const GAP = 7;
const MAX_R = 46;
/// A wallet with a rounding error of a balance still has to be a target a pointer can hit.
const MIN_R = 6;
/// Beyond this the circles are dust and the map is mush; the tail is a sentence instead.
const DRAW = 24;

const BURN = "0x000000000000000000000000000000000000dead";

function big(value: string | undefined): bigint {
  try {
    return BigInt(value ?? "0");
  } catch {
    return 0n;
  }
}

/// A share that is too small to round to a hundredth says so rather than printing 0%, which reads
/// as "holds nothing" when it means "holds a little".
function pct(share: number): string {
  if (!Number.isFinite(share) || share <= 0) return "0%";
  const value = share * 100;
  if (value >= 10) return `${value.toFixed(1)}%`;
  if (value >= 0.01) return `${value.toFixed(2)}%`;
  return "<0.01%";
}

export function HolderMap({
  token, symbol, creator, curve, locker, splitter, hook, totalSupply, holders,
}: {
  token: string;
  symbol: string;
  creator: string;
  curve: string;
  locker: string | null;
  splitter: string | null;
  hook: string | null;
  totalSupply: bigint;
  holders: number;
}) {
  const [active, setActive] = useState<string | null>(null);

  // The same key and the same route the token page already reads its top holders on, so the two
  // share one request and can never disagree with each other.
  const book = useQuery({
    queryKey: ["holders", token],
    queryFn: () => api<{ holders: Holder[] }>(`/tokens/${token}/holders`),
    refetchInterval: 30_000,
  });

  const known = useMemo(() => {
    const map = new Map<string, string>();
    const put = (address: string | null | undefined, label: string) => {
      const key = address?.toLowerCase();
      if (!key || key === "0x0000000000000000000000000000000000000000") return;
      if (!map.has(key)) map.set(key, label);
    };
    // The launch's own parts first: on a curve launch the curve holds everything unsold, and on a
    // direct one the locker holds the liquidity that can never come back out.
    put(curve, "the bonding curve");
    put(locker, "the locked liquidity");
    put(splitter, "the fee splitter");
    put(hook, "the launch hook");
    put(uniswapV4.poolManager, "the pool");
    put(uniswapV4.positionManager, "the pool's positions");
    put(addresses.staking, "staked here");
    put(addresses.feeRouter, "the fee router");
    put(addresses.graduator, "the graduator");
    put(addresses.factory, "the factory");
    put(directAddresses.portal, "the portal");
    put(directAddresses.deployer, "the deployer");
    put(directAddresses.buybackModule, "the buyback module");
    put(BURN, "burned");
    return map;
  }, [curve, locker, splitter, hook]);

  const entries = useMemo<Entry[]>(() => {
    const rows = book.data?.holders ?? [];
    const balances = rows.map((h) => ({ address: h.address.toLowerCase(), balance: big(h.balance) }));
    // The supply the shares are read against is the supply after burns, which is what the page's
    // market cap is read against too. A launch the indexer has no supply for falls back to what its
    // holders add up to, so the picture is still in proportion even if the caption is about a
    // smaller whole.
    const counted = balances.reduce((sum, b) => sum + b.balance, 0n);
    const whole = totalSupply > 0n ? totalSupply : counted;
    return balances
      .sort((a, b) => (a.balance === b.balance ? 0 : a.balance > b.balance ? -1 : 1))
      .map((b) => {
        const label = known.get(b.address) ?? null;
        const isCreator = b.address === creator.toLowerCase();
        return {
          address: b.address,
          balance: b.balance,
          // Parts per million in integer arithmetic: a balance is far past what a double holds
          // exactly, and dividing two of them as numbers is how a 4% holder becomes a 0% one.
          share: whole > 0n ? Number((b.balance * 1_000_000n) / whole) / 1_000_000 : 0,
          label: label ?? (isCreator ? "the creator" : null),
          ours: Boolean(label),
          creator: isCreator && !label,
        };
      });
  }, [book.data, known, creator, totalSupply]);

  // Circles are laid out largest first, wrapping into rows, and each row is centred on its own
  // tallest circle so a row of dust does not float at the top of the space a whale left.
  const laid = useMemo(() => {
    const drawn = entries.slice(0, DRAW);
    const top = drawn[0]?.share ?? 0;
    const rows: { entry: Entry; r: number; x: number }[][] = [];
    let row: { entry: Entry; r: number; x: number }[] = [];
    let x = 0;
    for (const entry of drawn) {
      const r = top > 0 ? Math.max(MIN_R, MAX_R * Math.sqrt(Math.max(0, entry.share) / top)) : MIN_R;
      if (row.length && x + 2 * r > WIDTH) {
        rows.push(row);
        row = [];
        x = 0;
      }
      row.push({ entry, r, x });
      x += 2 * r + GAP;
    }
    if (row.length) rows.push(row);

    const circles: { entry: Entry; r: number; cx: number; cy: number }[] = [];
    let y = 0;
    for (const line of rows) {
      const tallest = Math.max(...line.map((c) => c.r));
      for (const c of line) circles.push({ entry: c.entry, r: c.r, cx: c.x + c.r, cy: y + tallest });
      y += 2 * tallest + GAP;
    }
    return { circles, height: Math.max(1, y - GAP) };
  }, [entries]);

  const wallets = entries.filter((e) => !e.ours);
  const topTen = wallets.slice(0, 10).reduce((sum, e) => sum + e.share, 0);
  const largest = wallets[0]?.share ?? 0;
  const named = entries.filter((e) => e.label);
  const reading = active ? entries.find((e) => e.address === active) : undefined;

  return (
    <section className="panel holder-map p-4" aria-labelledby="holder-map-title">
      <div className="holder-map-head">
        <h3 id="holder-map-title">Who holds it</h3>
        <span className="holder-map-scale mono dim">largest first</span>
      </div>

      {book.isError && <p className="empty-inline">the holder list is not answering right now.</p>}
      {book.isLoading && <p className="empty-inline">reading the holders</p>}
      {!book.isLoading && !book.isError && entries.length === 0 && (
        <p className="empty-inline">nobody holds {symbol} yet.</p>
      )}

      {entries.length > 0 && (
        <>
          <svg
            className="holder-map-plot"
            viewBox={`0 0 ${WIDTH} ${laid.height}`}
            preserveAspectRatio="xMidYMin meet"
            role="group"
            aria-label={`Holders of ${symbol}, drawn in proportion, largest first`}
          >
            {laid.circles.map(({ entry, r, cx, cy }) => {
              const name = entry.label ?? shortAddress(entry.address);
              const classes = [
                "holder-dot",
                entry.ours ? "is-ours" : "",
                entry.creator ? "is-creator" : "",
                active === entry.address ? "is-on" : "",
              ].filter(Boolean).join(" ");
              return (
                <g
                  key={entry.address}
                  className={classes}
                  tabIndex={0}
                  role="img"
                  aria-label={`${name}, ${pct(entry.share)}`}
                  onMouseEnter={() => setActive(entry.address)}
                  onMouseLeave={() => setActive((held) => (held === entry.address ? null : held))}
                  onFocus={() => setActive(entry.address)}
                  onBlur={() => setActive((held) => (held === entry.address ? null : held))}
                  onClick={() => setActive(entry.address)}
                >
                  <title>{`${name}, ${pct(entry.share)}`}</title>
                  <circle cx={cx} cy={cy} r={r} />
                </g>
              );
            })}
          </svg>

          {/* The label the reader asked for by pointing at a circle. The slot is always here, so
              nothing under it moves when they do. */}
          <p className="holder-read">
            {reading ? (
              <>
                <b>{reading.label ?? shortAddress(reading.address)}</b>
                <span className="mono">{pct(reading.share)}</span>
                {reading.label && <span className="dim mono">{shortAddress(reading.address)}</span>}
              </>
            ) : (
              <span className="dim">point at a circle, or tab through them, to read one</span>
            )}
          </p>

          {named.length > 0 && (
            <ul className="holder-legend">
              {named.map((e) => (
                <li key={e.address} className={e.creator ? "is-creator" : "is-ours"}>
                  <b>{e.label}</b> <span className="mono">{pct(e.share)}</span>
                </li>
              ))}
            </ul>
          )}

          <div className="holder-facts">
            <div className="fact">
              <strong>{pct(topTen)}</strong>
              <span>the top ten wallets hold</span>
            </div>
            <div className="fact">
              <strong>{pct(largest)}</strong>
              <span>the largest wallet holds</span>
            </div>
            <div className="fact">
              <strong>{holders.toLocaleString("en-US")}</strong>
              <span>holders</span>
            </div>
          </div>

          <p className="holder-note">
            Every share is of the supply. The circles our own contracts hold are named above and left
            out of the two wallet figures, because the curve, the pool and the locker are the machine
            rather than anybody's position.
            {entries.length > DRAW && ` ${entries.length - DRAW} smaller holders are counted but not drawn.`}
          </p>
        </>
      )}
    </section>
  );
}
