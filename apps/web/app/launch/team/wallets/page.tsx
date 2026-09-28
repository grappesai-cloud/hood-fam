"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { isAddress } from "viem";
import { EXPLORER } from "@/lib/config";
import { MAX_OPEN_BUYERS } from "@/lib/launchAbi";
import { shortAddress } from "@/lib/format";
import { Field, Step } from "@/components/LaunchUI";
import { MAX_TEAM_LEGS } from "@/components/TeamLegsEditor";
import { copyLines, VaultPanel } from "@/components/team/VaultPanel";
import { FundPanel } from "@/components/team/FundPanel";
import { newDraft } from "@/components/team/app/drafts";
import {
  addSet, lockAll, lockSet, normalizeAddresses, removeSet, renameSet, setName, useUnlocked, useWalletSets, type WalletSet,
} from "@/components/team/app/walletSets";

/// The team's wallets, as sets: the wallets of one encrypted file, or addresses pasted in. A set
/// is offered to the launch form (holder wallets, open buyers), to the desk (acting on a token)
/// and to the funding step below, so the same list is never typed twice. Addresses stay in this
/// browser; keys stay in memory while a file is open, and only then.

const MAX_HOLDERS = MAX_TEAM_LEGS - 1;

export default function WalletsPage() {
  const sets = useWalletSets();
  const { ids, accounts } = useUnlocked();
  const [fundId, setFundId] = useState("");
  const fundSet = sets.find((s) => s.id === fundId) ?? null;

  return (
    <div className="launch-shell desk-shell tapp-page">
      <header className="page-intro">
        <div className="section-kicker">Team launch</div>
        <h1>Wallets</h1>
        <p>
          Make fresh wallets into an encrypted file, open a file you have, or add addresses whose keys live elsewhere. Each becomes a
          set you can hand to a launch as its holder wallets or open buyers, act with on the <Link href="/launch/team/desk">desk</Link>,
          or fund below. Nothing here leaves this browser. Every wallet a launch uses is written on chain and labelled on its token page.
        </p>
      </header>

      <div className="launch-form-stack">
        <VaultPanel n={1} unlocked={accounts.length} />
        <AddAddresses n={3} />

        <Step n={4} title="Your sets" purpose="Remembered in this browser, addresses only. Open means the keys are in memory right now; Lock forgets them." done={sets.length > 0}>
          {sets.length === 0 && <p className="field-note">No sets yet. Make or open a wallet file above, or add addresses.</p>}
          {sets.length > 0 && (
            <>
              <div className="table-scroll">
                <table className="desk-table ws-table">
                  <thead>
                    <tr><th>Name</th><th className="num">Wallets</th><th>From</th><th>Keys</th><th /></tr>
                  </thead>
                  <tbody>
                    {sets.map((s) => <SetRow key={s.id} s={s} open={ids.includes(s.id)} funding={s.id === fundId} onFund={() => setFundId(s.id === fundId ? "" : s.id)} />)}
                  </tbody>
                </table>
              </div>
              {ids.length > 0 && (
                <div className="desk-inline">
                  <span className="text-sm"><b>{accounts.length}</b> wallet{accounts.length === 1 ? "" : "s"} open across {ids.length} set{ids.length === 1 ? "" : "s"}. Locks itself after 15 minutes without input.</span>
                  <button type="button" className="btn desk-small" onClick={lockAll}>Lock all</button>
                </div>
              )}
            </>
          )}
        </Step>

        {fundSet && <FundPanel n={5} wallets={fundSet.addresses} title={`Fund ${setName(fundSet)}`} />}
      </div>
    </div>
  );
}

function SetRow({ s, open, funding, onFund }: { s: WalletSet; open: boolean; funding: boolean; onFund: () => void }) {
  const router = useRouter();
  const [name, setName_] = useState(s.name);
  const [copied, setCopied] = useState(false);
  const [armed, setArmed] = useState(false);
  const [showAll, setShowAll] = useState(false);

  function launch() {
    const holders = s.addresses.map((a) => a.toLowerCase()).slice(0, MAX_HOLDERS);
    const d = newDraft({
      wallets: holders, holdersSet: s.id, holdersCount: String(holders.length),
      openBuyers: s.addresses.map((a) => a.toLowerCase()).slice(0, MAX_OPEN_BUYERS), buyersSet: s.id,
    });
    router.push(`/launch/team?draft=${d.id}`);
  }

  return (
    <>
      <tr className={funding ? "on" : undefined}>
        <td className="ws-name">
          <input className="input" value={name} placeholder={setName(s)} maxLength={80} aria-label="Set name"
            onChange={(e) => setName_(e.target.value)} onBlur={() => renameSet(s.id, name)} />
        </td>
        <td className="num">
          <button type="button" className="ws-link mono" onClick={() => setShowAll((v) => !v)} aria-expanded={showAll}>{s.addresses.length}</button>
        </td>
        <td>{s.source === "file" ? <span className="mono dim">{s.fileName ?? "file"}</span> : <span className="dim">pasted</span>}</td>
        <td>{open ? <span className="desk-tag open">open</span> : <span className="desk-tag">locked</span>}</td>
        <td>
          <div className="ws-actions">
            <button type="button" className="btn btn-ghost desk-small" onClick={async () => { setCopied(await copyLines(s.addresses)); setTimeout(() => setCopied(false), 2_000); }}>{copied ? "Copied" : "Copy"}</button>
            <button type="button" className="btn btn-ghost desk-small" onClick={launch}>Launch with it</button>
            <button type="button" className={funding ? "btn desk-small" : "btn btn-ghost desk-small"} onClick={onFund}>{funding ? "Funding below" : "Fund"}</button>
            {open && <button type="button" className="btn btn-ghost desk-small" onClick={() => lockSet(s.id)}>Lock</button>}
            <button type="button" className={`btn btn-ghost desk-small${armed ? " bad" : ""}`} onClick={() => {
              if (!armed) { setArmed(true); setTimeout(() => setArmed(false), 3_000); return; }
              removeSet(s.id);
            }}>{armed ? "Forget?" : "Forget"}</button>
          </div>
        </td>
      </tr>
      {showAll && (
        <tr className="desk-manage-row">
          <td colSpan={5}>
            <ol className="desk-addresses mono">
              {s.addresses.map((a) => <li key={a}><a href={`${EXPLORER}/address/${a}`} target="_blank" rel="noreferrer">{a}</a></li>)}
            </ol>
          </td>
        </tr>
      )}
    </>
  );
}

/// A set from addresses alone, for wallets whose keys are somewhere else (a hardware wallet, a
/// teammate's file). It can be launched with and funded; it cannot act on the desk.
function AddAddresses({ n }: { n: number }) {
  const [name, setName_] = useState("");
  const [text, setText] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const lines = text.split(/[\s,;]+/).map((l) => l.trim()).filter(Boolean);
  const bad = lines.filter((l) => !isAddress(l));
  const good = normalizeAddresses(lines);

  function add() {
    const set = addSet(name, good, "pasted");
    if (!set) return;
    setDone(`${setName(set)}: ${set.addresses.length} wallets.`);
    setName_("");
    setText("");
  }

  return (
    <Step n={n} title="Add addresses" purpose="A set of addresses only, for wallets whose keys live elsewhere. It can be launched with and funded; it cannot act on the desk." done={Boolean(done)}>
      <Field label="Name (optional)">
        <input className="input" value={name} maxLength={80} onChange={(e) => setName_(e.target.value)} placeholder="project name" />
      </Field>
      <Field label="Addresses, one per line" error={bad.length ? `${bad.length} line${bad.length === 1 ? " is" : "s are"} not an address.` : undefined}>
        <textarea className="input mono" rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder={"0xabc…\n0xdef…"} spellCheck={false} />
      </Field>
      <div className="desk-inline">
        <button type="button" className="btn btn-ghost" disabled={bad.length > 0 || good.length === 0} onClick={add}>Add {good.length || ""} as a set</button>
        {done && <span className="field-note">{done}</span>}
      </div>
    </Step>
  );
}
