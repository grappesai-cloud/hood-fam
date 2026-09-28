"use client";

import { useState } from "react";
import Link from "next/link";
import { erc20Abi, zeroAddress, type Address } from "viem";
import { useAccount, useBlockNumber, usePublicClient, useReadContract, useReadContracts, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { useQuery } from "@tanstack/react-query";
import { hoodBlockZeroAbi, hoodCurveAbi } from "@hood/sdk";
import { api } from "@/lib/api";
import { blockZeroAddress, EXPLORER } from "@/lib/config";
import { fmt, pairDecimals, pairSymbol, shortAddress } from "@/lib/format";
import { Field, Step } from "@/components/LaunchUI";
import { EMPTY_LEG, legsProblem, TeamLegsEditor, units, type LegForm } from "@/components/TeamLegsEditor";

/// The team's view of its own launch in the first minutes: how much wallets outside the team have
/// bought, what the opening tax is charging right now, and a second wave that the periphery sends
/// only while the outside is under a line the launcher draws. Nothing here trades on its own.

interface Trade { side: string; trader: string; recipient: string | null; pair_amount: string; token_amount: string; ts: string; tx: string }
interface TeamRow { wallet: string }
interface TokenRow { symbol: string; pair_token: string; pair_decimals?: number | null; pair_symbol?: string | null; total_supply: string; mode: string }

function pct(part: bigint, whole: bigint): string {
  if (whole <= 0n) return "–";
  const v = Number((part * 1_000_000n) / whole) / 10_000;
  return v >= 10 ? `${v.toFixed(1)}%` : `${v.toFixed(2)}%`;
}

export function TeamWatch({ token }: { token: Address }) {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { writeContractAsync, isPending } = useWriteContract();
  const [hash, setHash] = useState<`0x${string}` | undefined>();
  const receipt = useWaitForTransactionReceipt({ hash });
  const [error, setError] = useState<string | null>(null);
  const [legs, setLegs] = useState<LegForm[]>([{ ...EMPTY_LEG }]);
  const [linePct, setLinePct] = useState("2");
  const [gas, setGas] = useState("0.0005");
  const { data: blockNumber } = useBlockNumber({ watch: true });

  const row = useQuery({ queryKey: ["token", token], queryFn: () => api<TokenRow>(`/tokens/${token}`), refetchInterval: 6000, retry: 15, retryDelay: 2000 });
  const team = useQuery({ queryKey: ["team", token], queryFn: () => api<{ team: TeamRow[] }>(`/tokens/${token}/team`), refetchInterval: 6000 });
  const trades = useQuery({ queryKey: ["trades", token, "watch"], queryFn: () => api<{ trades: Trade[] }>(`/tokens/${token}/trades?limit=100`), refetchInterval: 3000 });

  const zero = blockZeroAddress ?? zeroAddress;
  const { data: zeroReads } = useReadContracts({
    contracts: [
      { address: zero, abi: hoodBlockZeroAbi, functionName: "launcherOf", args: [token] },
      { address: zero, abi: hoodBlockZeroAbi, functionName: "curveOf", args: [token] },
      { address: zero, abi: hoodBlockZeroAbi, functionName: "teamTokens", args: [token] },
    ],
    query: { enabled: Boolean(blockZeroAddress), refetchInterval: 3000 },
  });
  const launcher = (zeroReads?.[0]?.result as Address | undefined) ?? zeroAddress;
  const curve = (zeroReads?.[1]?.result as Address | undefined) ?? zeroAddress;
  const teamTokens = (zeroReads?.[2]?.result as bigint | undefined) ?? 0n;
  const onCurve = curve !== zeroAddress;
  const { data: outside } = useReadContract({
    address: zero, abi: hoodBlockZeroAbi, functionName: "outsideBought", args: [token], query: { enabled: onCurve, refetchInterval: 2000 },
  });
  const { data: curveReads } = useReadContracts({
    contracts: [
      { address: curve, abi: hoodCurveAbi, functionName: "currentSnipeBps" },
      { address: curve, abi: hoodCurveAbi, functionName: "maxBuy" },
      { address: curve, abi: hoodCurveAbi, functionName: "restrictionsEndBlock" },
      { address: curve, abi: hoodCurveAbi, functionName: "pairToken" },
    ],
    query: { enabled: onCurve, refetchInterval: 1000 },
  });
  const snipeBps = Number((curveReads?.[0]?.result as bigint | undefined) ?? 0n);
  const maxBuy = (curveReads?.[1]?.result as bigint | undefined) ?? 0n;
  const capEnd = (curveReads?.[2]?.result as bigint | undefined) ?? 0n;
  const pair = ((curveReads?.[3]?.result as Address | undefined) ?? (row.data?.pair_token as Address | undefined) ?? zeroAddress);
  const dec = row.data?.pair_decimals ?? pairDecimals(pair);
  const sym = row.data?.pair_symbol ?? pairSymbol(pair);
  const supply = BigInt(row.data?.total_supply || "0");
  const isNative = pair === zeroAddress;

  const teamSet = new Set((team.data?.team ?? []).map((t) => t.wallet.toLowerCase()));
  const machine = new Set([zero.toLowerCase(), curve.toLowerCase()]);
  const outsideBuys = (trades.data?.trades ?? []).filter((t) =>
    t.side === "buy" && !teamSet.has(t.trader.toLowerCase()) && !machine.has(t.trader.toLowerCase())
    && !(t.recipient && teamSet.has(t.recipient.toLowerCase())));

  const line = units(linePct, 2) * supply / 10_000n;
  const legTotal = legs.reduce((s, l) => s + units(l.amount, dec), 0n);
  const gasEach = units(gas, 18);
  const value = (isNative ? legTotal : 0n) + gasEach * BigInt(legs.length);
  const isLauncher = Boolean(address) && address!.toLowerCase() === launcher.toLowerCase();

  const { data: allowance } = useReadContract({
    address: pair, abi: erc20Abi, functionName: "allowance", args: [address ?? zeroAddress, zero],
    query: { enabled: !isNative && Boolean(address) && onCurve },
  });
  const needsApproval = !isNative && ((allowance as bigint | undefined) ?? 0n) < legTotal;

  const blocked = !onCurve ? undefined
    : !isLauncher ? "Only the wallet that launched can send a second wave."
    : legsProblem(legs, dec)
    ?? (supply === 0n ? "Reading the supply." : undefined);

  async function wave() {
    if (blocked || !address || !blockZeroAddress) return;
    setError(null);
    try {
      if (needsApproval) {
        setHash(await writeContractAsync({ address: pair, abi: erc20Abi, functionName: "approve", args: [blockZeroAddress, legTotal] }));
        return;
      }
      const legArgs = legs.map((l) => ({
        wallet: l.wallet.trim() as Address, pairIn: units(l.amount, dec), minTokensOut: 0n, lock: BigInt(l.lock), gas: gasEach,
      }));
      await publicClient!.simulateContract({
        account: address, address: blockZeroAddress, abi: hoodBlockZeroAbi, functionName: "followUp", args: [token, legArgs, line] as never, value,
      });
      setHash(await writeContractAsync({
        address: blockZeroAddress, abi: hoodBlockZeroAbi, functionName: "followUp", args: [token, legArgs, line] as never, value,
      }));
    } catch (e) {
      const msg = e instanceof Error ? (e as { shortMessage?: string }).shortMessage ?? e.message : String(e);
      setError(msg.includes("OutsidersAhead") ? "The outside is already past your line, so the wave stood down. Nothing was spent." : msg);
    }
  }

  return (
    <div className="launch-content">
      <div className="launch-guide">
        <div className="launch-form-stack">
          <Step n={1} title={`Watching $${row.data?.symbol ?? "…"}`} purpose="What wallets outside the team have done since the launch transaction. Refreshes every few seconds.">
            <div className="holder-facts">
              <div className="fact">
                <strong>{onCurve && outside !== undefined ? pct(outside as bigint, supply) : "–"}</strong>
                <span>bought by wallets outside the team</span>
              </div>
              <div className="fact">
                <strong>{pct(teamTokens, supply)}</strong>
                <span>bought by the team</span>
              </div>
              <div className="fact">
                <strong>{onCurve ? `${(snipeBps / 100).toFixed(snipeBps < 1000 ? 1 : 0)}%` : "–"}</strong>
                <span>opening tax right now</span>
              </div>
              <div className="fact">
                <strong>{onCurve && maxBuy > 0n && blockNumber !== undefined && blockNumber <= capEnd ? `${capEnd - blockNumber} blocks` : "off"}</strong>
                <span>{maxBuy > 0n ? `wallet cap, ${pct(maxBuy, supply)} each` : "wallet cap"}</span>
              </div>
            </div>
            <div className="team-watch-tape mt-3 space-y-1 text-xs">
              {outsideBuys.length === 0 && <p className="dim">No outside buys yet.</p>}
              {outsideBuys.slice(0, 12).map((t) => (
                <div key={`${t.tx}:${t.trader}:${t.token_amount}`} className="team-row">
                  <a className="mono hover:text-[var(--color-lime)]" href={`${EXPLORER}/address/${t.recipient ?? t.trader}`} target="_blank" rel="noreferrer">{shortAddress(t.recipient ?? t.trader)}</a>
                  <span className="mono dim">{fmt(BigInt(t.pair_amount), dec, 4)} {sym}</span>
                  <span className="mono team-num">{pct(BigInt(t.token_amount), supply)}</span>
                  <a className="mono dim team-num hover:text-[var(--color-lime)]" href={`${EXPLORER}/tx/${t.tx}`} target="_blank" rel="noreferrer">{new Date(t.ts).toLocaleTimeString()}</a>
                </div>
              ))}
            </div>
            <p className="field-note mt-3">
              <Link className="hover:text-[var(--color-lime)]" href={`/token/${token}`}>Token page</Link>
              {" · "}
              <Link className="hover:text-[var(--color-lime)]" href={`/launch/team/desk?token=${token}`}>Team desk</Link>
            </p>
          </Step>

          {onCurve ? (
            <Step n={2} title="Second wave" purpose="More team buys, sent only while the outside has bought less than your line. Past it the transaction reverts and nothing is spent. It is a normal buy one transaction later, so it pays the opening tax and meets the wallet cap like anyone.">
              <TeamLegsEditor legs={legs} onChange={setLegs} symbol={sym} decimals={dec} />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Stand down if the outside has bought more than, % of supply" help={supply > 0n ? `${fmt(line, 18, 0)} tokens.` : undefined}>
                  <input className="input mono" value={linePct} onChange={(e) => setLinePct(e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" />
                </Field>
                <Field label="Gas per wallet, in ETH">
                  <input className="input mono" value={gas} onChange={(e) => setGas(e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" />
                </Field>
              </div>
              {blocked && <p className="field-note bad mt-3">{blocked}</p>}
              {error && <p className="field-note bad mt-3">{error}</p>}
              {receipt.isSuccess && <p className="field-note good mt-3">Sent. The new wallets are on the team list.</p>}
              <button type="button" className="btn mt-4" disabled={Boolean(blocked) || isPending || receipt.isLoading} onClick={wave}>
                {isPending || receipt.isLoading ? "Waiting for the chain…" : needsApproval ? `Approve ${sym}` : "Send the second wave"}
              </button>
            </Step>
          ) : (
            <Step n={2} title="Second wave" purpose="The second wave is a curve feature. A direct launch's team buys all happen in its launch transaction.">
              <p className="field-note">Nothing to send here for a direct launch.</p>
            </Step>
          )}
        </div>
      </div>
    </div>
  );
}
