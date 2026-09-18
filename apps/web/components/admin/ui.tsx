"use client";

import { useEffect, useState, type ReactNode } from "react";
import { EXPLORER } from "@/lib/config";
import { shortAddress } from "@/lib/format";

/// The small parts every admin panel is built from. Nothing here knows about the API or the
/// chain: it is labels, chips, links and a button that asks twice.

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

export function Chip({ on, label }: { on: boolean; label: string }) {
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-[11px] ${
        on ? "border-[var(--color-lime)] text-[var(--color-lime)]" : "border-[var(--color-line)] dim"
      }`}
    >
      {label} · {on ? "wired" : "not wired"}
    </span>
  );
}

export function Addr({ address, missing = "not set" }: { address?: string | null; missing?: string }) {
  if (!address) return <span className="dim">{missing}</span>;
  return (
    <a href={`${EXPLORER}/address/${address}`} target="_blank" rel="noreferrer" className="mono text-[var(--color-lime)]">
      {shortAddress(address)}
    </a>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs dim">{label}</span>
      {children}
    </label>
  );
}

/// Anything that cannot be taken back asks twice. Not a browser confirm(): that freezes the page
/// and every read behind it. The second click has to land within a few seconds.
export function ConfirmButton({
  label,
  confirm,
  onConfirm,
  disabled,
  className = "btn btn-ghost text-xs",
}: {
  label: string;
  confirm: string;
  onConfirm: () => void;
  disabled?: boolean;
  className?: string;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4_000);
    return () => clearTimeout(t);
  }, [armed]);

  return (
    <button
      type="button"
      disabled={disabled}
      className={armed ? `${className} !border-[var(--color-red)] !text-[var(--color-red)]` : className}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        onConfirm();
      }}
    >
      {armed ? confirm : label}
    </button>
  );
}
