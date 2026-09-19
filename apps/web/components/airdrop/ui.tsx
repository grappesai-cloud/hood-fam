"use client";

import type { ReactNode } from "react";

/// The small parts the airdrop panels are built from. No fetching, no chain, just labels.

export function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="fact">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

export function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="fact-row">
      <span>{label}</span>
      <span className="mono">{value}</span>
    </div>
  );
}

export function Headline({ value, note }: { value: string; note: string }) {
  return (
    <div className="headline">
      <strong>{value}</strong>
      <p>{note}</p>
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
