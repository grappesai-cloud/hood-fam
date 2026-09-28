"use client";

import { DEFAULT_SNIPE_PCT, OptionCard, Slider } from "@/components/LaunchUI";

/// The curve's opening rules (v4 factory): the same two tools the direct machine has, a surcharge
/// on buys that decays to nothing and a per-wallet buy cap for the first blocks. The launch's own
/// buys (the creator's first buy, a block-zero team) are exempt because they happen inside the
/// launch transaction; everything after it is a buyer like any other.

export interface CurveGuardForm {
  snipePct: number; // 0 = off
  snipeSeconds: number;
  capBlocks: number; // 0 = off
  capPct: number; // per wallet, of the total supply
}

/// Half the buy at second zero, gone in three seconds, and one percent per wallet for the first
/// thirty blocks (three seconds of 100 ms blocks). The same opening the direct form starts from.
export const CURVE_GUARD_DEFAULTS: CurveGuardForm = { snipePct: DEFAULT_SNIPE_PCT, snipeSeconds: 3, capBlocks: 30, capPct: 1 };
export const CURVE_GUARD_OFF: CurveGuardForm = { snipePct: 0, snipeSeconds: 0, capBlocks: 0, capPct: 0 };

/// The factory's own ceilings (HoodFactory.MAX_*), so the form refuses what the chain would.
export const CURVE_GUARD_CAPS = { snipePct: 90, snipeSeconds: 600, capBlocks: 1_200 } as const;

export function encodeGuard(g: CurveGuardForm) {
  return {
    snipeTaxBps: Math.round(g.snipePct * 100),
    snipeDecaySeconds: g.snipePct > 0 ? Math.round(g.snipeSeconds) : 0,
    restrictionBlocks: g.capBlocks > 0 ? Math.round(g.capBlocks) : 0,
    maxBuyBps: g.capBlocks > 0 ? Math.round(g.capPct * 100) : 0,
  };
}

export function guardProblem(g: CurveGuardForm): string | undefined {
  if (g.snipePct > CURVE_GUARD_CAPS.snipePct) return `The opening tax is at most ${CURVE_GUARD_CAPS.snipePct}%.`;
  if (g.snipePct > 0 && (g.snipeSeconds < 1 || g.snipeSeconds > CURVE_GUARD_CAPS.snipeSeconds)) return "The opening tax needs 1 to 600 seconds to fall away.";
  if (g.capBlocks > CURVE_GUARD_CAPS.capBlocks) return `The wallet cap lasts at most ${CURVE_GUARD_CAPS.capBlocks} blocks.`;
  if (g.capBlocks > 0 && (g.capPct <= 0 || g.capPct > 100)) return "Set the per-wallet cap between 0.01% and 100%.";
  return undefined;
}

export function guardReviewRows(g: CurveGuardForm): { label: string; value: string }[] {
  return [
    { label: "Opening tax", value: g.snipePct > 0 ? `${g.snipePct}% extra on buys at the open, gone after ${g.snipeSeconds}s, 80% to holders` : "Off" },
    { label: "Wallet cap", value: g.capBlocks > 0 ? `${g.capPct}% of the supply per wallet for the first ${g.capBlocks} blocks` : "Off" },
  ];
}

export function CurveGuardOptions({ value, onChange }: { value: CurveGuardForm; onChange: (next: CurveGuardForm) => void }) {
  const set = <K extends keyof CurveGuardForm>(k: K, v: CurveGuardForm[K]) => onChange({ ...value, [k]: v });
  return (
    <div className="option-stack">
      <OptionCard title="Opening tax" tag="on by default" on={value.snipePct > 0}
        body={`A buyer in the first ${value.snipeSeconds || 3} seconds pays up to ${value.snipePct || DEFAULT_SNIPE_PCT}% extra, falling to nothing by the end. 80% goes to the holders, 20% to the Bag. Your own first buy, in the launch transaction, pays none of it.`}
        onToggle={(on) => onChange({ ...value, snipePct: on ? DEFAULT_SNIPE_PCT : 0, snipeSeconds: on ? (value.snipeSeconds || 3) : 0 })}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Slider label={`Extra at the open ${value.snipePct}%`} hint={`At second zero, on top of the trade fee. At most ${CURVE_GUARD_CAPS.snipePct}%.`}
            min={1} max={CURVE_GUARD_CAPS.snipePct} step={1} value={Math.max(1, value.snipePct)} onChange={(v) => set("snipePct", v)} />
          <Slider label={`Gone after ${value.snipeSeconds}s`} hint="It falls away by the square, so most of it is gone half way."
            min={1} max={60} step={1} value={Math.max(1, value.snipeSeconds)} onChange={(v) => set("snipeSeconds", v)} />
        </div>
      </OptionCard>
      <OptionCard title="Wallet cap at the open" tag="on by default" on={value.capBlocks > 0}
        body={`For the first ${value.capBlocks || 30} blocks no wallet may buy more than ${value.capPct || 1}% of the supply. Blocks are 100 ms here, so 30 blocks is three seconds.`}
        onToggle={(on) => onChange({ ...value, capBlocks: on ? 30 : 0, capPct: on ? (value.capPct || 1) : 0 })}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Slider label={`${value.capPct}% per wallet`} hint="Of the total supply, counted over the whole window."
            min={0.1} max={10} step={0.1} value={Math.max(0.1, value.capPct)} onChange={(v) => set("capPct", Math.round(v * 10) / 10)} />
          <Slider label={`For ${value.capBlocks} blocks`} hint={`At most ${CURVE_GUARD_CAPS.capBlocks}.`}
            min={10} max={600} step={10} value={Math.max(10, value.capBlocks)} onChange={(v) => set("capBlocks", v)} />
        </div>
      </OptionCard>
    </div>
  );
}
