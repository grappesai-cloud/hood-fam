"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { encodeFunctionData, erc20Abi, isAddress, parseUnits, zeroAddress, type Address } from "viem";
import { useAccount, usePublicClient, useReadContract, useReadContracts, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { hoodFactoryAbi, hoodStakingAbi, BPS, FEE_LEG_LABEL, LOCK_TIERS, curveBuy } from "@hood/sdk";
import { addresses } from "@/lib/config";
import { api, type PairRow, type ResolvedQuote, type RouteAvailability } from "@/lib/api";
import { fmt, pairDecimals, pairSymbol } from "@/lib/format";
import { detectFactoryGeneration, factoryAbis, factoryTakesExempt } from "@/lib/launchAbi";
import { exemptAddresses, exemptProblem, OPENING_TAX_SUMMARY, OpeningTax, openingReviewRows, parseExempt } from "@/components/OpeningTax";
import { DirectLaunchForm } from "@/components/DirectLaunchForm";
import { ArtworkPicker } from "@/components/ArtworkPicker";
import { Choice, Field, LaunchBar, LaunchFeeExample, LaunchReview, PairChooser, Slider, Step, WhatHappens, WizardNav, WizardProgress } from "@/components/LaunchUI";
import { CurveSim } from "@/components/Sim";
import { useBatch } from "@/lib/safe";
import { brand } from "@/brands";
import plannedPairs from "@/lib/plannedPairs.json";

/// The pairs the quotes plan (deploy/quotes.plan.json) sized a preset for, with that preset's two
/// caps. Until the owner applies the plan to this factory they are not on its allow list, but
/// launchCustom takes any ERC-20, so the menu offers them and launches them with the plan's own
/// numbers. Once the plan is applied the API lists them as allowed and this list stops mattering.
interface PlannedPair {
  address: string; symbol: string; name: string | null; share: boolean; decimals: number;
  startCap: string; graduationCap: string;
}
/// The shares people come looking for go first, because the menu shows only its first six up front.
const HEADLINE = ["NVDA", "TSLA", "SPY", "AAPL"];
const rank = (p: PlannedPair) => (HEADLINE.includes(p.symbol) ? HEADLINE.indexOf(p.symbol) : HEADLINE.length);
const PLANNED: PlannedPair[] = [...plannedPairs.pairs].sort((a, b) => rank(a) - rank(b));

interface CurvePreset {
  /// What this preset's caps are written in, and the only pair it may be launched against.
  pairToken: `0x${string}`;
  totalSupply: bigint; curveSupplyBps: number; startCap: bigint; graduationCap: bigint;
  liquidityBps: number; protocolFeeBps: number; creatorFeeBps: number; enabled: boolean;
  /// The graduated pool's own two numbers. They travel with the preset and have to travel with a
  /// custom config too, or a launch whose only change is the fee would open a different pool.
  poolFee: number; tickSpacing: number;
}

const CUSTOM_SUPPLY = 1_000_000_000n * 10n ** 18n;
/// The fourth step is the opening tax: every launch runs the same schedule, and the creator only
/// names who skips it.
const STEPS = ["Token", "Market", "Economics", "Opening", "Review"] as const;
const REVIEW = STEPS.length - 1;

/// The platform fee on a curve trade: 1%, 0.30% into the Bag and 0.70% to the creator's split. A
/// preset carries its own two numbers and they are what the form shows for it; these are what a
/// custom config is written with, and the fallback while the presets are still loading.
const BAG_LEG_BPS = 30;
const CREATOR_LEG_BPS = 70;

function units(value: string, decimals: number): bigint {
  try { return parseUnits(value || "0", decimals); } catch { return 0n; }
}

/// The four places the creator leg can go, and what each one means to a buyer reading the page. A
/// launch splits between them rather than picking one, so these are labels on sliders, not options.
const LEG_COPY = [
  { key: "stakers" as const, title: FEE_LEG_LABEL.stakers, body: "Everyone who locked the pad's own coin earns it, from every launch that pays this way, more for a longer lock." },
  { key: "buyback" as const, title: FEE_LEG_LABEL.buyback, body: "It buys the token back and destroys it. Supply only goes down." },
  { key: "liquidity" as const, title: FEE_LEG_LABEL.liquidity, body: "It deepens the pool the token graduates into." },
  { key: "creator" as const, title: FEE_LEG_LABEL.creator, body: "It pays the address you name below. Transferable later, by that address only." },
];

/// Lock lengths come from the locker, because that is where a locked first buy actually sits.
/// The factory refuses anything that is not one of them, so the form offers exactly those.
const LOCKS = [{ label: "no lock", seconds: 0 }, ...LOCK_TIERS.filter((t) => t.seconds > 0).map((t) => ({ label: t.label, seconds: t.seconds }))];

/// Two machines, and the second one is the one people arrive looking for and do not find, because
/// "straight to the pool" does not tell them it is where the tax, the snipe surcharge, the opening
/// window and the four way split live. So each card now names what it gives you, not only its shape.
const MACHINES = {
  curve: {
    title: "Bonding curve",
    body: "The price rises as people buy. If the curve reaches its target, it moves into a permanently locked pool. Choose who benefits from trading fees.",
    meta: "starts on a curve",
  },
  direct: {
    title: "Direct pool",
    body: "Trading starts in a locked pool immediately. Choose what buys and sells cost, who receives those fees, and whether short opening limits apply.",
    meta: "trades from block one",
  },
} as const;

const CURVE_STRATEGIES_WITH_LOCKERS = [
  { id: "community", title: "Reward the community", body: "Half of the distributable fee goes to people locking the pad coin; the rest supports buyback and liquidity.", values: { stakers: 50, buyback: 25, liquidity: 15, creator: 10 } },
  { id: "balanced", title: "Balanced", body: "Split the distributable fee equally between lockers and the creator.", values: { stakers: 50, buyback: 0, liquidity: 0, creator: 50 } },
  { id: "creator", title: "Creator revenue", body: "Most of the distributable fee goes to the creator; a smaller part still supports lockers and the token.", values: { stakers: 10, buyback: 10, liquidity: 10, creator: 70 } },
] as const;
const CURVE_STRATEGIES_NO_LOCKERS = [
  { id: "community", title: "Grow the token", body: "Prioritize buyback and deeper locked liquidity while locker rewards are unavailable.", values: { stakers: 0, buyback: 50, liquidity: 40, creator: 10 } },
  { id: "balanced", title: "Balanced", body: "Half of the distributable fee goes to the creator; the rest supports buyback and liquidity.", values: { stakers: 0, buyback: 30, liquidity: 20, creator: 50 } },
  { id: "creator", title: "Creator revenue", body: "Most of the distributable fee goes to the creator; a small part supports the token.", values: { stakers: 0, buyback: 10, liquidity: 10, creator: 80 } },
] as const;

export default function LaunchPage() {
  const [machine, setMachine] = useState<keyof typeof MACHINES>("curve");

  const chooser = (
    <div className="launch-mode-switch" role="group" aria-label="Launch model">
      {(Object.keys(MACHINES) as (keyof typeof MACHINES)[]).map((k) => (
        <button key={k} type="button" aria-pressed={machine === k} onClick={() => setMachine(k)}
          className={machine === k ? "selected" : ""}>{MACHINES[k].title}<small>{MACHINES[k].meta}</small></button>
      ))}
      {/* Inside the grid on purpose: the stylesheet keys the compact switch off the wizard
          progress being its next sibling, and a paragraph between them would undo that. */}
      <p className="launch-mode-note">The curve pays your split 70 bps of every trade. The direct machine adds a tax of your own on top.</p>
    </div>
  );

  return (
    <div className="launch-shell">
      <header className="page-intro">
        <div className="section-kicker">Robinhood Chain</div>
        <h1>Create a token</h1>
        <p>
          Name it, choose its market and fee rules, then review before signing.
        </p>
      </header>

      {machine === "curve" ? <CurveLaunchForm chooser={chooser} /> : <DirectLaunchForm chooser={chooser} />}
    </div>
  );
}

function CurveLaunchForm({ chooser }: { chooser: React.ReactNode }) {
  const [activeStep, setActiveStep] = useState(0);
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const router = useRouter();
  const { writeContractAsync, isPending } = useWriteContract();
  const { canBatch, batch } = useBatch();
  const [hash, setHash] = useState<`0x${string}` | undefined>();
  const [reviewedFingerprint, setReviewedFingerprint] = useState("");
  const receipt = useWaitForTransactionReceipt({ hash });
  const [exemptText, setExemptText] = useState("");

  // Which LaunchParams the deployed factory reads, off its bytecode. This form writes the one with
  // the opening tax's `exempt` list and nothing older: a build pointed at an earlier factory says
  // so instead of launching on rules the page no longer describes. See lib/launchAbi.ts.
  const factoryGeneration = useQuery({
    queryKey: ["factory-generation", addresses.factory],
    queryFn: async () => {
      const code = await publicClient!.getCode({ address: addresses.factory });
      return detectFactoryGeneration(code) ?? null;
    },
    enabled: Boolean(publicClient) && addresses.factory !== zeroAddress,
    staleTime: Infinity,
  });
  const generation = factoryGeneration.data ?? undefined;
  const supportsExempt = factoryTakesExempt(generation);
  const exemptList = parseExempt(exemptText);
  const openingError = exemptProblem(exemptList);

  const [form, setForm] = useState({
    name: "", symbol: "", description: "", image: "", website: "", twitter: "", telegram: "",
    configId: 0, pairToken: zeroAddress as Address,
    customPair: false, customAddress: "", customStart: "1000000", customGraduation: "10000000",
    acceptThinLiquidity: false, acceptCustomRisk: false,
    firstBuy: "",
    // Percentages here, basis points on chain: a slider a person drags should be in the unit they
    // think in, and the conversion belongs at the edge, once.
    // Half to the creator, half to the fam: the pad's published default, and the one number a
    // reader of the paper expects the form to already be on.
    stakers: 50, buyback: 0, liquidity: 0, creator: 50,
    feeRecipient: "",
    // The trade fee in bps, or null for "whatever the preset charges". A creator who moves it is
    // launching a config of their own, which the factory takes through launchCustom.
    feeBps: null as number | null,
    firstBuyLock: 0,
  });
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  const { data: configCount } = useReadContract({
    address: addresses.factory, abi: hoodFactoryAbi, functionName: "configCount",
  });
  const { data: configs } = useReadContracts({
    contracts: Array.from({ length: Number(configCount ?? 0n) }, (_, i) => ({
      address: addresses.factory, abi: hoodFactoryAbi, functionName: "getConfig", args: [BigInt(i)],
    })) as never,
    query: { enabled: Boolean(configCount) },
  });
  // The one coin the vault accepts. Zero means nobody can be paid as a staker yet, and the
  // factory refuses a launch that promises them anything.
  const { data: houseToken } = useReadContract({
    address: addresses.staking, abi: hoodStakingAbi, functionName: "houseToken",
  });
  const canPayStakers = typeof houseToken === "string" && houseToken !== zeroAddress;
  useEffect(() => {
    // The default is the whole fee to stakers. Before the coin exists that default cannot launch,
    // so it moves to the next most useful thing once, without stepping on a creator who has
    // already touched the sliders.
    if (houseToken === undefined || canPayStakers) return;
    setForm((f) => (f.stakers === 50 && f.creator === 50 && f.buyback === 0 && f.liquidity === 0
      ? { ...f, stakers: 0, creator: 50, buyback: 30, liquidity: 20 }
      : f));
  }, [houseToken, canPayStakers]);

  // What this pad will take as a pair today. The factory's allow list decides it, so an asset the
  // owner adds shows up here without a deploy, and one they withdraw disappears the same way.
  const { data: pairData, isFetching: pairsLoading, isError: pairsError } = useQuery({
    queryKey: ["pairs"],
    queryFn: () => api<{ pairs: PairRow[] }>("/pairs"),
    staleTime: 60_000,
  });
  const allowedPairs = pairData?.pairs ?? [];
  // The plan's pairs join the menu only once the API has answered, so an allowed pair is never
  // shown as a planned one (and launched through launchCustom) just because it loaded first.
  const plannedRows = pairData
    ? PLANNED.filter((p) => !allowedPairs.some((a) => a.address.toLowerCase() === p.address.toLowerCase()))
    : [];
  const pairs: (PairRow & { usdReason?: string | null })[] = [
    ...allowedPairs,
    ...plannedRows.map((p) => ({ ...p, allowed: false, lockThreshold: "0", usd: 0, usdReason: "price on pick" })),
  ];
  const planned = form.customPair
    ? undefined
    : plannedRows.find((p) => p.address.toLowerCase() === form.pairToken.toLowerCase());
  // A planned pair has no price in the API's list, so the one picked is read on its own.
  const { data: plannedQuote } = useQuery({
    queryKey: ["custom-quote", planned?.address.toLowerCase()],
    queryFn: () => api<ResolvedQuote>(`/pairs/resolve/${planned!.address}`),
    enabled: Boolean(planned),
    staleTime: 60_000,
    retry: false,
  });
  const customAddressValid = isAddress(form.customAddress) && form.customAddress.toLowerCase() !== zeroAddress;
  const { data: customQuote, error: customQuoteError, isFetching: customQuoteLoading } = useQuery({
    queryKey: ["custom-quote", form.customAddress.toLowerCase()],
    queryFn: () => api<ResolvedQuote>(`/pairs/resolve/${form.customAddress}`),
    enabled: form.customPair && customAddressValid,
    staleTime: 60_000,
    retry: false,
  });
  const { data: customRoute } = useQuery({
    queryKey: ["custom-route", customQuote?.address],
    queryFn: () => api<RouteAvailability>(`/pairs/route/${customQuote!.address}`),
    enabled: form.customPair && Boolean(customQuote?.address),
    staleTime: 60_000,
    retry: false,
  });
  useEffect(() => {
    if (!form.customPair || !customQuote) return;
    setForm((f) => f.pairToken.toLowerCase() === customQuote.address.toLowerCase()
      ? f
      : { ...f, pairToken: customQuote.address as Address, firstBuy: "" });
  }, [form.customPair, customQuote]);

  const { data: launchFee } = useReadContract({
    address: addresses.factory, abi: hoodFactoryAbi, functionName: "launchFee",
  });
  const { data: symbolFree } = useReadContract({
    address: addresses.factory, abi: hoodFactoryAbi, functionName: "isSymbolAvailable",
    args: [form.symbol], query: { enabled: form.symbol.length > 0 },
  });
  const { data: econ } = useReadContract({
    address: addresses.factory, abi: hoodFactoryAbi, functionName: "previewLaunchEconomics",
    args: [BigInt(form.configId), form.pairToken], query: { enabled: !form.customPair && !planned, refetchInterval: 15_000 },
  });

  useEffect(() => {
    if (receipt.isSuccess && receipt.data) {
      const log = receipt.data.logs.find((l) => l.address.toLowerCase() === addresses.factory.toLowerCase() && l.topics.length >= 4);
      if (log) router.push(`/token/0x${log.topics[1]!.slice(26)}`);
    }
  }, [receipt.isSuccess, receipt.data, router]);

  const isNative = form.pairToken === zeroAddress;
  const chosenPair = pairs.find((p) => p.address.toLowerCase() === form.pairToken.toLowerCase());
  const pairDec = form.customPair ? (customQuote?.decimals ?? 18) : (chosenPair?.decimals ?? pairDecimals(form.pairToken));
  const pair = form.customPair ? (customQuote?.symbol ?? "custom token") : (chosenPair?.symbol ?? pairSymbol(form.pairToken));
  const pairUsd = form.customPair ? (customQuote?.usd ?? 0) : planned ? (plannedQuote?.usd ?? 0) : (chosenPair?.usd ?? 0);
  const firstBuyWei = units(form.firstBuy, pairDec);
  const customStartCap = units(form.customStart, pairDec);
  const customGraduationCap = units(form.customGraduation, pairDec);
  const customConfig = {
    pairToken: form.pairToken,
    totalSupply: CUSTOM_SUPPLY,
    curveSupplyBps: 8000,
    startCap: customStartCap,
    graduationCap: customGraduationCap,
    liquidityBps: 9000,
    protocolFeeBps: BAG_LEG_BPS,
    creatorFeeBps: CREATOR_LEG_BPS,
    poolFee: 3000,
    tickSpacing: 60,
    enabled: true,
  } as const;
  // Only the chain's own currency travels with the transaction. Everything else is pulled from the
  // wallet, which is why an ERC-20 first buy needs an approval before the launch, below.
  const value = (launchFee as bigint | undefined ?? 0n) + (isNative ? firstBuyWei : 0n);
  const feeDisplay = launchFee === undefined ? "Reading fee…" : `${fmt(launchFee as bigint, 18, 6)} ETH`;

  // A first buy in anything but the chain's own currency is pulled from the wallet, so the factory
  // needs an allowance before the launch. Read here so the bar can say which transaction it is on.
  const { data: pairAllowance } = useReadContract({
    address: form.pairToken, abi: erc20Abi, functionName: "allowance",
    args: [address ?? zeroAddress, addresses.factory],
    query: { enabled: !isNative && firstBuyWei > 0n && Boolean(address) },
  });
  const needsApproval = !isNative && firstBuyWei > 0n && ((pairAllowance as bigint | undefined) ?? 0n) < firstBuyWei;

  // Which presets belong to the chosen pair. The preset names it, so this is a fact rather than
  // the guess by dollar size it used to be, which let a preset written for one share appear under
  // another asset that happened to cost about the same.
  const presetFits = (cfg?: CurvePreset) =>
    Boolean(cfg?.enabled) && cfg!.pairToken.toLowerCase() === form.pairToken.toLowerCase();
  const presetsForPair = ((configs ?? []) as { result?: CurvePreset }[]).filter((c) => presetFits(c.result)).length;
  // A planned pair's preset is the one the plan would publish, built with the same numbers
  // script/AllowQuotes.s.sol writes, and it goes on chain through launchCustom.
  const plannedPreset = planned
    ? { ...customConfig, startCap: BigInt(planned.startCap), graduationCap: BigInt(planned.graduationCap) }
    : undefined;
  const chosen = plannedPreset ?? ((configs ?? []) as { result?: CurvePreset }[])[form.configId]?.result;
  const openingCap = form.customPair ? customStartCap : chosen?.startCap;
  const graduationCap = form.customPair ? customGraduationCap : chosen?.graduationCap;
  // The trading fee. The Bag's leg is not the creator's to move; everything above it is, up to
  // the 500 bps the factory refuses to go past. A preset carries its own two legs, so leaving
  // this alone launches the preset exactly as it was published and pins its econ hash; moving it
  // turns the launch into a config of the creator's own, which is what launchCustom is for.
  const PROTOCOL_FEE_BPS = form.customPair ? customConfig.protocolFeeBps : (chosen ? Number(chosen.protocolFeeBps) : BAG_LEG_BPS);
  const MAX_TOTAL_FEE_BPS = 500;
  const presetCreatorFeeBps = form.customPair ? customConfig.creatorFeeBps : (chosen ? Number(chosen.creatorFeeBps) : CREATOR_LEG_BPS);
  const creatorFeeBps = form.feeBps ?? presetCreatorFeeBps;
  const totalFeeBps = PROTOCOL_FEE_BPS + creatorFeeBps;
  const firstBuyConfig = form.customPair ? customConfig : chosen;
  const firstBuyEstimate = firstBuyWei > 0n && firstBuyConfig
    && firstBuyConfig.startCap > 0n && firstBuyConfig.graduationCap > firstBuyConfig.startCap
    ? curveBuy({
      p0: (firstBuyConfig.startCap * 10n ** 18n) / firstBuyConfig.totalSupply,
      p1: (firstBuyConfig.graduationCap * 10n ** 18n) / firstBuyConfig.totalSupply,
      supply: (firstBuyConfig.totalSupply * BigInt(firstBuyConfig.curveSupplyBps)) / 10_000n,
      sold: 0n, pairIn: firstBuyWei, feeBps: totalFeeBps,
    }) : null;
  // Older deployed factories do not forward an ERC-20 curve refund to the creator. Until every
  // deployment is replaced, never allow a first buy that visibly exceeds the curve's capacity.
  const erc20FirstBuyExcess = !isNative && firstBuyEstimate && firstBuyEstimate.spent < firstBuyWei
    ? firstBuyWei - firstBuyEstimate.spent : 0n;
  const feeMoved = form.feeBps !== null && form.feeBps !== presetCreatorFeeBps;
  // A preset whose fee the creator moved is still that preset in every other number, so the config
  // that goes on chain is the preset itself with one field replaced.
  const launchConfig = form.customPair
    ? { ...customConfig, creatorFeeBps }
    : chosen
      ? { ...chosen, creatorFeeBps, enabled: true }
      : null;
  const useCustomConfig = form.customPair || feeMoved || Boolean(planned);

  const tokenDone = form.name.length > 0 && form.symbol.length > 0 && symbolFree !== false;
  const splitTotal = form.stakers + form.buyback + form.liquidity + form.creator;
  const strategies = canPayStakers ? CURVE_STRATEGIES_WITH_LOCKERS : CURVE_STRATEGIES_NO_LOCKERS;
  const selectedStrategy = strategies.find((strategy) =>
    strategy.values.stakers === form.stakers && strategy.values.buyback === form.buyback
    && strategy.values.liquidity === form.liquidity && strategy.values.creator === form.creator,
  )?.id;
  // The address the creator leg pays. Empty means the wallet doing the launching, which is what it
  // silently did before; a team that wants the stream elsewhere says so here rather than
  // discovering later that it went to whichever key happened to sign.
  const recipient = form.feeRecipient.trim() || address || "";
  const recipientOk = !form.feeRecipient.trim() || isAddress(form.feeRecipient.trim());
  const reviewedTerms = JSON.stringify({
    form, exemptText, generation, pair, recipient, totalFeeBps,
    opening: String(form.customPair ? customStartCap : chosen?.startCap ?? ""),
    graduation: String(form.customPair ? customGraduationCap : chosen?.graduationCap ?? ""),
    econ: String(econ ?? ""),
  });
  const reviewed = reviewedFingerprint === reviewedTerms;
  const exampleAmount = (bps: number) => `${(bps / 10_000).toFixed(5)} ${pair}`;
  const distributableExample = creatorFeeBps / 10_000;
  const feeExampleRows = [
    { label: "Total trading fee", value: `${exampleAmount(totalFeeBps)} (${(totalFeeBps / 100).toFixed(2)}%)` },
    { label: `Into the Bag, ${(PROTOCOL_FEE_BPS / 100).toFixed(2)}%`, value: exampleAmount(PROTOCOL_FEE_BPS) },
    { label: `Your split, ${(creatorFeeBps / 100).toFixed(2)}%`, value: exampleAmount(creatorFeeBps) },
    { label: "  creator address", value: `${(distributableExample * form.creator / 100).toFixed(5)} ${pair}` },
    { label: "  buyback and burn", value: `${(distributableExample * form.buyback / 100).toFixed(5)} ${pair}` },
    { label: "  locked liquidity", value: `${(distributableExample * form.liquidity / 100).toFixed(5)} ${pair}` },
    ...(form.stakers > 0 ? [{ label: "  Vault lockers", value: `${(distributableExample * form.stakers / 100).toFixed(5)} ${pair}` }] : []),
  ];

  // One reason at a time, in the order somebody would hit them. A button that is off without saying
  // why is the single thing this page used to do worst.
  const blocked = !address ? "Connect a wallet first. It pays the fee and becomes the creator."
    : !form.name ? "Enter a token name."
    : !form.symbol ? "Enter a ticker."
    : symbolFree === false ? "That ticker is locked by a launch that is trading right now."
    : form.customPair && !customAddressValid ? "Enter a valid Robinhood Chain ERC-20 address."
    : form.customPair && !customQuote ? (customQuoteLoading ? "Reading the custom token from Robinhood Chain." : "That custom token could not be verified.")
    : form.customPair && customQuote && !customQuote.compatible ? "This token has more than 18 decimals and the curve refuses it."
    : form.customPair && customGraduationCap <= customStartCap ? "The custom graduation valuation must be above its opening valuation."
    : form.customPair && customStartCap === 0n ? "The custom opening valuation must be above zero."
    : form.customPair && customQuote && !customQuote.liquiditySafe && !form.acceptThinLiquidity ? "Confirm that you understand this quote token has thin or unverified liquidity."
    : form.customPair && !form.acceptCustomRisk ? "Confirm that the parent coin can lose value or change its transfer rules independently of your token."
    : form.stakers > 0 && !canPayStakers ? "Locker rewards are not available until the pad coin is named on chain."
    : splitTotal !== 100 ? `The fee shares total ${splitTotal}%; they must total 100%.`
    : !recipientOk ? "Enter a valid fee-recipient address, or leave it blank."
    : form.creator > 0 && !recipient ? "Connect a wallet or enter a creator-fee recipient."
    : totalFeeBps > MAX_TOTAL_FEE_BPS ? `The ${(totalFeeBps / 100).toFixed(2)}% fee exceeds the factory's 5% maximum.`
    : useCustomConfig && !launchConfig ? "No preset is available for this custom fee."
    : form.firstBuyLock > 0 && firstBuyWei === 0n ? "Enter a first buy before locking it."
    : erc20FirstBuyExcess > 0n ? `This first buy exceeds curve capacity. Reduce it by at least ${fmt(erc20FirstBuyExcess, pairDec, 6)} ${pair}.`
    : openingError ? openingError
    : launchFee === undefined ? "Reading the launch fee from chain."
    : factoryGeneration.isLoading ? "Checking the factory contract version."
    : factoryGeneration.isSuccess && !generation ? "The factory at this address answers to no launch this app knows."
    : !supportsExempt ? "This factory is an older version than this app launches on."
    : !reviewed ? "Review the permanent terms before creating the token."
    : undefined;

  const marketBlocked = form.customPair && !customAddressValid ? "Enter a valid ERC-20 address."
    : form.customPair && !customQuote ? (customQuoteLoading ? "Reading the token…" : "This token could not be verified.")
    : form.customPair && customQuote && !customQuote.compatible ? "This token is not compatible with the curve."
    : form.customPair && (customStartCap === 0n || customGraduationCap <= customStartCap) ? "Set a graduation valuation above the opening valuation."
    : form.customPair && customQuote && !customQuote.liquiditySafe && !form.acceptThinLiquidity ? "Confirm the liquidity warning."
    : form.customPair && !form.acceptCustomRisk ? "Confirm the parent-coin risk."
    : !form.customPair && !chosen ? "Choose an available curve preset."
    : erc20FirstBuyExcess > 0n ? "Reduce the first buy to fit the curve."
    : undefined;
  const economicsBlocked = form.stakers > 0 && !canPayStakers ? "Locker rewards are not available yet."
    : splitTotal !== 100 ? `Fee shares total ${splitTotal}%; they must total 100%.`
    : !recipientOk ? "Enter a valid creator-fee address."
    : totalFeeBps > MAX_TOTAL_FEE_BPS ? "The total trading fee cannot exceed 5%."
    : undefined;
  const nextBlocked = activeStep === 0 ? (!form.name ? "Enter a token name." : !form.symbol ? "Enter a ticker." : symbolFree === false ? "This ticker is taken." : undefined)
    : activeStep === 1 ? marketBlocked
    : activeStep === 2 ? economicsBlocked
    : openingError;
  const moveTo = (step: number) => {
    setActiveStep(step);
    requestAnimationFrame(() => document.getElementById("launch-flow")?.scrollIntoView({ block: "start", behavior: "auto" }));
  };

  async function launch() {
    if (!address || !reviewed || !generation) return;
    const abi = factoryAbis[generation];
    const salt = `0x${Array.from(crypto.getRandomValues(new Uint8Array(32))).map((b) => b.toString(16).padStart(2, "0")).join("")}` as `0x${string}`;
    const launchData = useCustomConfig && launchConfig
      ? encodeFunctionData({ abi, functionName: "launchCustom", args: [launchArgs(salt), launchConfig] as never })
      : encodeFunctionData({ abi, functionName: "launch", args: [launchArgs(salt)] as never });
    if (needsApproval) {
      // The wallet has to let the factory take the first buy. A Safe does both in one signature
      // round; anything else approves now and launches on the next press.
      const approve = { to: form.pairToken, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [addresses.factory, firstBuyWei] }) };
      if (canBatch) {
        const id = await batch([approve, { to: addresses.factory, data: launchData, value }]);
        if (id) return setHash(id);
      }
      return setHash(await writeContractAsync({
        address: form.pairToken, abi: erc20Abi, functionName: "approve", args: [addresses.factory, firstBuyWei],
      }));
    }
    if (useCustomConfig && launchConfig) {
      setHash(await writeContractAsync({
        address: addresses.factory, abi: abi as never, functionName: "launchCustom",
        args: [launchArgs(salt), launchConfig] as never, value,
      }));
    } else {
      setHash(await writeContractAsync({
        address: addresses.factory, abi: abi as never, functionName: "launch",
        args: [launchArgs(salt)] as never, value,
      }));
    }
  }

  /// LaunchParams in the contract's order, `exempt` last.
  function launchArgs(salt: `0x${string}`) {
    return {
      name: form.name, symbol: form.symbol, image: form.image, description: form.description,
      website: form.website, twitter: form.twitter, telegram: form.telegram,
      pairToken: form.pairToken, configId: BigInt(form.customPair ? 0 : form.configId),
      feeSplit: {
        stakersBps: form.stakers * 100, buybackBps: form.buyback * 100,
        liquidityBps: form.liquidity * 100, creatorBps: form.creator * 100,
      },
      creatorFeeRecipient: (recipient || address ) as Address,
      firstBuy: firstBuyWei, firstBuyLock: BigInt(form.firstBuyLock),
      salt, econ: useCustomConfig
        ? (`0x${"0".repeat(64)}` as `0x${string}`)
        : ((econ as `0x${string}`) ?? (`0x${"0".repeat(64)}` as `0x${string}`)),
      exempt: exemptAddresses(exemptText),
    } as const;
  }

  // No factory address means this build is not wired to the chain: a preview, or a box whose
  // contracts are not deployed yet. Say so, rather than showing a form whose button would write to
  // the zero address. The direct machine already says the same about its own portal.
  if (addresses.factory === zeroAddress) {
    return <p className="panel p-6 text-sm dim">The curve machine is not configured on this deployment.</p>;
  }

  return (
    <div className="launch-content" id="launch-flow">
      <div className="launch-guide">
        <div className="launch-form-stack">
          {chooser}
          <WizardProgress labels={STEPS} current={activeStep} />

          {activeStep === 0 && (
          <Step n={1} title="The token" purpose="Name it and choose how it appears on the board. You cannot edit these details after launch." done={tokenDone}>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name" help="The full name, as it should read on the board.">
                <input className="input" value={form.name} onChange={(e) => set("name", e.target.value)} placeholder={brand.id === "ox" ? "Your token" : "Hood Fam"} />
              </Field>
              <Field label="Ticker"
                error={form.symbol && symbolFree === false ? "Taken. A launch trading right now holds this ticker; it frees up when that one cools off." : undefined}
                ok={form.symbol && symbolFree === true ? "Available." : undefined}
                help="Letters and numbers, no dollar sign. We add that.">
                <input className="input mono uppercase" value={form.symbol}
                  onChange={(e) => set("symbol", e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} placeholder={brand.id === "ox" ? "TOKEN" : "FAM"} />
              </Field>
            </div>
            <Field label="Description" help="One or two lines. It shows on the token page and in the share card.">
              <textarea className="input min-h-20" value={form.description} onChange={(e) => set("description", e.target.value)} />
            </Field>
            <div>
              <span className="field-label">Picture</span>
              <ArtworkPicker value={form.image} onChange={(v) => set("image", v)} symbol={form.symbol}
                ai promptHint={`${form.name} ${form.symbol} token logo`.trim()} />
            </div>
            <details className="launch-advanced"><summary>Add social links <span>Optional</span></summary><div className="launch-advanced-body grid gap-4 sm:grid-cols-3">
              <Field label="Website" help="Optional."><input className="input" value={form.website} onChange={(e) => set("website", e.target.value)} placeholder="https://" /></Field>
              <Field label="X" help="Optional."><input className="input" value={form.twitter} onChange={(e) => set("twitter", e.target.value)} placeholder="https://x.com/" /></Field>
              <Field label="Telegram" help="Optional."><input className="input" value={form.telegram} onChange={(e) => set("telegram", e.target.value)} placeholder="https://t.me/" /></Field>
            </div></details>
          </Step>
          )}

          {activeStep === 2 && (
          <Step n={3} title={`Who gets your ${(presetCreatorFeeBps / 100).toFixed(2)}%?`}
            purpose={`The platform takes ${((PROTOCOL_FEE_BPS + presetCreatorFeeBps) / 100).toFixed(2)}% of every trade: ${(PROTOCOL_FEE_BPS / 100).toFixed(2)}% into the Bag, ${(presetCreatorFeeBps / 100).toFixed(2)}% to your split. Choose where your split goes. It is permanent after launch.`}
            done={splitTotal === 100 && recipientOk}>
            <div className="launch-outcome-grid" role="group" aria-label="Fee strategy">
              {strategies.map((strategy) => (
                <button key={strategy.id} type="button" aria-pressed={selectedStrategy === strategy.id}
                  className={selectedStrategy === strategy.id ? "launch-outcome selected" : "launch-outcome"}
                  onClick={() => setForm((current) => ({ ...current, ...strategy.values }))}>
                  <strong>{strategy.title}</strong><span>{strategy.body}</span>
                </button>
              ))}
            </div>
            {!canPayStakers && <p className="launch-outcome-note">Locker rewards are unavailable until the pad coin is named on chain. No option here promises those rewards.</p>}
            <details className="launch-advanced"><summary>See an example trade <span>Optional</span></summary><div className="launch-advanced-body"><LaunchFeeExample
              title={`If someone trades 1 ${pair}`}
              description={`At the current ${(totalFeeBps / 100).toFixed(2)}% trading fee, this is approximately where the fee goes:`}
              rows={feeExampleRows}
              note="This shows fee routing only. The curve price, slippage and token amount are separate."
            /></div></details>
            {form.creator > 0 && (
              <Field label="Where should the creator's fee go?"
                help="Leave blank to use your connected wallet. A team can enter its Safe address. Only that address controls its share."
                error={recipientOk ? undefined : "Enter a valid 0x address."}>
                <input className="input mono" placeholder={address ?? "0x..."} value={form.feeRecipient}
                  onChange={(e) => set("feeRecipient", e.target.value.trim())} />
              </Field>
            )}
            <details className="launch-advanced">
              <summary>Advanced: exact split and trading fee <span>Optional</span></summary>
              <div className="launch-advanced-body">
                <p>The platform fee is 1% of each trade: {(PROTOCOL_FEE_BPS / 100).toFixed(2)}% into the Bag, {(presetCreatorFeeBps / 100).toFixed(2)}% to your split. Your split is divided by these four percentages, which must total 100%.</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  {LEG_COPY.map((leg) => (
                    <Slider key={leg.key}
                      label={`${leg.title} ${form[leg.key]}%`}
                      hint={leg.key === "stakers" && !canPayStakers
                        ? "Unavailable until the pad coin is named on chain."
                        : leg.body}
                      min={0} max={leg.key === "stakers" && !canPayStakers ? 0 : 100} step={5}
                      value={form[leg.key]} onChange={(v) => set(leg.key, v)} />
                  ))}
                </div>
                <p className={splitTotal === 100 ? "field-note good" : "field-note bad"}>
                  {splitTotal === 100 ? "The four shares total 100%." : `The shares total ${splitTotal}%. Adjust them to 100%.`}
                </p>
                <Slider label={`Trading fee ${(totalFeeBps / 100).toFixed(2)}%`}
                  hint={`The Bag's ${(PROTOCOL_FEE_BPS / 100).toFixed(2)}% is fixed; anything you add here goes to your split, up to a 5% total. Moving it makes this a custom launch configuration. The curve leg is where a creator earns least; the direct machine's own tax is where a creator earns.`}
                  min={PROTOCOL_FEE_BPS} max={MAX_TOTAL_FEE_BPS} step={10}
                  value={totalFeeBps}
                  onChange={(v) => set("feeBps", Math.max(0, v - PROTOCOL_FEE_BPS))} />
                {feeMoved && <button type="button" className="text-xs dim underline" onClick={() => set("feeBps", null)}>Restore the preset fee</button>}
              </div>
            </details>
          </Step>
          )}

          {activeStep === 1 && (
          <Step n={2} title="Market and curve" purpose="Choose what buyers pay with, then how the token moves toward a locked pool." done>
            <div className="grid gap-2 sm:grid-cols-2">
              <Choice selected={!form.customPair} onClick={() => {
                set("customPair", false); set("pairToken", (pairs[0]?.address as Address | undefined) ?? zeroAddress); set("firstBuy", "");
              }} title="Curated pairs" body="ETH, USDG, tokenized stocks like NVDA and SPY, and the liquid coins already reviewed by the pad." meta="standard" />
              <Choice selected={form.customPair} onClick={() => { set("customPair", true); set("firstBuy", ""); }}
                title="Paste any coin" body="Launch against any compatible Robinhood Chain ERC-20, including an existing meme coin." meta="meme-to-meme" />
            </div>

            {!form.customPair ? <>
              <PairChooser pairs={pairs} value={form.pairToken} loading={pairsLoading} error={pairsError} compact
                onPick={(address: Address) => { set("pairToken", address); set("firstBuy", ""); set("configId", 0); }} />
              {plannedPreset && <div className="grid gap-2">
                <Choice selected onClick={() => {}}
                  title={`Starts at ${fmt(plannedPreset.startCap, pairDec, 3)} ${pair}, graduates at ${fmt(plannedPreset.graduationCap, pairDec, 3)} ${pair}`}
                  body={`${plannedPreset.curveSupplyBps / 100}% of the supply trades on the curve. The rest goes into the pool at graduation, locked.${
                    pairUsd > 0 ? ` About $${Math.round((Number(plannedPreset.startCap) / 10 ** pairDec) * pairUsd).toLocaleString()} at the open, $${Math.round((Number(plannedPreset.graduationCap) / 10 ** pairDec) * pairUsd).toLocaleString()} at graduation.` : ""
                  } Your launch publishes this preset and opens ${pair} as a pair.`}
                  meta={`${(plannedPreset.protocolFeeBps + plannedPreset.creatorFeeBps) / 100}% per trade`} />
              </div>}
              {!plannedPreset && <div className="grid gap-2">
                {((configs ?? []) as { result?: CurvePreset }[]).map((c, i) => {
                  const cfg = c.result;
                  if (!cfg?.enabled || !presetFits(cfg)) return null;
                  return (
                    <Choice key={i} selected={form.configId === i} onClick={() => set("configId", i)}
                      title={`Starts at ${fmt(cfg.startCap, pairDec, 3)} ${pair}, graduates at ${fmt(cfg.graduationCap, pairDec, 3)} ${pair}`}
                      body={`${cfg.curveSupplyBps / 100}% of the supply trades on the curve. The rest goes into the pool at graduation, locked.${
                        pairUsd > 0 ? ` About $${Math.round((Number(cfg.startCap) / 10 ** pairDec) * pairUsd).toLocaleString()} at the open, $${Math.round((Number(cfg.graduationCap) / 10 ** pairDec) * pairUsd).toLocaleString()} at graduation.` : ""
                      }`}
                      meta={`${(cfg.protocolFeeBps + cfg.creatorFeeBps) / 100}% per trade`} />
                  );
                })}
              </div>}
              {!plannedPreset && presetsForPair === 0 && <p className="text-xs text-[var(--color-red)]">No preset is denominated in {pair} yet. Pick another pair.</p>}
            </> : <>
              <Field label="Robinhood Chain token address"
                help="Paste the parent coin's ERC-20 address. Metadata and available USDG liquidity are read directly from chain."
                error={form.customAddress && (!customAddressValid || customQuoteError) ? "This address could not be resolved as a compatible ERC-20." : undefined}>
                <input className="input mono" value={form.customAddress}
                  onChange={(e) => { setForm((current) => ({ ...current, customAddress: e.target.value.trim(), acceptThinLiquidity: false, acceptCustomRisk: false })); }} placeholder="0x..." />
              </Field>
              {customQuoteLoading && <p className="text-xs dim">Reading token metadata and checking its USDG pools…</p>}
              {customQuote && <div className="panel p-4 text-xs">
                <div className="flex items-center justify-between gap-3">
                  <strong>{customQuote.name} · ${customQuote.symbol}</strong>
                  <span className={customQuote.liquiditySafe ? "text-[var(--color-lime)]" : "text-[var(--color-red)]"}>
                    {customQuote.hasLiquidity ? `$${Math.round(customQuote.depthUsd).toLocaleString()} USDG pool balance` : "no USDG pool found"}
                  </span>
                </div>
                <p className="mt-2 dim">{customQuote.decimals} decimals · metadata read on-chain{customQuote.pool ? ` · Uniswap v3 ${customQuote.pool.fee / 10_000}% pool found` : ""}</p>
                <p className="mt-1 dim">{customRoute?.available ? "A one-click ETH route is currently available." : "An ETH one-click route has not been verified; buyers may need to acquire this coin first."} Pool balance does not measure executable depth.</p>
                {customQuote.warnings.map((warning) => <p key={warning} className="mt-1 dim">⚠ {warning}</p>)}
              </div>}
              {customQuote && <label className="flex items-start gap-2 text-xs dim">
                <input type="checkbox" checked={form.acceptCustomRisk} onChange={(e) => set("acceptCustomRisk", e.target.checked)} />
                <span>I understand the parent coin has its own price and contract risk. Its USDG pool balance is not a safety guarantee.</span>
              </label>}
              {customQuote && !customQuote.liquiditySafe && <label className="flex items-start gap-2 text-xs dim">
                <input type="checkbox" checked={form.acceptThinLiquidity} onChange={(e) => set("acceptThinLiquidity", e.target.checked)} />
                <span>I understand buyers may have difficulty acquiring this quote token. Launching remains permissionless.</span>
              </label>}
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={`Opens at (${pair})`} help="Fully diluted valuation in whole units of the parent coin.">
                  <input className="input mono" inputMode="decimal" value={form.customStart}
                    onChange={(e) => set("customStart", e.target.value.replace(/[^0-9.]/g, ""))} />
                </Field>
                <Field label={`Graduates at (${pair})`} help="The curve creates the permanently locked token/parent pool here.">
                  <input className="input mono" inputMode="decimal" value={form.customGraduation}
                    onChange={(e) => set("customGraduation", e.target.value.replace(/[^0-9.]/g, ""))} />
                </Field>
              </div>
            </>}

            {(form.customPair ? Boolean(customQuote && customGraduationCap > customStartCap) : Boolean(chosen)) && <>
              <div className="launch-curve-summary">
                <strong>How this launch moves</strong>
                <p>Trading starts around {fmt(openingCap ?? 0n, pairDec, 3)} {pair} fully diluted valuation. If buyers fill the curve to {fmt(graduationCap ?? 0n, pairDec, 3)} {pair}, the remaining supply and raised funds move into a locked pool. Reaching that target is not guaranteed.</p>
              </div>
              <details className="launch-advanced">
                <summary>Advanced: explore curve math <span>Optional simulation</span></summary>
                <div className="launch-advanced-body">
                  <CurveSim
                    p0={((form.customPair ? customStartCap : chosen!.startCap) * 10n ** 18n) / (form.customPair ? CUSTOM_SUPPLY : chosen!.totalSupply)}
                    p1={((form.customPair ? customGraduationCap : chosen!.graduationCap) * 10n ** 18n) / (form.customPair ? CUSTOM_SUPPLY : chosen!.totalSupply)}
                    curveSupply={((form.customPair ? CUSTOM_SUPPLY : chosen!.totalSupply) * BigInt(form.customPair ? 8000 : chosen!.curveSupplyBps)) / 10_000n}
                    totalSupply={form.customPair ? CUSTOM_SUPPLY : chosen!.totalSupply}
                    dec={pairDec}
                    sym={pair}
                    feeBps={totalFeeBps}
                    ticker={form.symbol}
                  />
                </div>
              </details>
            </>}

            <details className="launch-advanced"><summary>First buy and optional lock <span>{form.firstBuy ? `${form.firstBuy} ${pair}` : "Optional"}</span></summary><div className="launch-advanced-body launch-optionals">
            <Field label={`Your first buy in ${pair}`}
              help={isNative
                ? "Optional, and it lands inside the launch transaction, so nobody can get in ahead of you. Leave it empty to launch without buying."
                : `Optional, and it lands inside the launch transaction, so nobody can get in ahead of you. Paid in ${pair} out of your wallet, which means one approval first unless you are signing from a Safe.`}>
              <input className="input mono" inputMode="decimal" value={form.firstBuy}
                onChange={(e) => set("firstBuy", e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0.0" />
            </Field>
            {firstBuyEstimate && <div className="launch-curve-summary" role="status">
              <strong>First-buy preview</strong>
              <p>Enter {fmt(firstBuyWei, pairDec, 6)} {pair} → the curve uses approximately {fmt(firstBuyEstimate.spent, pairDec, 6)} {pair} for {fmt(firstBuyEstimate.tokensOut, 18, 4)} ${form.symbol || "tokens"}. That includes a {fmt(firstBuyEstimate.fee, pairDec, 6)} {pair} curve fee. Gas and token-specific transfer behavior are not included; on-chain execution decides the final amount.</p>
              {erc20FirstBuyExcess > 0n && <p className="text-amber-300">Reduce the first buy: {fmt(erc20FirstBuyExcess, pairDec, 6)} {pair} would not be used by the curve. This launch is paused to protect your funds on older factory deployments.</p>}
            </div>}

            {firstBuyWei > 0n && (
              <Field label="Lock your own first buy"
                help="A buyer cannot tell a creator who is staying from one who is about to sell into them. Locking says which you are, on chain: the tokens go straight into the staking vault in your name, they earn whatever the fee split pays stakers, and nothing can take them out early, including us.">
                <div className="flex flex-wrap gap-2">
                  {LOCKS.map((lock) => (
                    <button key={lock.seconds} type="button"
                      className={form.firstBuyLock === lock.seconds ? "btn text-xs" : "btn btn-ghost text-xs"}
                      onClick={() => set("firstBuyLock", lock.seconds)}>
                      {lock.label}
                    </button>
                  ))}
                </div>
              </Field>
            )}
            </div></details>
          </Step>
          )}

          {activeStep === 3 && (
          <Step n={4} title="The opening tax" purpose="The same on every launch: what a buy pays in your token's first three seconds, and who does not pay it." done={!openingError}>
            <OpeningTax value={exemptText} onChange={setExemptText} machine="curve" />
          </Step>
          )}

          {activeStep === REVIEW && (
          <Step n={5} title="Review before signing" purpose="Check the permanent launch rules and cost before opening your wallet." done={reviewed}>
            <LaunchReview
              rows={[
                { label: "Token", value: form.name && form.symbol ? `${form.name} ($${form.symbol})` : "Add a name and ticker" },
                { label: "Launch", value: `Bonding curve paired with ${pair}` },
                { label: "Price path", value: openingCap && graduationCap ? `${fmt(openingCap, pairDec, 3)} to ${fmt(graduationCap, pairDec, 3)} ${pair} valuation` : "Choose a curve preset" },
                { label: "Trade fee", value: `${(totalFeeBps / 100).toFixed(2)}% total: ${(PROTOCOL_FEE_BPS / 100).toFixed(2)}% into the Bag, ${(creatorFeeBps / 100).toFixed(2)}% to your split` },
                { label: "Your split goes to", value: `Creator ${form.creator}% · burn ${form.buyback}% · liquidity ${form.liquidity}%${form.stakers > 0 ? ` · Vault lockers ${form.stakers}%` : ""}` },
                { label: "Creator fee wallet", value: form.creator > 0 ? (recipient || "Connect a wallet") : "No creator share" },
                { label: "First buy", value: firstBuyWei > 0n ? `${form.firstBuy} ${pair}${form.firstBuyLock > 0 ? ` · locked ${LOCKS.find((lock) => lock.seconds === form.firstBuyLock)?.label ?? ""}` : ""}` : "None" },
                ...openingReviewRows(exemptList),
                { label: "Launch cost", value: `${feeDisplay} plus gas${firstBuyWei > 0n ? ` and your ${form.firstBuy} ${pair} first buy` : ""}` },
              ]}
              note="The curve may never fill. The preview above explains fee routing, not returns or a guaranteed token sale. Your wallet will show the transaction before it is sent."
              reviewed={reviewed}
              onReviewed={(checked) => setReviewedFingerprint(checked ? reviewedTerms : "")}
            />
          </Step>
          )}

          {activeStep < REVIEW ? <WizardNav current={activeStep} count={STEPS.length} onBack={() => moveTo(activeStep - 1)} onNext={() => moveTo(activeStep + 1)}
            nextBlocked={nextBlocked} cost={feeDisplay} /> : <LaunchBar
            cost={feeDisplay}
            costLabel={form.firstBuy
              ? `launch fee, plus your ${form.firstBuy} ${pair} first buy${isNative ? "" : `, taken from your wallet in ${pair}`}`
              : "launch fee, plus gas"}
            blocked={blocked}
            busy={isPending || receipt.isLoading}
            busyLabel={receipt.isLoading ? "waiting for the chain" : "confirm in your wallet"}
            label={needsApproval ? `Approve ${pair}` : "Create the token"}
            onClick={launch}
          ><button type="button" className="btn btn-ghost" onClick={() => moveTo(REVIEW - 1)}>Back</button></LaunchBar>}
        </div>
      </div>

      <aside className="launch-preview">
        <div className="launch-preview-label">Live preview</div>
        <div className="launch-preview-art">
          {form.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={form.image} alt="" />
          ) : <span>{(form.symbol || form.name || "?").slice(0, 2).toUpperCase()}</span>}
        </div>
        <h2>{form.name || "Your token"}</h2>
        <p className="launch-preview-symbol">$<span>{form.symbol || "TICKER"}</span></p>
        <div className="launch-preview-details">
          <Row label="Launch model" value="Bonding curve" />
          <Row label="Paired with" value={pair} />
          <Row label="Trading fee" value={`${(totalFeeBps / 100).toFixed(2)}%`} />
          {form.creator > 0 && <Row label="Creator share pays" value={recipient ? `${recipient.slice(0, 6)}…${recipient.slice(-4)}` : "nobody yet"} />}
          <Row label="Opening tax" value={OPENING_TAX_SUMMARY} />
        </div>
        {activeStep === REVIEW && <WhatHappens items={[
          "Your wallet sends one transaction and pays the launch fee.",
          "The token, its curve and its fee split are created together.",
          "The terms above are sent with it, so if the preset moves first the transaction reverts instead of launching on terms you did not agree to.",
          "You land on the token page and it is tradable immediately.",
        ]} />}
      </aside>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between"><span className="dim">{label}</span><span className="mono">{value}</span></div>;
}
