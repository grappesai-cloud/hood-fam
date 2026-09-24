"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useAccount } from "wagmi";

import { api } from "@/lib/api";
import { ago, compact, imageUrl, shortAddress } from "@/lib/format";
import { useWalletSession } from "@/lib/session";
import { Alerts, WatchButton } from "@/components/Social";

/// Your crowd: the wallets you follow, the launches you watch, and the one feed that comes out of
/// both. Nothing here is a copy-trading bot — a trade you see is a trade you still sign yourself,
/// which is why every row ends in a link to that launch rather than in a button that spends.

interface FeedRow {
  token: string; side: string; trader: string; tokenAmount: string; at: string;
  name: string; symbol: string; image: string;
}

interface Watching {
  watching: { token: string; symbol: string; name: string; image: string; since: string }[];
}

export default function FollowingPage() {
  const { address } = useAccount();
  const { authed, signedIn, signIn, signingIn } = useWalletSession();

  const { data: feed } = useQuery({
    queryKey: ["feed"],
    queryFn: () => authed<{ feed: FeedRow[] }>("/feed?limit=60"),
    enabled: Boolean(address) && signedIn,
    refetchInterval: 20_000,
    retry: false,
  });
  const { data: follows } = useQuery({
    queryKey: ["follows"],
    queryFn: () => authed<{ following: { address: string; since: string }[] }>("/follows"),
    enabled: Boolean(address) && signedIn,
    retry: false,
  });
  const { data: watchlist } = useQuery({
    queryKey: ["watchlist"],
    queryFn: () => authed<Watching>("/watchlist"),
    enabled: Boolean(address) && signedIn,
    retry: false,
  });

  const rows = feed?.feed ?? [];

  return (
    <div className="following-shell">
      <div className="page-head">
        <header className="page-intro">
          <div className="section-kicker">Your crowd</div>
          <h1>Following</h1>
          <p>
            Traders you follow and launches you watch. The feed is the same public tape the board
            shows, narrowed to the wallets you chose; the alerts are drawn by your browser off the
            stream this page already holds open.
          </p>
        </header>
        <div className="head-figure">
          <strong>{follows?.following.length ?? "·"}</strong>
          <span>wallets followed</span>
        </div>
      </div>

      {!address && <p className="panel p-6 text-sm dim">Connect a wallet to keep a crowd.</p>}
      {address && !signedIn && (
        <div className="panel p-6 flex items-center gap-4">
          <p className="text-sm dim">One signature proves the wallet is yours. It moves nothing and costs nothing.</p>
          <button className="btn" onClick={signIn} disabled={signingIn}>{signingIn ? "Check your wallet" : "Sign in"}</button>
        </div>
      )}

      {signedIn && (
        <>
          <section className="panel watch-panel">
            <header className="refer-head">
              <h2>Watching</h2>
              <Alerts />
            </header>
            <div className="watch-row">
              {(watchlist?.watching ?? []).map((w) => (
                <Link key={w.token} href={`/token/${w.token}`} className="watch-chip">
                  {w.image ? <img src={imageUrl(w.image)} alt="" /> : <span className="watch-initials">{w.symbol.slice(0, 2)}</span>}
                  <span>${w.symbol}</span>
                </Link>
              ))}
              {!watchlist?.watching.length && (
                <p className="dim text-sm">Nothing yet. The star on any launch puts it here.</p>
              )}
            </div>
          </section>

          <section className="panel">
            <header className="refer-head"><h2>What they are doing</h2></header>
            <ul className="feed-list">
              {rows.map((row, i) => (
                <li key={`${row.token}-${row.at}-${i}`}>
                  <Link href={`/trader/${row.trader}`} className="mono">{shortAddress(row.trader)}</Link>
                  <span className={row.side === "buy" ? "text-[var(--color-green)]" : "text-[var(--color-red)]"}>
                    {row.side === "buy" ? "bought" : "sold"}
                  </span>
                  <Link href={`/token/${row.token}`}>${row.symbol}</Link>
                  <span className="dim">{compact(BigInt(row.tokenAmount))}</span>
                  <span className="dim">{ago(row.at)}</span>
                  <WatchButton token={row.token} className="feed-watch" />
                </li>
              ))}
              {!rows.length && (
                <li className="dim feed-empty">
                  Nobody you follow has traded yet. Find someone on the <Link href="/leaderboard">board</Link>.
                </li>
              )}
            </ul>
          </section>

          <section className="panel">
            <header className="refer-head"><h2>Followed wallets</h2></header>
            <div className="watch-row">
              {(follows?.following ?? []).map((f) => (
                <Link key={f.address} href={`/trader/${f.address}`} className="watch-chip mono">{shortAddress(f.address)}</Link>
              ))}
              {!follows?.following.length && <p className="dim text-sm">Nobody yet.</p>}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
