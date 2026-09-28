"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  erc20Abi, getAddress, isAddress, parseEther, zeroAddress,
  type Address, type Hash, type PrivateKeyAccount,
} from "viem";
import { useAccount, usePublicClient, useReadContract, useSendTransaction, useWriteContract } from "wagmi";
import { hoodBlockZeroAbi, hoodFactoryAbi, hoodTokenLockAbi, robinhood } from "@hood/sdk";
import { addresses, blockZeroAddress, EXPLORER } from "@/lib/config";
import { fmt, shortAddress } from "@/lib/format";
import { Field, Step } from "@/components/LaunchUI";
import { copyLines } from "./VaultPanel";
import { quoteSale, reason, sellOnCurve, sweepEth, sweepPlan, withdrawLock, type Report } from "./deskChain";
import { PCTS, WalletActions, lockOpen, whenText, type DeskToken, type LockView } from "./WalletActions";

/// The desk itself: every wallet the team has open, plus the token's declared team wallets that are
/// not open here, read only. Balances and locks are read straight off the chain, not the indexer,
/// because a desk that acts on a number should act on the current one.
///
/// Every action is started by a press. A batch only runs over wallets somebody ticked, and a sale or
/// a sweep across several wallets shows the full list before anything is signed.

export interface TeamRow {
  wallet: string;
  idx: number;
  pair_spent: string;
  tokens: string;
  lock_id: string | null;
  unlock_at: string | null;
  tx: string;
  balance: string;
}

interface DeskRow {
  key: string;
  address: Address;
  account?: PrivateKeyAccount;
  team?: TeamRow;
  lockId: bigint | null;
}

interface Entry {
  id: number;
  key: string;
  address: Address;
  action: string;
  state: "pending" | "confirmed" | "failed";
  step?: string;
  txs: { step: string; hash: Hash }[];
  error?: string;
}

interface Review {
  kind: "sell" | "sweep";
  title: string;
  lines: { row: DeskRow; text: string }[];
  note: string;
  pct?: number;
  to?: Address;
}

/// Multicall3's own ETH balance read, so forty wallets are one call and not forty.
const MULTICALL_ETH = [{
  type: "function", name: "getEthBalance", stateMutability: "view",
  inputs: [{ name: "addr", type: "address" }], outputs: [{ name: "balance", type: "uint256" }],
}] as const;

function lockIdOf(raw: string | null | undefined): bigint | null {
  try {
    const id = BigInt(raw ?? "0");
    return id > 0n ? id : null;
  } catch {
    return null;
  }
}

function pctOf(text: string): number {
  return Math.min(100, Math.max(0, Number(text) || 0));
}

export function WalletDesk({ n, accounts, info, team, label, onLock }: {
  n: number;
  accounts: PrivateKeyAccount[];
  info: DeskToken | null;
  team: TeamRow[];
  label: string;
  onLock: () => void;
}) {
  const publicClient = usePublicClient();
  const { address: me } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const { sendTransactionAsync } = useSendTransaction();
  const token = info?.token ?? null;

  const { data: lockAddress } = useReadContract({
    address: addresses.factory, abi: hoodFactoryAbi, functionName: "firstBuyLocker",
    query: { enabled: addresses.factory !== zeroAddress, staleTime: Infinity },
  });
  const locker = lockAddress && lockAddress !== zeroAddress ? (lockAddress as Address) : undefined;

  // Open wallets first, in the file's order; then the declared team wallets that are not open.
  const rows = useMemo<DeskRow[]>(() => {
    const byWallet = new Map(team.map((t) => [t.wallet.toLowerCase(), t]));
    const seen = new Set<string>();
    const out: DeskRow[] = [];
    for (const account of accounts) {
      const key = account.address.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const t = byWallet.get(key);
      out.push({ key, address: account.address, account, team: t, lockId: lockIdOf(t?.lock_id) });
    }
    for (const t of team) {
      const key = t.wallet.toLowerCase();
      if (seen.has(key) || !isAddress(t.wallet)) continue;
      seen.add(key);
      out.push({ key, address: getAddress(t.wallet), team: t, lockId: lockIdOf(t.lock_id) });
    }
    return out;
  }, [accounts, team]);

  const chain = useQuery({
    queryKey: ["team-desk", token ?? "", locker ?? "", rows.map((r) => `${r.key}:${r.lockId ?? ""}`).join(",")],
    enabled: Boolean(publicClient) && rows.length > 0,
    refetchInterval: 15_000,
    queryFn: async () => {
      const pc = publicClient!;
      const mc = robinhood.contracts.multicall3.address;
      const withLock = rows.filter((r) => r.lockId !== null);
      const [block, eth, bal, locks] = await Promise.all([
        pc.getBlock({ blockTag: "latest" }),
        pc.multicall({
          allowFailure: true,
          contracts: rows.map((r) => ({ address: mc, abi: MULTICALL_ETH, functionName: "getEthBalance" as const, args: [r.address] as const })),
        }),
        token
          ? pc.multicall({
            allowFailure: true,
            contracts: rows.map((r) => ({ address: token, abi: erc20Abi, functionName: "balanceOf" as const, args: [r.address] as const })),
          })
          : Promise.resolve([]),
        locker && withLock.length
          ? pc.multicall({
            allowFailure: true,
            contracts: withLock.map((r) => ({ address: locker, abi: hoodTokenLockAbi, functionName: "locks" as const, args: [r.lockId!] as const })),
          })
          : Promise.resolve([]),
      ]);
      const out: Record<string, { eth?: bigint; bal?: bigint; lock?: LockView }> = {};
      rows.forEach((r, i) => {
        const e = eth[i];
        const b = bal[i];
        out[r.key] = {
          eth: e?.status === "success" ? (e.result as bigint) : undefined,
          bal: b?.status === "success" ? (b.result as bigint) : undefined,
        };
      });
      withLock.forEach((r, i) => {
        const l = locks[i];
        if (l?.status !== "success") return;
        const [, owner, amount, unlockAt] = l.result as readonly [Address, Address, bigint, bigint];
        out[r.key]!.lock = { id: r.lockId!, owner, amount, unlockAt: BigInt(unlockAt) };
      });
      return { now: block.timestamp, byKey: out };
    },
  });
  const data = chain.data?.byKey ?? {};
  // Until the first read lands nothing counts as open; a button that lights up and then fails is worse.
  const now = chain.data?.now ?? 0n;

  // ---- the action log, newest first; a row shows its latest entry
  const [log, setLog] = useState<Entry[]>([]);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const busyRef = useRef(new Set<string>());
  const seq = useRef(0);
  const live = useRef(new Set<string>());
  useEffect(() => { live.current = new Set(accounts.map((a) => a.address.toLowerCase())); }, [accounts]);

  function openEntries(targets: DeskRow[], action: string): number[] {
    const fresh = targets.map((r) => ({
      id: ++seq.current, key: r.key, address: r.address, action, state: "pending" as const, step: "preparing", txs: [],
    }));
    setLog((l) => [...[...fresh].reverse(), ...l].slice(0, 300));
    return fresh.map((e) => e.id);
  }
  function patch(ids: number[], p: Partial<Entry> | ((e: Entry) => Partial<Entry>)) {
    const set = new Set(ids);
    setLog((l) => l.map((e) => (set.has(e.id) ? { ...e, ...(typeof p === "function" ? p(e) : p) } : e)));
  }
  function mark(keys: string[], on: boolean) {
    keys.forEach((k) => (on ? busyRef.current.add(k) : busyRef.current.delete(k)));
    setBusy(new Set(busyRef.current));
  }

  /// One action on one open wallet. A wallet runs one action at a time, so its transactions go out
  /// in order and never race for a nonce; different wallets run side by side. A wallet locked away
  /// while a batch is still queued is skipped rather than signed for.
  async function run(row: DeskRow, action: string, work: (report: Report) => Promise<void>) {
    if (!row.account || busyRef.current.has(row.key) || !live.current.has(row.key)) return;
    mark([row.key], true);
    const [id] = openEntries([row], action);
    const report: Report = (step, hash) => patch([id!], (e) => ({ step, txs: hash ? [...e.txs, { step, hash }] : e.txs }));
    try {
      await work(report);
      patch([id!], { state: "confirmed", step: undefined });
    } catch (e) {
      patch([id!], { state: "failed", step: undefined, error: reason(e) });
    } finally {
      mark([row.key], false);
      void chain.refetch();
    }
  }

  // ---- selection
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggle = (key: string) => setSelected((s) => {
    const next = new Set(s);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const picked = rows.filter((r) => selected.has(r.key));
  const pickedOpen = picked.filter((r) => r.account);
  useEffect(() => {
    // A locked wallet or a changed token must not leave ticks on rows that are gone.
    setSelected((s) => new Set([...s].filter((k) => rows.some((r) => r.key === k))));
  }, [rows]);

  const [manage, setManage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [batchPct, setBatchPct] = useState("25");
  const [sweepTo, setSweepTo] = useState("");
  const [gasEach, setGasEach] = useState("0.001");
  const [review, setReview] = useState<Review | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);

  const curveOpen = info?.mode === "curve" && info.curve !== null && info.phase === 0;
  const openLocks = rows.filter((r) => r.account && locker && lockOpen(data[r.key]?.lock, r.address, now));

  function withdrawAllOpen() {
    if (!locker) return;
    openLocks.forEach((r) => {
      const lock = data[r.key]!.lock!;
      void run(r, `withdraw lock #${lock.id}`, (rep) => withdrawLock(r.account!, locker, lock.id, rep));
    });
  }

  async function reviewSale() {
    if (!info?.curve || !curveOpen) return;
    const pct = pctOf(batchPct);
    setBatchError(null);
    setReviewing(true);
    try {
      const quotes = await Promise.all(pickedOpen.map((r) => quoteSale(info.token, info.curve!, r.address, pct)));
      const lines = pickedOpen
        .map((row, i) => ({ row, q: quotes[i]! }))
        .filter((x) => x.q.tokensIn > 0n)
        .map(({ row, q }) => ({
          row,
          text: `${fmt(q.tokensIn, info.decimals, 2)} ${info.symbol} for about ${fmt(q.pairOut, info.pairDecimals, 6)} ${info.pairSymbol}`,
        }));
      if (lines.length === 0) { setBatchError("None of the selected open wallets holds any of the token."); return; }
      setReview({
        kind: "sell", pct, lines,
        title: `Sell ${pct}% from ${lines.length} wallet${lines.length === 1 ? "" : "s"}`,
        note: "Each wallet is quoted alone against the curve as it is now. They sell one after another, so the later ones get less than shown. Each sale is re-quoted just before it is signed and refuses to go through more than 3% under that quote.",
      });
    } catch (e) {
      setBatchError(reason(e));
    } finally {
      setReviewing(false);
    }
  }

  async function reviewSweep() {
    if (!isAddress(sweepTo.trim())) return;
    const to = getAddress(sweepTo.trim());
    setBatchError(null);
    setReviewing(true);
    try {
      const plans = await Promise.all(pickedOpen.map((r) => sweepPlan(r.address, to)));
      const lines = pickedOpen
        .map((row, i) => ({ row, p: plans[i]! }))
        .filter((x) => x.p.value > 0n)
        .map(({ row, p }) => ({ row, text: `${fmt(p.value, 18, 6)} ETH, keeps up to ${fmt(p.reserve, 18, 8)} for the sweep's gas` }));
      if (lines.length === 0) { setBatchError("None of the selected open wallets has more ETH than the sweep would cost."); return; }
      setReview({
        kind: "sweep", to, lines,
        title: `Sweep ETH from ${lines.length} wallet${lines.length === 1 ? "" : "s"} to ${shortAddress(to)}`,
        note: `Everything goes to ${to}. The unspent part of the gas reserve stays behind as dust.`,
      });
    } catch (e) {
      setBatchError(reason(e));
    } finally {
      setReviewing(false);
    }
  }

  async function confirmReview() {
    const r = review;
    setReview(null);
    if (!r) return;
    if (r.kind === "sell" && info?.curve) {
      // One after another, not side by side: each sale moves the price the next one is quoted at,
      // and a fresh quote per sale is what keeps the 3% floor honest.
      for (const { row } of r.lines) {
        await run(row, `sell ${r.pct}%`, (rep) => sellOnCurve(row.account!, info.token, info.curve!, r.pct!, rep));
      }
    } else if (r.kind === "sweep" && r.to) {
      await Promise.all(r.lines.map(({ row }) => run(row, "sweep ETH", (rep) => sweepEth(row.account!, r.to!, rep))));
    }
  }

  /// Gas for the team wallets, paid by the wallet connected to the site. Through the block zero
  /// periphery when there is one and a token to file it under, so the funding shows on chain as
  /// team gas for that launch; otherwise one plain transfer per wallet.
  async function fundGas() {
    let each: bigint;
    try { each = parseEther(gasEach.trim() || "0"); } catch { setBatchError("The gas amount is not a number."); return; }
    if (!me || each <= 0n || picked.length === 0 || !publicClient) return;
    setBatchError(null);
    const targets = picked;
    const ids = openEntries(targets, `fund gas ${fmt(each, 18, 6)} ETH`);
    try {
      if (blockZeroAddress && token) {
        const wallets = targets.map((r) => r.address);
        const amounts = targets.map(() => each);
        const value = each * BigInt(targets.length);
        await publicClient.simulateContract({
          account: me, address: blockZeroAddress, abi: hoodBlockZeroAbi, functionName: "fundGas",
          args: [token, wallets, amounts], value,
        });
        patch(ids, { step: "waiting for your wallet" });
        const hash = await writeContractAsync({
          address: blockZeroAddress, abi: hoodBlockZeroAbi, functionName: "fundGas",
          args: [token, wallets, amounts], value,
        });
        patch(ids, (e) => ({ step: "funding", txs: [...e.txs, { step: "fund", hash }] }));
        const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
        if (receipt.status !== "success") throw new Error("The transaction reverted on chain.");
        patch(ids, { state: "confirmed", step: undefined });
      } else {
        // One request at a time to the wallet, which numbers them; the receipts are awaited together.
        const sent: { id: number; hash: Hash }[] = [];
        for (let i = 0; i < targets.length; i++) {
          patch([ids[i]!], { step: "waiting for your wallet" });
          try {
            const hash = await sendTransactionAsync({ to: targets[i]!.address, value: each });
            patch([ids[i]!], (e) => ({ step: "funding", txs: [...e.txs, { step: "fund", hash }] }));
            sent.push({ id: ids[i]!, hash });
          } catch (e) {
            // A rejected prompt stops the rest: the person said no, and asking thirty more times is not an answer to that.
            patch(ids.slice(i), { state: "failed", step: undefined, error: reason(e) });
            break;
          }
        }
        await Promise.all(sent.map(async ({ id, hash }) => {
          try {
            const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
            patch([id], receipt.status === "success" ? { state: "confirmed", step: undefined } : { state: "failed", step: undefined, error: "Reverted." });
          } catch (e) {
            patch([id], { state: "failed", step: undefined, error: reason(e) });
          }
        }));
      }
    } catch (e) {
      patch(ids, (en) => (en.state === "pending" ? { state: "failed", step: undefined, error: reason(e) } : {}));
    } finally {
      void chain.refetch();
    }
  }

  const latest = useMemo(() => {
    const m = new Map<string, Entry>();
    for (const e of log) if (!m.has(e.key)) m.set(e.key, e);
    return m;
  }, [log]);

  const gasTotal = (() => {
    try { return parseEther(gasEach.trim() || "0") * BigInt(picked.length); } catch { return 0n; }
  })();
  const openCount = accounts.length;

  return (
    <Step n={n} title="Team wallets" purpose="Open wallets can act; declared team wallets that are not open here are shown read only. Balances are read from the chain every 15 seconds.">
      <div className="desk-toolbar">
        <span className="text-sm">
          {openCount > 0
            ? <><b>{openCount}</b> wallet{openCount === 1 ? "" : "s"} open{label ? <> from <b>{label}</b></> : null}. Locks itself after 15 minutes without input.</>
            : "No wallets open. Make or open a wallet file above."}
        </span>
        <div className="desk-inline">
          {openCount > 0 && (
            <button type="button" className="btn btn-ghost desk-small" onClick={async () => {
              setCopied(await copyLines(accounts.map((a) => a.address)));
              setTimeout(() => setCopied(false), 2_000);
            }}>{copied ? "Copied" : "Copy addresses"}</button>
          )}
          {openCount > 0 && <button type="button" className="btn desk-small" onClick={onLock}>Lock</button>}
        </div>
      </div>

      {rows.length > 0 && (
        <div className="table-scroll">
          <table className="desk-table">
            <thead>
              <tr>
                <th>
                  <input type="checkbox" aria-label="Select all"
                    checked={selected.size > 0 && selected.size === rows.length}
                    onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.key)) : new Set())} />
                </th>
                <th>Wallet</th>
                <th className="num">ETH</th>
                <th className="num">{info ? info.symbol : "Token"}</th>
                <th>Lock</th>
                <th>Last action</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const d = data[r.key];
                const lock = d?.lock;
                const entry = latest.get(r.key);
                const last = entry?.txs[entry.txs.length - 1];
                return (
                  <Fragment key={r.key}>
                    <tr className={selected.has(r.key) ? "on" : undefined}>
                      <td><input type="checkbox" aria-label={`Select ${r.address}`} checked={selected.has(r.key)} onChange={() => toggle(r.key)} /></td>
                      <td>
                        <a className="mono" href={`${EXPLORER}/address/${r.address}`} target="_blank" rel="noreferrer">{shortAddress(r.address)}</a>
                        {r.team && <span className="desk-tag team">team #{r.team.idx}</span>}
                        {!r.account && <span className="desk-tag">read only</span>}
                      </td>
                      <td className={r.account && d?.eth === 0n ? "num bad" : "num"}>
                        {d?.eth === undefined ? "–" : fmt(d.eth, 18, 5)}
                      </td>
                      <td className="num">{!info || d?.bal === undefined ? "–" : fmt(d.bal, info.decimals, 2)}</td>
                      <td>
                        {r.lockId === null ? <span className="dim">none</span>
                          : !lock ? <span className="mono dim">#{r.lockId.toString()}</span>
                          : lock.amount === 0n ? <span className="dim">#{lock.id.toString()} withdrawn</span>
                          : (
                            <span>
                              <span className="mono">#{lock.id.toString()}</span> {whenText(lock.unlockAt)}{" "}
                              <span className={lockOpen(lock, r.address, now) ? "desk-tag open" : "desk-tag"}>{lockOpen(lock, r.address, now) ? "withdrawable" : "locked"}</span>
                            </span>
                          )}
                      </td>
                      <td>
                        {entry ? (
                          <span className={`desk-status ${entry.state}`} title={entry.error}>
                            {entry.action}: {entry.state === "pending" ? entry.step ?? "pending" : entry.state}
                            {last && <> <a className="mono" href={`${EXPLORER}/tx/${last.hash}`} target="_blank" rel="noreferrer">{last.hash.slice(0, 10)}</a></>}
                          </span>
                        ) : <span className="dim">–</span>}
                      </td>
                      <td>
                        {r.account && (
                          <button type="button" className="btn btn-ghost desk-small" aria-expanded={manage === r.key}
                            onClick={() => setManage((m) => (m === r.key ? null : r.key))}>
                            {manage === r.key ? "Close" : "Manage"}
                          </button>
                        )}
                      </td>
                    </tr>
                    {manage === r.key && r.account && (
                      <tr className="desk-manage-row">
                        <td colSpan={7}>
                          <WalletActions account={r.account} info={info} balance={d?.bal ?? 0n} lock={lock}
                            lockAddress={locker} now={now} busy={busy.has(r.key)}
                            run={(action, work) => void run(r, action, work)} />
                          {entry?.state === "failed" && entry.error && <p className="field-note bad">{entry.error}</p>}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {chain.isError && <p className="field-note bad">Balances could not be read: {reason(chain.error)}</p>}

      {rows.length > 0 && (
        <div className="desk-batch">
          <div className="desk-batch-cell">
            <span className="field-label">Locks</span>
            <span className="field-note">{openLocks.length} open wallet{openLocks.length === 1 ? " has a lock" : "s have locks"} ready to withdraw.</span>
            <button type="button" className="btn btn-ghost desk-small" disabled={openLocks.length === 0} onClick={withdrawAllOpen}>
              Withdraw all that are open
            </button>
          </div>

          <div className="desk-batch-cell">
            <span className="field-label">Sell from selected</span>
            {!info ? <span className="field-note">Choose a token first.</span>
              : !curveOpen ? (
                <span className="field-note">
                  {info.mode === "direct" ? "A direct token trades in its pool." : "The curve is closed."}{" "}
                  <Link href={`/token/${info.token}`}>Trade on the token page</Link>.
                </span>
              ) : (
                <>
                  <div className="desk-inline">
                    {PCTS.map((p) => (
                      <button key={p} type="button" className={Number(batchPct) === p ? "btn desk-small" : "btn btn-ghost desk-small"} onClick={() => setBatchPct(String(p))}>{p}%</button>
                    ))}
                    <input className="input mono desk-pct" inputMode="decimal" value={batchPct} onChange={(e) => setBatchPct(e.target.value.replace(/[^0-9.]/g, ""))} aria-label="Percent to sell" />
                  </div>
                  <button type="button" className="btn btn-ghost desk-small" disabled={pickedOpen.length === 0 || pctOf(batchPct) === 0 || reviewing} onClick={reviewSale}>
                    Review sale from {pickedOpen.length} selected
                  </button>
                </>
              )}
          </div>

          <div className="desk-batch-cell">
            <span className="field-label">Sweep ETH from selected</span>
            <input className="input mono" value={sweepTo} onChange={(e) => setSweepTo(e.target.value)} placeholder="0x recipient" aria-label="Sweep recipient" />
            {sweepTo.trim() && !isAddress(sweepTo.trim()) && <span className="field-note bad">Not an address.</span>}
            <button type="button" className="btn btn-ghost desk-small" disabled={pickedOpen.length === 0 || !isAddress(sweepTo.trim()) || reviewing} onClick={reviewSweep}>
              Review sweep from {pickedOpen.length} selected
            </button>
          </div>

          <div className="desk-batch-cell">
            <Field label="Fund gas, ETH per wallet" help={me ? `From your connected wallet: ${fmt(gasTotal, 18, 6)} ETH to ${picked.length} selected.` : "Connect a wallet to pay for it."}>
              <input className="input mono" inputMode="decimal" value={gasEach} onChange={(e) => setGasEach(e.target.value)} />
            </Field>
            <button type="button" className="btn btn-ghost desk-small" disabled={!me || picked.length === 0 || gasTotal === 0n} onClick={fundGas}>
              Fund {picked.length} selected
            </button>
          </div>
        </div>
      )}
      {batchError && <p className="field-note bad">{batchError}</p>}

      {review && (
        <div className="desk-confirm" role="dialog" aria-label={review.title}>
          <h3>{review.title}</h3>
          <ul>
            {review.lines.map(({ row, text }) => (
              <li key={row.key}><span className="mono">{row.address}</span><span>{text}</span></li>
            ))}
          </ul>
          <p className="field-note">{review.note}</p>
          <div className="desk-inline">
            <button type="button" className="btn desk-small" onClick={confirmReview}>Confirm and sign</button>
            <button type="button" className="btn btn-ghost desk-small" onClick={() => setReview(null)}>Cancel</button>
          </div>
        </div>
      )}

      {log.length > 0 && (
        <details className="desk-log">
          <summary>Activity in this tab ({log.length})</summary>
          <ul>
            {log.map((e) => (
              <li key={e.id}>
                <span className="mono">{shortAddress(e.address)}</span>
                <span>{e.action}</span>
                <span className={`desk-status ${e.state}`}>{e.state === "pending" ? e.step ?? "pending" : e.state}</span>
                <span>
                  {e.txs.map((t) => (
                    <a key={t.hash} className="mono" href={`${EXPLORER}/tx/${t.hash}`} target="_blank" rel="noreferrer">{t.step} {t.hash.slice(0, 10)} </a>
                  ))}
                  {e.error && <span className="bad"> {e.error}</span>}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </Step>
  );
}
