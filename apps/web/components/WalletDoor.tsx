"use client";

import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { usePreferredConnector } from "@/lib/safe";

/// A phone with no way in.
///
/// A desktop browser has an extension; a Safe has its own frame; a phone has neither. WalletConnect
/// is the usual answer and it needs a project id, so where one is not configured a phone reaches a
/// Connect button that cannot do anything. Every mobile wallet ships a browser of its own though,
/// and every one of them takes a link that opens a site inside it, where the wallet is injected and
/// the ordinary path works. So the dead button becomes a door: open this site in a wallet you have.
///
/// It shows only when there is genuinely no other way: no wallet injected, no connector to offer,
/// nothing connected, and a touch screen. On a desktop without an extension it stays out of the way,
/// because the answer there is to install one, not to open an app.

interface Door {
  name: string;
  href: (url: URL) => string;
}

const DOORS: Door[] = [
  // Each of these is the wallet's own documented "open this dapp" link. The site is passed as it is
  // being read, path and all, so the reader lands on the page they were already on.
  { name: "MetaMask", href: (url) => `https://metamask.app.link/dapp/${url.host}${url.pathname}${url.search}` },
  { name: "Coinbase Wallet", href: (url) => `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(url.toString())}` },
  { name: "Trust", href: (url) => `https://link.trustwallet.com/open_url?coin_id=60&url=${encodeURIComponent(url.toString())}` },
];

export function WalletDoor() {
  const { isConnected } = useAccount();
  const connector = usePreferredConnector();
  const [url, setUrl] = useState<URL | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const touch = window.matchMedia("(hover: none)").matches;
    const injected = Boolean((window as { ethereum?: unknown }).ethereum);
    const framed = window.parent !== window;
    if (!touch || injected || framed) return;
    try {
      setUrl(new URL(window.location.href));
    } catch {
      // A URL that cannot be parsed is not one worth handing to a wallet.
    }
  }, []);

  if (!url || isConnected || connector || dismissed) return null;

  return (
    <aside className="wallet-door" role="note">
      <div className="wallet-door-said">
        <strong>To trade here, open this page in your wallet.</strong>
        <span>A phone browser has no wallet in it. Every wallet below has a browser that does.</span>
      </div>
      <div className="wallet-door-links">
        {DOORS.map((door) => (
          <a key={door.name} className="btn btn-ghost" href={door.href(url)} rel="noreferrer noopener">
            {door.name}
          </a>
        ))}
      </div>
      <button type="button" className="wallet-door-close" onClick={() => setDismissed(true)} aria-label="Close">
        close
      </button>
    </aside>
  );
}
