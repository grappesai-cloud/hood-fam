"use client";

import { useEffect, useState } from "react";

/// The furniture both launch machines are built out of. It exists because the two forms had the
/// same shape and neither of them said what it wanted: a stack of boxes with two word headings, no
/// order, no sense of how far along you were, and a button at the very bottom whose refusal to
/// light up was never explained. Everything here is about answering three questions on every
/// screen: what am I doing, what does this field decide, and what is stopping me finishing.

export interface StepState {
  n: number;
  label: string;
  done: boolean;
}

/// One numbered section. The number is the answer to "where am I", the purpose line under the title
/// is the answer to "why am I being asked this", and both are always visible rather than hidden
/// behind a tooltip.
export function Step({ n, title, purpose, done, children }: {
  n: number; title: string; purpose: string; done?: boolean; children: React.ReactNode;
}) {
  return (
    <section className="panel step" id={`step-${n}`} aria-labelledby={`step-${n}-title`}>
      <span className="lg-sheen" />
      <header className="step-head">
        <span className={done ? "step-n done" : "step-n"} aria-hidden="true">{done ? "✓" : n}</span>
        <div>
          <h2 id={`step-${n}-title`}>{title}</h2>
          <p>{purpose}</p>
        </div>
      </header>
      <div className="step-body">{children}</div>
    </section>
  );
}

/// A labelled input with room for the sentence that stops somebody guessing. `help` is what the
/// field decides; `error` is why what is in it will not do.
export function Field({ label, help, error, ok, children }: {
  label: string; help?: string; error?: string; ok?: string; children: React.ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {error ? <span className="field-note bad">{error}</span>
        : ok ? <span className="field-note good">{ok}</span>
        : help ? <span className="field-note">{help}</span> : null}
    </label>
  );
}

/// The pick-one-box control, used for the machine, the fee rule and the curve shape. A chosen card
/// is lit rather than merely outlined, because on a dark sheet a 1px colour change is not an answer
/// to "which one did I pick".
export function Choice({ selected, title, body, meta, onClick }: {
  selected: boolean; title: string; body: string; meta?: string; onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick} aria-pressed={selected} className={selected ? "choice spot on" : "choice spot"}>
      <span className="lg-sheen" />
      <span className="choice-head">
        <span className="choice-title">{title}</span>
        {meta && <span className="choice-meta">{meta}</span>}
      </span>
      <span className="choice-body">{body}</span>
      <span className="choice-mark" aria-hidden="true">{selected ? "✓" : ""}</span>
    </button>
  );
}

/// The rail. Not decoration: it is the only thing on the page that says how many steps there are,
/// which one you are in and what is still unfinished, and clicking a row takes you there.
export function Rail({ steps }: { steps: StepState[] }) {
  const [current, setCurrent] = useState(steps[0]?.n ?? 1);

  // The dependency is the shape of the list, not the array itself: `steps` is rebuilt on every
  // keystroke in the form, and depending on it directly tore the observer down and stood it back up
  // between every character, which left the rail stuck on step one.
  const shape = steps.map((s) => s.n).join(",");

  // Which step is "current" is decided by what is actually on screen rather than by a click, so the
  // rail keeps up with somebody who scrolls past it.
  useEffect(() => {
    const seen = new Map<number, boolean>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set(Number(e.target.id.replace("step-", "")), e.isIntersecting);
        const visible = [...seen.entries()].filter(([, v]) => v).map(([k]) => k).sort((a, b) => a - b);
        if (visible.length) setCurrent(visible[0]!);
      },
      { rootMargin: "-88px 0px -55% 0px" },
    );
    for (const n of shape.split(",")) {
      const el = document.getElementById(`step-${n}`);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, [shape]);

  const left = steps.filter((s) => !s.done).length;
  return (
    <nav className="rail" aria-label="Steps">
      <p className="rail-title">
        {left === 0 ? "everything is filled in" : `${left} of ${steps.length} left`}
      </p>
      <ol>
        {steps.map((s) => (
          <li key={s.n} className={`${s.done ? "done" : ""} ${current === s.n ? "current" : ""}`.trim()}>
            <a href={`#step-${s.n}`}>
              <span className="rail-n" aria-hidden="true">{s.done ? "✓" : s.n}</span>
              <span className="rail-label">{s.label}</span>
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

/// The action bar. It is fixed to the bottom of the window on purpose: the old form put the only
/// button 2,000 pixels down the page, so the cost of what you were building and the reason you
/// could not finish were both somewhere you were not looking.
export function LaunchBar({ cost, costLabel, blocked, busyLabel, label, onClick, busy, children }: {
  cost: string; costLabel: string; blocked?: string; label: string; busyLabel?: string;
  onClick: () => void; busy?: boolean; children?: React.ReactNode;
}) {
  return (
    <div className="launch-bar">
      <span className="lg-sheen" />
      <div className="launch-bar-cost">
        <strong className="mono">{cost}</strong>
        <span>{costLabel}</span>
      </div>
      {children}
      <div className="launch-bar-action">
        {blocked && !busy && <span className="launch-bar-why">{blocked}</span>}
        <button className="btn" disabled={Boolean(blocked) || busy} onClick={onClick}>
          {busy ? (busyLabel ?? "working") : label}
        </button>
      </div>
    </div>
  );
}

/// What the wallet is about to be asked for, in the order it happens. A launch is one irreversible
/// transaction and most people have never sent one; saying what it does is not hand holding.
export function WhatHappens({ items }: { items: string[] }) {
  return (
    <div className="what-happens">
      <p className="what-happens-title">when you confirm</p>
      <ol>{items.map((t) => <li key={t}>{t}</li>)}</ol>
    </div>
  );
}

/// Shared: both machines split a fee across destinations now, so both draw the same control.
export function Slider({ label, min, max, step, value, onChange, hint }: {
  label: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void; hint?: string;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input type="range" className="w-full accent-[var(--color-lime)]"
        min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      {hint && <span className="field-note">{hint}</span>}
    </label>
  );
}

/// What a launch trades against, when there are more than a handful.
///
/// Two currencies and eight shares fit on a page; forty assets do not, and a wall of cards is a
/// worse way to find NVDA than a box you can type into. So the ones most launches use stay as
/// cards, everything else lives behind a search, and whatever is currently chosen is always shown
/// as a card whether or not it is one of the usual ones.
export function PairChooser({ pairs, value, onPick }: {
  pairs: { address: string; symbol: string; decimals: number; share: boolean; usd: number }[];
  value: string;
  onPick: (address: `0x${string}`) => void;
}) {
  const [query, setQuery] = useState("");
  const chosen = pairs.find((p) => p.address.toLowerCase() === value.toLowerCase());
  const featured = pairs.slice(0, 6);
  const shown = chosen && !featured.some((p) => p.address === chosen.address) ? [...featured, chosen] : featured;
  const rest = pairs.filter((p) => !shown.some((s) => s.address === p.address));
  const matches = query.trim()
    ? rest.filter((p) => p.symbol.toLowerCase().includes(query.trim().toLowerCase()) || p.address.toLowerCase() === query.trim().toLowerCase())
    : [];

  const body = (p: { symbol: string; share: boolean }) =>
    p.symbol === "ETH" ? "The chain's own currency. No approval and no second transaction."
      : p.symbol === "USDG" ? "The dollar on this chain. A price that does not move underneath you."
      : p.share ? `A tokenised share. Buyers pay in ${p.symbol}, the raise is held in ${p.symbol}, and your share of the fee arrives in ${p.symbol}.`
      : `Buyers pay in ${p.symbol}, the raise is held in ${p.symbol}, and your share of the fee arrives in ${p.symbol}.`;

  return (
    <div className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-2">
        {shown.map((p) => (
          <Choice key={p.address} selected={p.address.toLowerCase() === value.toLowerCase()}
            onClick={() => onPick(p.address as `0x${string}`)}
            title={p.symbol} body={body(p)}
            meta={p.usd > 0 ? `$${p.usd.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : undefined} />
        ))}
        {pairs.length === 0 && <p className="text-xs dim">Reading what this deployment takes as a pair.</p>}
      </div>

      {rest.length > 0 && (
        <details className="pair-more">
          <summary>{rest.length} more, by ticker or address</summary>
          <input className="input mt-2" placeholder="NVDA, or 0x…" value={query}
            onChange={(e) => setQuery(e.target.value)} />
          <div className="mt-2 grid gap-1.5">
            {matches.slice(0, 12).map((p) => (
              <button key={p.address} type="button" className="pair-row" onClick={() => onPick(p.address as `0x${string}`)}>
                <span className="pair-row-symbol">{p.symbol}</span>
                <span className="pair-row-price mono">{p.usd > 0 ? `$${p.usd.toLocaleString(undefined, { maximumFractionDigits: 4 })}` : "no price"}</span>
              </button>
            ))}
            {query.trim() && matches.length === 0 && <p className="text-xs dim">Nothing by that name is allowed here.</p>}
          </div>
        </details>
      )}
    </div>
  );
}
