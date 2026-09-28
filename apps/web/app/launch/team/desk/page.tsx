"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { erc20Abi, getAddress, isAddress, zeroAddress, type Address } from "viem";
import { useReadContract } from "wagmi";
import { hoodCurveAbi } from "@hood/sdk";
import { api } from "@/lib/api";
import { fmt, machineLabel, pairDecimals, pairSymbol } from "@/lib/format";
import { Field, Step } from "@/components/LaunchUI";
import { VaultPanel } from "@/components/team/VaultPanel";
import { WalletDesk, type TeamRow } from "@/components/team/WalletDesk";
import type { DeskToken } from "@/components/team/WalletActions";
import { lockAll, setName, useUnlocked, useWalletSets } from "@/components/team/app/walletSets";

/// The team desk: where a team acts with the wallets it opened, on one token.
///
/// The wallets are the console's wallet sets (the Wallets page, or the file panel here): keys made
/// or decrypted in this tab, held in memory only, dropped by Lock or after 15 idle minutes. Every
/// action is one press by a person: buy, take a lock out, move tokens, sell back to the curve,
/// move ETH, fund gas. There is no schedule, no trigger and no watcher. The wallets were public
/// from the launch transaction on, and nothing here changes that: the token page labels the team
/// and the open buyers.

interface TokenRow {
  token: string;
  name?: string;
  symbol: string;
  mode: "curve" | "direct";
  curve: string | null;
  pair_token: string;
  pair_decimals?: number | null;
  pair_symbol?: string | null;
  phase?: number;
  bonded?: boolean;
}

interface TeamResponse {
  team: TeamRow[];
  launch: { launched_by: string; team_tokens: string; team_legs: number; total_supply: string; creator: string } | null;
  exempt?: string[];
}

export default function TeamDeskPage() {
  const { accounts, ids } = useUnlocked();
  const sets = useWalletSets();
  const label = ids
    .map((id) => sets.find((s) => s.id === id))
    .filter((s): s is NonNullable<typeof s> => Boolean(s))
    .map(setName)
    .join(", ");
  const [tokenText, setTokenText] = useState("");

  // `?token=` from the team launch or the token page. Read after mount, so the page itself stays
  // static and needs no suspense boundary for the search params.
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("token");
    if (t) setTokenText(t);
  }, []);

  const token = isAddress(tokenText.trim()) ? getAddress(tokenText.trim()) : null;
  useEffect(() => {
    // Keep the address in the URL, so a reload or a shared link opens the same token.
    const url = new URL(window.location.href);
    if (token) url.searchParams.set("token", token); else url.searchParams.delete("token");
    window.history.replaceState(null, "", url.toString());
  }, [token]);

  const row = useQuery({
    queryKey: ["desk-token", token],
    queryFn: () => api<TokenRow>(`/tokens/${token}`),
    enabled: Boolean(token),
    retry: false,
  });
  const teamQuery = useQuery({
    queryKey: ["team", token, "desk"],
    queryFn: () => api<TeamResponse>(`/tokens/${token}/team`),
    enabled: Boolean(token),
    refetchInterval: 30_000,
  });

  const t = row.data;
  const curve = t?.mode === "curve" && t.curve && isAddress(t.curve) ? getAddress(t.curve) : null;
  const { data: decimals } = useReadContract({
    address: token ?? undefined, abi: erc20Abi, functionName: "decimals", query: { enabled: Boolean(token), staleTime: Infinity },
  });
  const { data: phase } = useReadContract({
    address: curve ?? undefined, abi: hoodCurveAbi, functionName: "phase", query: { enabled: Boolean(curve), refetchInterval: 15_000 },
  });

  const info: DeskToken | null = token && t ? {
    token,
    symbol: t.symbol,
    decimals: decimals ?? 18,
    mode: t.mode,
    curve,
    phase: phase === undefined ? null : Number(phase),
    pairToken: isAddress(t.pair_token) ? getAddress(t.pair_token) : zeroAddress,
    pairSymbol: pairSymbol(t.pair_token, t),
    pairDecimals: pairDecimals(t.pair_token, t),
  } : null;

  const team = teamQuery.data?.team ?? [];
  const exempt = teamQuery.data?.exempt ?? [];
  const launch = teamQuery.data?.launch;
  const totalSupply = launch ? BigInt(launch.total_supply || "0") : 0n;
  const teamTokens = launch ? BigInt(launch.team_tokens || "0") : 0n;

  return (
    <div className="launch-shell desk-shell tapp-page">
      <header className="page-intro">
        <div className="section-kicker">Team launch</div>
        <h1>Team desk</h1>
        <p>
          Act with the wallets your team opened, on one token: buy, withdraw locks, send, sell back to the curve, move ETH and fund
          gas. Sets you opened on the <Link href="/launch/team/wallets">Wallets</Link> page are already here; a file opened below
          joins them. The keys stay in this browser tab and are never sent anywhere. The team wallets and the open buyers are
          public: the token page lists every one of them.
        </p>
      </header>

      <div className="launch-form-stack">
        <VaultPanel n={1} unlocked={accounts.length} />

        <Step n={3} title="Token" purpose="The launch these wallets act on. Its team and its open buyers come from the indexer; every balance and lock below is read from the chain." done={Boolean(info)}>
          <Field label="Token address"
            error={tokenText.trim() && !token ? "Not an address." : row.isError ? "The indexer does not know this token." : undefined}>
            <input className="input mono" value={tokenText} onChange={(e) => setTokenText(e.target.value)} placeholder="0x token" spellCheck={false} />
          </Field>
          {t && (
            <div className="holder-facts">
              <div className="fact"><strong>{t.symbol}</strong><span>{t.name || "token"}</span></div>
              <div className="fact"><strong>{t.mode}</strong><span>{t.mode === "curve" && phase !== undefined ? machineLabel({ mode: "curve", phase: Number(phase), bonded: false }) : t.mode === "direct" ? "trades in its pool" : "machine"}</span></div>
              <div className="fact"><strong>{team.length}</strong><span>declared team wallets</span></div>
              <div className="fact"><strong>{exempt.length}</strong><span>open buyers named at launch</span></div>
              {totalSupply > 0n && (
                <div className="fact">
                  <strong>{fmt(teamTokens, info?.decimals ?? 18, 0)}</strong>
                  <span>bought by the team, {Number((teamTokens * 10_000n) / totalSupply) / 100}% of supply</span>
                </div>
              )}
            </div>
          )}
          {t && team.length === 0 && exempt.length === 0 && !teamQuery.isLoading && (
            <p className="field-note">This token has no declared team wallets and no open buyers. Open wallets still show their balances of it and can buy it.</p>
          )}
          {token && <p className="field-note"><Link href={`/token/${token}`}>Open the token page</Link></p>}
        </Step>

        <WalletDesk n={4} accounts={accounts} info={info} team={team} exempt={exempt} label={label} onLock={lockAll} />
      </div>
    </div>
  );
}
