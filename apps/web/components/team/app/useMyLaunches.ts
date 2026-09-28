"use client";

import { useQueries, useQuery } from "@tanstack/react-query";
import { useAccount } from "wagmi";
import { api } from "@/lib/api";
import { API } from "@/lib/config";

/// The funder's launches as the indexer has them, with each one's declared team and what that team
/// holds now. The indexer credits a block-zero launch to the wallet that sent it, so `creator` is
/// the funder here, not the periphery.

export interface LaunchRow {
  token: string; name: string; symbol: string; image: string; mode: string;
  pair_token: string; pair_symbol?: string | null; pair_decimals?: number | null;
  price: string | null; total_supply: string; launched_at: string;
  team_tokens?: string | null; team_legs?: number | null; status?: string;
}
interface TeamRow { wallet: string; pair_spent: string; tokens: string; balance: string }

export interface LaunchPnl {
  row: LaunchRow;
  wallets: number;
  spent: number; // in the pair
  value: number; // in the pair, the team's balance at the last price
  usd: number | null; // pair price in dollars
}

export function useMyLaunches() {
  const { address } = useAccount();
  const list = useQuery({
    queryKey: ["tapp-mine", address],
    queryFn: () => api<{ tokens: LaunchRow[] }>(`/tokens?creator=${address}&limit=100`),
    enabled: Boolean(address),
    refetchInterval: 30_000,
  });
  const rows = list.data?.tokens ?? [];
  const teams = useQueries({
    queries: rows.map((r) => ({
      queryKey: ["team", r.token, "dash"],
      queryFn: () => api<{ team: TeamRow[] }>(`/tokens/${r.token}/team`),
      refetchInterval: 60_000,
    })),
  });
  const pairs = useQuery({
    queryKey: ["tapp-pairs"],
    queryFn: async () => ((await (await fetch(`${API}/pairs`, { cache: "no-store" })).json()) as { pairs: { address: string; usd: number | null }[] }).pairs,
    refetchInterval: 60_000,
  });

  const launches: LaunchPnl[] = rows.map((row, i) => {
    const team = teams[i]?.data?.team ?? [];
    const dec = row.pair_decimals ?? 18;
    const spent = team.reduce((s, t) => s + Number(t.pair_spent || 0), 0) / 10 ** dec;
    const tokens = team.reduce((s, t) => s + Number(t.balance || 0), 0) / 1e18;
    const value = (tokens * Number(row.price || 0)) / 10 ** dec;
    const usd = pairs.data?.find((p) => p.address.toLowerCase() === row.pair_token.toLowerCase())?.usd ?? null;
    return { row, wallets: team.length, spent, value, usd };
  });
  return { address, loading: list.isLoading, error: list.error, launches };
}
