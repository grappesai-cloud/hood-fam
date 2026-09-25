"use client";

import { useEffect, useState } from "react";
import { PENALTY_CAPS, type PenaltyForm } from "@/lib/launchAbi";

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

export function WizardProgress({ labels, current }: { labels: readonly string[]; current: number }) {
  // The stylesheet was written for four steps; five would wrap. The count decides the columns.
  return <nav className="wizard-progress" aria-label="Launch progress" style={{ gridTemplateColumns: `repeat(${labels.length}, minmax(0, 1fr))` }}>
    {labels.map((label, index) => <div key={label} className={index === current ? "current" : index < current ? "complete" : ""}
      aria-current={index === current ? "step" : undefined}>
      <span>{index < current ? "✓" : index + 1}</span>{label}
    </div>)}
  </nav>;
}

export function WizardNav({ current, count, onBack, onNext, nextBlocked, cost }: {
  current: number; count: number; onBack: () => void; onNext: () => void; nextBlocked?: string; cost: string;
}) {
  return <div className="launch-bar wizard-nav">
    <div className="launch-bar-cost"><strong className="mono">{cost}</strong><span>launch fee, plus gas</span></div>
    <div className="launch-bar-action">
      {current > 0 && <button type="button" className="btn btn-ghost" onClick={onBack}>Back</button>}
      {nextBlocked && <span className="launch-bar-why" role="status">{nextBlocked}</span>}
      <button type="button" className="btn" disabled={Boolean(nextBlocked)} onClick={onNext}>
        Continue to {current + 1 === count - 1 ? "review" : "next step"} →
      </button>
    </div>
  </div>;
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

/// A last, plain-language receipt before irreversible launch parameters reach the wallet.
/// The parent owns `reviewed` so any change to the terms can invalidate an earlier acknowledgement.
export function LaunchReview({ rows, reviewed, onReviewed, note }: {
  rows: { label: string; value: string }[];
  reviewed: boolean;
  onReviewed: (reviewed: boolean) => void;
  note?: string;
}) {
  return (
    <div className="launch-review">
      <dl className="launch-review-rows">
        {rows.map((row) => (
          <div key={row.label}>
            <dt>{row.label}</dt><dd>{row.value}</dd>
          </div>
        ))}
      </dl>
      {note && <p className="launch-review-note">{note}</p>}
      <label className="launch-review-ack">
        <input type="checkbox" checked={reviewed} onChange={(event) => onReviewed(event.target.checked)} />
        <span>I reviewed these terms. Fees and launch rules cannot be changed after the transaction.</span>
      </label>
    </div>
  );
}

/// Shows a concrete trade rather than asking users to infer outcomes from percentages.
export function LaunchFeeExample({ title, description, rows, note }: {
  title: string;
  description: string;
  rows: { label: string; value: string }[];
  note: string;
}) {
  return (
    <div className="launch-fee-example">
      <span className="launch-fee-example-kicker">Example, not a forecast</span>
      <strong>{title}</strong>
      <p>{description}</p>
      <dl>{rows.map((row) => <div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl>
      <small>{note}</small>
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
export function PairChooser({ pairs, value, onPick, loading, error, compact = false }: {
  pairs: { address: string; symbol: string; name?: string | null; decimals: number; share: boolean; usd: number; usdReason?: string | null }[];
  value: string;
  onPick: (address: `0x${string}`) => void;
  loading?: boolean;
  error?: boolean;
  compact?: boolean;
}) {
  const [query, setQuery] = useState("");
  const chosen = pairs.find((p) => p.address.toLowerCase() === value.toLowerCase());
  const featured = pairs.slice(0, 6);
  const shown = chosen && !featured.some((p) => p.address === chosen.address) ? [...featured, chosen] : featured;
  const rest = pairs.filter((p) => !shown.some((s) => s.address === p.address));
  // A ticker is not how most people know a company. Somebody after a share of Boeing types
  // "boeing", not "BA", so the company's own name is searched alongside the ticker.
  const needle = query.trim().toLowerCase();
  const matches = needle
    ? rest.filter((p) =>
      p.symbol.toLowerCase().includes(needle)
      || (p.name ?? "").toLowerCase().includes(needle)
      || p.address.toLowerCase() === needle)
    : [];
  const restShares = rest.filter((p) => p.share).length;

  const body = (p: { symbol: string; name?: string | null; share: boolean }) =>
    p.symbol === "ETH" ? "The chain's own currency. No approval and no second transaction."
      : p.symbol === "USDG" ? "The dollar on this chain. A price that does not move underneath you."
      : p.share ? `${p.name ?? p.symbol}, tokenised. Buyers pay in ${p.symbol}, the raise is held in ${p.symbol}, and your share of the fee arrives in ${p.symbol}.`
      : `Buyers pay in ${p.symbol}, the raise is held in ${p.symbol}, and your share of the fee arrives in ${p.symbol}.`;

  return (
    <div className={compact ? "pair-compact space-y-2" : "space-y-2"}>
      <div className={compact ? "grid grid-cols-2 gap-2 sm:grid-cols-3" : "grid gap-2 sm:grid-cols-2"}>
        {shown.map((p) => (
          <Choice key={p.address} selected={p.address.toLowerCase() === value.toLowerCase()}
            onClick={() => onPick(p.address as `0x${string}`)}
            title={p.symbol} body={compact ? "" : body(p)}
            meta={p.usd > 0 ? `$${p.usd.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : undefined} />
        ))}
        {pairs.length === 0 && <p className="text-xs dim">{error ? "Pair list unavailable. Check the API connection and refresh." : loading ? "Reading supported pairs…" : "No supported pairs are listed for this deployment."}</p>}
      </div>
      {compact && chosen && <p className="field-note">{body(chosen)}</p>}

      {rest.length > 0 && (
        <details className="pair-more">
          <summary>
            {restShares > 0
              ? `${rest.length} more, ${restShares} of them shares, by ticker, company or address`
              : `${rest.length} more, by ticker or address`}
          </summary>
          <input className="input mt-2" placeholder="NVDA, Nvidia, or 0x…" value={query}
            onChange={(e) => setQuery(e.target.value)} />
          <div className="mt-2 grid gap-1.5">
            {matches.slice(0, 12).map((p) => (
              <button key={p.address} type="button" className="pair-row"
                onClick={() => { setQuery(""); onPick(p.address as `0x${string}`); }}>
                <span className="pair-row-symbol">{p.symbol}</span>
                {/* Always rendered, even empty: the row is a three column grid, and a missing
                    middle cell would slide every price left on that row alone. */}
                <span className="pair-row-name">{p.name ?? ""}</span>
                <span className="pair-row-price mono">{p.usd > 0 ? `$${p.usd.toLocaleString(undefined, { maximumFractionDigits: 4 })}` : `— ${p.usdReason ?? "no price"}`}</span>
              </button>
            ))}
            {needle && matches.length > 12 && (
              <p className="text-xs dim">{matches.length - 12} more match. Narrow it down.</p>
            )}
            {query.trim() && matches.length === 0 && <p className="text-xs dim">Nothing by that name is allowed here.</p>}
          </div>
        </details>
      )}
    </div>
  );
}

/// An on/off switch that says which it is without a colour being the only clue: the knob sits on
/// the right when it is on, and the control is a real switch for a screen reader.
export function Toggle({ on, onChange, label, disabled }: {
  on: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean;
}) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled}
      className={on ? "toggle on" : "toggle"} onClick={() => onChange(!on)}>
      <span className="toggle-knob" aria-hidden="true" />
      <span className="toggle-word" aria-hidden="true">{on ? "on" : "off"}</span>
    </button>
  );
}

/// One mechanic of the toolbox. The title names it, the body is one sentence saying what it does
/// and who pays, the switch turns it on, and the children are the numbers it takes once it is on.
/// A `fixed` card has no switch: it is a fact about every launch, shown so the creator knows it.
export function OptionCard({ title, body, on, fixed, tag, onToggle, children }: {
  title: string; body: string; on: boolean; fixed?: boolean; tag?: string;
  onToggle?: (on: boolean) => void; children?: React.ReactNode;
}) {
  return (
    <div className={`option-card${on ? " on" : ""}${fixed ? " fixed" : ""}`}>
      <div className="option-card-head">
        <div className="option-card-text">
          <span className="option-card-title">{title}{tag && <span className="option-card-tag">{tag}</span>}</span>
          <p className="option-card-body">{body}</p>
        </div>
        {fixed ? <span className="option-card-fixed">always on</span> : <Toggle on={on} onChange={(v) => onToggle?.(v)} label={title} />}
      </div>
      {on && children ? <div className="option-card-controls">{children}</div> : null}
    </div>
  );
}

/// The creator's penalty options, the same six cards on both machines. The snipe tax is the one
/// with a home elsewhere (it is a field of the direct machine's own config), so the direct form
/// passes it in and the curve form leaves it out. The three defaults that cannot be turned off are
/// listed as facts under the cards, because a buyer reads them on the token page and the creator
/// should not learn them there first.
export function PenaltyOptions({ value, onChange, snipe, postGraduation }: {
  value: PenaltyForm;
  onChange: (next: PenaltyForm) => void;
  snipe?: { pct: number; seconds: number; maxPct: number; onChange: (pct: number, seconds: number) => void; error?: string };
  postGraduation?: boolean;
}) {
  const set = <K extends keyof PenaltyForm>(k: K, v: PenaltyForm[K]) => onChange({ ...value, [k]: v });
  const to = value.lockersEat ? "the Vault's lockers" : "the holders";
  const when = postGraduation ? " after graduation" : "";
  return (
    <div className="option-stack">
      {snipe && (
        <OptionCard title="Snipe tax" tag="on by default" on={snipe.pct > 0}
          body={`A buyer in the first ${snipe.seconds || 3} seconds pays up to ${snipe.pct}% extra, falling to nothing by the end. The holders get it.`}
          onToggle={(on) => snipe.onChange(on ? snipe.maxPct : 0, on ? (snipe.seconds || 3) : 0)}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Slider label={`Extra tax at the open ${snipe.pct}%`} hint={`Added to the buy tax at second zero. The hook allows at most ${snipe.maxPct}% on top of your buy tax.`}
              min={1} max={snipe.maxPct} step={1} value={Math.min(snipe.pct, snipe.maxPct)} onChange={(v) => snipe.onChange(v, snipe.seconds || 3)} />
            <Slider label={`Gone after ${snipe.seconds}s`} hint="It falls away by the square, so most of it is gone before a person has read the ticker."
              min={1} max={30} step={1} value={Math.max(1, snipe.seconds)} onChange={(v) => snipe.onChange(snipe.pct, v)} />
          </div>
          {snipe.error && <p className="field-note bad">{snipe.error}</p>}
        </OptionCard>
      )}

      <OptionCard title="Jeet tax" on={value.jeetOn} onToggle={(on) => set("jeetOn", on)}
        body={`A seller who flips within ${value.jeetMinutes} minutes of buying pays ${value.jeetPct}% to ${to}${when}.`}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Slider label={`Tax ${value.jeetPct}%`} hint={`1 to ${PENALTY_CAPS.jeetTaxBps / 100}% of the sell.`} min={1} max={PENALTY_CAPS.jeetTaxBps / 100} step={1} value={value.jeetPct} onChange={(v) => set("jeetPct", v)} />
          <Slider label={`Window ${value.jeetMinutes} min`} hint="How long after a buy a sell still counts as a flip. 1 to 60 minutes." min={1} max={PENALTY_CAPS.jeetWindowSeconds / 60} step={1} value={value.jeetMinutes} onChange={(v) => set("jeetMinutes", v)} />
        </div>
      </OptionCard>

      <OptionCard title="Whale dump tax" on={value.whaleOn} onToggle={(on) => set("whaleOn", on)}
        body={`A sell that moves the pool more than ${value.whaleTicks} ticks pays ${value.whalePct}% to ${to}${when}.`}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Slider label={`Tax ${value.whalePct}%`} hint={`1 to ${PENALTY_CAPS.whaleTaxBps / 100}% of the sell.`} min={1} max={PENALTY_CAPS.whaleTaxBps / 100} step={1} value={value.whalePct} onChange={(v) => set("whalePct", v)} />
          <Slider label={`Tick limit ${value.whaleTicks}`} hint={`A tick is a hundredth of a percent of price. 300 ticks is about a 3% move. At most ${PENALTY_CAPS.whaleTickLimit}.`} min={10} max={PENALTY_CAPS.whaleTickLimit} step={10} value={value.whaleTicks} onChange={(v) => set("whaleTicks", v)} />
        </div>
      </OptionCard>

      <OptionCard title="King of the hill" on={value.kingOn} onToggle={(on) => set("kingOn", on)}
        body={`${value.kingPct}% of every sell tax fills a pot. Every buy resets a 60 second timer; when it runs out, the last buyer takes the pot.`}>
        <Slider label={`Slice ${value.kingPct}%`} hint={`5 to ${PENALTY_CAPS.kingBps / 100}% of the holders' share of each penalty.`} min={5} max={PENALTY_CAPS.kingBps / 100} step={5} value={value.kingPct} onChange={(v) => set("kingPct", v)} />
      </OptionCard>

      <OptionCard title="Lockers eat the jeets" on={value.lockersEat} onToggle={(on) => set("lockersEat", on)}
        body="Jeet and whale taxes go to whoever locked the house coin in the Vault, instead of to this token's holders." />

      <OptionCard title="Sniper auction" on={value.auctionOn} onToggle={(on) => set("auctionOn", on)}
        body={`Instead of a fair open, the first slot after your block goes to the highest bidder over ${value.auctionBlocks} blocks. Half the bid goes to the holders, half into locked liquidity.`}>
        <Slider label={`Bidding lasts ${value.auctionBlocks} blocks`} hint={`10 to ${PENALTY_CAPS.auctionBlocks} blocks, about a second each.`} min={10} max={PENALTY_CAPS.auctionBlocks} step={5} value={value.auctionBlocks} onChange={(v) => set("auctionBlocks", v)} />
      </OptionCard>

      <div className="option-facts" role="list" aria-label="Rules every launch has">
        <p className="option-facts-title">On for every launch, not a choice</p>
        <div role="listitem"><strong>Creator cannot rug his fees</strong><span>You sell your own token, your unclaimed fees go to the holders in the same transaction.</span></div>
        <div role="listitem"><strong>Bots buy the dip</strong><span>Every sell tax, as it is collected, buys the token back. The seller's own money buys the token.</span></div>
        <div role="listitem"><strong>Wall of shame</strong><span>Every penalty is a line on the board with the payer's address. The holders present when a bot paid get season points.</span></div>
        <div role="listitem"><strong>Where a penalty goes</strong><span>80% to this token's holders (or the Vault, above), 20% into the Bag.</span></div>
      </div>
    </div>
  );
}
