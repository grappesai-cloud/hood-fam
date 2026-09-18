"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAccount, useConnect, useDisconnect, useBalance } from "wagmi";
import { shortAddress, fmt } from "@/lib/format";

const LINKS = [
  { href: "/", label: "Explore" },
  { href: "/launch", label: "Create" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/creator", label: "Creator" },
  { href: "/leaderboard", label: "Leaderboard" },
  { href: "/airdrop", label: "The drop" },
  { href: "/bridge", label: "Bridge" },
];

export function Nav() {
  const path = usePathname();
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { data: balance } = useBalance({ address });

  return (
    <header className="site-header">
      <div className="nav-inner">
        <Link href="/" className="brand" aria-label="hood.fam home">hood<span>.fam</span></Link>
        <nav className="nav-links" aria-label="Main navigation">
          {LINKS.map((l) => (
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
            {balance ? `${fmt(balance.value, 18, 3)} ETH · ` : ""}{shortAddress(address!)}
          </button>
        ) : (
          <button className="btn wallet-button" disabled={isPending}
            onClick={() => connect({ connector: connectors[0]! })}>
            {isPending ? "Connecting…" : "Connect"}
          </button>
        )}
        </div>
      </div>
    </header>
  );
}
