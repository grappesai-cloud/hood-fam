"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAccount } from "wagmi";

import { api } from "@/lib/api";
import { useLive } from "@/lib/live";
import { describe, pendingReferral, rememberReferral, useWalletSession } from "@/lib/session";
import { brand } from "@/brands";

/// The small social controls that appear on other people's pages: follow a trader, watch a launch,
/// and be told when a launch you watch does something. All three sit behind the pad's one session,
/// all three write a row in our own database, and none of them can spend anything.

/// Keeps `?ref=` from the link until a wallet is around to be tied to it. Mounted once, in the
/// layout, so a referral link works wherever it points rather than only at the front page.
export function ReferralCatcher() {
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get("ref");
    if (code) rememberReferral(code);
  }, []);
  return null;
}

export function FollowButton({ address, className }: { address: string; className?: string }) {
  const { address: me } = useAccount();
  const { authed, signingIn } = useWalletSession();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const { data } = useQuery({
    queryKey: ["trader", address],
    queryFn: () => api<{ following: boolean }>(`/traders/${address}`),
    enabled: Boolean(address),
  });
  const mine = me?.toLowerCase() === address.toLowerCase();
  const following = Boolean(data?.following);
  if (mine) return null;

  async function toggle() {
    setBusy(true);
    setError(undefined);
    try {
      await authed(`/follows/${address}`, { method: following ? "DELETE" : "POST" });
      void queryClient.invalidateQueries({ queryKey: ["trader", address] });
      void queryClient.invalidateQueries({ queryKey: ["follows"] });
      void queryClient.invalidateQueries({ queryKey: ["feed"] });
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className={className}>
      <button className={`btn${following ? " btn-ghost" : ""}`} onClick={toggle} disabled={busy || signingIn}>
        {signingIn ? "Sign in" : busy ? "…" : following ? "Following" : "Follow"}
      </button>
      {error && <span className="text-xs dim"> {error}</span>}
    </span>
  );
}

export function WatchButton({ token, className }: { token: string; className?: string }) {
  const { address } = useAccount();
  const { authed, signedIn, signingIn } = useWalletSession();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);

  const { data } = useQuery({
    queryKey: ["watchlist"],
    queryFn: () => authed<{ watching: { token: string }[] }>("/watchlist"),
    enabled: Boolean(address) && signedIn,
    retry: false,
  });
  const watching = Boolean(data?.watching?.some((w) => w.token.toLowerCase() === token.toLowerCase()));

  async function toggle() {
    setBusy(true);
    try {
      await authed(`/watchlist/${token}`, { method: watching ? "DELETE" : "POST" });
      void queryClient.invalidateQueries({ queryKey: ["watchlist"] });
    } finally {
      setBusy(false);
    }
  }

  return (
    <button className={`watch-button${watching ? " is-watching" : ""} ${className ?? ""}`}
      onClick={toggle} disabled={busy || signingIn} aria-pressed={watching}
      title={watching ? "You are told when this one moves" : "Tell me when this one moves"}>
      <span aria-hidden="true">{watching ? "★" : "☆"}</span>
      <span className="watch-label">{watching ? "Watching" : "Watch"}</span>
    </button>
  );
}

/// Browser notifications for the launches a wallet watches.
///
/// The stream is the one the whole app already holds open, so this adds no connection and no
/// polling: it filters the events that are already arriving. Permission is asked by a button and
/// never on load, because a page that asks the moment it opens is a page people say no to once and
/// for ever. Nothing is stored on a server and nothing is pushed: close the tab and it stops, which
/// is the honest shape of a browser notification.
export function Alerts() {
  const { address } = useAccount();
  const { authed, signedIn } = useWalletSession();
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">("default");
  const watched = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (typeof window === "undefined" || !("Notification" in window)) return setPermission("unsupported");
    setPermission(Notification.permission);
  }, []);

  const { data } = useQuery({
    queryKey: ["watchlist"],
    queryFn: () => authed<{ watching: { token: string; symbol: string }[] }>("/watchlist"),
    enabled: Boolean(address) && signedIn,
    retry: false,
  });
  useEffect(() => {
    watched.current = new Set((data?.watching ?? []).map((w) => w.token.toLowerCase()));
  }, [data]);

  const tokens = (data?.watching ?? []).map((w) => w.token);
  useLive({
    tokens,
    onTrade: (event) => {
      if (permission !== "granted") return;
      if (!watched.current.has(String(event.token).toLowerCase())) return;
      const symbol = data?.watching.find((w) => w.token.toLowerCase() === String(event.token).toLowerCase())?.symbol ?? "A launch";
      say(`${symbol}: somebody ${event.side === "buy" ? "bought" : "sold"}`, `/token/${event.token}`);
    },
    onGraduated: (event) => {
      if (permission !== "granted") return;
      if (!watched.current.has(String(event.token).toLowerCase())) return;
      const symbol = data?.watching.find((w) => w.token.toLowerCase() === String(event.token).toLowerCase())?.symbol ?? "A launch";
      say(`${symbol} graduated. Liquidity is live and locked.`, `/token/${event.token}`);
    },
  });

  if (permission === "unsupported" || !address) return null;
  if (permission === "granted") return <span className="dim text-xs">Alerts on for {tokens.length} launches.</span>;
  return (
    <button className="btn btn-ghost" onClick={async () => setPermission(await Notification.requestPermission())}>
      Turn on alerts
    </button>
  );
}

function say(body: string, href: string) {
  try {
    const note = new Notification(brand.name, { body, tag: href });
    note.onclick = () => { window.open(href, "_blank"); };
  } catch {
    /* a browser that refuses to construct one is a browser that said no; nothing to do */
  }
}

/// Shown once, on the front page, when somebody arrived through a link and has a wallet connected.
export function ReferralPrompt() {
  const { address } = useAccount();
  const { authed } = useWalletSession();
  const [code, setCode] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => { setCode(pendingReferral()); }, []);
  if (!code || !address || done) return null;

  return (
    <div className="panel refer-prompt">
      <p>You arrived through a friend&apos;s link. Tying your wallet to it costs you nothing and pays them a tenth of the points you earn.</p>
      <div className="refer-prompt-actions">
        <button className="btn" onClick={async () => {
          try {
            await authed("/refer/bind", { method: "POST", body: { code } });
            setDone(true);
          } catch (e) {
            setError(describe(e));
          }
        }}>Tie it</button>
        <button className="btn btn-ghost" onClick={() => setDone(true)}>No thanks</button>
      </div>
      {error && <p className="text-xs dim">{error}</p>}
    </div>
  );
}
