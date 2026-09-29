"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import { robinhood } from "@hood/sdk";
import { shortAddress } from "@/lib/format";
import { usePreferredConnector, useSafeAccount } from "@/lib/safe";
import { SafeStrip } from "@/components/SafeStrip";
import { DemoBanner } from "@/components/DemoBanner";
import { SupportChatMount } from "@/components/SupportChatMount";
import { brand } from "@/brands";
import { Wordmark } from "./Wordmark";

const PRIMARY_NAV = [
  { href: "/discover", label: "Discover" },
  { href: "/airdrop", label: "Your cut" },
  { href: "/following", label: "Following" },
  { href: "/analytics", label: "Analytics" },
  { href: "/portfolio", label: "Portfolio" },
] as const;

const MORE_NAV = [
  { href: "/leaderboard", label: "Leaderboard" },
  { href: "/ledger", label: "Ledger" },
  { href: "/bag", label: "The Bag" },
  { href: "/quests", label: "Quests" },
  { href: "/lock", label: "Lock" },
  { href: "/refer", label: "Refer" },
  { href: "/bridge", label: "Bridge" },
  { href: "/docs", label: "Docs" },
  { href: "/whitepaper", label: "Whitepaper" },
] as const;

export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();

  useEffect(() => {
    if (document.documentElement.dataset.oxSplash !== "show") return;
    try { sessionStorage.setItem("ox-intro-seen-v1", "1"); } catch { /* Storage is optional. */ }
    const timer = window.setTimeout(() => { delete document.documentElement.dataset.oxSplash; }, 1050);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div className="ox-app-shell">
      <div className="ox-intro" aria-hidden="true">
        <div className="ox-intro-first"><span>famdotfun</span><small>ROBINHOOD CHAIN</small></div>
        <div className="ox-intro-second">
          <span className="ox-intro-eyebrow">A market for every community</span>
          <strong>CREATE<br />TRADE</strong>
          <span className="ox-intro-arrow">↗</span>
          <span className="ox-intro-foot">CREATE <i /> TRADE <i /> SHARE</span>
        </div>
      </div>
      <header className="ox-topbar">
        <div className="ox-topbar-inner">
          <Link href="/discover" className="ox-brand-link" aria-label={`${brand.name} home`}><Wordmark /></Link>
          <nav className="ox-nav" aria-label="Launchpad navigation">
            {PRIMARY_NAV.map((item) => {
              const active = path.startsWith(item.href);
              return <Link key={item.href} href={item.href} className={active ? "ox-nav-link active" : "ox-nav-link"}>{item.label}</Link>;
            })}
          </nav>

          <div className="ox-top-actions">
            <details className="ox-more-menu">
              <summary>More <span aria-hidden="true">⌄</span></summary>
              <nav aria-label="More pages">
                {/* The top menu folds away under 900px; this keeps Your cut one tap from the top there. */}
                <Link className="ox-more-cut" href="/airdrop">Your cut</Link>
                {MORE_NAV.map((item) => <Link key={item.href} href={item.href}>{item.label}</Link>)}
              </nav>
            </details>
            <Link className="ox-launch-button" href="/launch"><span>＋</span>Create</Link>
            <Wallet />
          </div>
        </div>

        <div className="ox-network-line"><span><i aria-hidden="true" /> Robinhood Chain <b>{robinhood.id}</b></span></div>
      </header>

      <div className="ox-content-column">
        <SafeStrip />
        <DemoBanner />
        <main className="site-main ox-main">{children}</main>
        <footer className="ox-footer">
          <Wordmark />
          <p>Community tokens are volatile and may lose all value. Verify the contract address before trading. {brand.copy.footnote}</p>
          <nav aria-label="Legal">
            <Link href="/docs">Docs</Link><Link href="/whitepaper">Whitepaper</Link><Link href="/analytics">Analytics</Link><Link href="/terms">Terms</Link><Link href="/privacy">Privacy</Link>
          </nav>
        </footer>
      </div>

      <nav className="ox-mobile-nav" aria-label="Mobile navigation">
        <Link className={path.startsWith("/discover") ? "active" : ""} href="/discover"><span>⌂</span>Discover</Link>
        <Link className={path.startsWith("/portfolio") ? "active" : ""} href="/portfolio"><span>◫</span>Portfolio</Link>
        <Link className="create" href="/launch"><span>＋</span>Launch</Link>
        <Link className={path.startsWith("/leaderboard") ? "active" : ""} href="/leaderboard"><span>↗</span>Board</Link>
        <Link className={path.startsWith("/lock") ? "active" : ""} href="/lock"><span>◇</span>Lock</Link>
        <Link className={path.startsWith("/bag") ? "active" : ""} href="/bag"><span>◎</span>The Bag</Link>
      </nav>

      <SupportChatMount />
    </div>
  );
}

function Wallet() {
  const { address, isConnected } = useAccount();
  const { connect, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const connector = usePreferredConnector();
  const { safe } = useSafeAccount();

  if (isConnected && address) {
    return (
      <button className="ox-wallet" onClick={() => disconnect()} title="Disconnect wallet">
        <span className="ox-wallet-dot" aria-hidden="true" />
        {safe ? `Safe ${safe.threshold}/${safe.owners.length} · ` : ""}{shortAddress(address)}
      </button>
    );
  }

  return (
    <button className="ox-wallet ox-wallet-connect" disabled={isPending || !connector} onClick={() => connector && connect({ connector })}>
      {isPending ? "Connecting…" : "Connect"}
    </button>
  );
}
