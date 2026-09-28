"use client";

import { isAddress, parseUnits } from "viem";
import { LOCK_TIERS } from "@hood/sdk";
import { Field } from "@/components/LaunchUI";
import { fmt } from "@/lib/format";

/// The list of team wallets for a block-zero launch, on either machine: who, how much, locked or
/// not. The wallets buy in this order inside the launch transaction, and every one of them is
/// published as the team's on the token page.

export interface LegForm {
  wallet: string;
  amount: string;
  lock: number;
}

export const MAX_TEAM_LEGS = 40;
export const TEAM_LOCKS = [{ label: "no lock", seconds: 0 }, ...LOCK_TIERS.filter((t) => t.seconds > 0).map((t) => ({ label: t.label, seconds: t.seconds }))];
export const EMPTY_LEG: LegForm = { wallet: "", amount: "", lock: 0 };

export function units(value: string, decimals: number): bigint {
  try { return parseUnits(value.trim() || "0", decimals); } catch { return 0n; }
}

/// One wallet per line: `address amount [lock days]`, separated by spaces, commas or tabs, which is
/// what a spreadsheet column pasted in gives. A line with only an address takes the amount given.
export function parseBulk(text: string, fallbackAmount = ""): LegForm[] {
  const tiers = new Map(TEAM_LOCKS.map((l) => [Math.round(l.seconds / 86_400), l.seconds]));
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [wallet = "", amount = fallbackAmount, days = "0"] = line.split(/[\s,;]+/);
    return { wallet, amount, lock: tiers.get(Number(days)) ?? 0 };
  });
}

/// The first reason the list cannot go on chain, or undefined.
export function legsProblem(legs: LegForm[], decimals: number): string | undefined {
  if (legs.length === 0) return "Add at least one team wallet.";
  if (legs.length > MAX_TEAM_LEGS) return `At most ${MAX_TEAM_LEGS} wallets in one launch.`;
  const bad = legs.find((l) => !isAddress(l.wallet.trim()));
  if (bad) return `Not an address: ${bad.wallet || "(empty)"}`;
  const seen = new Set<string>();
  for (const l of legs) {
    const w = l.wallet.trim().toLowerCase();
    if (seen.has(w)) return `The same wallet twice: ${w}`;
    seen.add(w);
  }
  if (legs.some((l) => units(l.amount, decimals) === 0n)) return "Every wallet needs an amount above zero.";
  return undefined;
}

export function TeamLegsEditor({ legs, onChange, symbol, decimals, estimates, supply }: {
  legs: LegForm[];
  onChange: (next: LegForm[]) => void;
  symbol: string;
  decimals: number;
  /// Tokens each leg would get, in order, when the app can work it out (the curve); omit otherwise.
  estimates?: (bigint | undefined)[];
  supply?: bigint;
}) {
  const setLeg = (i: number, patch: Partial<LegForm>) => onChange(legs.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const pct = (part: bigint) => {
    if (!supply || supply <= 0n) return "";
    const v = Number((part * 1_000_000n) / supply) / 10_000;
    return ` · ${v >= 10 ? v.toFixed(1) : v.toFixed(2)}%`;
  };
  return (
    <div className="team-legs">
      <div className="space-y-2">
        {legs.map((l, i) => (
          <div key={i} className="team-leg-row">
            <input className="input mono" value={l.wallet} onChange={(e) => setLeg(i, { wallet: e.target.value })} placeholder="0x wallet" aria-label={`Wallet ${i + 1}`} />
            <input className="input mono" value={l.amount} onChange={(e) => setLeg(i, { amount: e.target.value.replace(/[^0-9.]/g, "") })} placeholder={symbol} inputMode="decimal" aria-label={`Amount ${i + 1}`} />
            <select className="input" value={l.lock} onChange={(e) => setLeg(i, { lock: Number(e.target.value) })} aria-label={`Lock ${i + 1}`}>
              {TEAM_LOCKS.map((t) => <option key={t.seconds} value={t.seconds}>{t.label}</option>)}
            </select>
            <span className="mono text-xs dim">{estimates?.[i] ? `${fmt(estimates[i]!, 18, 0)}${pct(estimates[i]!)}` : "–"}</span>
            <button type="button" className="btn btn-ghost" aria-label={`Remove wallet ${i + 1}`} onClick={() => onChange(legs.filter((_, j) => j !== i))}>×</button>
          </div>
        ))}
      </div>
      <TeamLegTools legs={legs} onChange={onChange} symbol={symbol} decimals={decimals} />
    </div>
  );
}

function TeamLegTools({ legs, onChange, symbol, decimals }: { legs: LegForm[]; onChange: (next: LegForm[]) => void; symbol: string; decimals: number }) {
  return (
    <>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className="btn btn-ghost" disabled={legs.length >= MAX_TEAM_LEGS} onClick={() => onChange([...legs, { ...EMPTY_LEG }])}>Add wallet</button>
        <form className="flex flex-wrap gap-2" onSubmit={(e) => {
          e.preventDefault();
          const total = units(String(new FormData(e.currentTarget).get("total") ?? ""), decimals);
          if (!legs.length || total === 0n) return;
          const each = total / BigInt(legs.length);
          onChange(legs.map((l) => ({ ...l, amount: fmt(each, decimals, decimals).replace(/,/g, "") })));
        }}>
          <input name="total" className="input mono team-total" placeholder={`total ${symbol}`} inputMode="decimal" aria-label="Total to split" />
          <button type="submit" className="btn btn-ghost" disabled={!legs.length}>Split evenly</button>
        </form>
      </div>
      <form onSubmit={(e) => {
        e.preventDefault();
        const text = String(new FormData(e.currentTarget).get("bulk") ?? "");
        if (!text.trim()) return;
        onChange(parseBulk(text).slice(0, MAX_TEAM_LEGS));
        e.currentTarget.reset();
      }}>
        <Field label="Paste a list" help="One wallet per line: address, amount, and lock days (0, 7, 30, 90 or 180). Replaces the list above.">
          <textarea name="bulk" className="input mono" rows={4} placeholder={"0xabc… 0.25 30\n0xdef… 0.25 0"} />
        </Field>
        <button type="submit" className="btn btn-ghost">Use this list</button>
      </form>
    </>
  );
}
