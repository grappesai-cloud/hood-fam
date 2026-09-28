"use client";

import { useState } from "react";
import { EXPLORER } from "@/lib/config";
import type { BagAddresses } from "@/lib/bag";

/// The contracts, next to the numbers they produce, so a reader can check any figure on this page
/// against the chain. Each address copies and links to the explorer.

const ROWS: { key: keyof BagAddresses; label: string; note: string; unset: string }[] = [
  { key: "bag", label: "The Bag", note: "no owner, no withdrawal, splits fixed at deploy", unset: "not deployed yet" },
  { key: "payday", label: "Payday", note: "pays the hour's wallets by points", unset: "not deployed yet" },
  { key: "burnClock", label: "Burn clock", note: "buys the house coin and burns it", unset: "not deployed yet" },
  { key: "boosts", label: "Boosts", note: "hourly slots on the board", unset: "not deployed yet" },
  { key: "vault", label: "The Vault", note: "house-coin lockers earn per block", unset: "not deployed yet" },
  { key: "house", label: "The house", note: "the treasury Safe, paid first on every flush", unset: "not set" },
  { key: "graduationHook", label: "Graduation hook", note: "the 1% on every graduated pool", unset: "not deployed yet" },
  { key: "houseCoin", label: "House coin", note: "the Vault and the burn clock take it once", unset: "not launched yet" },
];

export function Addresses({ addresses, missing }: { addresses: BagAddresses | null | undefined; missing: boolean }) {
  return (
    <section className="panel">
      <header className="refer-head">
        <h2>The contracts</h2>
        <span className="dim text-sm">every figure above is read off these</span>
      </header>
      {missing || !addresses ? (
        <p className="dim text-sm">The addresses are not served by this API yet. They appear once the indexer knows the Bag.</p>
      ) : (
        <ul className="bag-addresses">
          {ROWS.map((row) => <AddressRow key={row.key} label={row.label} note={row.note} unset={row.unset} address={addresses[row.key]} />)}
        </ul>
      )}
    </section>
  );
}

function AddressRow({ label, note, unset, address }: { label: string; note: string; unset: string; address: string | null }) {
  const [copied, setCopied] = useState<"yes" | "no" | null>(null);

  async function copy() {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied("yes");
    } catch {
      setCopied("no");
    }
    setTimeout(() => setCopied(null), 2000);
  }

  return (
    <li>
      <div className="bag-address-label">
        <strong>{label}</strong>
        <span className="dim text-xs">{note}</span>
      </div>
      {address ? (
        <div className="bag-address-value">
          <code className="mono" title={address}>{address}</code>
          <div className="bag-address-actions">
            <button type="button" className="bag-copy" onClick={copy} title="Copy the address">
              {copied === "yes" ? "copied" : copied === "no" ? "select it by hand" : "copy"}
            </button>
            <a className="bag-copy" href={`${EXPLORER}/address/${address}`} target="_blank" rel="noreferrer">explorer ↗</a>
          </div>
        </div>
      ) : (
        <div className="bag-address-value"><span className="figure-dash">—</span> <span className="dim text-xs">{unset}</span></div>
      )}
    </li>
  );
}
