"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import { robinhood } from "@hood/sdk";
import { shortAddress } from "@/lib/format";
import { usePreferredConnector, useSafeAccount } from "@/lib/safe";
import { SafeStrip } from "@/components/SafeStrip";
import { DemoBanner } from "@/components/DemoBanner";
import { SupportChatMount } from "@/components/SupportChatMount";
import { brand } from "@/brands";
import { Wordmark } from "./Wordmark";

const ICONS: Record<string, string> = {
  "/": "⌂",
  "/launch": "+",
  "/portfolio": "◫",
  "/leaderboard": "↗",
  "/lock": "◇",
  "/airdrop": "✦",
  "/bridge": "⇄",
};

export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();

  return (
    <div className="ox-app-shell">
      <aside className="ox-sidebar">
        <Link href="/" className="ox-brand-link" aria-label={`${brand.name} home`}>
          <Wordmark />
        </Link>

        <nav className="ox-nav" aria-label="Main navigation">
          {brand.nav.map((item) => {
            const active = item.href === "/" ? path === "/" : path.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={active ? "ox-nav-link active" : "ox-nav-link"}
                aria-current={active ? "page" : undefined}
              >
                <span className="ox-nav-icon" aria-hidden="true">{ICONS[item.href] ?? "·"}</span>
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="ox-sidebar-bottom">
          <div className="ox-chain-status">
            <i aria-hidden="true" />
            <span><b>Robinhood Chain</b><small>Network {robinhood.id}</small></span>
          </div>
          <Wallet />
          <p className="ox-side-note">Trade carefully. Tokens can lose all value.</p>
        </div>
      </aside>

      <div className="ox-content-column">
        <header className="ox-mobile-head">
          <Link href="/" aria-label={`${brand.name} home`}><Wordmark /></Link>
          <Wallet compact />
        </header>
        <SafeStrip />
        <DemoBanner />
        <main className="site-main ox-main">{children}</main>
        <footer className="ox-footer">
          <Wordmark />
          <p>Community tokens are volatile and may lose all value. Verify the contract address before trading. {brand.copy.footnote}</p>
          <nav aria-label="Legal">
            <Link href="/analytics">Analytics</Link>
            <Link href="/terms">Terms</Link>
            <Link href="/privacy">Privacy</Link>
          </nav>
        </footer>
      </div>

      <SupportChatMount />
    </div>
  );
}

function Wallet({ compact = false }: { compact?: boolean }) {
  const { address, isConnected } = useAccount();
  const { connect, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const connector = usePreferredConnector();
  const { safe } = useSafeAccount();

  if (isConnected && address) {
    return (
      <button className="ox-wallet" onClick={() => disconnect()} title="Disconnect wallet">
        <span className="ox-wallet-dot" aria-hidden="true" />
        {safe && !compact ? `Safe ${safe.threshold}/${safe.owners.length} · ` : ""}{shortAddress(address)}
      </button>
    );
  }

  return (
    <button
      className="ox-wallet ox-wallet-connect"
      disabled={isPending || !connector}
      onClick={() => connector && connect({ connector })}
    >
      {isPending ? "Connecting…" : compact ? "Connect" : "Connect wallet"}
    </button>
  );
}
