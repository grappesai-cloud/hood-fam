"use client";

import { useState } from "react";
import Link from "next/link";
import { isAddress, parseUnits, type Address, type PrivateKeyAccount } from "viem";
import { useReadContract } from "wagmi";
import { hoodCurveAbi } from "@hood/sdk";
import { fmt } from "@/lib/format";
import { sellOnCurve, sendTokens, sweepEth, withdrawLock, type Report } from "./deskChain";

/// The four things one team wallet can do from the desk, each signed by that wallet alone.

export interface DeskToken {
  token: Address;
  symbol: string;
  decimals: number;
  mode: "curve" | "direct";
  curve: Address | null;
  /// HoodCurve.phase: 0 trading, 1 sold out, 2 graduated. Null for a direct token or before it is read.
  phase: number | null;
  pairSymbol: string;
  pairDecimals: number;
}

export interface LockView {
  id: bigint;
  owner: Address;
  amount: bigint;
  unlockAt: bigint;
}

export type Run = (action: string, work: (report: Report) => Promise<void>) => void;

export const PCTS = [25, 50, 100] as const;

/// `now` is the chain's clock, the latest block's timestamp, because that is the clock the lock
/// checks. The laptop's clock can be minutes off, and a fork's can be days off.
export function lockOpen(lock: LockView | undefined, wallet: Address, now: bigint): boolean {
  return Boolean(lock && lock.amount > 0n && lock.owner.toLowerCase() === wallet.toLowerCase()
    && lock.unlockAt <= now);
}

export function whenText(unlockAt: bigint): string {
  return new Date(Number(unlockAt) * 1000).toLocaleString("en-US", {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function amountOf(text: string, decimals: number): bigint | null {
  try {
    const v = parseUnits(text.trim().replace(/,/g, ""), decimals);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}

export function WalletActions({ account, info, balance, lock, lockAddress, now, busy, run }: {
  account: PrivateKeyAccount;
  now: bigint;
  info: DeskToken | null;
  balance: bigint;
  lock: LockView | undefined;
  lockAddress: Address | undefined;
  busy: boolean;
  run: Run;
}) {
  const [pct, setPct] = useState("25");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [sweepTo, setSweepTo] = useState("");

  const pctNum = Math.min(100, Math.max(0, Number(pct) || 0));
  const tokensIn = pctNum >= 100 ? balance : (balance * BigInt(Math.round(pctNum * 100))) / 10_000n;
  const curveOpen = info?.mode === "curve" && info.curve !== null && info.phase === 0;
  const { data: quote } = useReadContract({
    address: info?.curve ?? undefined, abi: hoodCurveAbi, functionName: "quoteSell", args: [tokensIn],
    query: { enabled: curveOpen && tokensIn > 0n, refetchInterval: 10_000 },
  });

  const toOk = isAddress(to.trim());
  const sendAmount = info ? amountOf(amount, info.decimals) : null;
  const sweepOk = isAddress(sweepTo.trim());
  const canWithdraw = lockAddress && lock && lockOpen(lock, account.address, now);

  return (
    <div className="desk-manage">
      <div className="desk-manage-cell">
        <span className="field-label">Lock</span>
        {!lock || lock.amount === 0n ? <span className="dim text-sm">{lock ? "Already withdrawn." : "No lock for this wallet."}</span> : (
          <>
            <span className="text-sm">
              <span className="mono">#{lock.id.toString()}</span>, {info ? `${fmt(lock.amount, info.decimals, 2)} ${info.symbol}` : ""}, opens {whenText(lock.unlockAt)}
            </span>
            <button type="button" className="btn btn-ghost desk-small" disabled={busy || !canWithdraw}
              onClick={() => lockAddress && run(`withdraw lock #${lock.id}`, (r) => withdrawLock(account, lockAddress, lock.id, r))}>
              {canWithdraw ? "Withdraw" : "Still locked"}
            </button>
          </>
        )}
      </div>

      <div className="desk-manage-cell">
        <span className="field-label">Sell</span>
        {!info ? <span className="dim text-sm">Choose a token first.</span>
          : !curveOpen ? (
            <span className="dim text-sm">
              {info.mode === "direct" ? "This token trades in its pool, not on a curve." : "The curve is closed; the token now trades in its pool."}{" "}
              <Link href={`/token/${info.token}`}>Trade on the token page</Link>.
            </span>
          ) : (
            <>
              <div className="desk-inline">
                {PCTS.map((p) => (
                  <button key={p} type="button" className={Number(pct) === p ? "btn desk-small" : "btn btn-ghost desk-small"} onClick={() => setPct(String(p))}>{p}%</button>
                ))}
                <input className="input mono desk-pct" inputMode="decimal" value={pct} onChange={(e) => setPct(e.target.value.replace(/[^0-9.]/g, ""))} aria-label="Percent to sell" />
              </div>
              <span className="field-note">
                {tokensIn > 0n
                  ? `${fmt(tokensIn, info.decimals, 2)} ${info.symbol} for about ${fmt(quote?.[0] ?? 0n, info.pairDecimals, 6)} ${info.pairSymbol}, at least 3% under that or it does not go through.`
                  : "Nothing to sell."}
              </span>
              <button type="button" className="btn btn-ghost desk-small" disabled={busy || tokensIn === 0n || !info.curve}
                onClick={() => info.curve && run(`sell ${pctNum}%`, (r) => sellOnCurve(account, info.token, info.curve!, pctNum, r))}>
                Sell {pctNum}%
              </button>
            </>
          )}
      </div>

      <div className="desk-manage-cell">
        <span className="field-label">Send tokens</span>
        {!info ? <span className="dim text-sm">Choose a token first.</span> : (
          <>
            <input className="input mono" value={to} onChange={(e) => setTo(e.target.value)} placeholder="0x recipient" aria-label="Recipient" />
            <input className="input mono" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={`amount ${info.symbol}`} aria-label="Amount" />
            {to.trim() && !toOk && <span className="field-note bad">Not an address.</span>}
            <div className="desk-inline">
              <button type="button" className="btn btn-ghost desk-small" disabled={busy || !toOk || !sendAmount}
                onClick={() => sendAmount && run("send tokens", (r) => sendTokens(account, info.token, to.trim() as Address, sendAmount, r))}>
                Send
              </button>
              <button type="button" className="btn btn-ghost desk-small" disabled={busy || !toOk || balance === 0n}
                onClick={() => run("send all tokens", (r) => sendTokens(account, info.token, to.trim() as Address, null, r))}>
                Send all
              </button>
            </div>
          </>
        )}
      </div>

      <div className="desk-manage-cell">
        <span className="field-label">Sweep ETH</span>
        <input className="input mono" value={sweepTo} onChange={(e) => setSweepTo(e.target.value)} placeholder="0x recipient" aria-label="Sweep recipient" />
        {sweepTo.trim() && !sweepOk && <span className="field-note bad">Not an address.</span>}
        <span className="field-note">Sends the whole balance, less what the sweep itself needs for gas.</span>
        <button type="button" className="btn btn-ghost desk-small" disabled={busy || !sweepOk}
          onClick={() => run("sweep ETH", (r) => sweepEth(account, sweepTo.trim() as Address, r))}>
          Sweep
        </button>
      </div>
    </div>
  );
}
