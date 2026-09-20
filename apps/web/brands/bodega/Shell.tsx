"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import { brand } from "@/brands";
import { SafeStrip } from "@/components/SafeStrip";
import { DemoBanner } from "@/components/DemoBanner";
import { SupportChatMount } from "@/components/SupportChatMount";
import { shortAddress } from "@/lib/format";
import { usePreferredConnector, useSafeAccount } from "@/lib/safe";

/// Bodega's chrome: a masthead, a column, and a shopkeeper's notice at the bottom.
///
/// Nothing here is fixed over the page except the header, and nothing is lit. A shop is read from
/// the top down, so the chrome gets out of the way: the mark and the wallet on one line, the routes
/// as plain words on the next, and then 900px of column with air either side of it.
export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();

  return (
    <>
      <header className="bd-header">
        <div className="bd-header-inner">
          <Link href="/" className="bd-brand" aria-label={`${brand.name} home`}>
            <brand.Wordmark />
          </Link>
          <WalletButton />
          <nav className="bd-nav" aria-label="Main navigation">
            {brand.nav.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className={path === l.href ? "bd-nav-link on" : "bd-nav-link"}
                aria-current={path === l.href ? "page" : undefined}
              >
                {l.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>

      <SafeStrip />
      <DemoBanner />

      <main className="bd-main">{children}</main>

      <footer className="bd-footer">
        <div className="bd-footer-top">
          <brand.Wordmark className="bd-footer-mark" />
          <nav className="bd-footer-links" aria-label="More pages">
            <Link href="/airdrop">{brand.copy.drop}</Link>
            <Link href="/analytics">The numbers</Link>
            <Link href="/terms">Terms</Link>
            <Link href="/privacy">Privacy</Link>
          </nav>
        </div>
        {/* The small print is the part of a shop people actually need, so it is written the way a
            shopkeeper would say it out loud rather than the way a disclaimer is usually set. */}
        <p>
          Bodega is a shop window onto Robinhood Chain, chain 4663. The coins on the shelf were made
          by other people, and putting one there costs nothing and proves nothing about it.
        </p>
        <p>
          Buying a coin is a risk, and most of them end up worth nothing at all. Money leaves your
          own wallet, so nobody here can send it back once it has gone. Read the address of a coin
          before you buy it, because two coins can wear the same name.
        </p>
        <p>{brand.copy.footnote}</p>
      </footer>

      <SupportChatMount />
    </>
  );
}

/// The one control in the chrome. It follows `components/Nav.tsx`: the connector is chosen for the
/// window the app is in rather than taken off the top of the list, and a Safe says what it is,
/// because "connected" means something different when it takes several people to sign.
function WalletButton() {
  const { address, isConnected } = useAccount();
  const { connect, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const connector = usePreferredConnector();
  const { safe } = useSafeAccount();

  if (isConnected && address) {
    return (
      <button className="bd-wallet" onClick={() => disconnect()} title="Disconnect this wallet">
        {safe ? `Safe ${safe.threshold}/${safe.owners.length}` : shortAddress(address)}
      </button>
    );
  }
  return (
    <button
      className="bd-wallet bd-wallet-open"
      disabled={isPending || !connector}
      onClick={() => connector && connect({ connector })}
    >
      {isPending ? "Connecting" : "Connect a wallet"}
    </button>
  );
}
