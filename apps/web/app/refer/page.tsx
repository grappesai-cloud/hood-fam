"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAccount } from "wagmi";

import { shortAddress } from "@/lib/format";
import { clearReferral, describe, pendingReferral, useWalletSession } from "@/lib/session";

/// Bringing somebody, and what it pays.
///
/// A referral here is a tenth of the points the wallet you brought earns by trading, paid on top of
/// theirs rather than out of them: nobody is worse off for having come through a link. It only
/// counts trades made after the two wallets were tied together, and the tie is written once and
/// never re-pointed, because a referral that can be moved later is one worth farming.

interface Summary {
  code: string;
  season: number;
  points: number;
  paidEvents: number;
  broughtBy: string | null;
  boundAt: string | null;
  friends: { address: string; boundAt: string; volumeUsd: number; trades: number }[];
}

export default function ReferPage() {
  const { address } = useAccount();
  const { authed, signingIn } = useWalletSession();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string>();
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => { setPending(pendingReferral()); }, []);

  const { data } = useQuery({
    queryKey: ["refer", address],
    queryFn: () => authed<Summary>("/refer/me"),
    enabled: Boolean(address),
    retry: false,
  });

  const link = typeof window !== "undefined" && address
    ? `${window.location.origin}/?ref=${address.toLowerCase()}`
    : "";

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setMessage("This browser would not let the page copy. Select the link and copy it by hand.");
    }
  }

  async function bind(code: string) {
    setMessage(undefined);
    try {
      await authed("/refer/bind", { method: "POST", body: { code } });
      clearReferral();
      setPending(null);
      setMessage(`You are now tied to ${shortAddress(code)}. It costs you nothing and pays them a tenth of what you earn.`);
      void queryClient.invalidateQueries({ queryKey: ["refer"] });
    } catch (error) {
      setMessage(describe(error));
    }
  }

  const friends = data?.friends ?? [];
  const traded = friends.filter((f) => f.volumeUsd > 0).length;

  return (
    <div className="refer-shell">
      <div className="page-head">
        <header className="page-intro">
          <div className="section-kicker">Bring the fam</div>
          <h1>Your link</h1>
          <p>
            Every wallet that arrives through it and trades earns you a tenth of its points, for as
            long as it trades. Their points are untouched: the share is paid on top, out of the same
            season pool everything else is paid from.
          </p>
        </header>
        <div className="head-figure">
          <strong>{Math.round(data?.points ?? 0).toLocaleString("en-US")}</strong>
          <span>points earned from referrals</span>
        </div>
      </div>

      {!address && <p className="panel p-6 text-sm dim">Connect a wallet to get your link.</p>}

      {address && (
        <div className="panel refer-link">
          <label htmlFor="refer-link">Your link</label>
          <div className="refer-row">
            <input id="refer-link" className="input mono" readOnly value={link} onFocus={(e) => e.target.select()} />
            <button className="btn" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
          </div>
          <p className="dim text-xs">
            The code is your own address, so anybody can check on chain who they are about to be tied
            to before they click. {signingIn ? "Sign in your wallet to load your friends." : ""}
          </p>
        </div>
      )}

      {pending && address && !data?.broughtBy && (
        <div className="panel refer-pending">
          <p>You arrived through {shortAddress(pending)}&apos;s link.</p>
          <button className="btn" onClick={() => bind(pending)}>Tie my wallet to it</button>
        </div>
      )}

      {data?.broughtBy && (
        <p className="text-sm dim">
          You were brought by <Link href={`/trader/${data.broughtBy}`} className="mono">{shortAddress(data.broughtBy)}</Link>
          {data.boundAt ? ` on ${new Date(data.boundAt).toLocaleDateString()}` : ""}. That does not change.
        </p>
      )}
      {message && <p className="text-sm dim">{message}</p>}

      {address && (
        <section className="panel">
          <header className="refer-head">
            <h2>Who you brought</h2>
            <span className="dim text-sm">{friends.length} tied · {traded} trading</span>
          </header>
          <div className="table-scroll">
            <table>
              <thead>
                <tr><th>Wallet</th><th>Since</th><th>Volume</th><th>Trades</th></tr>
              </thead>
              <tbody>
                {friends.map((friend) => (
                  <tr key={friend.address}>
                    <td><Link href={`/trader/${friend.address}`} className="mono">{shortAddress(friend.address)}</Link></td>
                    <td className="dim">{new Date(friend.boundAt).toLocaleDateString()}</td>
                    <td>${Math.round(friend.volumeUsd).toLocaleString("en-US")}</td>
                    <td>{friend.trades}</td>
                  </tr>
                ))}
                {!friends.length && (
                  <tr><td colSpan={4} className="dim">Nobody yet. The link works from the moment you copy it.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
