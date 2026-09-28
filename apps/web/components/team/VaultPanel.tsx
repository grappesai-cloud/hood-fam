"use client";

import { useEffect, useRef, useState } from "react";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, PrivateKeyAccount } from "viem";
import { Field, Step } from "@/components/LaunchUI";
import {
  MAX_WALLETS, MIN_PASSPHRASE, decryptVault, encryptVault, generateTeamKeys, parseVaultFile,
  passphraseProblem, vaultFileName, type VaultFile, type VaultKey,
} from "@/lib/teamVault";
import { registerVault } from "./app/walletSets";

/// Making and opening team wallet files.
///
/// A file that is made or opened here becomes a wallet set the whole console knows (addresses in
/// this browser, keys in memory only), so the desk, the launch form and the funding step all see
/// it without being handed anything.
///
/// A generated set is not handed to the desk until it has been encrypted and offered as a download:
/// wallets that can receive tokens before a copy of their keys exists anywhere are wallets that can
/// be lost with a closed tab. The plaintext keys sit in a ref, not in React state, so they never
/// land in devtools' state snapshots, and the ref is emptied the moment the file is made.

function download(file: VaultFile) {
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = vaultFileName(file);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export async function copyLines(addresses: readonly string[]): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(addresses.join("\n"));
    return true;
  } catch {
    return false;
  }
}

export function VaultPanel({ n, unlocked, onUnlock }: {
  n: number;
  unlocked: number;
  onUnlock?: (accounts: PrivateKeyAccount[], label: string) => void;
}) {
  // ---- generate
  const [count, setCount] = useState("10");
  const [label, setLabel] = useState("");
  const pending = useRef<VaultKey[] | null>(null);
  const [fresh, setFresh] = useState<Address[]>([]);
  const [pass, setPass] = useState("");
  const [confirm, setConfirm] = useState("");
  const [made, setMade] = useState<VaultFile | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ---- unlock
  const [loaded, setLoaded] = useState<VaultFile | null>(null);
  const [loadedName, setLoadedName] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [openPass, setOpenPass] = useState("");
  const [opening, setOpening] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // Leaving with keys that exist nowhere else loses them; the browser asks first.
  useEffect(() => {
    if (fresh.length === 0) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [fresh.length]);

  // Nothing about a key outlives the panel.
  useEffect(() => () => { pending.current = null; }, []);

  const wanted = Math.floor(Number(count));
  const countOk = Number.isInteger(wanted) && wanted >= 1 && wanted <= MAX_WALLETS;
  const passIssue = pass || confirm ? passphraseProblem(pass, confirm) : null;

  function generate() {
    if (!countOk) return;
    setError(null);
    setMade(null);
    pending.current = generateTeamKeys(wanted);
    setFresh(pending.current.map((k) => k.address));
  }

  function discard() {
    pending.current = null;
    setFresh([]);
    setPass("");
    setConfirm("");
  }

  async function seal() {
    const keys = pending.current;
    if (!keys || passphraseProblem(pass, confirm)) return;
    setBusy(true);
    setError(null);
    try {
      const file = await encryptVault(keys, pass, label);
      download(file);
      const accounts = keys.map((k) => privateKeyToAccount(k.privateKey));
      registerVault(file, accounts, vaultFileName(file));
      onUnlock?.(accounts, file.label);
      pending.current = null;
      setFresh([]);
      setMade(file);
      setPass("");
      setConfirm("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Encryption failed.");
    } finally {
      setBusy(false);
    }
  }

  async function copy(list: readonly string[], tag: string) {
    setCopied((await copyLines(list)) ? tag : null);
    setTimeout(() => setCopied(null), 2_000);
  }

  async function pick(file: File | undefined) {
    setLoaded(null);
    setLoadError(null);
    if (!file) return;
    if (file.size > 1_000_000) { setLoadError("That file is far too large to be a team wallet file."); return; }
    try {
      setLoaded(parseVaultFile(await file.text()));
      setLoadedName(file.name);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "That file could not be read.");
    }
  }

  async function unlock() {
    if (!loaded || !openPass) return;
    setOpening(true);
    setLoadError(null);
    try {
      const keys = await decryptVault(loaded, openPass);
      const accounts = keys.map((k) => privateKeyToAccount(k.privateKey));
      registerVault(loaded, accounts, loadedName || undefined);
      onUnlock?.(accounts, loaded.label);
      setOpenPass("");
      setLoaded(null);
      if (fileInput.current) fileInput.current.value = "";
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "The file could not be opened.");
    } finally {
      setOpening(false);
    }
  }

  return (
    <div className="desk-grid-2">
      <Step n={n} title="Make fresh wallets" purpose={`Up to ${MAX_WALLETS} new wallets, made in this tab. They go into one encrypted file you download. Nothing is sent anywhere.`} done={Boolean(made)}>
        <div className="desk-inline">
          <Field label="How many">
            <input className="input mono" inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value.replace(/[^0-9]/g, ""))} />
          </Field>
          <Field label="Label (optional)">
            <input className="input" value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} placeholder="project name" />
          </Field>
        </div>
        {!countOk && count !== "" && <p className="field-note bad">Between 1 and {MAX_WALLETS}.</p>}
        {fresh.length === 0 && (
          <button type="button" className="btn btn-ghost" disabled={!countOk} onClick={generate}>Generate wallets</button>
        )}

        {fresh.length > 0 && (
          <>
            <ol className="desk-addresses mono">{fresh.map((a) => <li key={a}>{a}</li>)}</ol>
            <div className="desk-inline">
              <button type="button" className="btn btn-ghost desk-small" onClick={() => copy(fresh, "fresh")}>
                {copied === "fresh" ? "Copied" : "Copy addresses"}
              </button>
              <button type="button" className="btn btn-ghost desk-small" onClick={discard}>Discard</button>
            </div>
            <p className="desk-warning">
              The file and the passphrase are the only copy of these keys. Lose either one and the wallets, and anything in them, are gone. Nobody can recover them, including us.
            </p>
            <Field label="Passphrase" help={`At least ${MIN_PASSPHRASE} characters. A few unrelated words is easier to keep than symbols.`}>
              <input className="input" type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} />
            </Field>
            <Field label="Passphrase again" error={passIssue ?? undefined}>
              <input className="input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </Field>
            {error && <p className="field-note bad">{error}</p>}
            <button type="button" className="btn" disabled={busy || Boolean(passphraseProblem(pass, confirm))} onClick={seal}>
              {busy ? "Encrypting" : "Encrypt and download"}
            </button>
          </>
        )}

        {made && (
          <div className="desk-note">
            <p>
              Saved as <span className="mono">{vaultFileName(made)}</span>. The {made.addresses.length} wallets are open on the desk below.
              Keep the file somewhere other than this computer too.
            </p>
            <div className="desk-inline">
              <button type="button" className="btn btn-ghost desk-small" onClick={() => download(made)}>Download again</button>
              <button type="button" className="btn btn-ghost desk-small" onClick={() => copy(made.addresses, "made")}>
                {copied === "made" ? "Copied" : "Copy addresses"}
              </button>
            </div>
            <p className="field-note">One address per line. Add an amount and lock days after each to paste them into the team launch console.</p>
          </div>
        )}
      </Step>

      <Step n={n + 1} title="Open a wallet file" purpose="Decrypted in this tab, held in memory only. Lock forgets the keys, and the desk locks itself after 15 minutes without input." done={unlocked > 0}>
        <Field label="Wallet file">
          <input ref={fileInput} className="input" type="file" accept="application/json,.json" onChange={(e) => pick(e.target.files?.[0])} />
        </Field>
        {loaded && (
          <p className="field-note">
            {loaded.label ? <b>{loaded.label}</b> : "Unlabelled"}, {loaded.addresses.length} wallets, made {loaded.createdAt.slice(0, 10)}.
          </p>
        )}
        <Field label="Passphrase">
          <input className="input" type="password" autoComplete="current-password" value={openPass}
            onChange={(e) => setOpenPass(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void unlock(); }} />
        </Field>
        {loadError && <p className="field-note bad">{loadError}</p>}
        <button type="button" className="btn btn-ghost" disabled={!loaded || !openPass || opening} onClick={unlock}>
          {opening ? "Decrypting" : "Unlock"}
        </button>
      </Step>
    </div>
  );
}
