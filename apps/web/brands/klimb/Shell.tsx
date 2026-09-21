"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import { SafeStrip } from "@/components/SafeStrip";
import { DemoBanner } from "@/components/DemoBanner";
import { SupportChatMount } from "@/components/SupportChatMount";
import { shortAddress } from "@/lib/format";
import { usePreferredConnector, useSafeAccount } from "@/lib/safe";
import { Wordmark } from "./Wordmark";
import { brand } from "@/brands";

/// Klimb's chrome is a terminal's chrome: a rail down the left, the page beside it, nothing on top.
///
/// A horizontal bar costs the same 68px of height on every screen and pushes the market down; a
/// rail costs width, which a table of numbers has to spare and a reader of one does not miss. The
/// routes stack, so they are read as a list rather than scanned as a strip, and the wallet sits at
/// the foot of the rail where a status line belongs rather than competing with the mark.
///
/// Under 900px there is no width to give away, so the rail lies down into a bar and the routes
/// become one scrolling line inside it. The page itself never scrolls sideways.
export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();

  return (
    <>
      <div className="kl-frame">
        <aside className="kl-rail">
          <Link href="/" className="kl-rail-brand" aria-label="Klimb home"><Wordmark /></Link>

          <nav className="kl-routes" aria-label="Main navigation">
            {ROUTES.map((r) => (
              <Link key={r.href} href={r.href} className={path === r.href ? "kl-route active" : "kl-route"}
                aria-current={path === r.href ? "page" : undefined}>
                {r.label}
              </Link>
            ))}
          </nav>

          <div className="kl-rail-foot">
            <span className="kl-chain">Robinhood Chain · 4663</span>
            <WalletButton />
          </div>
        </aside>

        <div className="kl-column">
          <SafeStrip />
          <DemoBanner />
          <main className="kl-main">{children}</main>
          <footer className="kl-footer">
            <div className="kl-footer-top">
              <Wordmark className="kl-footer-brand" />
              <nav className="kl-footer-links" aria-label="Footer">
                <Link href="/analytics">Analytics</Link>
                <Link href="/airdrop">Season payout</Link>
                <Link href="/terms">Terms</Link>
                <Link href="/privacy">Privacy</Link>
              </nav>
            </div>
            <div className="kl-footer-legal">
              <p>Trading tokens is risky and most launches go to zero. Nothing here is financial advice.</p>
              <p>Transactions go through your wallet and cannot be reversed. Klimb holds no funds and gives no financial advice. Always check the token address before you trade it.</p>
            </div>
          </footer>
        </div>
      </div>
      <SupportChatMount />
    </>
  );
}

/// The rail reads the brand's own list. It used to be a copy kept here, which drifted the moment
/// the routes changed: the bridge was taken out of every brand and this rail still offered it.
const ROUTES = brand.nav;

/// The same wallet behaviour as the shared nav: the connector is chosen for the surroundings (the
/// Safe when framed by Safe{Wallet}, the injected wallet in a browser, WalletConnect on a phone),
/// and an account that turns out to be a Safe says so, because how many signatures a trade needs is
/// something a trader has to know before they click buy.
function WalletButton() {
  const { address, isConnected } = useAccount();
  const { connect, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const connector = usePreferredConnector();
  const { safe } = useSafeAccount();

  if (isConnected && address) {
    return (
      <button className="kl-wallet connected" onClick={() => disconnect()} title="Disconnect">
        <span className="kl-wallet-addr">{shortAddress(address)}</span>
        {safe && <span className="kl-wallet-safe">Safe {safe.threshold}/{safe.owners.length}</span>}
      </button>
    );
  }
  return (
    <button className="kl-wallet" disabled={isPending || !connector}
      onClick={() => connector && connect({ connector })}>
      {isPending ? "Connecting" : "Connect wallet"}
    </button>
  );
}
