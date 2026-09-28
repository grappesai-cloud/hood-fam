"use client";

import { use } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useAccount, useReadContract, useWriteContract } from "wagmi";
import { encodeAbiParameters, keccak256, zeroAddress, type Address } from "viem";
import { hoodCurveAbi, hoodFeeRouterAbi, hoodStakingAbi, uniswapV4GraduatorAbi } from "@hood/sdk";
import { api, type TokenDetail } from "@/lib/api";
import { addresses, directAddresses, EXPLORER } from "@/lib/config";
import { useLive } from "@/lib/live";
import { TradeBox } from "@/components/TradeBox";
import { Tape } from "@/components/Tape";
import { Sound } from "@/components/Sound";
import { GraduationRace } from "@/components/GraduationRace";
import { GraduationCelebration } from "@/components/GraduationCelebration";
import { WatchButton } from "@/components/Social";
import { HolderMap } from "@/components/HolderMap";
import { TokenChat } from "@/components/TokenChat";
import { DirectTradeBox } from "@/components/DirectTradeBox";
import { DirectPanels } from "@/components/DirectPanels";
import { HoldersPaid } from "@/components/token/HoldersPaid";
import { PenaltyTape } from "@/components/token/PenaltyTape";
import { KingOfHill } from "@/components/token/KingOfHill";
import { BoostBadge } from "@/components/token/BoostBadge";
import { BoostBuy } from "@/components/token/BoostBuy";
import { AuctionPanel } from "@/components/token/AuctionPanel";
import { TeamPanel } from "@/components/token/TeamPanel";
import dynamic from "next/dynamic";
// lightweight-charts is ~45 kB and the chart is a widget, not the first thing a trader needs. Split
// it out of the token page's initial bundle and mount it after hydration, behind a matching box, so
// the page paints and the trade box is interactive without waiting on the charting library.
const Chart = dynamic(() => import("@/components/Chart").then((m) => m.Chart), {
  ssr: false,
  loading: () => <div className="h-[320px] w-full animate-pulse rounded-xl bg-[var(--color-ink)]" />,
});
import { LockElsewhere, StakePanel } from "@/components/StakePanel";
import { ago, compact, fmt, imageUrl, launchProgress, machineLabel, pairDecimals, pairSymbol, safeUrl, splitOf, screenerLinks, shortAddress, splitLabel, telegramUrl, twitterUrl } from "@/lib/format";
import { Artwork } from "@/components/Artwork";
import { FeeFlow } from "@/components/FeeFlow";
import { Figure, Prov, usdCompact, type Provenance } from "@/components/Provenance";
import { sortedPair, uniswapAddLiquidityUrl, uniswapPoolUrl, uniswapSwapUrl } from "@/lib/links";

interface PoolKey { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }

/// v4 has no pool contract: a pool is the hash of its key inside the PoolManager, and that hash is
/// what the screeners address it by.
function poolIdOf(key: PoolKey): string {
  return keccak256(encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
    [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
  ));
}

export default function TokenPage({ params }: { params: Promise<{ address: string }> }) {
  const { address: token } = use(params);
  const { address: me } = useAccount();

  // Every number below is read on a timer, and the stream is what makes those timers the fallback
  // rather than the pace of the page: a trade on this launch refreshes the same queries at once.
  useLive({ tokens: [token] });

  // A creator lands here the second their launch transaction is mined, a few seconds before the
  // indexer has seen that block. A 404 in that window is "not yet", not "not a token".
  const { data, isError, failureCount } = useQuery({
    queryKey: ["token", token],
    queryFn: () => api<TokenDetail>(`/tokens/${token}`),
    refetchInterval: 6000,
    retry: 15,
    retryDelay: 2000,
  });

  const holders = useQuery({
    queryKey: ["holders", token],
    queryFn: () => api<{ holders: { address: string; balance: string; team?: boolean }[] }>(`/tokens/${token}/holders`),
    refetchInterval: 30_000,
  });

  const { data: accrued } = useReadContract({
    address: addresses.feeRouter, abi: hoodFeeRouterAbi, functionName: "accrued",
    args: [token as Address], query: { refetchInterval: 10_000 },
  });

  const { writeContractAsync } = useWriteContract();

  // The one coin this pad's vault accepts. Read from the vault rather than configured, because it
  // is named once on chain and the app should never disagree with it.
  const { data: houseToken } = useReadContract({
    address: addresses.staking, abi: hoodStakingAbi, functionName: "houseToken",
  });

  // a graduated curve token trades its pool; the key is whatever the graduator opened
  const { data: position } = useReadContract({
    address: addresses.graduator, abi: uniswapV4GraduatorAbi, functionName: "positionOf",
    args: [token as Address], query: { enabled: Boolean(data && data.mode === "curve" && data.phase === 2) },
  });
  const graduatedKey = (position as readonly [PoolKey, bigint] | undefined)?.[0];

  if (isError) return <div className="token-shell"><div className="token-breadcrumb"><Link href="/">← ALL LAUNCHES</Link></div><div className="portfolio-empty panel"><span>↯</span><h2>Token unavailable.</h2><p>We could not find this token or reach the indexer.</p></div></div>;
  if (!data) {
    return (
      <div className="token-shell"><div className="token-breadcrumb"><Link href="/">← ALL LAUNCHES</Link></div><div className="portfolio-empty panel"><span>✳</span><h2>Finding the market.</h2><p>{failureCount > 0 ? "Your launch is on chain. The board is catching up with it." : "Loading token data…"}</p></div></div>
    );
  }

  const dec = pairDecimals(data.pair_token, data);
  const sym = pairSymbol(data.pair_token, data);
  const progress = launchProgress(data);
  // total_supply is what is left after burns; the cap is price times that, not times what was printed
  const totalSupply = BigInt(data.total_supply || "0");
  const burned = BigInt(data.burned || "0");
  const isCreator = me?.toLowerCase() === data.creator.toLowerCase();
  const isDirect = data.mode === "direct";
  const isHouse = typeof houseToken === "string" && houseToken.toLowerCase() === data.token.toLowerCase();
  const graduated = data.status === "graduated";
  // a direct launch's pool is on the row; a graduated curve token's is whatever key the graduator opened
  const poolId = isDirect ? data.pool_id : graduatedKey ? poolIdOf(graduatedKey) : null;
  const hasPool = isDirect || graduated;
  const links = screenerLinks(data.token, poolId);
  // The pool's key, for the links into Uniswap's own app: a direct launch's is on the row, a
  // graduated curve token's is whatever the graduator opened. Nothing here is a form of ours.
  const poolKey = isDirect && data.hook && data.pool_fee != null && data.tick_spacing != null
    ? (() => {
        const [currency0, currency1] = sortedPair(data.token, data.pair_token);
        return { currency0, currency1, fee: data.pool_fee, tickSpacing: data.tick_spacing, hooks: data.hook };
      })()
    : graduatedKey
      ? { currency0: graduatedKey.currency0, currency1: graduatedKey.currency1, fee: Number(graduatedKey.fee), tickSpacing: Number(graduatedKey.tickSpacing), hooks: graduatedKey.hooks }
      : null;
  // The cap is the last trade's price times what is left of the supply: both measured, the product
  // derived. In dollars only when the pair has a price source, and it says which one.
  const cap = (BigInt(data.price || "0") * totalSupply) / 10n ** 18n;
  const capUsd = data.usd?.usd != null ? (Number(cap) / 10 ** dec) * data.usd.usd : null;
  const usdKind: Provenance = data.usd?.source === "feed" || data.usd?.source === "resolver" ? "reported" : "derived";
  // What the fee machinery has actually paid on this launch. A curve pays on a flush; a direct
  // launch pays on a sweep, which the API files under what came in.
  const paidOut = BigInt((isDirect ? data.fees?.accrued : data.fees?.flushed) ?? "0");
  // The pot's receipts, under the payout line on either machine. King of the hill is a splitter
  // option, so it only ever has a panel on a launch whose penalties turned it on.
  const kingBps = data.penalties?.king_bps ?? 0;
  const holdersPaid = (
    <HoldersPaid token={data.token} pot={data.pot} paidToHolders={data.paid_to_holders} decimals={dec} symbol={sym} />
  );
  const supplyFacts = (
    <>
      <Fact label="supply" value={`${compact(totalSupply)} ${data.symbol}`} />
      {burned > 0n && <Fact label="burned" value={`${compact(burned)} ${data.symbol}`} />}
      {data.referral_to && (data.referral_bps ?? 0) > 0 && (
        <Fact label={`brought by ${shortAddress(data.referral_to)}`}
          value={`${((data.referral_bps ?? 0) / 100).toFixed(0)}% of the protocol's share`} />
      )}
    </>
  );

  return (
    <div className="token-shell">
    <GraduationCelebration token={data.token} symbol={data.symbol} />
    <div className="token-breadcrumb"><Link href="/">← ALL LAUNCHES</Link><span>/</span><span>$</span><span>{data.symbol}</span></div>
        <header className="panel token-hero flex flex-wrap items-center gap-4 p-4">
          <Artwork src={imageUrl(data.image)} symbol={data.symbol} size={64} rounded="rounded-xl" />
          <div className="min-w-0 flex-1">
            <div className="section-kicker">ONCHAIN / TOKEN PROFILE</div>
            <div className="flex flex-wrap items-baseline gap-2">
              <h1 className="text-xl font-semibold">{data.name}</h1>
              <span className="mono dim">$<span>{data.symbol}</span></span>
              <span className={`rounded-full border px-2 py-0.5 text-[11px] ${
                graduated ? "border-[var(--color-lime)] text-[var(--color-lime)]" : "border-[var(--color-line)] dim"
              }`}>
                {isDirect ? "Live in pool" : machineLabel(data)}
              </span>
              {data.boosted && <BoostBadge />}
            </div>
            <p className="text-sm dim">{data.description}</p>
            <div className="mt-1 flex flex-wrap gap-3 text-xs dim">
              <a className="hover:text-[var(--color-lime)]" href={`${EXPLORER}/token/${data.token}`} target="_blank" rel="noreferrer">contract</a>
              {isDirect && data.hook && <a className="hover:text-[var(--color-lime)]" href={`${EXPLORER}/address/${data.hook}`} target="_blank" rel="noreferrer">hook</a>}
              {isDirect && data.splitter && <a className="hover:text-[var(--color-lime)]" href={`${EXPLORER}/address/${data.splitter}`} target="_blank" rel="noreferrer">splitter</a>}
              {hasPool && <a className="hover:text-[var(--color-lime)]" href={links.dexscreener} target="_blank" rel="noreferrer">dexscreener</a>}
              {hasPool && links.geckoterminal && <a className="hover:text-[var(--color-lime)]" href={links.geckoterminal} target="_blank" rel="noreferrer">geckoterminal</a>}
              {hasPool && <a className="hover:text-[var(--color-lime)]" href={uniswapSwapUrl(data.token, data.pair_token)} target="_blank" rel="noreferrer">trade on uniswap</a>}
              {poolKey && <a className="hover:text-[var(--color-lime)]" href={uniswapAddLiquidityUrl(poolKey)} target="_blank" rel="noreferrer">add liquidity</a>}
              {poolId && <a className="hover:text-[var(--color-lime)]" href={uniswapPoolUrl(poolId)} target="_blank" rel="noreferrer">pool</a>}
              {safeUrl(data.website) && <a className="hover:text-[var(--color-lime)]" href={safeUrl(data.website)!} target="_blank" rel="noreferrer noopener">website</a>}
              {twitterUrl(data.twitter) && <a className="hover:text-[var(--color-lime)]" href={twitterUrl(data.twitter)!} target="_blank" rel="noreferrer noopener">x</a>}
              {telegramUrl(data.telegram) && <a className="hover:text-[var(--color-lime)]" href={telegramUrl(data.telegram)!} target="_blank" rel="noreferrer noopener">telegram</a>}
              <span>printed {ago(data.launched_at)} ago by <Link className="hover:text-[var(--color-lime)]" href={`/portfolio?address=${data.creator}`}>{shortAddress(data.creator)}</Link></span>
              {(data.team_legs ?? 0) > 0 && (
                <span className="token-team-line">team launch: {data.team_legs} wallets bought in block zero</span>
              )}
              {BigInt(data.first_buy_locked || "0") > 0n && (
                <span className="token-locked-line">
                  dev locked
                  {data.first_buy_unlock_at
                    ? new Date(data.first_buy_unlock_at).getTime() > Date.now()
                      ? ` until ${new Date(data.first_buy_unlock_at).toLocaleDateString()}`
                      : " (expired)"
                    : ""}
                </span>
              )}
            </div>
          </div>
          <div className="token-hero-cap text-right">
            <div className="mono text-lg">{compact(cap, dec)} {sym}</div>
            <div className="text-xs dim">MARKET CAP <Prov kind="derived" /></div>
            {capUsd != null ? (
              <div className="mono text-sm">{usdCompact(capUsd)} <Prov kind={usdKind} /></div>
            ) : (
              <div className="text-xs dim figure-reason"><span className="figure-dash">—</span> {data.usd?.reason ?? "no dollar price for this pair"}</div>
            )}
            <WatchButton token={data.token} className="mt-2" />
          </div>
        </header>

        {isDirect ? (
          <section className="panel token-facts p-4">
            <div className="mb-2 flex items-center justify-between text-sm">
              <span>Live in the pool</span>
              <span className="mono dim">Liquidity from block one</span>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
              <Fact label="24h volume" value={`${compact(BigInt(data.volume_24h || "0"), dec)} ${sym}`} />
              <Fact label="holders" value={String(data.holders)} />
              <Fact label="trades" value={String(data.trades_total)} />
              <Fact label="pool fee" value={data.pool_fee == null ? null : `${(data.pool_fee / 10_000).toFixed(2)}%`} reason="the pool's shape has not been indexed yet" />
              {supplyFacts}
              {data.alloc_dividends_bps != null && (
                <Fact label="tax paid to holders"
                  value={data.alloc_dividends_bps === 0 ? "none on this launch" : `${(data.alloc_dividends_bps / 100).toFixed(0)}% of the creator's share`} />
              )}
            </div>
            <PaidOut amount={paidOut} decimals={dec} symbol={sym} token={data.token} />
            {holdersPaid}
          </section>
        ) : (
        <section className="panel token-tape p-4">
          <div className="mb-2 flex items-center justify-between text-sm">
            <span>{machineLabel(data)}</span>
            <span className="mono dim">{(progress * 100).toFixed(1)}% to the pool</span>
          </div>
          {((data.snipe_tax_bps ?? 0) > 0 || (data.max_buy_bps ?? 0) > 0) && (
            <p className="token-guard-line mono dim text-xs mb-2">
              opening rules:
              {(data.snipe_tax_bps ?? 0) > 0 && ` ${(data.snipe_tax_bps! / 100).toFixed(0)}% extra on buys, gone after ${data.snipe_decay_seconds}s, 80% to holders`}
              {(data.snipe_tax_bps ?? 0) > 0 && (data.max_buy_bps ?? 0) > 0 && " ·"}
              {(data.max_buy_bps ?? 0) > 0 && ` ${(data.max_buy_bps! / 100).toFixed(2)}% per wallet until block ${data.restrictions_end_block}`}
            </p>
          )}
          <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--color-ink)]">
            <div className="h-full rounded-full bg-[var(--color-lime)]" style={{ width: `${Math.min(100, progress * 100)}%` }} />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
            <Fact label="raised" value={`${fmt(BigInt(data.reserve || "0"), dec, 4)} ${sym}`} />
            <Fact label="24h volume" value={`${compact(BigInt(data.volume_24h || "0"), dec)} ${sym}`} />
            <Fact label="holders" value={String(data.holders)} />
            <Fact label="trades" value={String(data.trades_total)} />
            {supplyFacts}
          </div>
          <PaidOut amount={paidOut} decimals={dec} symbol={sym} token={data.token} />
          {holdersPaid}
        </section>
        )}

    <div className="token-layout">
      <div className="space-y-4">
        <Chart token={data.token} decimals={dec} totalSupply={totalSupply} />

        <section className="grid gap-4 md:grid-cols-2">
          {!isDirect && (
          <div className="panel p-4">
            <h3 className="mb-2 font-semibold">Where the fee goes</h3>
            <p className="text-sm">{splitLabel(data)}</p>
            <p className="mt-1 text-xs dim">
              Chosen at launch and locked. Nobody, including us, can point it somewhere else.
            </p>
            <FeeFlow
              legs={splitOf(data).map((l) => ({ key: l.leg, label: l.label, bps: l.bps }))}
              token={data.token}
              source={`fee on every trade`}
              waiting={`${fmt((accrued as bigint | undefined) ?? 0n, dec, 6)} ${sym} waiting to be pushed`}
            />
            {(data.split_buyback_bps ?? 0) > 0 ? (
              <p className="mt-2 text-xs dim">The buyback trades against a quoted price floor. The Safe-appointed keeper sends this fee onward.</p>
            ) : (
              <button className="btn btn-ghost mt-2 w-full text-xs"
                disabled={!me || ((accrued as bigint | undefined) ?? 0n) === 0n}
                onClick={() => writeContractAsync({
                  address: addresses.feeRouter, abi: hoodFeeRouterAbi, functionName: "flush", args: [data.token as Address],
                })}>
                push the fees through (anyone can)
              </button>
            )}
          </div>
          )}

          <div className="panel p-4">
            <h3 className="mb-2 font-semibold">Top holders</h3>
            <div className="space-y-1 text-xs">
              {holders.data?.holders.slice(0, 8).map((h) => (
                <div key={h.address} className="flex justify-between">
                  <span className="mono dim">{shortAddress(h.address)}{h.team && <span className="team-tag"> team</span>}</span>
                  <span className="mono">{fmt(BigInt(h.balance))}</span>
                </div>
              ))}
              {holders.data?.holders.length === 0 && <p className="dim">nobody yet</p>}
            </div>
          </div>
        </section>

        <HolderMap
          token={data.token}
          symbol={data.symbol}
          creator={data.creator}
          curve={data.curve}
          locker={data.locker}
          splitter={data.splitter}
          hook={data.hook}
          totalSupply={totalSupply}
          holders={data.holders}
        />

        {(data.team_legs ?? 0) > 0 && (
          <TeamPanel token={data.token} totalSupply={totalSupply} pairSymbol={sym} pairDecimals={dec} />
        )}

        <GraduationRace current={data.token} />

        <PenaltyTape token={data.token} />

        {/* The sound toggle is the tape's, and sits on top of it. It is a sibling rather than a
            child because Tape.tsx is the shared tape every brand's board runs too, and is not this
            page's to rewrite. */}
        <div className="tape-block">
          <Sound token={data.token} progress={progress} />
          <Tape token={data.token} symbol={data.symbol} pairToken={data.pair_token} />
        </div>

        <TokenChat token={data.token} symbol={data.symbol} creator={data.creator} pairToken={data.pair_token} launchedAt={data.launched_at} />
      </div>

      <aside className="space-y-4">
        {isDirect ? (
          <>
            <DirectTradeBox
              token={data.token as Address}
              hook={data.hook as Address}
              quote={data.pair_token as Address}
              symbol={data.symbol}
              poolFee={data.pool_fee ?? 10_000}
              tickSpacing={data.tick_spacing ?? 200}
            />
            <DirectPanels
              token={data.token as Address}
              hook={data.hook as Address}
              splitter={data.splitter as Address}
              locker={data.locker as Address}
              quote={data.pair_token as Address}
              launchedAt={Math.floor(new Date(data.launched_at).getTime() / 1000)}
              buybackModule={directAddresses.buybackModule}
            />
          </>
        ) : data.phase === 2 && graduatedKey ? (
          <DirectTradeBox
            token={data.token as Address}
            quote={data.pair_token as Address}
            symbol={data.symbol}
            poolFee={Number(graduatedKey.fee)}
            tickSpacing={Number(graduatedKey.tickSpacing)}
          />
        ) : (
          <TradeBox token={data.token as Address} curve={data.curve as Address}
            pairToken={data.pair_token as Address} pairDecimals={dec} pairSymbol={sym}
            symbol={data.symbol} phase={data.phase} />
        )}

        {/* The opening auction only exists while it is open, and the panel decides that itself. */}
        <AuctionPanel token={data.token as Address} />

        {kingBps > 0 && (
          <KingOfHill token={data.token} splitter={data.splitter} kingBps={kingBps} decimals={dec} symbol={sym} />
        )}

        {!isDirect && data.phase === 1 && (
          <button className="btn w-full" onClick={() => writeContractAsync({
            address: data.curve as Address, abi: hoodCurveAbi, functionName: "finalize", args: [],
          })}>
            open the pool
          </button>
        )}

        {/* There is one coin to lock on this pad and it is not, as a rule, the one on screen. On
            the house coin's own page this is the room itself; everywhere else it is a sentence
            saying where the room is and that nothing here can be locked. */}
        {isHouse ? <StakePanel /> : <LockElsewhere token={data.token as Address} />}

        <BoostBuy token={data.token as Address} symbol={data.symbol} boosted={data.boosted} />

        {isCreator && (
          <div className="panel p-4 text-sm">
            <h3 className="font-semibold">You printed this</h3>
            <p className="mt-1 text-xs dim">
              The fee stream points at {shortAddress(data.fee_recipient ?? data.creator)}.
              {isDirect ? " That recipient was fixed in the signed launch transaction." : " You can hand it to somebody else, in one step, and only you can."}
            </p>
            <Link className="btn btn-ghost mt-2 block text-center text-xs" href={`/portfolio`}>manage</Link>
          </div>
        )}

        <div className="panel p-4 text-xs dim">
          <p className="mb-1 font-semibold text-[var(--color-text)]">Pair</p>
          <p>{data.pair_token === zeroAddress
            ? "ETH, the chain's own gas token"
            : `${sym}, the quote token this market raises and graduates against`}</p>
        </div>
      </aside>
    </div>
    </div>
  );
}

/// Every fact on this page is our indexer's own count unless it says otherwise.
function Fact({ label, value, kind = "measured", reason }: {
  label: string; value: string | null; kind?: Provenance; reason?: string;
}) {
  return <Figure label={label} value={value} kind={kind} reason={reason} />;
}

/// The one line that turns the split into receipts: what has actually left, and where the rest of
/// the story is.
function PaidOut({ amount, decimals, symbol, token }: { amount: bigint; decimals: number; symbol: string; token: string }) {
  return (
    <p className="paid-out">
      paid out so far <span className="mono">{fmt(amount, decimals, 4)} {symbol}</span> <Prov kind="measured" />
      <span className="prov-sep">·</span>
      <Link href={`/ledger?token=${token}`}>every payout, on the ledger →</Link>
    </p>
  );
}
