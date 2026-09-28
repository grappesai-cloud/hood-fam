"use client";

import { isAddress, type Address } from "viem";
import { SNIPE_SCHEDULE_BPS } from "@hood/sdk";
import { Field } from "@/components/LaunchUI";
import "./opening-tax.css";

/// The opening tax, as a launch form shows it (v5 factory and portal on). It is not a setting:
/// every launch on both machines runs the same schedule (SnipeSchedule.sol), and all a creator
/// picks is who does not pay it. The launcher and the creator fee recipient never do; up to
/// MAX_EXEMPT more wallets can be named, and they are on chain from the launch transaction on.

export const MAX_EXEMPT = 32;

/// One address per line, or separated by spaces or commas. Duplicates are dropped.
export function parseExempt(text: string): string[] {
  const seen = new Set<string>();
  return text.split(/[\s,;]+/).map((w) => w.trim()).filter(Boolean).filter((w) => {
    const k = w.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function exemptProblem(list: string[]): string | undefined {
  const bad = list.find((w) => !isAddress(w));
  if (bad) return `Not an address: ${bad}`;
  if (list.length > MAX_EXEMPT) return `At most ${MAX_EXEMPT} wallets can skip the opening tax.`;
  return undefined;
}

export const exemptAddresses = (text: string) => parseExempt(text) as Address[];

const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;

export const OPENING_TAX_SUMMARY =
  `${SNIPE_SCHEDULE_BPS.map(pct).join(", ")} of a buy over the first ${SNIPE_SCHEDULE_BPS.length} seconds, then none`;

export function openingReviewRows(list: string[]): { label: string; value: string }[] {
  return [
    { label: "Opening tax", value: `${OPENING_TAX_SUMMARY}. It joins the trading fee: 70% to your split, 30% to the Bag.` },
    { label: "Pays no opening tax", value: `You, your fee recipient${list.length ? ` and ${list.length} named wallet${list.length === 1 ? "" : "s"}` : ""}` },
  ];
}

export function OpeningTax({ value, onChange, machine }: {
  value: string;
  onChange: (next: string) => void;
  machine: "curve" | "direct";
}) {
  const list = parseExempt(value);
  const problem = value.trim() ? exemptProblem(list) : undefined;
  return (
    <div className="option-stack">
      <div className="opening-tax-table" role="table" aria-label="Opening tax schedule">
        {SNIPE_SCHEDULE_BPS.map((bps, s) => (
          <div key={s} role="row"><span role="cell">Second {s}</span><strong role="cell">{pct(bps)}</strong></div>
        ))}
        <div role="row"><span role="cell">Second {SNIPE_SCHEDULE_BPS.length} on</span><strong role="cell">0%</strong></div>
      </div>
      <p className="field-note">
        Every launch opens the same way, so a buyer never has to read your settings to know what the first seconds cost.
        Buys only; selling is never taxed by it. What it collects is trading fee, split like the rest: 70% to your split, 30% to the Bag.
        {machine === "curve"
          ? " On the curve it is keyed on the wallet that receives the tokens."
          : " On the pool it is keyed on the wallet that sends the swap."}
        {" "}Your own first buy happens inside the launch transaction and never pays it.
      </p>
      <Field label="Wallets that skip it (optional)"
        help={`You and your fee recipient already do. Name up to ${MAX_EXEMPT} more, one per line, for a team spreading its opening buys across wallets. The list is public on chain.`}
        error={problem}>
        <textarea className="input mono" rows={4} value={value} onChange={(e) => onChange(e.target.value)} placeholder={"0xabc…\n0xdef…"} spellCheck={false} />
      </Field>
      {list.length > 0 && !problem && <p className="field-note">{list.length} of {MAX_EXEMPT} named.</p>}
    </div>
  );
}
