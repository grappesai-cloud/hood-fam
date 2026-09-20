"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Nav } from "@/components/Nav";
import { SafeStrip } from "@/components/SafeStrip";
import { DemoBanner } from "@/components/DemoBanner";
import { SupportChatMount } from "@/components/SupportChatMount";
import { Spotlight } from "@/components/Spotlight";
import { Wordmark } from "./Wordmark";

/// hood.fam's chrome: a lit sheet, a bar of links across the top, the page, and a footer that says
/// what the place is and what it is not.
export function Shell({ children }: { children: ReactNode }) {
  return (
    <>
      {/* The light the whole sheet is built on: painted once, fixed behind every page, and
          invisible to a screen reader and to a pointer. */}
      <div className="atmosphere" aria-hidden="true" />
      <Spotlight />
      <Nav />
      <SafeStrip />
      <DemoBanner />
      <main className="site-main">{children}</main>
      <footer className="site-footer">
        <div className="footer-top">
          <Wordmark className="footer-brand" />
          <nav className="footer-links">
            <Link href="/analytics">Analytics</Link>
            <Link href="/airdrop">The drop</Link>
            <Link href="/terms">Terms</Link>
            <Link href="/privacy">Privacy</Link>
            <span>Robinhood Chain · 4663</span>
          </nav>
        </div>
        <div className="footer-legal">
          <p>Trading tokens is risky and most launches go to zero. Nothing here is financial advice.</p>
          <p>Transactions go through your wallet and cannot be reversed. Tokens can lose all their value. hood.fam holds no funds and gives no financial advice. Always check the token address.</p>
        </div>
      </footer>
      <SupportChatMount />
    </>
  );
}
