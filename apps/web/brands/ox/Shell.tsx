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

/// 0x.fam's chrome: one line of header, the page, one line of footer.
///
/// Everything a market terminal puts on screen is either data or a way of reaching data, so the
/// chrome takes a single 44px band and gives the rest of the window to the table. The routes are
/// written as paths because that is what the reader of this front already types; the chain and the
/// wallet sit on the right, where a trading screen keeps its session state.
///
/// The nav comes from `brand.nav` rather than a list of its own, so the routes this brand offers
/// are stated once, in `index.ts`. That import cycles back through `brands/` exactly as the shared
/// Nav does for hood; it is read at render time, long after both modules have evaluated.
export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();

  return (
    <>
      <header className="ox-top">
        <Link href="/" className="ox-brand" aria-label={`${brand.name} home`}><Wordmark /></Link>
        <nav className="ox-routes" aria-label="Main navigation">
          {brand.nav.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={path === l.href ? "ox-route active" : "ox-route"}
              aria-current={path === l.href ? "page" : undefined}
            >
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="ox-session">
          {/* The chain is stated, not decorated: a reader who is about to sign something wants the
              id, not a logo. The dot is the only thing here that claims to be live. */}
          <span className="ox-net"><i aria-hidden="true" />robinhood:{robinhood.id}</span>
          <Wallet />
        </div>
      </header>

      <SafeStrip />
      <DemoBanner />

      <main className="site-main">{children}</main>

      <footer className="ox-foot">
        <span className="ox-foot-mark"><Wordmark /></span>
        <p>
          Tokens are risky and most launches go to zero. Transactions go through your wallet and
          cannot be reversed. Nothing here is financial advice. {brand.copy.footnote} Check the
          address before you sign.
        </p>
        <nav className="ox-foot-links" aria-label="Footer">
          <Link href="/analytics">/analytics</Link>
          <Link href="/airdrop">/drop</Link>
          <Link href="/terms">/terms</Link>
          <Link href="/privacy">/privacy</Link>
        </nav>
      </footer>

      <SupportChatMount />
    </>
  );
}

/// The session control, built on the same hooks the shared Nav uses so a Safe behaves identically
/// here: inside Safe{Wallet} the connected account is a multisig, and saying `Safe 2/3` is the only
/// warning a signer gets that their click will be queued for other people rather than sent.
function Wallet() {
  const { address, isConnected } = useAccount();
  const { connect, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const connector = usePreferredConnector();
  const { safe } = useSafeAccount();

  if (isConnected && address) {
    return (
      <button className="btn btn-ghost ox-wallet" onClick={() => disconnect()} title="Disconnect this wallet">
        {safe ? `Safe ${safe.threshold}/${safe.owners.length} ` : ""}{shortAddress(address)}
      </button>
    );
  }
  return (
    <button
      className="btn ox-wallet"
      disabled={isPending || !connector}
      onClick={() => connector && connect({ connector })}
    >
      {isPending ? "connecting" : "connect"}
    </button>
  );
}
