"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type TokenRow } from "@/lib/api";
import { useLive } from "@/lib/live";
import { ago, compact, launchProgress, machineLabel, pairDecimals, pairSymbol, shortAddress } from "@/lib/format";
import { brand } from "@/brands";
import { GraduationRace } from "@/components/GraduationRace";

/// The front of 0x.fam: no hero, no artwork, no card. A launch is a row, and the page is the list
/// of rows, because everything a reader of addresses wants to compare is a number and numbers only
/// compare when they are stacked in a column.
///
/// The queries are the ones the default board runs, keyed the same way, so this front shares its
/// cache with the rest of the app instead of doubling the load on the indexer.

const SORTS = [
  { key: "new", label: "new", query: "sort=new" },
  { key: "volume", label: "volume", query: "sort=volume" },
  { key: "graduating", label: "graduating", query: "sort=progress&status=graduating" },
  { key: "graduated", label: "graduated", query: "sort=graduated&status=graduated" },
] as const;

type SortKey = (typeof SORTS)[number]["key"];

export function Explore() {
  const [sort, setSort] = useState<SortKey>("new");
  const [q, setQ] = useState("");
  const query = SORTS.find((s) => s.key === sort)?.query ?? "sort=new";

  // A launch or a trade anywhere on the chain changes what this board is showing, so the board
  // is told rather than asked: the stream refreshes these same queries, and the timers stay as the
  // fallback for a reader whose stream never connected.
  useLive();

  const stats = useQuery({
    queryKey: ["stats"],
    queryFn: () => api<{ launches: string; graduated: string; volume_24h: string; trades: string; traders: string }>("/stats"),
  });
  const tokens = useQuery({
    queryKey: ["tokens", sort, q],
    queryFn: () => api<{ tokens: TokenRow[] }>(`/tokens?${query}&limit=60${q ? `&q=${encodeURIComponent(q)}` : ""}`),
  });

  // Slash is the filter key on every terminal and every trading screen, so it is the filter key
  // here. Guarded against firing while the reader is already typing somewhere.
  const filter = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
      e.preventDefault();
      filter.current?.focus();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  const rows = tokens.data?.tokens ?? [];

  return (
    <div className="ox-board">
      {/* The race to the pool is the loop this place runs on, so it sits where a reader lands. */}
      <GraduationRace />
      <div className="ox-head">
        <h1>launches</h1>
        <p>every token printed on this chain, one line each, in the order the index reports them.</p>
      </div>

      <dl className="ox-stats" aria-label="Platform activity">
        <Stat label="launches" value={stats.data?.launches ?? "--"} />
        <Stat label="graduated" value={stats.data?.graduated ?? "--"} />
        <Stat label="vol 24h" value={stats.data ? compact(BigInt(stats.data.volume_24h || "0")) : "--"} />
        <Stat label="traders" value={stats.data?.traders ?? "--"} />
      </dl>

      <div className="ox-cmd">
        <div className="ox-cmd-field">
          <span aria-hidden="true">&gt;</span>
          <input
            ref={filter}
            aria-label="Filter launches by name, ticker or address"
            placeholder="filter by name, ticker or address"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              // Escape is the way out of a filter on a keyboard-first screen: it clears first, and
              // gives the page back its slash key on the second press.
              if (e.key !== "Escape") return;
              if (q) setQ("");
              else e.currentTarget.blur();
            }}
          />
          <kbd aria-hidden="true">/</kbd>
        </div>
        <Link className="btn ox-deploy" href="/launch">{brand.copy.create}</Link>
      </div>

      <div className="ox-toolbar">
        <div className="ox-tabs" role="tablist" aria-label="Sort launches">
          {SORTS.map((s) => (
            <button
              key={s.key}
              role="tab"
              type="button"
              aria-selected={sort === s.key}
              className="ox-tab"
              onClick={() => setSort(s.key)}
            >
              {s.label}
            </button>
          ))}
        </div>
        <span className="ox-count">{tokens.data ? `${rows.length} rows` : "reading index"}</span>
      </div>

      {tokens.isError ? (
        <Void
          head="feed down"
          body="The indexer is not answering, so there is nothing to print. Nothing on chain has changed and no position moved."
        />
      ) : tokens.isLoading ? (
        <Table busy>
          {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => (
            <tr className="ox-skel" key={i}>
              {COLUMNS.map((c) => <td key={c.label} className={c.cls}><span /></td>)}
            </tr>
          ))}
        </Table>
      ) : rows.length ? (
        <Table>{rows.map((t, i) => <Row key={t.token} t={t} n={i + 1} />)}</Table>
      ) : q ? (
        <Void head="0 rows" body={`Nothing in the index matches "${q}". Tickers are short; try fewer characters, or paste the address.`} />
      ) : (
        <Void
          head="0 rows"
          body="This sort is empty. The first token that lands in a block shows up on this line."
          action={<Link className="btn" href="/launch">{brand.copy.create}</Link>}
        />
      )}

      <p className="ox-keys">
        <kbd>/</kbd> filter <span aria-hidden="true">//</span> <kbd>esc</kbd> clear <span aria-hidden="true">//</span>
        {" "}<kbd>tab</kbd> walk the rows
      </p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/// The columns are declared once and the header, the rows and the loading skeleton all read from
/// the same list, so a column that drops out on a narrow window drops out of all three together
/// rather than leaving the skeleton one cell wider than the table it is standing in for.
const COLUMNS = [
  { label: "#", cls: "ox-c-n" },
  { label: "ticker", cls: "" },
  { label: "name", cls: "ox-c-name" },
  { label: "mcap", cls: "ox-c-num" },
  { label: "vol 24h", cls: "ox-c-num ox-c-vol" },
  { label: "progress", cls: "ox-c-prog" },
  { label: "age", cls: "ox-c-num" },
  { label: "machine", cls: "ox-c-machine" },
  { label: "address", cls: "ox-c-addr" },
] as const;

function Table({ children, busy }: { children: React.ReactNode; busy?: boolean }) {
  return (
    <div className="ox-tablewrap">
      <table className="ox-table" aria-busy={busy || undefined}>
        <thead>
          <tr>
            {COLUMNS.map((c) => <th scope="col" key={c.label} className={c.cls || undefined}>{c.label}</th>)}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function Row({ t, n }: { t: TokenRow; n: number }) {
  const decimals = pairDecimals(t.pair_token);
  const unit = pairSymbol(t.pair_token);
  // The same arithmetic the card and the tape use. Two places on one screen quoting different caps
  // for one token is worse than quoting none.
  const mcap = (BigInt(t.price || "0") * BigInt(t.total_supply || "0")) / 10n ** 18n;
  // A launch with nowhere left to go reads full, so a graduated token is not drawn as a stalled one.
  const done = t.status === "graduated" || (t.mode === "direct" && t.bonded);
  const progress = done ? 1 : launchProgress(t);
  const pct = Math.round(progress * 100);
  const engine = t.mode === "direct" ? "pool" : "curve";
  const state = machineLabel(t).replace("on the ", "").replace(/\s+/g, "-");

  return (
    <tr className={done ? "ox-row done" : "ox-row"}>
      <td className="ox-c-n">{n}</td>
      <td>
        {/* The link is one cell wide but its overlay covers the row, so the whole line is a target
            for a pointer while the keyboard still lands on a single named link per launch. */}
        <Link className="ox-rowlink" href={`/token/${t.token}`}>{t.symbol}</Link>
      </td>
      <td className="ox-c-name ox-name">{t.name}</td>
      <td className="ox-c-num">{compact(mcap, decimals)}<small> {unit}</small></td>
      <td className="ox-c-num ox-c-vol">{compact(BigInt(t.volume_24h || "0"), decimals)}<small> {unit}</small></td>
      <td className="ox-c-prog">
        <span className="ox-bar" aria-hidden="true">
          <span className="on">{"▓".repeat(cells(progress))}</span>
          <span className="off">{"░".repeat(10 - cells(progress))}</span>
        </span>
        <span className="ox-pct">{pct}%</span>
      </td>
      <td className="ox-c-num ox-age">{ago(t.launched_at)}</td>
      <td className="ox-c-machine">
        {engine}
        {state !== engine ? <span className="ox-state"> {state}</span> : null}
      </td>
      <td className="ox-c-addr ox-addr">{shortAddress(t.token)}</td>
    </tr>
  );
}

/// Ten cells, so the bar reads as tenths and every row's bar is the same width in a monospace
/// column. Anything above zero keeps at least one filled cell, because a launch that has taken
/// money should not be drawn as empty.
function cells(progress: number) {
  const p = Math.max(0, Math.min(1, progress));
  if (p === 0) return 0;
  return Math.min(10, Math.max(1, Math.round(p * 10)));
}

function Void({ head, body, action }: { head: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="ox-void" role="status">
      <p className="ox-void-head">{head}</p>
      <p>{body}</p>
      {action}
    </div>
  );
}
