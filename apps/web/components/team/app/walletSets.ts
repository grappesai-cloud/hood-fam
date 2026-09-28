"use client";

import { useSyncExternalStore } from "react";
import { getAddress, isAddress, type Address, type PrivateKeyAccount } from "viem";
import type { VaultFile } from "@/lib/teamVault";

/// The team's wallet sets, shared by every page of the console.
///
/// A set is a named list of addresses: the wallets of one encrypted file, or addresses somebody
/// pasted. The list lives in this browser's storage so the console can offer it again tomorrow; a
/// key never does. Keys arrive when a file is opened, stay in this module's memory for as long as
/// the tab and the idle lock allow, and are dropped by Lock. Nothing here is sent anywhere.

export type SetSource = "file" | "pasted";

export interface WalletSet {
  id: string;
  name: string;
  addresses: Address[];
  source: SetSource;
  fileName?: string;
  createdAt: number;
}

const KEY = "team-wallet-sets-v1";
const listeners = new Set<() => void>();
let cache: WalletSet[] | null = null;

/// Checksummed, without repeats, without anything that is not an address.
export function normalizeAddresses(list: readonly string[]): Address[] {
  const out: Address[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const a = raw.trim();
    if (!isAddress(a)) continue;
    const k = a.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(getAddress(a));
  }
  return out;
}

function read(): WalletSet[] {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<WalletSet>[]) : [];
    cache = parsed
      .filter((s) => s && typeof s.id === "string" && Array.isArray(s.addresses))
      .map((s) => ({
        id: s.id!,
        name: typeof s.name === "string" ? s.name : "",
        addresses: normalizeAddresses(s.addresses as string[]),
        source: s.source === "pasted" ? "pasted" as const : "file" as const,
        fileName: typeof s.fileName === "string" ? s.fileName : undefined,
        createdAt: typeof s.createdAt === "number" ? s.createdAt : 0,
      }))
      .filter((s) => s.addresses.length > 0);
  } catch {
    cache = [];
  }
  return cache;
}

function write(next: WalletSet[]) {
  cache = next;
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* storage is optional */ }
  listeners.forEach((l) => l());
}

const NONE: WalletSet[] = [];

export function useWalletSets(): WalletSet[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      const onStorage = (e: StorageEvent) => { if (e.key === KEY) { cache = null; l(); } };
      window.addEventListener("storage", onStorage);
      return () => { listeners.delete(l); window.removeEventListener("storage", onStorage); };
    },
    read,
    () => NONE,
  );
}

const sameList = (a: readonly Address[], b: readonly Address[]) =>
  a.length === b.length && a.every((x, i) => x.toLowerCase() === b[i]!.toLowerCase());

/// Adds a set, or returns the one that already holds exactly these addresses: the same wallets are
/// the same set, so opening a file twice does not make two rows. Null when nothing was an address.
export function addSet(name: string, addresses: readonly string[], source: SetSource, fileName?: string): WalletSet | null {
  const list = normalizeAddresses(addresses);
  if (list.length === 0) return null;
  const have = read().find((s) => sameList(s.addresses, list));
  if (have) {
    const patch: Partial<WalletSet> = {};
    if (!have.name && name.trim()) patch.name = name.trim();
    if (!have.fileName && fileName) patch.fileName = fileName;
    if (Object.keys(patch).length) write(read().map((s) => (s.id === have.id ? { ...s, ...patch } : s)));
    return read().find((s) => s.id === have.id)!;
  }
  const set: WalletSet = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: name.trim(), addresses: list, source, fileName, createdAt: Date.now(),
  };
  write([set, ...read()]);
  return set;
}

export function renameSet(id: string, name: string) {
  write(read().map((s) => (s.id === id ? { ...s, name: name.trim() } : s)));
}

/// Forgets the set here. The file, if there was one, is wherever it was saved; the wallets are
/// wherever they are on chain. Nothing about them changes.
export function removeSet(id: string) {
  lockSet(id);
  write(read().filter((s) => s.id !== id));
}

export function setName(s: WalletSet): string {
  return s.name || (s.fileName ? s.fileName.replace(/\.json$/i, "") : `${s.addresses.length} wallets`);
}

// ---------------------------------------------------------------- the keys, in memory only

export interface Unlocked {
  /// Ids of the sets whose keys are open.
  ids: string[];
  /// Every open account, once each, in the order the sets were opened.
  accounts: PrivateKeyAccount[];
}

const keys = new Map<string, PrivateKeyAccount[]>();
const keyListeners = new Set<() => void>();
const LOCKED: Unlocked = { ids: [], accounts: [] };
let unlocked: Unlocked = LOCKED;

function refresh() {
  const seen = new Set<string>();
  const accounts: PrivateKeyAccount[] = [];
  for (const list of keys.values()) {
    for (const a of list) {
      const k = a.address.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      accounts.push(a);
    }
  }
  unlocked = keys.size === 0 ? LOCKED : { ids: [...keys.keys()], accounts };
  keyListeners.forEach((l) => l());
}

export function unlockSet(id: string, accounts: readonly PrivateKeyAccount[]) {
  keys.set(id, [...accounts]);
  refresh();
}

export function lockSet(id: string) {
  if (keys.delete(id)) refresh();
}

export function lockAll() {
  if (keys.size === 0) return;
  keys.clear();
  refresh();
}

export function useUnlocked(): Unlocked {
  return useSyncExternalStore(
    (l) => { keyListeners.add(l); return () => { keyListeners.delete(l); }; },
    () => unlocked,
    () => LOCKED,
  );
}

export function accountFor(address: string): PrivateKeyAccount | undefined {
  const k = address.toLowerCase();
  return unlocked.accounts.find((a) => a.address.toLowerCase() === k);
}

/// A file that was just made or just opened: its addresses become (or find) a set, and its keys
/// open that set.
export function registerVault(file: VaultFile, accounts: readonly PrivateKeyAccount[], fileName?: string): WalletSet | null {
  const set = addSet(file.label, file.addresses, "file", fileName);
  if (set) unlockSet(set.id, accounts);
  return set;
}
