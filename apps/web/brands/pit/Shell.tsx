"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import { api, type TokenRow } from "@/lib/api";
import { compact, pairDecimals, pairSymbol, shortAddress } from "@/lib/format";
import { usePreferredConnector, useSafeAccount } from "@/lib/safe";
import { SafeStrip } from "@/components/SafeStrip";
import { DemoBanner } from "@/components/DemoBanner";
import { SupportChatMount } from "@/components/SupportChatMount";
import { brand } from "@/brands";
import { Wordmark } from "./Wordmark";

/// PIT's chrome: a sign, a tape, and a row of doors.
///
/// Nothing here floats and nothing here glows. The header is a painted board with the name on it,
/// the tape under it is the only thing in the building that moves, and the routes are doors wide
/// enough to be hit at a run. Blocks sit hard against each other, separated by rules rather than by
/// gaps, so the page reads as one sheet of print rather than a tray of cards.
export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const { address, isConnected } = useAccount();
  const { connect, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const connector = usePreferredConnector();
  const { safe } = useSafeAccount();

  // The tape carries what is being traded, not what was printed last, so it says the same thing
  // whatever page the reader is on and whatever sort the board happens to be showing.
  const tape = useQuery({
    queryKey: ["pit-tape"],
    queryFn: () => api<{ tokens: TokenRow[] }>("/tokens?sort=volume&limit=14"),
    refetchInterval: 30_000,
  });
  const run = marquee(tape.data?.tokens ?? []);

  return (
    <>
      <header className="pit-head">
        <Link href="/" className="pit-sign" aria-label={`${brand.name} home`}>
          <Wordmark />
        </Link>
        <div className="pit-head-side">
          <span className="pit-chain">CHAIN 4663</span>
          {isConnected ? (
            <button className="pit-wallet" onClick={() => disconnect()}>
              {safe ? `SAFE ${safe.threshold}/${safe.owners.length} · ` : ""}
              {shortAddress(address!)}
            </button>
          ) : (
            <button className="pit-wallet pit-wallet-on" disabled={isPending || !connector}
              onClick={() => connector && connect({ connector })}>
              {isPending ? "CONNECTING" : "CONNECT"}
            </button>
          )}
        </div>
      </header>

      {/* Decoration, and only decoration: everything it shouts is on the board underneath in a form
          that holds still, so it is hidden from a screen reader rather than read out twice. The CSS
          stops the roll outright for anybody who asked for less motion. */}
      <div className="pit-tape" aria-hidden="true">
        {run.length ? (
          <div className="pit-tape-track">
            {[0, 1].map((copy) => (
              <div className="pit-tape-run" key={copy}>
                {run.map((t, i) => (
                  <span className="pit-tape-item" key={`${copy}-${i}-${t.token}`}>
                    <b>{t.symbol}</b>
                    <span>{cap(t)}</span>
                  </span>
                ))}
              </div>
            ))}
          </div>
        ) : (
          <div className="pit-tape-track">
            <div className="pit-tape-run">
              <span className="pit-tape-item pit-tape-quiet">FLOOR QUIET · WAITING ON THE FIRST TRADE</span>
            </div>
          </div>
        )}
      </div>

      <nav className="pit-routes" aria-label="Main navigation">
        {brand.nav.map((l) => (
          <Link key={l.href} href={l.href}
            className={path === l.href ? "pit-route pit-route-on" : "pit-route"}
            aria-current={path === l.href ? "page" : undefined}>
            {l.label}
          </Link>
        ))}
      </nav>

      <SafeStrip />
      <DemoBanner />
      <main className="pit-main">{children}</main>

      <footer className="pit-foot">
        <div className="pit-foot-top">
          <Wordmark className="pit-foot-sign" />
          <div className="pit-foot-links">
            <Link href="/analytics">Numbers</Link>
            <Link href="/airdrop">The cut</Link>
            <Link href="/terms">Terms</Link>
            <Link href="/privacy">Privacy</Link>
          </div>
        </div>
        <p className="pit-foot-warn">
          MOST LAUNCHES GO TO ZERO. NOTHING HERE IS FINANCIAL ADVICE.
        </p>
        <p className="pit-foot-small">
          Trades go through your own wallet and cannot be called back. A token can lose all of its
          value. PIT holds no funds and gives no financial advice. Check the address before you buy.
        </p>
      </footer>

      <SupportChatMount />
    </>
  );
}

/// A tape with four tickers on it is four tickers followed by a screen of nothing, so the list
/// repeats until one run is long enough to cover the width it scrolls across.
function marquee(tokens: TokenRow[]): TokenRow[] {
  if (!tokens.length) return tokens;
  const out: TokenRow[] = [];
  while (out.length < 14) out.push(...tokens);
  return out;
}

/// The tape quotes the market cap the tickets quote, worked out the same way, because one screen
/// showing two different numbers for one launch is worse than showing none.
function cap(t: TokenRow) {
  const mcap = (BigInt(t.price || "0") * BigInt(t.total_supply || "0")) / 10n ** 18n;
  return `${compact(mcap, pairDecimals(t.pair_token))} ${pairSymbol(t.pair_token)}`;
}
