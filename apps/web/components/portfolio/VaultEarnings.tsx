"use client";

import { zeroAddress, type Address } from "viem";
import { useReadContract } from "wagmi";
import { hoodStakingAbi } from "@hood/sdk";
import { addresses } from "@/lib/config";
import { ago, fmt, pairDecimals, pairSymbol } from "@/lib/format";
import { Figure } from "@/components/Provenance";

/// An asset as the API names it: the address, and the symbol and decimals it read off the asset
/// when it can. address(0) is the chain's own currency. Rows written by an older API carry only
/// the address, so the registry is the fallback.
export interface AssetRef { asset: string; symbol?: string | null; decimals?: number | null }
export const assetSymbol = (a: AssetRef) => a.symbol ?? pairSymbol(a.asset);
export const assetDecimals = (a: AssetRef) => a.decimals ?? pairDecimals(a.asset);

/// `GET /portfolio/:address` -> `vault`: what this wallet took out of the Vault per asset, and
/// what it could take right now when the API read it.
export interface VaultWalletRow extends AssetRef { claimed: string; pending?: string | null }
/// `GET /vault` -> `rewards`: everything the Vault was ever paid, per asset.
export interface VaultRewardRow extends AssetRef { total: string; last_ts?: string | null }
/// `GET /vault` -> `held`: the Vault's share the Bag is holding until the house coin exists.
export interface VaultHeldRow extends AssetRef { amount: string }
export interface VaultResponse {
  houseCoin: string | null;
  totalLocked: string;
  positions: number;
  rewards: VaultRewardRow[];
  held: VaultHeldRow[];
}

/// The one sentence for the time before the house coin. Used by every page that mentions the Vault.
export const VAULT_NOT_OPEN = "The Vault opens the day the house coin launches. Until then its share waits inside the Bag.";

/// The Vault, per asset. Two scopes, one shape: a wallet's own earnings (portfolio) or the whole
/// Vault's (lock page). Amounts in different assets are never added together.
export function VaultEarnings({ scope, rows, held, houseCoin, n, title }: {
  scope: "wallet" | "vault";
  rows: VaultWalletRow[] | VaultRewardRow[] | undefined;
  held?: VaultHeldRow[];
  /// The house coin's address, or null for "not launched". Left out, the panel reads it off the
  /// Vault contract itself.
  houseCoin?: string | null;
  n: string;
  title: string;
}) {
  const { data: chainHouse } = useReadContract({
    address: addresses.staking, abi: hoodStakingAbi, functionName: "houseToken",
    query: { enabled: houseCoin === undefined && addresses.staking !== zeroAddress },
  });
  const coin = houseCoin !== undefined ? houseCoin : (chainHouse as Address | undefined);
  const open = Boolean(coin && coin !== zeroAddress);
  const waiting = (held ?? []).filter((h) => BigInt(h.amount || "0") > 0n);

  return (
    <section className="panel portfolio-section p-5">
      <div className="panel-head"><span className="n">{n}</span><h2>{title}</h2><span className="hatch" aria-hidden="true" /></div>
      <p className="mb-4 text-sm dim">
        {scope === "wallet"
          ? "You lock the house coin, you get a share of what the Bag sends the Vault, every block, in the asset it arrived in. Longer lock, bigger share."
          : "The Vault is paid every block, in whatever the trades that fed it were quoted in. Lockers split it by weight."}
      </p>

      {!open ? (
        <>
          <p className="empty-inline">{VAULT_NOT_OPEN}</p>
          {waiting.length > 0 && (
            <div className="earn-grid mt-3">
              {waiting.map((h) => (
                <Figure key={h.asset} label={`waiting in the Bag, ${assetSymbol(h)}`} kind="measured"
                  value={`${fmt(BigInt(h.amount), assetDecimals(h), 6)} ${assetSymbol(h)}`} />
              ))}
            </div>
          )}
        </>
      ) : rows === undefined ? (
        <div className="earn-grid">
          <Figure label={scope === "wallet" ? "earned from the Vault" : "paid into the Vault"} kind="measured" value={null}
            reason="the indexer does not report Vault earnings yet" />
        </div>
      ) : rows.length === 0 ? (
        <p className="empty-inline">
          {scope === "wallet" ? "Nothing from the Vault yet. Lock the house coin and the next block starts paying you." : "Nothing has reached the Vault yet."}
        </p>
      ) : (
        <div className="earn-grid">
          {scope === "wallet"
            ? (rows as VaultWalletRow[]).map((r) => (
              <div key={r.asset} className="earn-cell">
                <Figure label={`taken out, ${assetSymbol(r)}`} kind="measured" value={`${fmt(BigInt(r.claimed || "0"), assetDecimals(r), 6)} ${assetSymbol(r)}`} />
                <Figure label="claimable now" kind="derived"
                  value={r.pending == null ? null : `${fmt(BigInt(r.pending), assetDecimals(r), 6)} ${assetSymbol(r)}`}
                  reason="read on the lock page, per position" />
              </div>
            ))
            : (rows as VaultRewardRow[]).map((r) => (
              <div key={r.asset} className="earn-cell">
                <Figure label={`paid in, ${assetSymbol(r)}`} kind="measured" value={`${fmt(BigInt(r.total || "0"), assetDecimals(r), 6)} ${assetSymbol(r)}`} />
                <span className="earn-when">{r.last_ts ? `last ${ago(r.last_ts)} ago` : "no payment yet"}</span>
              </div>
            ))}
          {waiting.map((h) => (
            <Figure key={`held-${h.asset}`} label={`waiting in the Bag, ${assetSymbol(h)}`} kind="measured"
              value={`${fmt(BigInt(h.amount), assetDecimals(h), 6)} ${assetSymbol(h)}`} />
          ))}
        </div>
      )}
    </section>
  );
}
