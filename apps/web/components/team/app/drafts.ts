"use client";

import { useSyncExternalStore } from "react";

/// Launch drafts for the team console, kept in this browser only. A draft is the three tabs of the
/// form as they were left; once it launches it keeps the token address, so the sidebar can open its
/// watch instead of its form. Nothing here is a key or a secret: the wallets in a draft are
/// addresses, and the keys stay in the desk's encrypted files.

export type Machine = "curve";
export type BuildPreset = "quick" | "full" | "custom";
export type FeeTo = "deployer" | "wallet" | "holders";

export interface Draft {
  id: string;
  createdAt: number;
  updatedAt: number;
  // Chain and launchpad
  machine: Machine;
  market: "crypto" | "stocks";
  /// A factory preset id for crypto, or a planned pair's address for stocks.
  configId: number;
  stockPair: string;
  feeTo: FeeTo;
  feeRecipient: string;
  split: { stakers: number; buyback: number; liquidity: number; creator: number };
  // Token details
  name: string;
  symbol: string;
  description: string;
  image: string;
  twitter: string;
  telegram: string;
  website: string;
  // Launch settings
  devPct: string;
  holdersPct: string;
  holdersCount: string;
  preset: BuildPreset;
  holderLock: number;
  devLock: number;
  gas: string;
  wallets: string[];
  /// The wallet set the holder wallets were taken from, if a set was used.
  holdersSet: string;
  /// Open buyers: wallets named at launch as paying no opening tax (v5 factory), addresses only.
  openBuyers: string[];
  buyersSet: string;
  // After the launch
  token?: string;
  tx?: string;
}

const KEY = "team-drafts-v1";
const listeners = new Set<() => void>();
let cache: Draft[] | null = null;

function read(): Draft[] {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    // Fields added since a draft was saved come in with their defaults, so an older draft still
    // reads as a whole one.
    cache = raw ? (JSON.parse(raw) as Partial<Draft>[]).map((d) => ({ ...blank(), ...d } as Draft)) : [];
  } catch {
    cache = [];
  }
  return cache;
}

function write(next: Draft[]) {
  cache = next;
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* storage is optional */ }
  listeners.forEach((l) => l());
}

const EMPTY: Draft[] = [];

export function useDrafts(): Draft[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      const onStorage = (e: StorageEvent) => { if (e.key === KEY) { cache = null; l(); } };
      window.addEventListener("storage", onStorage);
      return () => { listeners.delete(l); window.removeEventListener("storage", onStorage); };
    },
    read,
    () => EMPTY,
  );
}

function blank(): Draft {
  const now = Date.now();
  return {
    id: now.toString(36) + Math.random().toString(36).slice(2, 6),
    createdAt: now, updatedAt: now,
    machine: "curve", market: "crypto", configId: 0, stockPair: "",
    feeTo: "deployer", feeRecipient: "",
    split: { stakers: 0, buyback: 30, liquidity: 20, creator: 50 },
    name: "", symbol: "", description: "", image: "", twitter: "", telegram: "", website: "",
    devPct: "2", holdersPct: "8", holdersCount: "5", preset: "quick",
    holderLock: 0, devLock: 0, gas: "0",
    wallets: [], holdersSet: "", openBuyers: [], buyersSet: "",
  };
}

export function newDraft(patch: Partial<Draft> = {}): Draft {
  const draft: Draft = { ...blank(), ...patch };
  write([draft, ...read()]);
  return draft;
}

export function saveDraft(id: string, patch: Partial<Draft>) {
  write(read().map((d) => (d.id === id ? { ...d, ...patch, updatedAt: Date.now() } : d)));
}

export function removeDraft(id: string) {
  write(read().filter((d) => d.id !== id));
}

export function importDraft(raw: unknown): Draft | null {
  if (!raw || typeof raw !== "object") return null;
  const base = newDraft();
  const { id: _id, createdAt: _c, token: _t, tx: _x, ...rest } = raw as Partial<Draft>;
  const merged = { ...base, ...rest, id: base.id, createdAt: base.createdAt };
  saveDraft(base.id, merged);
  return merged;
}
