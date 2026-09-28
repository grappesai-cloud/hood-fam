"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { erc20Abi, getAddress, isAddress, type Address, type PrivateKeyAccount } from "viem";
import { useReadContract } from "wagmi";
import { hoodCurveAbi } from "@hood/sdk";
import { api } from "@/lib/api";
import { fmt, machineLabel, pairDecimals, pairSymbol } from "@/lib/format";
import { Field, Step } from "@/components/LaunchUI";
import { VaultPanel } from "@/components/team/VaultPanel";
import { WalletDesk, type TeamRow } from "@/components/team/WalletDesk";
import type { DeskToken } from "@/components/team/WalletActions";
import { useIdleLock } from "@/components/team/useIdleLock";

/// The team desk: where a team looks after the wallets it declared in a block-zero launch.
///
/// The keys are made or decrypted in this tab and live in React state only; nothing writes them
/// to storage or sends them anywhere, and Lock (or 15 idle minutes) drops them. Every action is one
/// press by a person: take a lock out, move tokens, sell back to the curve, move ETH, fund gas.
/// There is no schedule, no trigger and no watcher. The wallets were public from the launch
/// transaction on, and nothing here changes that: the token page labels them as the team.

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
}

export default function TeamDeskPage() {
  const [accounts, setAccounts] = useState<PrivateKeyAccount[]>([]);
  const [label, setLabel] = useState("");
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

  const lock = useCallback(() => { setAccounts([]); setLabel(""); }, []);
  useIdleLock(accounts.length > 0, lock);

  const onUnlock = useCallback((more: PrivateKeyAccount[], fileLabel: string) => {
    setAccounts((have) => {
      const seen = new Set(have.map((a) => a.address.toLowerCase()));
      return [...have, ...more.filter((a) => !seen.has(a.address.toLowerCase()))];
    });
    setLabel((l) => (l && fileLabel && l !== fileLabel ? `${l}, ${fileLabel}` : l || fileLabel));
  }, []);

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
    pairSymbol: pairSymbol(t.pair_token, t),
    pairDecimals: pairDecimals(t.pair_token, t),
  } : null;

  const team = teamQuery.data?.team ?? [];
  const launch = teamQuery.data?.launch;
  const totalSupply = launch ? BigInt(launch.total_supply || "0") : 0n;
  const teamTokens = launch ? BigInt(launch.team_tokens || "0") : 0n;

  return (
    <div className="launch-shell desk-shell">
      <header className="page-intro">
        <div className="section-kicker">Team launch</div>
        <h1>Team desk</h1>
        <p>
          Look after the wallets your team bought with in a <Link href="/launch/team">team launch</Link>: make fresh ones, open them from
          an encrypted file, withdraw locks, send, sell back to the curve, move ETH and fund gas. The keys stay in this browser tab and
          are never sent anywhere. The team wallets are public: the token page lists every one of them as the team.
        </p>
      </header>

      <div className="launch-form-stack">
        <VaultPanel n={1} unlocked={accounts.length} onUnlock={onUnlock} />

        <Step n={3} title="Token" purpose="The launch these wallets belong to. Its team list comes from the indexer; every balance and lock below is read from the chain." done={Boolean(info)}>
          <Field label="Token address"
            error={tokenText.trim() && !token ? "Not an address." : row.isError ? "The indexer does not know this token." : undefined}>
            <input className="input mono" value={tokenText} onChange={(e) => setTokenText(e.target.value)} placeholder="0x token" spellCheck={false} />
          </Field>
          {t && (
            <div className="holder-facts">
              <div className="fact"><strong>{t.symbol}</strong><span>{t.name || "token"}</span></div>
              <div className="fact"><strong>{t.mode}</strong><span>{t.mode === "curve" && phase !== undefined ? machineLabel({ mode: "curve", phase: Number(phase), bonded: false }) : t.mode === "direct" ? "trades in its pool" : "machine"}</span></div>
              <div className="fact"><strong>{team.length}</strong><span>declared team wallets</span></div>
              {totalSupply > 0n && (
                <div className="fact">
                  <strong>{fmt(teamTokens, info?.decimals ?? 18, 0)}</strong>
                  <span>bought by the team, {Number((teamTokens * 10_000n) / totalSupply) / 100}% of supply</span>
                </div>
              )}
            </div>
          )}
          {t && team.length === 0 && !teamQuery.isLoading && (
            <p className="field-note">This token has no declared team wallets. Open wallets still show their balances of it.</p>
          )}
          {token && <p className="field-note"><Link href={`/token/${token}`}>Open the token page</Link></p>}
        </Step>

        <WalletDesk n={4} accounts={accounts} info={info} team={team} label={label} onLock={lock} />
      </div>
    </div>
  );
}
