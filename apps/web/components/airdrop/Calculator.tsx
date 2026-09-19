"use client";

import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useAccount } from "wagmi";
import {
  LOCK_DAYS,
  points,
  postJson,
  sharePercent,
  sliderToUsd,
  usd,
  usdToSlider,
  type Estimate,
  type EstimateInput,
  type LockDays,
} from "./data";
import { Broken, Quiet, Row } from "./ui";

const START: EstimateInput = { launches: 0, buyUsd: 1_000, sellUsd: 0, stakeUsd: 0, lockDays: 0 };

/// The inputs settle before the API hears about them, so dragging a slider is one request at the
/// end rather than one per pixel.
function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/// What a given amount of activity would be worth, priced by the API rather than by this page.
/// The last answer stays on screen while the next one is in flight, because a number that blinks
/// to nothing reads as a number that changed.
export function Calculator({ season }: { season: number }) {
  const { address } = useAccount();
  const [input, setInput] = useState<EstimateInput>(START);
  const settled = useDebounced(input, 300);

  const estimate = useQuery({
    queryKey: ["airdrop", "estimate", season, address ?? null, settled],
    queryFn: () =>
      postJson<Estimate>("/airdrop/estimate", {
        season,
        ...(address ? { address } : {}),
        launches: settled.launches,
        buyUsd: settled.buyUsd,
        sellUsd: settled.sellUsd,
        stakeUsd: settled.stakeUsd,
        lockDays: settled.lockDays,
      }),
    placeholderData: keepPreviousData,
    refetchInterval: false,
  });

  const e = estimate.data;

  // A band only when the two arms differ, which is exactly when this much volume changes the rank.

  const band = Boolean(e && e.high && e.low && e.high.rank !== e.low.rank);

  const pointsBand = (lo: number, hi: number) => (band && hi !== lo ? `${points(lo)} to ${points(hi)}` : points(lo));
  const waiting = estimate.isFetching || settled !== input;

  return (
    <section className="panel space-y-4 p-4">
      <div className="panel-head">
        <span className="n">04 / THE MATH</span><h2>What more activity would be worth</h2>
        <span className="aside">{waiting ? "working" : `season ${season}`}</span>
      </div>
      <Quiet>Set what you would trade, print and lock before the season ends.</Quiet>

      <div className="space-y-3">
        <Money
          label="buy volume"
          value={input.buyUsd}
          onChange={(buyUsd) => setInput({ ...input, buyUsd })}
        />
        <Money
          label="sell volume"
          value={input.sellUsd}
          onChange={(sellUsd) => setInput({ ...input, sellUsd })}
        />
        <Money
          label="amount locked"
          value={input.stakeUsd}
          onChange={(stakeUsd) => setInput({ ...input, stakeUsd })}
        />

        <label className="block space-y-1">
          <span className="text-xs dim">tokens printed</span>
          <div className="flex items-center gap-3">
            <div className="w-24 flex-none">
              <input
                className="input mono"
                inputMode="numeric"
                value={String(input.launches)}
                onChange={(ev) => setInput({ ...input, launches: clampInt(ev.target.value, 0, 100) })}
              />
            </div>
            <input
              type="range"
              className="flex-1 accent-[var(--color-lime)]"
              min={0}
              max={20}
              step={1}
              value={Math.min(20, input.launches)}
              onChange={(ev) => setInput({ ...input, launches: Number(ev.target.value) })}
            />
          </div>
        </label>

        <div className="space-y-1">
          <span className="text-xs dim">how long it is locked</span>
          <div className="flex flex-wrap gap-2">
            {LOCK_DAYS.map((t) => (
              <button
                key={t.days}
                type="button"
                aria-pressed={input.lockDays === t.days}
                onClick={() => setInput({ ...input, lockDays: t.days as LockDays })}
                className={`min-h-10 rounded-lg border px-2.5 py-1.5 text-xs ${
                  input.lockDays === t.days
                    ? "border-[var(--color-lime)] text-[var(--color-lime)]"
                    : "border-[var(--color-line)] dim"
                }`}
              >
                {t.label} · {t.multiplier}x
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="space-y-3 border-t border-[var(--color-line)] pt-3">
        {estimate.isError && !e && <Broken>the estimator is not answering right now.</Broken>}
        {estimate.isError && e && <Broken>the estimator stopped answering, so these numbers are the last it gave.</Broken>}
        {!e && !estimate.isError && <Quiet>working</Quiet>}

        {e && (
          <>
            {/* Two ranks, so two numbers. The activity is scored at the rank held today and at the
                rank the volume would reach; the truth is in between, and a single number would be
                wrong in one direction or the other. */}
            <div className={waiting ? "opacity-60 transition-opacity" : "transition-opacity"}>
              <div className="mono text-3xl font-bold leading-none">
                {band ? `${usd(e.low.estimateUsd)} to ${usd(e.high.estimateUsd)}` : usd(e.low.estimateUsd)}
              </div>
              <p className="mt-1.5 text-xs dim">
                {band
                  ? `${sharePercent(e.low.sharePpm)} to ${sharePercent(e.high.sharePpm)} of a pool that stands at ${usd(e.poolUsd)} today, depending on how much of it you trade at ${e.high.rank}.`
                  : `${sharePercent(e.low.sharePpm)} of a pool that stands at ${usd(e.poolUsd)} today.`}
              </p>
            </div>

            <div className="space-y-1">
              <Row
                label="rank this activity earns"
                value={band ? `${e.low.rank} · ${e.low.multiplier}x to ${e.high.rank} · ${e.high.multiplier}x` : `${e.low.rank} · ${e.low.multiplier}x`}
              />
              <Row label="points from printing" value={pointsBand(e.low.points.launch, e.high.points.launch)} />
              <Row label="points from buying" value={pointsBand(e.low.points.buy, e.high.points.buy)} />
              <Row label="points from selling" value={pointsBand(e.low.points.sell, e.high.points.sell)} />
              <Row
                label={`points from locking (${Math.round(e.stakeDays)} days)`}
                value={pointsBand(e.low.points.stake, e.high.points.stake)}
              />
              <Row label="points this activity adds" value={pointsBand(e.low.points.total, e.high.points.total)} />
              <Row label="points you already hold" value={points(e.existingPoints)} />
              <Row label="your points after it" value={pointsBand(e.low.projectedPoints, e.high.projectedPoints)} />
              <Row label="the season's points after it" value={pointsBand(e.low.seasonTotalAfter, e.high.seasonTotalAfter)} />
              <Row label="your share of the pool" value={band ? `${sharePercent(e.low.sharePpm)} to ${sharePercent(e.high.sharePpm)}` : sharePercent(e.low.sharePpm)} />
            </div>

            {e.assumptions.length > 0 && (
              <details className="fineprint">
                <summary>How this was worked out</summary>
                <ul>{e.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
              </details>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function clampInt(raw: string, min: number, max: number): number {
  const n = Number.parseInt(raw.replace(/[^0-9]/g, ""), 10);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function clampUsd(raw: string): number {
  const n = Number.parseFloat(raw.replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(1_000_000, Math.round(n));
}

/// A dollar field and the slider that moves it. The slider is logarithmic, so the first hundred
/// dollars get as much of the track as the last hundred thousand.
function Money({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs dim">{label}</span>
      <div className="flex items-center gap-3">
        <span className="mono text-sm dim">$</span>
        <div className="w-28 flex-none">
          <input
            className="input mono"
            inputMode="decimal"
            value={value === 0 ? "" : String(value)}
            placeholder="0"
            onChange={(ev) => onChange(clampUsd(ev.target.value))}
          />
        </div>
        <input
          type="range"
          className="flex-1 accent-[var(--color-lime)]"
          min={0}
          max={100}
          step={0.5}
          value={usdToSlider(value)}
          onChange={(ev) => onChange(sliderToUsd(Number(ev.target.value)))}
        />
      </div>
    </label>
  );
}
