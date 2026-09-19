import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { Providers } from "./providers";
import { Nav } from "@/components/Nav";
import { SupportChatMount } from "@/components/SupportChatMount";
import { DemoBanner } from "@/components/DemoBanner";
import { Spotlight } from "@/components/Spotlight";
import { CANONICAL, SITE } from "@/lib/site";

const TITLE = "hood.fam";
const DESCRIPTION = "A launchpad on Robinhood Chain. What the house takes, the fam gets back.";

/// `metadataBase` is what turns a relative image into an absolute one in a share card, and without
/// it every unfurl on X and Telegram is text only. Each token page overrides this with its own
/// card in `app/token/[address]/layout.tsx`.
export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: { default: TITLE, template: "%s" },
  description: DESCRIPTION,
  applicationName: TITLE,
  openGraph: { title: TITLE, description: DESCRIPTION, url: SITE, siteName: TITLE, type: "website" },
  twitter: { card: "summary", title: TITLE, description: DESCRIPTION },
  // A preview of this site runs on another host before launch. robots.txt asks a crawler to stay
  // away from it; this says the same thing on the page itself, for the crawler that arrives from
  // a pasted link rather than from the root.
  robots: CANONICAL ? { index: true, follow: true } : { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        {/* The light the whole sheet is built on: painted once, fixed behind every page, and
            invisible to a screen reader and to a pointer. */}
        <div className="atmosphere" aria-hidden="true" />
        <Spotlight />
        <Providers>
          <Nav />
          <DemoBanner />
          <main className="site-main">{children}</main>
          <footer className="site-footer">
            <div className="footer-top">
              <span className="footer-brand">hood<span>.fam</span></span>
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
        </Providers>
      </body>
    </html>
  );
}
