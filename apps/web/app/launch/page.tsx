"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { encodeFunctionData, erc20Abi, isAddress, parseUnits, zeroAddress, type Address } from "viem";
import { useAccount, useReadContract, useReadContracts, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { hoodFactoryAbi, hoodStakingAbi, BPS, FEE_LEG_LABEL, LOCK_TIERS } from "@hood/sdk";
import { addresses } from "@/lib/config";
import { api, type PairRow, type ResolvedQuote } from "@/lib/api";
import { fmt, pairDecimals, pairSymbol } from "@/lib/format";
import { DirectLaunchForm } from "@/components/DirectLaunchForm";
import { ArtworkPicker } from "@/components/ArtworkPicker";
import { Choice, Field, LaunchBar, PairChooser, Rail, Slider, Step, WhatHappens, type StepState } from "@/components/LaunchUI";
import { CurveSim } from "@/components/Sim";
import { useBatch } from "@/lib/safe";

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
    body: "Buyers trade against a rising price. When it sells out, the raise and the rest of the supply move into a Uniswap pool that is locked forever. You set where the trading fee goes and can lock your own first buy.",
    meta: "the pump.fun shape",
  },
  direct: {
    title: "Straight to the pool",
    body: "The whole supply opens in a real Uniswap pool from the first block. You set the buy and sell tax, a surcharge that punishes the first bots and decays in seconds, how long wallets are capped, and how the tax splits between you, a buyback, dividends and the liquidity. No curve, no migration.",
    meta: "tax, anti-snipe, splits",
  },
} as const;

export default function LaunchPage() {
  const [machine, setMachine] = useState<keyof typeof MACHINES>("curve");

  // Step one belongs to the page, not to either machine, but it has to appear inside the machine's
  // own column so the rail counts it. So it is built here and handed down.
  const chooser = (
    <Step n={1} title="How it launches" purpose="This decides everything else on this page, and it cannot be changed after the launch." done>
      <div className="grid gap-2 sm:grid-cols-2">
        {(Object.keys(MACHINES) as (keyof typeof MACHINES)[]).map((k) => (
          <Choice key={k} selected={machine === k} onClick={() => setMachine(k)}
            title={MACHINES[k].title} body={MACHINES[k].body} meta={MACHINES[k].meta} />
        ))}
      </div>
    </Step>
  );

  return (
    <div className="launch-shell">
      <header className="page-intro">
        <div className="section-kicker">Robinhood Chain</div>
        <h1>Create a token</h1>
        <p>
          Four steps, one transaction, about a minute. Nothing is sent until you confirm in your
          wallet, and the cost is on the bar at the bottom the whole way down.
        </p>
      </header>

      {machine === "curve" ? <CurveLaunchForm chooser={chooser} /> : <DirectLaunchForm chooser={chooser} />}
    </div>
  );
}

function CurveLaunchForm({ chooser }: { chooser: React.ReactNode }) {
  const { address } = useAccount();
  const router = useRouter();
  const { writeContractAsync, isPending } = useWriteContract();
  const { canBatch, batch } = useBatch();
  const [hash, setHash] = useState<`0x${string}` | undefined>();
  const receipt = useWaitForTransactionReceipt({ hash });

  const [form, setForm] = useState({
    name: "", symbol: "", description: "", image: "", website: "", twitter: "", telegram: "",
    configId: 0, pairToken: zeroAddress as Address,
    customPair: false, customAddress: "", customStart: "1000000", customGraduation: "10000000",
    acceptThinLiquidity: false,
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
  const { data: pairData } = useQuery({
    queryKey: ["pairs"],
    queryFn: () => api<{ pairs: PairRow[] }>("/pairs"),
    staleTime: 60_000,
  });
  const pairs = pairData?.pairs ?? [];
  const customAddressValid = isAddress(form.customAddress) && form.customAddress.toLowerCase() !== zeroAddress;
  const { data: customQuote, error: customQuoteError, isFetching: customQuoteLoading } = useQuery({
    queryKey: ["custom-quote", form.customAddress.toLowerCase()],
    queryFn: () => api<ResolvedQuote>(`/pairs/resolve/${form.customAddress}`),
    enabled: form.customPair && customAddressValid,
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
    args: [BigInt(form.configId), form.pairToken], query: { enabled: !form.customPair, refetchInterval: 15_000 },
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
  const pairUsd = form.customPair ? (customQuote?.usd ?? 0) : (chosenPair?.usd ?? 0);
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
    protocolFeeBps: 30,
    creatorFeeBps: 70,
    poolFee: 3000,
    tickSpacing: 60,
    enabled: true,
  } as const;
  // Only the chain's own currency travels with the transaction. Everything else is pulled from the
  // wallet, which is why an ERC-20 first buy needs an approval before the launch, below.
  const value = (launchFee as bigint | undefined ?? 0n) + (isNative ? firstBuyWei : 0n);

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
  const chosen = ((configs ?? []) as { result?: CurvePreset }[])[form.configId]?.result;
  // The trading fee. The protocol's 30 bps is not the creator's to move; everything above it is,
  // up to the 500 bps the factory refuses to go past. A preset carries its own, so leaving this
  // alone launches the preset exactly as it was published and pins its econ hash; moving it turns
  // the launch into a config of the creator's own, which is what launchCustom is for.
  const PROTOCOL_FEE_BPS = 30;
  const MAX_TOTAL_FEE_BPS = 500;
  const presetCreatorFeeBps = form.customPair ? customConfig.creatorFeeBps : (chosen ? Number(chosen.creatorFeeBps) : 70);
  const creatorFeeBps = form.feeBps ?? presetCreatorFeeBps;
  const totalFeeBps = PROTOCOL_FEE_BPS + creatorFeeBps;
  const feeMoved = form.feeBps !== null && form.feeBps !== presetCreatorFeeBps;
  // A preset whose fee the creator moved is still that preset in every other number, so the config
  // that goes on chain is the preset itself with one field replaced.
  const launchConfig = form.customPair
    ? { ...customConfig, creatorFeeBps }
    : chosen
      ? { ...chosen, creatorFeeBps, enabled: true }
      : null;
  const useCustomConfig = form.customPair || feeMoved;

  const tokenDone = form.name.length > 0 && form.symbol.length > 0 && symbolFree !== false;
  const splitTotal = form.stakers + form.buyback + form.liquidity + form.creator;
  // The address the creator leg pays. Empty means the wallet doing the launching, which is what it
  // silently did before; a team that wants the stream elsewhere says so here rather than
  // discovering later that it went to whichever key happened to sign.
  const recipient = form.feeRecipient.trim() || address || "";
  const recipientOk = !form.feeRecipient.trim() || isAddress(form.feeRecipient.trim());

  // One reason at a time, in the order somebody would hit them. A button that is off without saying
  // why is the single thing this page used to do worst.
  const blocked = !address ? "Connect a wallet first. It pays the fee and becomes the creator."
    : !form.name ? "Step 2 needs a name."
    : !form.symbol ? "Step 2 needs a ticker."
    : symbolFree === false ? "That ticker is locked by a launch that is trading right now."
    : form.customPair && !customAddressValid ? "Step 4 needs a valid Robinhood Chain ERC-20 address."
    : form.customPair && !customQuote ? (customQuoteLoading ? "Reading the custom token from Robinhood Chain." : "That custom token could not be verified.")
    : form.customPair && customQuote && !customQuote.compatible ? "This token has more than 18 decimals and the curve refuses it."
    : form.customPair && customGraduationCap <= customStartCap ? "The custom graduation valuation must be above its opening valuation."
    : form.customPair && customStartCap === 0n ? "The custom opening valuation must be above zero."
    : form.customPair && customQuote && !customQuote.liquiditySafe && !form.acceptThinLiquidity ? "Confirm that you understand this quote token has thin or unverified liquidity."
    : form.stakers > 0 && !canPayStakers ? "Step 3 cannot pay stakers yet: the pad's own coin has not been named on chain."
    : splitTotal !== 100 ? `Step 3 has to add up to 100%. It is at ${splitTotal}%.`
    : !recipientOk ? "Step 3 needs a valid address for the fee, or none at all."
    : form.creator > 0 && !recipient ? "Step 3 pays the creator leg to an address, and there is none."
    : totalFeeBps > MAX_TOTAL_FEE_BPS ? `Step 3 asks for a ${(totalFeeBps / 100).toFixed(2)}% fee; the factory refuses anything above 5%.`
    : useCustomConfig && !launchConfig ? "Step 4 has no preset to build the custom fee on."
    : form.firstBuyLock > 0 && firstBuyWei === 0n ? "Step 4 locks a first buy that is not being made."
    : undefined;

  const steps: StepState[] = [
    { n: 1, label: "How it launches", done: true },
    { n: 2, label: "The token", done: tokenDone },
    { n: 3, label: "Where the fee goes", done: true },
    { n: 4, label: "The curve", done: true },
  ];

  async function launch() {
    if (!address) return;
    const salt = `0x${Array.from(crypto.getRandomValues(new Uint8Array(32))).map((b) => b.toString(16).padStart(2, "0")).join("")}` as `0x${string}`;
    const launchData = useCustomConfig && launchConfig
      ? encodeFunctionData({ abi: hoodFactoryAbi, functionName: "launchCustom", args: [launchArgs(salt), launchConfig] })
      : encodeFunctionData({ abi: hoodFactoryAbi, functionName: "launch", args: [launchArgs(salt)] });
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
        address: addresses.factory, abi: hoodFactoryAbi, functionName: "launchCustom",
        args: [launchArgs(salt), launchConfig], value,
      }));
    } else {
      setHash(await writeContractAsync({
        address: addresses.factory, abi: hoodFactoryAbi, functionName: "launch",
        args: [launchArgs(salt)], value,
      }));
    }
  }

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
    } as const;
  }

  // No factory address means this build is not wired to the chain: a preview, or a box whose
  // contracts are not deployed yet. Say so, rather than showing a form whose button would write to
  // the zero address. The direct machine already says the same about its own portal.
  if (addresses.factory === zeroAddress) {
    return <p className="panel p-6 text-sm dim">The curve machine is not configured on this deployment.</p>;
  }

  return (
    <div className="launch-content">
      <div className="launch-guide">
        <Rail steps={steps} />
        <div className="launch-form-stack">
          {chooser}

          <Step n={2} title="The token" purpose="The name, the ticker and the picture people will see on the board. All of it is written on chain and none of it can be edited later." done={tokenDone}>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name" help="The full name, as it should read on the board.">
                <input className="input" value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Hood Fam" />
              </Field>
              <Field label="Ticker"
                error={form.symbol && symbolFree === false ? "Taken. A launch trading right now holds this ticker; it frees up when that one cools off." : undefined}
                ok={form.symbol && symbolFree === true ? "Available." : undefined}
                help="Letters and numbers, no dollar sign. We add that.">
                <input className="input mono uppercase" value={form.symbol}
                  onChange={(e) => set("symbol", e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} placeholder="FAM" />
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
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Website" help="Optional."><input className="input" value={form.website} onChange={(e) => set("website", e.target.value)} placeholder="https://" /></Field>
              <Field label="X" help="Optional."><input className="input" value={form.twitter} onChange={(e) => set("twitter", e.target.value)} placeholder="https://x.com/" /></Field>
              <Field label="Telegram" help="Optional."><input className="input" value={form.telegram} onChange={(e) => set("telegram", e.target.value)} placeholder="https://t.me/" /></Field>
            </div>
          </Step>

          <Step n={3} title="Where the trading fee goes" purpose="Every trade pays a fee. You decide once, here, how it is divided. This is the promise a buyer can check on chain, and nobody can change it afterwards, including us." done={splitTotal === 100 && recipientOk}>
            <div className="grid gap-3">
              {LEG_COPY.map((leg) => (
                <Slider key={leg.key}
                  label={`${leg.title} ${form[leg.key]}%`}
                  hint={leg.key === "stakers" && !canPayStakers
                    ? "Not yet: the pad's own coin has not been named on chain, so there is nobody locked to pay."
                    : leg.body}
                  min={0} max={leg.key === "stakers" && !canPayStakers ? 0 : 100} step={5}
                  value={form[leg.key]} onChange={(v) => set(leg.key, v)} />
              ))}
            </div>
            <p className={splitTotal === 100 ? "text-xs dim" : "text-xs text-[var(--color-red)]"}>
              {splitTotal === 100
                ? "Adds up to 100%. Every trade divides the creator's share exactly this way, forever."
                : `These have to add up to 100%. Right now they add up to ${splitTotal}%.`}
            </p>
            <Field label={`What a trade pays: ${(totalFeeBps / 100).toFixed(2)}%`}
              help={feeMoved
                ? "Your own fee, so this launch goes on chain as a config of its own rather than as the published preset."
                : "The preset's fee. Move it and this launch carries your number instead; the protocol's 0.30% is fixed and the factory refuses anything above 5% in total."}>
              <Slider label={`${(totalFeeBps / 100).toFixed(2)}% per trade, of which ${(creatorFeeBps / 100).toFixed(2)}% is yours to split`}
                hint="Traders see this before they buy. High fees are a choice a market can price."
                min={PROTOCOL_FEE_BPS} max={MAX_TOTAL_FEE_BPS} step={10}
                value={totalFeeBps}
                onChange={(v) => set("feeBps", Math.max(0, v - PROTOCOL_FEE_BPS))} />
              {feeMoved && (
                <button type="button" className="text-xs dim underline"
                  onClick={() => set("feeBps", null)}>Back to the preset's {(presetCreatorFeeBps + PROTOCOL_FEE_BPS) / 100}%</button>
              )}
            </Field>
            {form.creator > 0 && (
              <Field label="Who the creator share pays"
                help="Leave it empty and it pays the wallet doing this launch. A team usually wants its own Safe here. Only that address can hand the stream on later."
                error={recipientOk ? undefined : "That is not an address."}>
                <input className="input mono" placeholder={address ?? "0x..."} value={form.feeRecipient}
                  onChange={(e) => set("feeRecipient", e.target.value.trim())} />
              </Field>
            )}
          </Step>

          <Step n={4} title="What it trades against, and the curve" purpose="Every trade is priced in this, the raise is held in it, and the fee reaches you in it. Then how much supply trades on the curve, and whether you want the first buy in the same transaction." done>
            <div className="grid gap-2 sm:grid-cols-2">
              <Choice selected={!form.customPair} onClick={() => {
                set("customPair", false); set("pairToken", (pairs[0]?.address as Address | undefined) ?? zeroAddress); set("firstBuy", "");
              }} title="Curated pairs" body="ETH, USDG and the liquid assets already reviewed by the pad." meta="standard" />
              <Choice selected={form.customPair} onClick={() => { set("customPair", true); set("firstBuy", ""); }}
                title="Paste any coin" body="Launch against any compatible Robinhood Chain ERC-20, including an existing meme coin." meta="meme-to-meme" />
            </div>

            {!form.customPair ? <>
              <PairChooser pairs={pairs} value={form.pairToken}
                onPick={(address: Address) => { set("pairToken", address); set("firstBuy", ""); set("configId", 0); }} />
              <div className="grid gap-2">
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
              </div>
              {presetsForPair === 0 && <p className="text-xs text-[var(--color-red)]">No preset is denominated in {pair} yet. Pick another pair.</p>}
            </> : <>
              <Field label="Robinhood Chain token address"
                help="Paste the parent coin's ERC-20 address. Metadata and available USDG liquidity are read directly from chain."
                error={form.customAddress && (!customAddressValid || customQuoteError) ? "This address could not be resolved as a compatible ERC-20." : undefined}>
                <input className="input mono" value={form.customAddress}
                  onChange={(e) => { set("customAddress", e.target.value.trim()); set("acceptThinLiquidity", false); }} placeholder="0x..." />
              </Field>
              {customQuoteLoading && <p className="text-xs dim">Reading token metadata and checking its USDG pools…</p>}
              {customQuote && <div className="panel p-4 text-xs">
                <div className="flex items-center justify-between gap-3">
                  <strong>{customQuote.name} · ${customQuote.symbol}</strong>
                  <span className={customQuote.liquiditySafe ? "text-[var(--color-lime)]" : "text-[var(--color-red)]"}>
                    {customQuote.liquiditySafe ? `$${Math.round(customQuote.depthUsd).toLocaleString()} verified depth` : "thin / unverified liquidity"}
                  </span>
                </div>
                <p className="mt-2 dim">{customQuote.decimals} decimals · ERC-20 verified{customQuote.pool ? ` · Uniswap v3 ${customQuote.pool.fee / 10_000}% pool found` : ""}</p>
                {customQuote.warnings.map((warning) => <p key={warning} className="mt-1 dim">⚠ {warning}</p>)}
              </div>}
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

            {(form.customPair ? Boolean(customQuote && customGraduationCap > customStartCap) : Boolean(chosen)) && (
              <CurveSim
                p0={((form.customPair ? customStartCap : chosen!.startCap) * 10n ** 18n) / (form.customPair ? CUSTOM_SUPPLY : chosen!.totalSupply)}
                p1={((form.customPair ? customGraduationCap : chosen!.graduationCap) * 10n ** 18n) / (form.customPair ? CUSTOM_SUPPLY : chosen!.totalSupply)}
                curveSupply={((form.customPair ? CUSTOM_SUPPLY : chosen!.totalSupply) * BigInt(form.customPair ? 8000 : chosen!.curveSupplyBps)) / 10_000n}
                totalSupply={form.customPair ? CUSTOM_SUPPLY : chosen!.totalSupply}
                dec={pairDec}
                sym={pair}
                feeBps={form.customPair ? 100 : chosen!.protocolFeeBps + chosen!.creatorFeeBps}
                ticker={form.symbol}
              />
            )}

            <Field label={`Your first buy in ${pair}`}
              help={isNative
                ? "Optional, and it lands inside the launch transaction, so nobody can get in ahead of you. Leave it empty to launch without buying."
                : `Optional, and it lands inside the launch transaction, so nobody can get in ahead of you. Paid in ${pair} out of your wallet, which means one approval first unless you are signing from a Safe.`}>
              <input className="input mono" inputMode="decimal" value={form.firstBuy}
                onChange={(e) => set("firstBuy", e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0.0" />
            </Field>

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
          </Step>

          <LaunchBar
            cost={`${fmt((launchFee as bigint | undefined) ?? 0n, 18, 6)} ETH`}
            costLabel={form.firstBuy
              ? `launch fee, plus your ${form.firstBuy} ${pair} first buy${isNative ? "" : `, taken from your wallet in ${pair}`}`
              : "launch fee, plus gas"}
            blocked={blocked}
            busy={isPending || receipt.isLoading}
            busyLabel={receipt.isLoading ? "waiting for the chain" : "confirm in your wallet"}
            label={needsApproval ? `Approve ${pair}` : "Create the token"}
            onClick={launch}
          />
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
          <Row label="Fee split" value={LEG_COPY.filter((l) => form[l.key] > 0).map((l) => `${form[l.key]}% ${l.title.toLowerCase()}`).join(", ") || "not set"} />
          {form.creator > 0 && <Row label="Creator share pays" value={recipient ? `${recipient.slice(0, 6)}…${recipient.slice(-4)}` : "nobody yet"} />}
          {form.firstBuyLock > 0 && <Row label="Your first buy" value={`locked ${LOCKS.find((l) => l.seconds === form.firstBuyLock)?.label ?? ""}`} />}
          <Row label="Launch fee" value={`${fmt((launchFee as bigint | undefined) ?? 0n, 18, 6)} ETH`} />
          <Row label="Terms pinned" value={econ ? `${(econ as string).slice(0, 10)}…` : "reading"} />
        </div>
        <WhatHappens items={[
          "Your wallet sends one transaction and pays the launch fee.",
          "The token, its curve and its fee split are created together.",
          "The terms above are sent with it, so if the preset moves first the transaction reverts instead of launching on terms you did not agree to.",
          "You land on the token page and it is tradable immediately.",
        ]} />
      </aside>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between"><span className="dim">{label}</span><span className="mono">{value}</span></div>;
}
