"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { EXPLORER } from "@/lib/config";
import { fmt, shortAddress } from "@/lib/format";

/// The team of a block-zero launch, wallet by wallet.
///
/// Every row here was written on chain by HoodBlockZero in the launch transaction itself: the
/// wallet, what it paid, what it got, and when its lock opens. The page adds only what each wallet
/// still holds in hand, from the indexer's balances, so a reader can see whether the team has sold.
/// Under it, the launch's open buyers: the wallets it named as paying no opening tax in its first
/// seconds, from the market's own event. Both lists are on chain from the launch transaction on.

interface TeamRow {
  wallet: string;
  idx: number;
  pair_spent: string;
  tokens: string;
  lock_id: string;
  unlock_at: string | null;
  tx: string;
  balance: string;
}

function big(value: string | undefined | null): bigint {
  try {
    return BigInt(value ?? "0");
  } catch {
    return 0n;
  }
}

function pct(part: bigint, whole: bigint): string {
  if (whole <= 0n) return "–";
  const ppm = Number((part * 1_000_000n) / whole) / 10_000;
  return ppm >= 10 ? `${ppm.toFixed(1)}%` : `${ppm.toFixed(2)}%`;
}

export function TeamPanel({ token, totalSupply, pairSymbol, pairDecimals }: {
  token: string;
  totalSupply: bigint;
  pairSymbol: string;
  pairDecimals: number;
}) {
  const query = useQuery({
    queryKey: ["team", token],
    queryFn: () => api<{ team: TeamRow[]; exempt?: string[] }>(`/tokens/${token}/team`),
    refetchInterval: 30_000,
  });
  const team = query.data?.team ?? [];
  const open = query.data?.exempt ?? [];
  if (!query.isLoading && team.length === 0 && open.length === 0) return null;

  const bought = team.reduce((sum, t) => sum + big(t.tokens), 0n);
  const spent = team.reduce((sum, t) => sum + big(t.pair_spent), 0n);
  const now = Date.now();
  const locked = team.filter((t) => t.unlock_at && new Date(t.unlock_at).getTime() > now);
  const lockedTokens = locked.reduce((sum, t) => sum + big(t.tokens), 0n);
  const inHand = team.reduce((sum, t) => sum + big(t.balance), 0n);

  return (
    <section className="panel team-panel p-4" aria-labelledby="team-title">
      <div className="mb-2 flex items-center justify-between text-sm">
        <h3 id="team-title" className="font-semibold">Team</h3>
        <span className="mono dim">bought in the launch transaction</span>
      </div>

      {query.isError && <p className="empty-inline">the team list is not answering right now.</p>}
      {query.isLoading && <p className="empty-inline">reading the team</p>}

      {team.length > 0 && (
        <>
          <div className="holder-facts mb-3">
            <div className="fact">
              <strong>{pct(bought, totalSupply)}</strong>
              <span>of the supply bought by {team.length} team {team.length === 1 ? "wallet" : "wallets"}</span>
            </div>
            <div className="fact">
              <strong>{pct(lockedTokens, totalSupply)}</strong>
              <span>still locked</span>
            </div>
            <div className="fact">
              <strong>{pct(inHand, totalSupply)}</strong>
              <span>in the team's wallets now</span>
            </div>
          </div>

          <div className="team-rows space-y-1 text-xs">
            {team.map((t) => {
              const open = t.unlock_at ? new Date(t.unlock_at) : null;
              return (
                <div key={t.wallet} className="team-row">
                  <a className="mono hover:text-[var(--color-lime)]" href={`${EXPLORER}/address/${t.wallet}`} target="_blank" rel="noreferrer">
                    {shortAddress(t.wallet)}
                  </a>
                  <span className="mono dim">paid {fmt(big(t.pair_spent), pairDecimals, 4)} {pairSymbol}</span>
                  <span className="mono team-num">{fmt(big(t.tokens), 18, 0)} bought</span>
                  <span className="mono dim team-num">
                    {open
                      ? open.getTime() > now ? `locked until ${open.toLocaleDateString()}` : "lock open"
                      : "not locked"}
                  </span>
                </div>
              );
            })}
          </div>

          <p className="holder-note mt-3">
            {team.length} wallets paid {fmt(spent, pairDecimals, 4)} {pairSymbol} between them, before anyone else could
            trade. Every wallet and every lock is on chain in the{" "}
            <a className="hover:text-[var(--color-lime)]" href={`${EXPLORER}/tx/${team[0]!.tx}`} target="_blank" rel="noreferrer">launch transaction</a>.
          </p>
        </>
      )}

      {open.length > 0 && (
        <div className="team-open mt-3">
          <p className="holder-note">
            <b>{open.length} open buyer{open.length === 1 ? "" : "s"}</b>: wallets the launch named as paying no opening tax in
            its first seconds. Everyone else pays 99% in the launch's own second, 6% the next, under 1% the one after, then nothing. Named on chain in the
            launch itself; the holder map labels them.
          </p>
          <div className="team-rows space-y-1 text-xs mt-2">
            {open.map((w) => (
              <div key={w} className="team-row">
                <a className="mono hover:text-[var(--color-lime)]" href={`${EXPLORER}/address/${w}`} target="_blank" rel="noreferrer">
                  {shortAddress(w)}
                </a>
                <span className="mono dim">open buyer</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
