"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAccount, useConnect, useDisconnect, useBalance } from "wagmi";
import { shortAddress, fmt } from "@/lib/format";
import { usePreferredConnector, useSafeAccount } from "@/lib/safe";
import { brand } from "@/brands";

export function Nav() {
  const path = usePathname();
  const { address, isConnected } = useAccount();
  const { connect, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { data: balance } = useBalance({ address });
  const connector = usePreferredConnector();
  const { safe } = useSafeAccount();

  return (
    <header className="site-header">
      <div className="nav-inner">
        <Link href="/" className="brand" aria-label={`${brand.name} home`}><brand.Wordmark /></Link>
        <nav className="nav-links" aria-label="Main navigation">
          {brand.nav.map((l) => (
            <Link key={l.href} href={l.href}
              className={path === l.href ? "nav-link active" : "nav-link"}>
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="nav-actions">
        <span className="chain-pill"><i /> Robinhood Chain</span>
        {isConnected ? (
          <button className="btn btn-ghost wallet-button mono text-xs" onClick={() => disconnect()}>
            {safe ? `Safe ${safe.threshold}/${safe.owners.length} · ` : balance ? `${fmt(balance.value, 18, 3)} ETH · ` : ""}
            {shortAddress(address!)}
          </button>
        ) : (
          <button className="btn wallet-button" disabled={isPending || !connector}
            onClick={() => connector && connect({ connector })}>
            {isPending ? "Connecting…" : "Connect"}
          </button>
        )}
        </div>
      </div>
    </header>
  );
}
