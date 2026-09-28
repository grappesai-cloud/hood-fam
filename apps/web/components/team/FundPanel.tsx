"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { parseEther, zeroAddress, type Address, type Hash } from "viem";
import { useAccount, usePublicClient, useSendTransaction, useWriteContract } from "wagmi";
import { hoodBlockZeroAbi, robinhood } from "@hood/sdk";
import { blockZeroAddress, EXPLORER } from "@/lib/config";
import { fmt, shortAddress } from "@/lib/format";
import { Field, Step } from "@/components/LaunchUI";
import { reason } from "./deskChain";

/// ETH from the funder wallet to many team wallets at once: the same amount each, or each topped up
/// to a target so a wallet that still has ETH is not funded twice. One transaction through the
/// block zero periphery when there is one (it fans the value out and files it as team gas), one
/// plain transfer per wallet otherwise. The list is shown before the wallet is asked to sign.

const MULTICALL_ETH = [{
  type: "function", name: "getEthBalance", stateMutability: "view",
  inputs: [{ name: "addr", type: "address" }], outputs: [{ name: "balance", type: "uint256" }],
}] as const;

interface Entry {
  address: Address;
  amount: bigint;
  state: "pending" | "confirmed" | "failed";
  hash?: Hash;
  error?: string;
}

export function FundPanel({ n, wallets, title, token }: {
  n: number;
  wallets: Address[];
  title: string;
  /// The launch the funding is filed under on chain, when there is one.
  token?: Address | null;
}) {
  const publicClient = usePublicClient();
  const { address: me } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const { sendTransactionAsync } = useSendTransaction();
  const [mode, setMode] = useState<"each" | "topup">("each");
  const [amountText, setAmountText] = useState("0.002");
  const [log, setLog] = useState<Entry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const balances = useQuery({
    queryKey: ["fund-balances", wallets.join(",")],
    enabled: Boolean(publicClient) && wallets.length > 0,
    refetchInterval: 15_000,
    queryFn: async () => {
      const mc = robinhood.contracts.multicall3.address;
      const res = await publicClient!.multicall({
        allowFailure: true,
        contracts: wallets.map((w) => ({ address: mc, abi: MULTICALL_ETH, functionName: "getEthBalance" as const, args: [w] as const })),
      });
      const out: Record<string, bigint | undefined> = {};
      wallets.forEach((w, i) => { const r = res[i]; out[w.toLowerCase()] = r?.status === "success" ? (r.result as bigint) : undefined; });
      return out;
    },
  });
  const balanceOf = (w: Address) => balances.data?.[w.toLowerCase()];

  let amount = 0n;
  let amountBad = false;
  try { amount = parseEther(amountText.trim() || "0"); } catch { amountBad = true; }

  // What each wallet would get. A top-up needs the balance first; until it is read, nothing counts.
  const plan = wallets.map((w) => {
    const bal = balanceOf(w);
    const give = mode === "each" ? amount : bal === undefined ? 0n : amount > bal ? amount - bal : 0n;
    return { w, bal, give };
  });
  const targets = plan.filter((p) => p.give > 0n);
  const total = targets.reduce((s, p) => s + p.give, 0n);

  async function fund() {
    if (!me || !publicClient || targets.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    const fresh: Entry[] = targets.map((t) => ({ address: t.w, amount: t.give, state: "pending" }));
    setLog(fresh);
    const patch = (i: number, p: Partial<Entry>) => setLog((l) => l.map((e, j) => (j === i ? { ...e, ...p } : e)));
    try {
      if (blockZeroAddress) {
        const list = targets.map((t) => t.w);
        const amounts = targets.map((t) => t.give);
        const args = [token ?? zeroAddress, list, amounts] as const;
        await publicClient.simulateContract({ account: me, address: blockZeroAddress, abi: hoodBlockZeroAbi, functionName: "fundGas", args, value: total });
        const hash = await writeContractAsync({ address: blockZeroAddress, abi: hoodBlockZeroAbi, functionName: "fundGas", args, value: total });
        setLog((l) => l.map((e) => ({ ...e, hash })));
        const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
        setLog((l) => l.map((e) => ({ ...e, state: receipt.status === "success" ? "confirmed" : "failed", error: receipt.status === "success" ? undefined : "Reverted." })));
      } else {
        // One request at a time to the wallet, which numbers them; the receipts are awaited together.
        const sent: { i: number; hash: Hash }[] = [];
        for (let i = 0; i < targets.length; i++) {
          try {
            const hash = await sendTransactionAsync({ to: targets[i]!.w, value: targets[i]!.give });
            patch(i, { hash });
            sent.push({ i, hash });
          } catch (e) {
            // A rejected prompt stops the rest: the person said no.
            setLog((l) => l.map((en, j) => (j >= i && en.state === "pending" ? { ...en, state: "failed", error: reason(e) } : en)));
            break;
          }
        }
        await Promise.all(sent.map(async ({ i, hash }) => {
          try {
            const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
            patch(i, receipt.status === "success" ? { state: "confirmed" } : { state: "failed", error: "Reverted." });
          } catch (e) {
            patch(i, { state: "failed", error: reason(e) });
          }
        }));
      }
    } catch (e) {
      const why = reason(e);
      setError(why);
      setLog((l) => l.map((en) => (en.state === "pending" ? { ...en, state: "failed", error: why } : en)));
    } finally {
      setBusy(false);
      void balances.refetch();
    }
  }

  return (
    <Step n={n} title={title} purpose="ETH from your connected funder wallet to these wallets, for their buys and their gas. Balances are read from the chain every 15 seconds.">
      <div className="desk-inline">
        <button type="button" className={mode === "each" ? "btn desk-small" : "btn btn-ghost desk-small"} onClick={() => setMode("each")}>Each gets</button>
        <button type="button" className={mode === "topup" ? "btn desk-small" : "btn btn-ghost desk-small"} onClick={() => setMode("topup")}>Top each up to</button>
        <Field label="ETH" error={amountBad ? "Not a number." : undefined}>
          <input className="input mono" inputMode="decimal" value={amountText} onChange={(e) => setAmountText(e.target.value)} aria-label="ETH amount" />
        </Field>
      </div>
      <p className="field-note">
        {mode === "each"
          ? "Every wallet in the set gets this much, whatever it holds now."
          : "A wallet under the target gets the difference; one at or over it gets nothing."}
      </p>

      <div className="table-scroll">
        <table className="desk-table fund-table">
          <thead><tr><th>Wallet</th><th className="num">Holds</th><th className="num">Gets</th></tr></thead>
          <tbody>
            {plan.map(({ w, bal, give }) => (
              <tr key={w}>
                <td><a className="mono" href={`${EXPLORER}/address/${w}`} target="_blank" rel="noreferrer">{shortAddress(w)}</a></td>
                <td className="num">{bal === undefined ? "–" : fmt(bal, 18, 5)}</td>
                <td className={give > 0n ? "num" : "num dim"}>{give > 0n ? fmt(give, 18, 5) : "0"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {balances.isError && <p className="field-note bad">Balances could not be read: {reason(balances.error)}</p>}

      <div className="desk-toolbar">
        <span className="text-sm">
          {targets.length === 0
            ? mode === "topup" && amount > 0n && balances.data ? "Every wallet is already at or over the target." : "Nothing to send yet."
            : <><b>{fmt(total, 18, 5)} ETH</b> to {targets.length} wallet{targets.length === 1 ? "" : "s"}, {blockZeroAddress ? "in one transaction" : "one transfer each"}.</>}
          {!me && " Connect the funder wallet to send it."}
        </span>
        <button type="button" className="btn desk-small" disabled={!me || targets.length === 0 || busy || amountBad} onClick={fund}>
          {busy ? "Waiting for your wallet…" : `Fund ${targets.length} wallet${targets.length === 1 ? "" : "s"}`}
        </button>
      </div>
      {error && <p className="field-note bad">{error}</p>}

      {log.length > 0 && (
        <details className="desk-log" open>
          <summary>This funding ({log.length})</summary>
          <ul>
            {log.map((e) => (
              <li key={e.address}>
                <span className="mono">{shortAddress(e.address)}</span>
                <span>{fmt(e.amount, 18, 5)} ETH</span>
                <span className={`desk-status ${e.state}`}>{e.state}</span>
                <span>
                  {e.hash && <a className="mono" href={`${EXPLORER}/tx/${e.hash}`} target="_blank" rel="noreferrer">{e.hash.slice(0, 10)}</a>}
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
