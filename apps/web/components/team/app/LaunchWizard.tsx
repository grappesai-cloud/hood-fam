"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { erc20Abi, isAddress, zeroAddress, type Address } from "viem";
import { useAccount, usePublicClient, useReadContract, useReadContracts, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { hoodFactoryAbi, hoodStakingAbi } from "@hood/sdk";
import { addresses, API, blockZeroAddress } from "@/lib/config";
import { fmt, imageUrl, pairDecimals, pairSymbol } from "@/lib/format";
import { blockZeroAbis, detectBlockZeroGeneration, encodePenalties, MAX_OPEN_BUYERS, PENALTY_FORM_DEFAULTS } from "@/lib/launchAbi";
import { encodeGuard, guardProblem, CURVE_GUARD_CAPS } from "@/components/CurveGuardOptions";
import { MAX_TEAM_LEGS, TEAM_LOCKS } from "@/components/TeamLegsEditor";
import { VaultPanel } from "@/components/team/VaultPanel";
import plannedPairs from "@/lib/plannedPairs.json";
import { removeDraft, saveDraft, useDrafts, newDraft, type BuildPreset, type Draft } from "./drafts";
import { buildPlan, type CurveCfg } from "./plan";
import { normalizeAddresses, setName, useWalletSets, type WalletSet } from "./walletSets";
import {
  IconArchive, IconBolt, IconChevron, IconClock, IconCoins, IconCrown, IconCubes, IconGas, IconHelp, IconHex,
  IconInfo, IconLock, IconMap, IconPalette, IconPencil, IconRocket, IconShield, IconUpload, IconUsers, IconWallet,
} from "./icons";

/// Block zero, laid out as a launch desk: where it launches, what the token is, and how the team
/// buys in the launch transaction. The three tabs write one draft in this browser; the panel on the
/// right is the plan as the chain will run it, priced on the curve the contract prices with.
///
/// What the desk does not do is hide anyone. Every team wallet goes on chain through HoodBlockZero,
/// which records it, and the token page labels it as the team on the holder map. There is no
/// layer of throwaway wallets, no funding through exchanges to cut the trail, and no automatic
/// selling into the people who buy after the launch.

const TABS = ["Chain & Launchpad", "Token Details", "Launch Settings"] as const;
const ZERO32 = `0x${"0".repeat(64)}` as `0x${string}`;
const CUSTOM_SUPPLY = 1_000_000_000n * 10n ** 18n;
const BAG_LEG_BPS = 70;
const CREATOR_LEG_BPS = 30;
const MAX_HOLDERS = MAX_TEAM_LEGS - 1;

interface PlannedPair { address: string; symbol: string; name: string | null; share: boolean; decimals: number; startCap: string; graduationCap: string }
const HEADLINE = ["NVDA", "TSLA", "SPY", "AAPL", "AMZN", "MSFT", "META", "GOOGL", "COIN", "HOOD", "PLTR", "AMD"];
const STOCKS: PlannedPair[] = (plannedPairs.pairs as PlannedPair[]).filter((p) => p.share)
  .sort((a, b) => (HEADLINE.includes(a.symbol) ? HEADLINE.indexOf(a.symbol) : 99) - (HEADLINE.includes(b.symbol) ? HEADLINE.indexOf(b.symbol) : 99));

const days = (d: number) => TEAM_LOCKS.find((t) => Math.round(t.seconds / 86_400) === d)?.seconds ?? 0;

/// Quick and Full are starting points; touching any number after picking one makes it Custom.
const PRESETS: Record<Exclude<BuildPreset, "custom">, Partial<Draft>> = {
  quick: { holdersCount: "5", holderLock: 0, devLock: 0, gas: "0" },
  full: { holdersCount: "20", holderLock: days(30), devLock: days(90), gas: "0.0005" },
};

function bpsOf(text: string): number {
  const n = Number(text);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
}
function units(text: string, decimals: number): bigint {
  const [w = "0", f = ""] = (text.trim() || "0").split(".");
  try { return BigInt(w || "0") * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0"); } catch { return 0n; }
}
function pctText(part: bigint, whole: bigint): string {
  if (whole <= 0n) return "0%";
  const v = Number((part * 1_000_000n) / whole) / 10_000;
  return v >= 10 ? `${v.toFixed(1)}%` : `${v.toFixed(2)}%`;
}
function lockText(seconds: number): string {
  return seconds ? `${Math.round(seconds / 86_400)}d` : "none";
}

export function LaunchWizard({ draftId }: { draftId: string | null }) {
  const drafts = useDrafts();
  const router = useRouter();
  const draft = drafts.find((d) => d.id === draftId);

  // No draft in the URL: open the newest one that has not launched, or start one.
  useEffect(() => {
    if (draft) return;
    const t = setTimeout(() => {
      const open = drafts.find((d) => !d.token);
      router.replace(`/launch/team?draft=${(open ?? newDraft()).id}`);
    }, 0);
    return () => clearTimeout(t);
  }, [draft, drafts, router]);

  if (!draft) return <div className="tw-loading">Opening your launch…</div>;
  return <Wizard key={draft.id} draft={draft} />;
}

function Wizard({ draft }: { draft: Draft }) {
  const [tab, setTab] = useState(0);
  const set = (patch: Partial<Draft>) => saveDraft(draft.id, patch);
  const top = useRef<HTMLDivElement>(null);
  const go = (t: number) => { setTab(t); top.current?.scrollIntoView({ block: "start" }); };
  const chain = useLaunchChain(draft);

  return (
    <div className="tw" ref={top}>
      <nav className="tw-tabs" aria-label="Launch steps">
        {TABS.map((t, i) => (
          <button key={t} type="button" className={i === tab ? "on" : ""} aria-current={i === tab ? "step" : undefined} onClick={() => go(i)}>{t}</button>
        ))}
      </nav>
      <div className={`tw-grid${tab === 2 ? " with-side" : ""}`}>
        <section className="tw-card">
          {tab === 0 && <ChainTab draft={draft} set={set} chain={chain} next={() => go(1)} />}
          {tab === 1 && <TokenTab draft={draft} set={set} symbolFree={chain.symbolFree} next={() => go(2)} />}
          {tab === 2 && <SettingsTab draft={draft} set={set} chain={chain} />}
        </section>
        {tab === 2 && <SidePanel draft={draft} chain={chain} onEdit={() => go(1)} />}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------ the chain

function useLaunchChain(draft: Draft) {
  const { address } = useAccount();
  const publicClient = usePublicClient();

  // Which shape the deployed periphery takes, read off its bytecode: v4 sends the curve's opening
  // rules, v5 names the open buyers. The factory behind it is the same generation by construction.
  const generation = useQuery({
    queryKey: ["block-zero-generation", blockZeroAddress ?? ""],
    queryFn: async () => detectBlockZeroGeneration(await publicClient!.getCode({ address: blockZeroAddress! })) ?? null,
    enabled: Boolean(publicClient) && Boolean(blockZeroAddress),
    staleTime: Infinity,
  });
  const gen = generation.data ?? undefined;
  const namesBuyers = gen === "v5";
  const openBuyers = namesBuyers ? normalizeAddresses(draft.openBuyers ?? []) : [];
  // The factory exempts its caller and the fee recipient by itself. When the fee recipient is
  // somebody other than the funder, block zero names the funder on the list too, which takes
  // one of the 32 places.
  const feeElsewhere = draft.feeTo === "wallet" && isAddress(draft.feeRecipient.trim())
    && draft.feeRecipient.trim().toLowerCase() !== (address ?? "").toLowerCase();
  const openBuyersCap = MAX_OPEN_BUYERS - (feeElsewhere ? 1 : 0);
  const holderWalletsNotNamed = namesBuyers
    ? draft.wallets.filter((w) => isAddress(w) && !openBuyers.some((b) => b.toLowerCase() === w.toLowerCase())).length
    : 0;
  const { data: configCount } = useReadContract({ address: addresses.factory, abi: hoodFactoryAbi, functionName: "configCount" });
  const { data: configs } = useReadContracts({
    contracts: Array.from({ length: Number(configCount ?? 0n) }, (_, i) => ({
      address: addresses.factory, abi: hoodFactoryAbi, functionName: "getConfig", args: [BigInt(i)],
    })) as never,
    query: { enabled: Boolean(configCount) },
  });
  const presets = useMemo(() => ((configs ?? []) as { result?: CurveCfg }[])
    .map((c, id) => ({ id, cfg: c.result }))
    .filter((c): c is { id: number; cfg: CurveCfg } => Boolean(c.cfg?.enabled)), [configs]);

  const stock = draft.market === "stocks" ? STOCKS.find((s) => s.address.toLowerCase() === draft.stockPair.toLowerCase()) : undefined;
  const cfg: CurveCfg | undefined = draft.market === "stocks"
    ? (stock ? {
      pairToken: stock.address as `0x${string}`, totalSupply: CUSTOM_SUPPLY, curveSupplyBps: 8000,
      startCap: BigInt(stock.startCap), graduationCap: BigInt(stock.graduationCap), liquidityBps: 9000,
      protocolFeeBps: BAG_LEG_BPS, creatorFeeBps: CREATOR_LEG_BPS, poolFee: 3000, tickSpacing: 60, enabled: true,
    } : undefined)
    : presets.find((p) => p.id === draft.configId)?.cfg;
  const custom = draft.market === "stocks";

  const pair = (cfg?.pairToken ?? zeroAddress) as Address;
  const dec = stock ? stock.decimals : pairDecimals(pair);
  const sym = stock ? stock.symbol : pairSymbol(pair);
  const isNative = pair === zeroAddress;

  const { data: houseToken } = useReadContract({ address: addresses.staking, abi: hoodStakingAbi, functionName: "houseToken" });
  const canPayStakers = typeof houseToken === "string" && houseToken !== zeroAddress;
  const { data: launchFee } = useReadContract({ address: addresses.factory, abi: hoodFactoryAbi, functionName: "launchFee" });
  const { data: symbolFree } = useReadContract({
    address: addresses.factory, abi: hoodFactoryAbi, functionName: "isSymbolAvailable",
    args: [draft.symbol], query: { enabled: draft.symbol.length > 0 },
  });
  const { data: econ } = useReadContract({
    address: addresses.factory, abi: hoodFactoryAbi, functionName: "previewLaunchEconomics",
    args: [BigInt(draft.configId), pair], query: { enabled: Boolean(cfg) && !custom, refetchInterval: 15_000 },
  });

  const count = Math.max(0, Math.min(MAX_HOLDERS, Math.floor(Number(draft.holdersCount) || 0)));
  const holderWallets = Array.from({ length: count }, (_, i) => draft.wallets[i] ?? "");
  const devBps = bpsOf(draft.devPct);
  const holdersBps = bpsOf(draft.holdersPct);
  const plan = useMemo(() => cfg ? buildPlan(cfg,
    { wallet: address ?? "", bps: devBps, lock: draft.devLock },
    { wallets: holderWallets, bps: holdersBps, lock: draft.holderLock }) : null,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [cfg?.pairToken, cfg?.startCap, cfg?.graduationCap, cfg?.totalSupply, address, devBps, holdersBps, draft.devLock, draft.holderLock, holderWallets.join()]);

  const gasEach = units(draft.gas, 18);
  const gasTotal = gasEach * BigInt(plan?.legs.length ?? 0);
  const fee = (launchFee as bigint | undefined) ?? 0n;
  const value = fee + (isNative ? plan?.pairTotal ?? 0n : 0n) + gasTotal;

  const { data: allowance } = useReadContract({
    address: pair, abi: erc20Abi, functionName: "allowance",
    args: [address ?? zeroAddress, blockZeroAddress ?? zeroAddress],
    query: { enabled: !isNative && Boolean(address) && Boolean(blockZeroAddress), refetchInterval: 10_000 },
  });
  const needsApproval = !isNative && ((allowance as bigint | undefined) ?? 0n) < (plan?.pairTotal ?? 0n);

  const pairsUsd = useQuery({
    queryKey: ["tapp-pairs"],
    queryFn: async () => ((await (await fetch(`${API}/pairs`, { cache: "no-store" })).json()) as { pairs: { address: string; usd: number | null }[] }).pairs,
    refetchInterval: 60_000,
  });
  const usd = pairsUsd.data?.find((p) => p.address.toLowerCase() === pair.toLowerCase())?.usd ?? null;

  const split = draft.split;
  const splitTotal = split.stakers + split.buyback + split.liquidity + split.creator;
  const walletsNeeded = holderWallets.filter((w) => !isAddress(w.trim())).length;
  const seen = new Set<string>();
  const dupe = [...(devBps > 0 && address ? [address] : []), ...holderWallets].find((w) => {
    const k = w.trim().toLowerCase();
    if (!k) return false;
    if (seen.has(k)) return true;
    seen.add(k);
    return false;
  });
  const guard = { snipePct: draft.snipePct, snipeSeconds: draft.snipeSeconds, capBlocks: draft.capBlocks, capPct: draft.capPct };

  const blocked = !blockZeroAddress ? "Block zero is not deployed on this build yet (NEXT_PUBLIC_BLOCK_ZERO is empty)."
    : !address ? "Connect the funder wallet: it pays for the launch and every team buy."
    : !draft.name ? "Enter a project name on Token Details."
    : !draft.symbol ? "Enter a symbol on Token Details."
    : symbolFree === false ? "That symbol is taken by a launch trading right now."
    : !cfg ? (draft.market === "stocks" ? "Choose a stock to launch against." : "Choose a launch currency.")
    : generation.isLoading ? "Checking the block zero version."
    : !gen ? "Block zero on this build is not a version this console knows (v4 or v5)."
    : devBps + holdersBps === 0 ? "Set a developer buy or a holders buy."
    : holdersBps > 0 && count === 0 ? "Set how many holder wallets buy."
    : walletsNeeded > 0 ? `Import ${walletsNeeded} more holder wallet${walletsNeeded === 1 ? "" : "s"}.`
    : dupe ? `The same wallet twice: ${dupe}`
    : plan?.overflow ? "The curve sells out before the last wallet. Lower the percentages."
    : split.stakers > 0 && !canPayStakers ? "Paying holders needs the house coin to be named first."
    : splitTotal !== 100 ? `The fee split adds up to ${splitTotal}%, it must be 100%.`
    : draft.feeTo === "wallet" && !isAddress(draft.feeRecipient.trim()) ? "The fee recipient is not an address."
    : openBuyers.length > openBuyersCap ? `At most ${openBuyersCap} open buyers${feeElsewhere ? " when the fee recipient is not the funder (the funder takes one place)" : ""}; ${openBuyers.length} are listed.`
    : (gen === "v4" ? guardProblem(guard) : undefined) ?? (launchFee === undefined ? "Reading the launch fee." : undefined);

  return {
    address, publicClient, generation, presets, cfg, custom, stock, pair, dec, sym, isNative, canPayStakers,
    symbolFree, econ, plan, gasEach, gasTotal, fee, value, needsApproval, usd, blocked, guard, count, holderWallets,
    gen, namesBuyers, openBuyers, openBuyersCap, holderWalletsNotNamed,
  };
}
type Chain = ReturnType<typeof useLaunchChain>;

// ------------------------------------------------------------------------- tab 1: where it goes

function ChainTab({ draft, set, chain, next }: { draft: Draft; set: (p: Partial<Draft>) => void; chain: Chain; next: () => void }) {
  const router = useRouter();
  const [stockQ, setStockQ] = useState("");
  const currencies = useMemo(() => {
    const seen = new Map<string, number[]>();
    chain.presets.forEach((p) => {
      const k = p.cfg.pairToken.toLowerCase();
      seen.set(k, [...(seen.get(k) ?? []), p.id]);
    });
    return [...seen.entries()].map(([pair, ids]) => ({ pair, ids }));
  }, [chain.presets]);
  const currentPair = chain.presets.find((p) => p.id === draft.configId)?.cfg.pairToken.toLowerCase();
  const versions = currencies.find((c) => c.pair === currentPair)?.ids ?? [];
  const q = stockQ.trim().toLowerCase();
  const stocks = (q ? STOCKS.filter((s) => s.symbol.toLowerCase().includes(q) || (s.name ?? "").toLowerCase().includes(q)) : STOCKS).slice(0, 12);

  const setSplit = (patch: Partial<Draft["split"]>) => set({ split: { ...draft.split, ...patch }, feeTo: patch.stakers !== undefined && patch.stakers > 0 ? "holders" : draft.feeTo });
  const buyback = draft.split.buyback > 0;

  return (
    <>
      <CardHead title="Create a new launch" sub="Choose where your token launches and how its trading fee is paid out." icon={<IconRocket size={170} />} />
      <div className="tw-body">
        <Label>Launchpad</Label>
        <div className="tw-tiles cols-3">
          <button type="button" className="tw-tile on">
            <span className="tw-tile-row"><IconCubes size={18} />Bonding curve</span>
          </button>
          <Link href="/launch" className="tw-tile">
            <span className="tw-tile-row"><IconCoins size={18} />Direct pool</span>
            <small>Team wallets in the direct form</small>
          </Link>
        </div>

        <div className="tw-label-row">
          <Label>Launch currency</Label>
          <div className="tw-seg" role="tablist">
            {(["stocks", "crypto"] as const).map((m) => (
              <button key={m} type="button" role="tab" aria-selected={draft.market === m} className={draft.market === m ? "on" : ""} onClick={() => set({ market: m })}>
                {m === "stocks" ? "Stocks" : "Crypto"}
              </button>
            ))}
          </div>
        </div>

        {draft.market === "crypto" ? (
          <>
            <div className="tw-tiles cols-3">
              {currencies.length === 0 && <p className="tw-note">Reading the factory&apos;s presets…</p>}
              {currencies.map((c) => {
                const sym = pairSymbol(c.pair);
                return (
                  <button key={c.pair} type="button" className={`tw-tile tw-coin${c.pair === currentPair ? " on" : ""}`} onClick={() => set({ configId: c.ids[0]! })}>
                    <span className="tw-coin-icon">{sym.slice(0, 1)}</span>
                    <span><strong>{sym === "ETH" ? "Ethereum" : sym}</strong><small>{sym}</small></span>
                  </button>
                );
              })}
            </div>
            {versions.length > 1 && (
              <>
                <Label>Curve preset</Label>
                <div className="tw-seg-wide">
                  {versions.map((id) => {
                    const cfg = chain.presets.find((p) => p.id === id)!.cfg;
                    const d = pairDecimals(cfg.pairToken);
                    return (
                      <button key={id} type="button" className={id === draft.configId ? "on" : ""} onClick={() => set({ configId: id })}>
                        #{id} · {fmt(cfg.startCap, d, 2)} → {fmt(cfg.graduationCap, d, 2)} {pairSymbol(cfg.pairToken)}
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </>
        ) : (
          <>
            <input className="tw-input" value={stockQ} onChange={(e) => setStockQ(e.target.value)} placeholder="Search 192 stocks: NVDA, Tesla, SPY…" aria-label="Search stocks" />
            <div className="tw-tiles cols-3">
              {stocks.map((s) => (
                <button key={s.address} type="button" className={`tw-tile tw-coin${s.address.toLowerCase() === draft.stockPair.toLowerCase() ? " on" : ""}`} onClick={() => set({ stockPair: s.address })}>
                  <span className="tw-coin-icon">{s.symbol.slice(0, 1)}</span>
                  <span><strong>{s.symbol}</strong><small>{s.name ?? "tokenized share"}</small></span>
                </button>
              ))}
            </div>
            <p className="tw-note">A stock pair launches with its planned curve, through the factory&apos;s custom launch.</p>
          </>
        )}

        <p className="tw-sublabel">Creator fee recipient</p>
        <div className="tw-seg-wide cols-3">
          {([["deployer", "Deployer"], ["wallet", "Wallet"], ["holders", "Holders"]] as const).map(([k, l]) => (
            <button key={k} type="button" className={draft.feeTo === k ? "on" : ""}
              disabled={k === "holders" && !chain.canPayStakers}
              title={k === "holders" && !chain.canPayStakers ? "Paying holders needs the house coin to be named first." : undefined}
              onClick={() => set(k === "holders"
                ? { feeTo: k, split: { stakers: 50, buyback: draft.split.buyback, liquidity: draft.split.liquidity, creator: Math.max(0, 50 - draft.split.buyback - draft.split.liquidity) } }
                : { feeTo: k, split: { ...draft.split, creator: draft.split.creator + draft.split.stakers, stakers: 0 } })}>
              {l}
            </button>
          ))}
        </div>
        {draft.feeTo === "wallet" && (
          <input className="tw-input mono" value={draft.feeRecipient} onChange={(e) => set({ feeRecipient: e.target.value })} placeholder="0x fee recipient" aria-label="Fee recipient" />
        )}

        <FieldLabel icon={<IconCoins size={15} />} title="Creator fee split" hint="(adds up to 100%)" help="Where the creator's part of every trade goes: to stakers of the house coin, to buybacks of this token, to its liquidity, or to the recipient above." />
        <div className="tw-split">
          {(["creator", "buyback", "liquidity", "stakers"] as const).map((k) => (
            <label key={k} className="tw-affix">
              <span className="tw-affix-label">{k}</span>
              <input className="tw-input" inputMode="numeric" value={draft.split[k]} disabled={k === "stakers" && !chain.canPayStakers}
                onChange={(e) => setSplit({ [k]: Math.max(0, Math.min(100, Number(e.target.value.replace(/\D/g, "")) || 0)) })} />
              <span className="tw-affix-unit">%</span>
            </label>
          ))}
        </div>
        <p className="tw-note">Total {draft.split.creator + draft.split.buyback + draft.split.liquidity + draft.split.stakers}%. The Bag&apos;s own leg of the trading fee is fixed and not part of this split.</p>

        <label className="tw-check">
          <input type="checkbox" checked={buyback} onChange={(e) => set({ split: e.target.checked
            ? { ...draft.split, buyback: 30, creator: Math.max(0, draft.split.creator - 30 + draft.split.buyback) }
            : { ...draft.split, creator: draft.split.creator + draft.split.buyback, buyback: 0 } })} />
          <span>
            <strong>Buyback enabled</strong>
            <small>When enabled, part of the creator fee buys this token back automatically.</small>
          </span>
        </label>

        <div className="tw-center"><button type="button" className="tw-btn" onClick={next}>Configure Token</button></div>
        <div className="tw-or"><span>OR</span></div>
        <div className="tw-center gap">
          <button type="button" className="tw-btn ghost" onClick={() => {
            const copy = newDraft();
            const { id: _i, createdAt: _c, token: _t, tx: _x, ...rest } = draft;
            saveDraft(copy.id, { ...rest, name: rest.name ? `${rest.name} copy` : "" });
            router.push(`/launch/team?draft=${copy.id}`);
          }}>Duplicate draft</button>
          <button type="button" className="tw-btn ghost" onClick={() => {
            const blob = new Blob([JSON.stringify(draft, null, 2)], { type: "application/json" });
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = `launch-${draft.symbol || draft.id}.json`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 1000);
          }}>Export draft</button>
        </div>
      </div>
    </>
  );
}

// --------------------------------------------------------------------- tab 2: what the token is

function TokenTab({ draft, set, symbolFree, next }: { draft: Draft; set: (p: Partial<Draft>) => void; symbolFree: unknown; next: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  async function upload(f: File | undefined) {
    setError(null);
    if (!f) return;
    if (!/^image\/(png|jpe?g|gif|webp)$/.test(f.type)) return setError("Use a .jpg, .png, .gif or .webp file.");
    if (f.size > 4 * 1024 * 1024) return setError("That file is over 4 MB.");
    setBusy(true);
    try {
      const body = new FormData();
      body.append("file", f);
      const res = await fetch(`${API}/uploads/image`, { method: "POST", body });
      const json = (await res.json().catch(() => null)) as { url?: string; error?: string } | null;
      if (!res.ok || !json?.url) throw new Error(json?.error ?? `upload failed: ${res.status}`);
      set({ image: json.url });
    } catch (e) {
      setError(e instanceof Error ? e.message : "The upload failed.");
    } finally {
      setBusy(false);
    }
  }

  const ready = draft.name && draft.symbol && symbolFree !== false;
  return (
    <>
      <CardHead title="Token Details" sub="How your token appears on explorers, wallets and the launchpad." icon={<IconPalette size={170} />} />
      <div className="tw-body">
        <div className="tw-row-2-1">
          <label className="tw-field"><span>Project Name<i>*</i></span>
            <input className="tw-input" value={draft.name} maxLength={48} onChange={(e) => set({ name: e.target.value })} />
          </label>
          <label className="tw-field"><span>Symbol<i>*</i>{draft.symbol && symbolFree === false && <b className="bad"> taken right now</b>}</span>
            <input className="tw-input" value={draft.symbol} maxLength={12} onChange={(e) => set({ symbol: e.target.value.replace(/^\$/, "").replace(/\s/g, "") })} />
          </label>
        </div>
        <label className="tw-field"><span>Description</span>
          <input className="tw-input" value={draft.description} maxLength={280} onChange={(e) => set({ description: e.target.value })} />
        </label>
        <div className="tw-field">
          <span>Image</span>
          <div className="tw-image-row">
            <div className={`tw-drop${drag ? " drag" : ""}`}
              onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
              onDrop={(e) => { e.preventDefault(); setDrag(false); upload(e.dataTransfer.files?.[0]); }}>
              <IconUpload size={20} />
              <p>{busy ? "Uploading…" : <>Drag &amp; Drop or <button type="button" className="tw-link" onClick={() => file.current?.click()}>Choose file</button> to upload</>}</p>
              <small>.jpg, .png, .gif or .webp (max 4 MB)</small>
              <input ref={file} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={(e) => upload(e.target.files?.[0])} />
            </div>
            <div className="tw-preview">
              <small>Preview</small>
              <div>{draft.image ? <img src={imageUrl(draft.image)} alt="" /> : <span>{(draft.symbol || "?").slice(0, 2).toUpperCase()}</span>}</div>
            </div>
          </div>
          <input className="tw-input" value={draft.image} onChange={(e) => set({ image: e.target.value })} placeholder="or paste an image URL (https:// or ipfs://)" aria-label="Image URL" />
          {error && <p className="tw-note bad">{error}</p>}
        </div>
        <div className="tw-row-3">
          <label className="tw-field"><span>X/ Twitter <em>(optional)</em></span>
            <input className="tw-input" value={draft.twitter} onChange={(e) => set({ twitter: e.target.value })} placeholder="x.com/yourtoken" />
          </label>
          <label className="tw-field"><span>Telegram <em>(optional)</em></span>
            <input className="tw-input" value={draft.telegram} onChange={(e) => set({ telegram: e.target.value })} placeholder="t.me/yourtoken" />
          </label>
          <label className="tw-field"><span>Website <em>(optional)</em></span>
            <input className="tw-input" value={draft.website} onChange={(e) => set({ website: e.target.value })} placeholder="yourtoken.xyz" />
          </label>
        </div>
        <div className="tw-center"><button type="button" className="tw-btn" disabled={!ready} onClick={next}>Continue</button></div>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ tab 3: how the team buys in

function SettingsTab({ draft, set, chain }: { draft: Draft; set: (p: Partial<Draft>) => void; chain: Chain }) {
  const [importOpen, setImportOpen] = useState(false);
  const [buyersOpen, setBuyersOpen] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const custom = (p: Partial<Draft>) => set({ ...p, preset: "custom" });
  const num = (v: string) => v.replace(/[^0-9.]/g, "");

  return (
    <div className="tw-body tw-settings">
      <div className="tw-banner">
        <IconInfo size={18} />
        <p>Block 0 is all or nothing: the token and every team buy land in one transaction. If any buy cannot fill, nothing launches and only gas is spent.</p>
      </div>

      <div className="tw-row-2">
        <NumField icon={<IconCrown size={15} />} title="Developer Buy %" req help="Of the total supply, bought by the funder wallet itself."
          value={draft.devPct} unit="%" onChange={(v) => custom({ devPct: num(v) })} />
        <NumField icon={<IconUsers size={15} />} title="Holders Buy" hint="(excluding developer)" req help="Of the total supply, split evenly across the holder wallets."
          value={draft.holdersPct} unit="%" onChange={(v) => custom({ holdersPct: num(v) })} />
        <NumField icon={<IconUsers size={15} />} title="Holders Count" hint={`(0-${MAX_HOLDERS})`} req help="How many holder wallets buy. Each one is recorded on chain and labelled as the team."
          value={draft.holdersCount} onChange={(v) => custom({ holdersCount: v.replace(/\D/g, "") })} />
        {!chain.namesBuyers && (
          <NumField icon={<IconShield size={15} />} title="Opening Tax" hint={`(0-${CURVE_GUARD_CAPS.snipePct})`} help="Extra paid by buyers right after the launch, falling to nothing. 80% goes to holders, 20% to the Bag. The team's buys are inside the launch, so they pay none."
            value={String(draft.snipePct)} unit="%" onChange={(v) => custom({ snipePct: Math.min(CURVE_GUARD_CAPS.snipePct, Number(v.replace(/\D/g, "")) || 0) })} />
        )}
      </div>

      {chain.namesBuyers && (
        <div className="tw-banner">
          <IconShield size={18} />
          <p>Opening tax: every launch runs the same schedule, 99% of a buy in the launch's own second, 6% the next, under 1% the one after, then nothing. The team&apos;s buys are inside the launch and pay none. Wallets named below as open buyers pay none either, and the holder map labels them.</p>
        </div>
      )}

      <FieldLabel icon={<IconCubes size={15} />} title="Block-0 Preset" />
      <div className="tw-tiles cols-3 presets">
        {([
          ["quick", <IconBolt key="i" size={16} />, "Quick Build", "Fast, low cost"],
          ["full", <IconShield key="i" size={16} />, "Full Build", "More wallets, locked"],
          ["custom", <IconHex key="i" size={16} />, "Custom", "Manual inputs"],
        ] as const).map(([k, icon, title, sub]) => (
          <button key={k} type="button" className={`tw-tile tw-preset${draft.preset === k ? " on" : ""}`}
            onClick={() => set(k === "custom" ? { preset: k } : { ...PRESETS[k], preset: k })}>
            <span className="tw-tile-row">{icon}{title}</span>
            <small>{sub}</small>
          </button>
        ))}
      </div>

      {!chain.namesBuyers && (
        <>
          <NumField icon={<IconMap size={15} />} title="Wallet Cap at Open" hint="(% of supply per wallet)" help="For the first blocks after the launch, no outside wallet may buy more than this. 0 turns it off."
            value={String(draft.capBlocks > 0 ? draft.capPct : 0)} unit="%" onChange={(v) => {
              const pct = Number(num(v)) || 0;
              custom({ capPct: pct, capBlocks: pct > 0 ? (draft.capBlocks || 30) : 0 });
            }} />

          <FieldLabel icon={<IconClock size={15} />} title="Protection Window" hint="(optional)" help="How long the opening tax takes to fall away, and how many blocks the wallet cap lasts. Blocks are 100 ms here." />
          <div className="tw-split-time">
            <label><small>SEC</small>
              <input value={String(draft.snipeSeconds).padStart(2, "0")} inputMode="numeric" aria-label="Opening tax seconds"
                onChange={(e) => custom({ snipeSeconds: Math.min(CURVE_GUARD_CAPS.snipeSeconds, Number(e.target.value.replace(/\D/g, "")) || 0) })} />
            </label>
            <span>:</span>
            <label><small>BLOCKS</small>
              <input value={String(draft.capBlocks)} inputMode="numeric" aria-label="Wallet cap blocks"
                onChange={(e) => custom({ capBlocks: Math.min(CURVE_GUARD_CAPS.capBlocks, Number(e.target.value.replace(/\D/g, "")) || 0) })} />
            </label>
          </div>
        </>
      )}

      <hr className="tw-hr" />

      <button type="button" className="tw-import" onClick={() => setImportOpen((v) => !v)} aria-expanded={importOpen}>
        <span className="tw-import-icon"><IconWallet size={20} /></span>
        <strong>Import Wallets</strong>
        <small>{draft.wallets.length ? `${draft.wallets.length} wallet${draft.wallets.length === 1 ? "" : "s"} ready. ` : ""}Paste addresses, or make fresh ones and save their encrypted file</small>
      </button>
      {importOpen && <WalletImport draft={draft} set={set} needed={chain.count} />}

      {chain.namesBuyers && (
        <>
          <button type="button" className="tw-import" onClick={() => setBuyersOpen((v) => !v)} aria-expanded={buyersOpen}>
            <span className="tw-import-icon"><IconUsers size={20} /></span>
            <strong>Open Buyers</strong>
            <small>
              {chain.openBuyers.length ? `${chain.openBuyers.length} of ${chain.openBuyersCap} named. ` : ""}
              Wallets that may buy in the first seconds without the opening tax. Named on chain in the launch, labelled on the holder map.
              {chain.holderWalletsNotNamed > 0 && (
                <> <b>{chain.holderWalletsNotNamed} holder wallet{chain.holderWalletsNotNamed === 1 ? " is" : "s are"} not named:</b> inside the launch they pay nothing, but a buy they make right after it would be taxed like a sniper&apos;s.</>
              )}
            </small>
          </button>
          {buyersOpen && <OpenBuyersImport draft={draft} set={set} cap={chain.openBuyersCap} />}
        </>
      )}

      <label className="tw-check">
        <input type="checkbox" checked={Number(draft.gas) > 0} onChange={(e) => custom({ gas: e.target.checked ? "0.0005" : "0" })} />
        <span>
          <strong><IconGas size={15} /> Gas for every wallet</strong>
          <small>Each team wallet also gets {Number(draft.gas) > 0 ? draft.gas : "0.0005"} ETH, so it can withdraw its lock or sell later without a separate funding step.</small>
        </span>
      </label>

      <button type="button" className="tw-advanced" aria-expanded={advanced} onClick={() => setAdvanced((v) => !v)}>
        <IconHex size={15} /><span>Advanced settings (optional)</span><i /><IconChevron size={16} className={advanced ? "rot180" : ""} />
      </button>
      {advanced && (
        <div className="tw-adv">
          <div className="tw-row-3">
            <label className="tw-field"><span><IconLock size={14} /> Developer lock</span>
              <select className="tw-input" value={draft.devLock} onChange={(e) => custom({ devLock: Number(e.target.value) })}>
                {TEAM_LOCKS.map((t) => <option key={t.seconds} value={t.seconds}>{t.label}</option>)}
              </select>
            </label>
            <label className="tw-field"><span><IconLock size={14} /> Holders lock</span>
              <select className="tw-input" value={draft.holderLock} onChange={(e) => custom({ holderLock: Number(e.target.value) })}>
                {TEAM_LOCKS.map((t) => <option key={t.seconds} value={t.seconds}>{t.label}</option>)}
              </select>
            </label>
            <label className="tw-field"><span><IconGas size={14} /> Gas per wallet (ETH)</span>
              <input className="tw-input mono" value={draft.gas} inputMode="decimal" onChange={(e) => custom({ gas: num(e.target.value) })} />
            </label>
          </div>
          <LegTable chain={chain} />
        </div>
      )}

      <LaunchButton draft={draft} chain={chain} className="tw-create-bottom" />
    </div>
  );
}

/// The console's wallet sets, to fill a list from. Made on the Wallets page or by the file panel.
function SetPicker({ value, onPick }: { value: string; onPick: (s: WalletSet) => void }) {
  const sets = useWalletSets();
  if (sets.length === 0) {
    return <p className="tw-note">No wallet sets yet. Make or open a file on the <Link href="/launch/team/wallets">Wallets</Link> page, and it is offered here.</p>;
  }
  return (
    <label className="tw-field"><span>Use a wallet set</span>
      <select className="tw-input" value={value} onChange={(e) => { const s = sets.find((x) => x.id === e.target.value); if (s) onPick(s); }}>
        <option value="">Choose a set</option>
        {sets.map((s) => <option key={s.id} value={s.id}>{setName(s)} ({s.addresses.length})</option>)}
      </select>
    </label>
  );
}

function WalletImport({ draft, set, needed }: { draft: Draft; set: (p: Partial<Draft>) => void; needed: number }) {
  const [text, setText] = useState(draft.wallets.join("\n"));
  const [makeOpen, setMakeOpen] = useState(false);
  const lines = text.split(/[\s,;]+/).map((l) => l.trim()).filter(Boolean);
  const bad = lines.filter((l) => !isAddress(l));
  return (
    <div className="tw-import-body">
      <SetPicker value={draft.holdersSet ?? ""} onPick={(s) => {
        const list = s.addresses.map((a) => a.toLowerCase()).slice(0, MAX_HOLDERS);
        setText(list.join("\n"));
        // The same wallets are named as open buyers when nothing is named yet, so the team can
        // buy again right after the launch without paying the opening tax.
        const named = (draft.openBuyers ?? []).length ? {} : { openBuyers: list.slice(0, MAX_OPEN_BUYERS), buyersSet: s.id };
        set({ wallets: list, holdersSet: s.id, holdersCount: String(list.length), ...named });
      }} />
      <label className="tw-field"><span>Holder wallet addresses <em>(one per line; addresses only, never keys)</em></span>
        <textarea className="tw-input mono" rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder={"0xabc…\n0xdef…"} spellCheck={false} />
      </label>
      <div className="tw-import-actions">
        <span className={bad.length ? "bad" : "dim"}>{bad.length ? `${bad.length} line${bad.length === 1 ? " is" : "s are"} not an address` : `${lines.length} of ${needed} needed`}</span>
        <button type="button" className="tw-btn ghost" onClick={() => setMakeOpen((v) => !v)}>{makeOpen ? "Close" : "Make fresh wallets"}</button>
        <button type="button" className="tw-btn" disabled={bad.length > 0} onClick={() => set({ wallets: [...new Set(lines.map((l) => l.toLowerCase()))].slice(0, MAX_HOLDERS), holdersSet: "" })}>Use these</button>
      </div>
      {makeOpen && (
        <div className="tw-vault">
          <VaultPanel n={1} unlocked={0} onUnlock={(accounts) => {
            const list = accounts.map((a) => a.address.toLowerCase()).slice(0, MAX_HOLDERS);
            setText(list.join("\n"));
            set({ wallets: list, holdersSet: "" });
          }} />
        </div>
      )}
    </div>
  );
}

/// The open buyers of a v5 launch: up to MAX_OPEN_BUYERS addresses named in the launch itself.
function OpenBuyersImport({ draft, set, cap }: { draft: Draft; set: (p: Partial<Draft>) => void; cap: number }) {
  const [text, setText] = useState((draft.openBuyers ?? []).join("\n"));
  // Named from elsewhere (a set picked for the holder wallets) shows up here without a reload.
  const fromDraft = (draft.openBuyers ?? []).join("\n");
  useEffect(() => { setText(fromDraft); }, [fromDraft]);
  const lines = text.split(/[\s,;]+/).map((l) => l.trim()).filter(Boolean);
  const bad = lines.filter((l) => !isAddress(l));
  const listed = normalizeAddresses(lines);
  const apply = (list: readonly string[], setId = "") => {
    const l = normalizeAddresses(list).map((a) => a.toLowerCase()).slice(0, cap);
    setText(l.join("\n"));
    set({ openBuyers: l, buyersSet: setId });
  };
  return (
    <div className="tw-import-body">
      <SetPicker value={draft.buyersSet ?? ""} onPick={(s) => apply(s.addresses, s.id)} />
      <label className="tw-field"><span>Open buyer addresses <em>(one per line, up to {cap}; addresses only, never keys)</em></span>
        <textarea className="tw-input mono" rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder={"0xabc…\n0xdef…"} spellCheck={false} />
      </label>
      <div className="tw-import-actions">
        <span className={bad.length || listed.length > cap ? "bad" : "dim"}>
          {bad.length ? `${bad.length} line${bad.length === 1 ? " is" : "s are"} not an address` : `${listed.length} of ${cap}`}
        </span>
        <button type="button" className="tw-btn ghost" disabled={draft.wallets.length === 0} onClick={() => apply(draft.wallets, draft.holdersSet)}>Same as holder wallets</button>
        <button type="button" className="tw-btn" disabled={bad.length > 0 || listed.length > cap} onClick={() => apply(lines)}>Use these</button>
      </div>
      <p className="tw-note">
        The funder and the fee recipient pay no opening tax without being listed. A wallet that is not listed and buys in the first
        three seconds pays the same tax as any sniper, and the desk will not sign such a buy. Plain wallets only: on the direct
        machine the exemption is read off the wallet that sends the transaction, so a contract wallet (a Safe) is not covered.
      </p>
    </div>
  );
}

function LegTable({ chain }: { chain: Chain }) {
  const plan = chain.plan;
  if (!plan || !chain.cfg) return <p className="tw-note">Choose a launch currency to see the plan.</p>;
  return (
    <div className="tw-legs">
      <div className="tw-legs-head"><span>#</span><span>Wallet</span><span>Pays</span><span>Gets</span><span>Lock</span></div>
      {plan.legs.map((l, i) => (
        <div key={i} className="tw-legs-row">
          <span className="dim">{l.role === "developer" ? "dev" : i + (plan.legs[0]?.role === "developer" ? 0 : 1)}</span>
          <span className="mono">{l.wallet ? `${l.wallet.slice(0, 6)}…${l.wallet.slice(-4)}` : <em className="bad">import</em>}</span>
          <span className="mono">{fmt(l.pairIn, chain.dec, 5)} {chain.sym}</span>
          <span className="mono">{pctText(l.tokens, chain.cfg!.totalSupply)}</span>
          <span>{lockText(l.lock)}</span>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------------------ the right panel

function SidePanel({ draft, chain, onEdit }: { draft: Draft; chain: Chain; onEdit: () => void }) {
  const [armed, setArmed] = useState(false);
  const [open, setOpen] = useState(true);
  const router = useRouter();
  const plan = chain.plan;
  const supply = chain.cfg?.totalSupply ?? 0n;
  const teamShare = plan && supply > 0n ? Number((plan.tokens * 10_000n) / supply) / 100 : 0;
  const locks = [draft.devLock, draft.holderLock].filter((_, i) => (i === 0 ? bpsOf(draft.devPct) > 0 : bpsOf(draft.holdersPct) > 0));
  const longest = Math.max(0, ...locks);
  const raise = chain.cfg ? (chain.cfg.graduationCap + chain.cfg.startCap) / 2n : 0n;
  const costShare = plan && raise > 0n ? Math.min(1, Number((plan.pairTotal * 1000n) / raise) / 1000) : 0;
  const mcap = plan ? (plan.priceAfter * supply) / 10n ** 18n : 0n;
  const mcapUsd = chain.usd ? (Number(mcap) / 10 ** chain.dec) * chain.usd : null;
  const total = chain.value;
  const img = draft.image ? imageUrl(draft.image) : "";

  return (
    <aside className="tw-side" aria-label="Launch summary">
      <header className="tw-side-head">
        <span className="tw-side-img">{img ? <img src={img} alt="" /> : <span>{(draft.symbol || "?").slice(0, 2).toUpperCase()}</span>}</span>
        <div>
          <p><strong>${draft.symbol || "TICKER"}</strong> <span className="dim">{draft.name || "Untitled"}</span>
            <button type="button" className="tw-icon" aria-label="Edit token details" onClick={onEdit}><IconPencil size={14} /></button></p>
          <p className="tw-pills"><span className="tw-pill accent">Curve · {chain.sym || "…"}</span><span className="tw-pill">Draft</span></p>
        </div>
        <button type="button" className={`tw-btn ghost sm${armed ? " danger" : ""}`} onClick={() => {
          if (!armed) { setArmed(true); setTimeout(() => setArmed(false), 3000); return; }
          removeDraft(draft.id);
          router.replace("/launch/team");
        }}>{armed ? "Delete?" : <>Archive <IconArchive size={14} /></>}</button>
      </header>

      <div className="tw-mode">
        <div className="tw-mode-head"><h3><IconShield size={18} /> Block-0 Mode</h3><Link href="/docs">View in documentation</Link></div>
        <p>Block 0 puts the team&apos;s buys inside the launch itself, ahead of any bot, and publishes every one of them.</p>
        <ul>
          <li><b>+++</b>Nobody trades in between<i>- - -</i><em>Team visible to all</em></li>
          <li><b>+++</b>Guaranteed supply<i>- -</i><em>More gas</em></li>
          <li><b>+++</b>Can&apos;t get front-run<i>-</i><em>Overkill for a small launch</em></li>
        </ul>
      </div>

      <button type="button" className="tw-preset-row" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {draft.preset === "quick" ? <IconBolt size={18} /> : draft.preset === "full" ? <IconShield size={18} /> : <IconHex size={18} />}
        <span>{draft.preset === "quick" ? "Quick Build" : draft.preset === "full" ? "Full Build" : "Custom"}</span>
        <IconChevron size={18} className={open ? "rot180" : ""} />
      </button>

      {open && (
        <div className="tw-meters">
          <Meter icon={<IconUsers size={16} />} title="Team Share" help="Of the total supply, developer and holders together." value={`${teamShare.toFixed(teamShare >= 10 ? 1 : 2)}%`} fill={Math.min(1, teamShare / 30)} lo="Low" hi="High" />
          <Meter icon={<IconCoins size={16} />} title="Supply Cost" help="What the team pays, against the curve's whole raise." value={plan ? `${fmt(plan.pairTotal, chain.dec, 4)}` : "–"} fill={costShare} lo="Low" hi="High" />
          <Meter icon={<IconMap size={16} />} title="Holder Map" help="Every team wallet and every open buyer is written on chain and labelled on the token page." value="Labelled" fill={1} lo="Hidden" hi="Labelled" />
          <Meter icon={<IconLock size={16} />} title="Unlock Time" help="The longest lock among the team's buys." value={lockText(longest)} fill={Math.min(1, longest / (180 * 86_400))} lo="None" hi="180d" />
        </div>
      )}

      <div className="tw-side-fill" />

      <div className="tw-est">
        <div className="tw-est-row soft"><span>Est. Market Cap <Help text="Right after the last team buy, at the curve's price then." /></span>
          <strong>{mcapUsd !== null ? `$${compactUsd(mcapUsd)}` : plan ? `${fmt(mcap, chain.dec, 2)} ${chain.sym}` : "–"}</strong></div>
        <div className="tw-est-box">
          <div className="tw-est-row"><span>Funding Estimation</span><strong>{fmt(total, 18, 4)} ETH{!chain.isNative && plan ? ` + ${fmt(plan.pairTotal, chain.dec, 4)} ${chain.sym}` : ""}</strong></div>
          <div className="tw-est-row dim"><span>Team buys</span><span>{plan ? `${fmt(plan.pairTotal, chain.dec, 4)} ${chain.sym}` : "–"}</span></div>
          <div className="tw-est-row dim"><span>Gas for wallets <Help text="Sent along to every team wallet." /></span><span>{fmt(chain.gasTotal, 18, 4)} ETH</span></div>
          {chain.namesBuyers && (
            <div className="tw-est-row dim"><span>Open buyers <Help text="Named on chain in the launch. No opening tax for them in the first seconds; labelled on the holder map." /></span><span>{chain.openBuyers.length} wallet{chain.openBuyers.length === 1 ? "" : "s"}</span></div>
          )}
          <div className="tw-est-row dim"><span>Launch fee</span><span>{fmt(chain.fee, 18, 4)} ETH</span></div>
          <div className="tw-est-row warn"><span>If a buy fails <Help text="The whole launch reverts. The funder pays the network fee and nothing else." /></span><span>gas only</span></div>
        </div>
      </div>
      <LaunchButton draft={draft} chain={chain} className="tw-create-side" />
    </aside>
  );
}

function compactUsd(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(2)}K`;
  return v.toFixed(0);
}

function LaunchButton({ draft, chain, className }: { draft: Draft; chain: Chain; className: string }) {
  const router = useRouter();
  const { writeContractAsync, isPending } = useWriteContract();
  const [hash, setHash] = useState<`0x${string}` | undefined>();
  const [error, setError] = useState<string | null>(null);
  const receipt = useWaitForTransactionReceipt({ hash });

  useEffect(() => {
    if (!receipt.isSuccess || !receipt.data || !blockZeroAddress) return;
    // TeamLaunched: topic 1 is the token, and it is the only event of the periphery with four topics.
    const periphery = blockZeroAddress.toLowerCase();
    const log = receipt.data.logs.find((l) => l.address.toLowerCase() === periphery && l.topics.length === 4);
    if (log) {
      const token = `0x${log.topics[1]!.slice(26)}`;
      saveDraft(draft.id, { token, tx: receipt.data.transactionHash });
      router.push(`/launch/team?token=${token}`);
    } else setHash(undefined); // that was the approval; the launch is next
  }, [receipt.isSuccess, receipt.data, router, draft.id]);

  async function go() {
    const { address, publicClient, cfg, plan, pair, gen } = chain;
    if (chain.blocked || !address || !blockZeroAddress || !cfg || !plan || !publicClient || !gen) return;
    setError(null);
    try {
      if (chain.needsApproval) {
        setHash(await writeContractAsync({ address: pair, abi: erc20Abi, functionName: "approve", args: [blockZeroAddress, plan.pairTotal] }));
        return;
      }
      const salt = `0x${Array.from(crypto.getRandomValues(new Uint8Array(32))).map((b) => b.toString(16).padStart(2, "0")).join("")}` as `0x${string}`;
      const s = draft.split;
      const base = {
        name: draft.name, symbol: draft.symbol, image: draft.image, description: draft.description,
        website: draft.website, twitter: draft.twitter, telegram: draft.telegram,
        pairToken: pair, configId: BigInt(chain.custom ? 0 : draft.configId),
        feeSplit: { stakersBps: s.stakers * 100, buybackBps: s.buyback * 100, liquidityBps: s.liquidity * 100, creatorBps: s.creator * 100 },
        creatorFeeRecipient: (draft.feeTo === "wallet" ? draft.feeRecipient.trim() : zeroAddress) as Address,
        firstBuy: 0n, firstBuyLock: 0n, salt,
        econ: chain.custom ? ZERO32 : ((chain.econ as `0x${string}` | undefined) ?? ZERO32),
      };
      // v5 names the open buyers; v4 sends the penalties (all off) and the curve's opening rules.
      const params = gen === "v5"
        ? { ...base, exempt: chain.openBuyers }
        : { ...base, penalties: encodePenalties(PENALTY_FORM_DEFAULTS), guard: encodeGuard(chain.guard) };
      const abi = blockZeroAbis[gen];
      const legs = plan.legs.map((l) => ({
        wallet: l.wallet.trim() as Address,
        pairIn: l.pairIn,
        // The price inside the launch transaction is known; the floor only catches a preset or a
        // fee that moved between this screen and the block, with half a percent of room.
        minTokensOut: (l.tokens * 995n) / 1000n,
        lock: BigInt(l.lock),
        gas: chain.gasEach,
      }));
      const call = chain.custom
        ? { functionName: "launchCustom" as const, args: [params, cfg, legs] }
        : { functionName: "launch" as const, args: [params, legs] };
      // Simulated first, so a refusal shows its reason here instead of as a failed transaction.
      await publicClient.simulateContract({ account: address, address: blockZeroAddress, abi, ...call, args: call.args as never, value: chain.value } as never);
      setHash(await writeContractAsync({ address: blockZeroAddress, abi, ...call, args: call.args as never, value: chain.value } as never));
    } catch (e) {
      setError(e instanceof Error ? (e as { shortMessage?: string }).shortMessage ?? e.message : String(e));
    }
  }

  const busy = isPending || receipt.isLoading;
  return (
    <div className={className}>
      {(chain.blocked || error) && <p className={`tw-why${error ? " bad" : ""}`}>{error ?? chain.blocked}</p>}
      <button type="button" className="tw-btn wide" disabled={Boolean(chain.blocked) || busy} onClick={go}>
        {busy ? "Waiting for the chain…" : chain.needsApproval ? `Approve ${chain.sym}` : "Create"}
      </button>
    </div>
  );
}

// ------------------------------------------------------------------------------------- furniture

function CardHead({ title, sub, icon }: { title: string; sub: string; icon: React.ReactNode }) {
  return (
    <header className="tw-head">
      <div><h1>{title}</h1><p>{sub}</p></div>
      <span className="tw-head-art" aria-hidden="true">{icon}</span>
    </header>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <p className="tw-label">{children}</p>;
}

function Help({ text }: { text: string }) {
  return <span className="tw-help" tabIndex={0} aria-label={text} data-tip={text}><IconHelp size={14} /></span>;
}

function FieldLabel({ icon, title, hint, req, help }: { icon: React.ReactNode; title: string; hint?: string; req?: boolean; help?: string }) {
  return (
    <p className="tw-flabel">{icon}<strong>{title}</strong>{req && <i>*</i>}{hint && <em>{hint}</em>}{help && <Help text={help} />}</p>
  );
}

function NumField({ icon, title, hint, req, help, value, unit, onChange }: {
  icon: React.ReactNode; title: string; hint?: string; req?: boolean; help?: string; value: string; unit?: string; onChange: (v: string) => void;
}) {
  return (
    <div className="tw-numfield">
      <FieldLabel icon={icon} title={title} hint={hint} req={req} help={help} />
      <label className="tw-affix">
        <input className="tw-input" inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} aria-label={title} />
        {unit && <span className="tw-affix-unit">{unit}</span>}
      </label>
    </div>
  );
}

function Meter({ icon, title, help, value, fill, lo, hi }: { icon: React.ReactNode; title: string; help: string; value: string; fill: number; lo: string; hi: string }) {
  return (
    <div className="tw-meter">
      <p>{icon}<strong>{title}</strong><Help text={help} /><span>{value}</span></p>
      <div className="tw-meter-bar"><i style={{ width: `${Math.max(0, Math.min(1, fill)) * 100}%` }} /></div>
      <p className="tw-meter-ends"><small>{lo}</small><small>{hi}</small></p>
    </div>
  );
}
