"use client";

import { use } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useAccount, useReadContract, useWriteContract } from "wagmi";
import { encodeAbiParameters, keccak256, zeroAddress, type Address } from "viem";
import { hoodCurveAbi, hoodFeeRouterAbi, uniswapV4GraduatorAbi } from "@hood/sdk";
import { api, type TokenDetail } from "@/lib/api";
import { addresses, directAddresses, EXPLORER } from "@/lib/config";
import { TradeBox } from "@/components/TradeBox";
import { DirectTradeBox } from "@/components/DirectTradeBox";
import { DirectPanels } from "@/components/DirectPanels";
import dynamic from "next/dynamic";
// lightweight-charts is ~45 kB and the chart is a widget, not the first thing a trader needs. Split
// it out of the token page's initial bundle and mount it after hydration, behind a matching box, so
// the page paints and the trade box is interactive without waiting on the charting library.
const Chart = dynamic(() => import("@/components/Chart").then((m) => m.Chart), {
  ssr: false,
  loading: () => <div className="h-[320px] w-full animate-pulse rounded-xl bg-[var(--color-ink)]" />,
});
import { StakePanel } from "@/components/StakePanel";
import { ago, compact, feeModelLabel, fmt, imageUrl, launchProgress, machineLabel, pairDecimals, pairSymbol, safeUrl, screenerLinks, shortAddress, telegramUrl, twitterUrl } from "@/lib/format";
import { Artwork } from "@/components/Artwork";

interface Trade {
  side: string; trader: string; pair_amount: string; token_amount: string; price: string; ts: string; tx: string;
}

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

  // A creator lands here the second their launch transaction is mined, a few seconds before the
  // indexer has seen that block. A 404 in that window is "not yet", not "not a token".
  const { data, isError, failureCount } = useQuery({
    queryKey: ["token", token],
    queryFn: () => api<TokenDetail>(`/tokens/${token}`),
    refetchInterval: 6000,
    retry: 15,
    retryDelay: 2000,
  });

  const trades = useQuery({
    queryKey: ["trades", token],
    queryFn: () => api<{ trades: Trade[] }>(`/tokens/${token}/trades?limit=40`),
    refetchInterval: 6000,
  });

  const holders = useQuery({
    queryKey: ["holders", token],
    queryFn: () => api<{ holders: { address: string; balance: string }[] }>(`/tokens/${token}/holders`),
    refetchInterval: 30_000,
  });

  const { data: accrued } = useReadContract({
    address: addresses.feeRouter, abi: hoodFeeRouterAbi, functionName: "accrued",
    args: [token as Address], query: { refetchInterval: 10_000 },
  });

  const { writeContractAsync } = useWriteContract();

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

  const dec = pairDecimals(data.pair_token);
  const sym = pairSymbol(data.pair_token);
  const progress = launchProgress(data);
  // total_supply is what is left after burns; the cap is price times that, not times what was printed
  const totalSupply = BigInt(data.total_supply || "0");
  const burned = BigInt(data.burned || "0");
  const isCreator = me?.toLowerCase() === data.creator.toLowerCase();
  const isDirect = data.mode === "direct";
  const graduated = data.status === "graduated";
  // a direct launch's pool is on the row; a graduated curve token's is whatever key the graduator opened
  const poolId = isDirect ? data.pool_id : graduatedKey ? poolIdOf(graduatedKey) : null;
  const hasPool = isDirect || graduated;
  const links = screenerLinks(data.token, poolId);
  const supplyFacts = (
    <>
      <Fact label="supply" value={`${compact(totalSupply)} ${data.symbol}`} />
      {burned > 0n && <Fact label="burned" value={`${compact(burned)} ${data.symbol}`} />}
    </>
  );

  return (
    <div className="token-shell">
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
            </div>
            <p className="text-sm dim">{data.description}</p>
            <div className="mt-1 flex flex-wrap gap-3 text-xs dim">
              <a className="hover:text-[var(--color-lime)]" href={`${EXPLORER}/token/${data.token}`} target="_blank" rel="noreferrer">contract</a>
              {isDirect && data.hook && <a className="hover:text-[var(--color-lime)]" href={`${EXPLORER}/address/${data.hook}`} target="_blank" rel="noreferrer">hook</a>}
              {isDirect && data.splitter && <a className="hover:text-[var(--color-lime)]" href={`${EXPLORER}/address/${data.splitter}`} target="_blank" rel="noreferrer">splitter</a>}
              {hasPool && <a className="hover:text-[var(--color-lime)]" href={links.dexscreener} target="_blank" rel="noreferrer">dexscreener</a>}
              {hasPool && links.geckoterminal && <a className="hover:text-[var(--color-lime)]" href={links.geckoterminal} target="_blank" rel="noreferrer">geckoterminal</a>}
              {safeUrl(data.website) && <a className="hover:text-[var(--color-lime)]" href={safeUrl(data.website)!} target="_blank" rel="noreferrer noopener">website</a>}
              {twitterUrl(data.twitter) && <a className="hover:text-[var(--color-lime)]" href={twitterUrl(data.twitter)!} target="_blank" rel="noreferrer noopener">x</a>}
              {telegramUrl(data.telegram) && <a className="hover:text-[var(--color-lime)]" href={telegramUrl(data.telegram)!} target="_blank" rel="noreferrer noopener">telegram</a>}
              <span>printed {ago(data.launched_at)} ago by <Link className="hover:text-[var(--color-lime)]" href={`/portfolio?address=${data.creator}`}>{shortAddress(data.creator)}</Link></span>
            </div>
          </div>
          <div className="token-hero-cap text-right">
            <div className="mono text-lg">{compact((BigInt(data.price || "0") * totalSupply) / 10n ** 18n, dec)} {sym}</div>
            <div className="text-xs dim">MARKET CAP</div>
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
              <Fact label="pool fee" value={`${((data.pool_fee ?? 0) / 10_000).toFixed(2)}%`} />
              {supplyFacts}
              {data.alloc_dividends_bps != null && (
                <Fact label="tax paid to holders"
                  value={data.alloc_dividends_bps === 0 ? "none on this launch" : `${(data.alloc_dividends_bps / 100).toFixed(0)}% of the creator's share`} />
              )}
            </div>
          </section>
        ) : (
        <section className="panel token-tape p-4">
          <div className="mb-2 flex items-center justify-between text-sm">
            <span>{machineLabel(data)}</span>
            <span className="mono dim">{(progress * 100).toFixed(1)}% to the pool</span>
          </div>
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
        </section>
        )}

    <div className="token-layout">
      <div className="space-y-4">
        <Chart token={data.token} decimals={dec} totalSupply={totalSupply} />

        <section className="grid gap-4 md:grid-cols-2">
          {!isDirect && (
          <div className="panel p-4">
            <h3 className="mb-2 font-semibold">Where the fee goes</h3>
            <p className="text-sm">{feeModelLabel(data.fee_model)}</p>
            <p className="mt-1 text-xs dim">
              Chosen at launch and locked. Nobody, including us, can point it somewhere else.
            </p>
            <div className="mt-3 flex items-center justify-between text-xs">
              <span className="dim">waiting to be pushed</span>
              <span className="mono">{fmt((accrued as bigint | undefined) ?? 0n, dec, 6)} {sym}</span>
            </div>
            <button className="btn btn-ghost mt-2 w-full text-xs"
              disabled={!me || ((accrued as bigint | undefined) ?? 0n) === 0n}
              onClick={() => writeContractAsync({
                address: addresses.feeRouter, abi: hoodFeeRouterAbi, functionName: "flush", args: [data.token as Address],
              })}>
              push the fees through (anyone can)
            </button>
          </div>
          )}

          <div className="panel p-4">
            <h3 className="mb-2 font-semibold">Top holders</h3>
            <div className="space-y-1 text-xs">
              {holders.data?.holders.slice(0, 8).map((h) => (
                <div key={h.address} className="flex justify-between">
                  <span className="mono dim">{shortAddress(h.address)}</span>
                  <span className="mono">{fmt(BigInt(h.balance))}</span>
                </div>
              ))}
              {holders.data?.holders.length === 0 && <p className="dim">nobody yet</p>}
            </div>
          </div>
        </section>

        <section className="panel p-4">
          <h3 className="mb-2 font-semibold">Tape</h3>
          <div className="space-y-1 text-xs">
            {trades.data?.trades.map((t) => (
              <a key={t.tx + t.ts} href={`${EXPLORER}/tx/${t.tx}`} target="_blank" rel="noreferrer"
                className="flex justify-between hover:text-[var(--color-lime)]">
                <span className={t.side === "buy" ? "text-[var(--color-lime)]" : "text-[var(--color-red)]"}>{t.side}</span>
                <span className="mono dim">{shortAddress(t.trader)}</span>
                <span className="mono">{fmt(BigInt(t.token_amount))} {data.symbol}</span>
                <span className="mono dim">{fmt(BigInt(t.pair_amount), dec, 4)} {sym}</span>
                <span className="dim">{ago(t.ts)}</span>
              </a>
            ))}
            {trades.data?.trades.length === 0 && <p className="dim">no trades yet</p>}
          </div>
        </section>
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
            pairToken={data.pair_token as Address} symbol={data.symbol} phase={data.phase} />
        )}

        {!isDirect && data.phase === 1 && (
          <button className="btn w-full" onClick={() => writeContractAsync({
            address: data.curve as Address, abi: hoodCurveAbi, functionName: "finalize", args: [],
          })}>
            open the pool
          </button>
        )}

        {/* Only the curve machine has a fee stream to lock into. A direct launch pays its holders
            where they stand, out of the splitter and by balance, so tokens locked here would stop
            being a holder as far as that accumulator is concerned. The contract refuses it; the app
            should not offer it in the first place. */}
        {!isDirect && (
          <StakePanel token={data.token as Address} symbol={data.symbol} feeModel={data.fee_model ?? 0} />
        )}

        {isCreator && (
          <div className="panel p-4 text-sm">
            <h3 className="font-semibold">You printed this</h3>
            <p className="mt-1 text-xs dim">
              The fee stream points at {shortAddress(data.creator)}. You can hand it to somebody else, in one step,
              and only you can.
            </p>
            <Link className="btn btn-ghost mt-2 block text-center text-xs" href={`/portfolio`}>manage</Link>
          </div>
        )}

        <div className="panel p-4 text-xs dim">
          <p className="mb-1 font-semibold text-[var(--color-text)]">Pair</p>
          <p>{data.pair_token === zeroAddress ? "ETH, the chain's own gas token" : "USDG, so the chart does not move with ETH"}</p>
        </div>
      </aside>
    </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="mono">{value}</div>
      <div className="dim">{label}</div>
    </div>
  );
}
