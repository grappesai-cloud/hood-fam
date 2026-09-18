"use client";

import type { ReactNode } from "react";

/// The small parts the airdrop panels are built from. No fetching, no chain, just labels.

export function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-lg border border-[var(--color-line)] p-2">
      <div className="mono text-sm break-words">{value}</div>
      <div className="text-xs dim">{label}</div>
    </div>
  );
}

export function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <span className="dim">{label}</span>
      <span className="mono break-all text-right">{value}</span>
    </div>
  );
}

export function Headline({ value, note }: { value: string; note: string }) {
  return (
    <div>
      <div className="mono text-3xl font-bold leading-none">{value}</div>
      <p className="mt-1.5 text-xs dim">{note}</p>
    </div>
  );
}

export function Quiet({ children }: { children: ReactNode }) {
  return <p className="text-xs dim">{children}</p>;
}

export function Broken({ children }: { children: ReactNode }) {
  return <p className="break-words text-xs text-[var(--color-red)]">{children}</p>;
}

export function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-2 rounded-lg border border-[var(--color-line)] p-2.5">
      <div className="text-sm font-semibold">{title}</div>
      {children}
    </div>
  );
}
