"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { erc20Abi, formatUnits, getAbiItem, getAddress, isAddress, keccak256, parseUnits, stringToHex, toFunctionSelector, zeroAddress, type Address } from "viem";
import { useAccount, usePublicClient, useReadContract, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { useQuery } from "@tanstack/react-query";
import { directTicks, hoodPortalAbi, hoodDirectDeployerAbi, mineFreeHookSalt, predictDirectToken, uniswapV4 } from "@hood/sdk";
import { directAddresses } from "@/lib/config";
import { api, type PairRow } from "@/lib/api";
import { pairDecimals, pairSymbol, shortAddress } from "@/lib/format";
import { Artwork } from "@/components/Artwork";
import { ArtworkPicker } from "@/components/ArtworkPicker";
import { Choice, Field, LaunchBar, PairChooser, Rail, Slider, Step, WhatHappens, type StepState } from "@/components/LaunchUI";
import { DirectSim } from "@/components/Sim";
import { brand } from "@/brands";

const SUPPLY = 1_000_000_000;
const SPACING = 200;
const FEE_PRESETS = [
  { id: "low", title: "Low fees", detail: "1% buy · 1% sell · no opening surcharge", values: { buyTax: 1, sellTax: 1, snipeTax: 0, snipeSeconds: 0 } },
  { id: "standard", title: "Standard", detail: "5% buy · 5% sell · no opening surcharge", values: { buyTax: 5, sellTax: 5, snipeTax: 0, snipeSeconds: 0 } },
  { id: "protected", title: "Protected opening", detail: "5% buy · 5% sell · extra 50% fades over 3 seconds", values: { buyTax: 5, sellTax: 5, snipeTax: 50, snipeSeconds: 3 } },
] as const;
const SPLIT_PRESETS = [
  { id: "balanced", title: "Balanced", detail: "Creator 25% · burn 25% · holders 40% · liquidity 10%", values: { creatorBps: 25, buybackBps: 25, dividendsBps: 40, liquidityBps: 10 } },
  { id: "creator", title: "Creator income", detail: "Creator 50% · burn 10% · holders 30% · liquidity 10%", values: { creatorBps: 50, buybackBps: 10, dividendsBps: 30, liquidityBps: 10 } },
  { id: "holders", title: "Holder rewards", detail: "Creator 10% · burn 15% · holders 65% · liquidity 10%", values: { creatorBps: 10, buybackBps: 15, dividendsBps: 65, liquidityBps: 10 } },
  { id: "burn", title: "Buyback focus", detail: "Creator 10% · burn 60% · holders 20% · liquidity 10%", values: { creatorBps: 10, buybackBps: 60, dividendsBps: 20, liquidityBps: 10 } },
] as const;
const OPENING_PRESETS = [
  { id: "open", title: "Open from block one", detail: "No temporary wallet limits", values: { restrictionBlocks: 0, maxHold: 20, maxBuy: 20 } },
  { id: "guarded", title: "Short guardrail", detail: "For 30 blocks: 5% per wallet, 5.5% per buy", values: { restrictionBlocks: 30, maxHold: 5, maxBuy: 5.5 } },
] as const;

// A Portal deployed before creatorFeeRecipient existed still serves the rest of the direct-launch
// machine. Derive its ABI from the generated current one instead of keeping a second hand-written
// tuple that can drift. The runtime selector check below chooses exactly what the deployed bytecode
// supports, so publishing the web app never bricks launch while an on-chain upgrade is pending.
const createLaunchItem = getAbiItem({ abi: hoodPortalAbi, name: "createLaunch" });
const currentCreateLaunchSelector = toFunctionSelector(createLaunchItem);
const legacyPortalAbi = hoodPortalAbi.map((item) => {
  if (item.type !== "function" || item.name !== "createLaunch") return item;
  const [launch, salt] = item.inputs;
  if (!launch || launch.type !== "tuple" || !("components" in launch)) return item;
  return { ...item, inputs: [{ ...launch, components: launch.components.filter((component) => component.name !== "creatorFeeRecipient") }, salt] };
}) as unknown as typeof hoodPortalAbi;

/// The other machine. A creator here is not choosing a curve, they are choosing a price to open at,
/// a price to bond at, what the trade costs, and who that cost pays.
export function DirectLaunchForm({ chooser }: { chooser: React.ReactNode }) {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const router = useRouter();
  const { writeContractAsync, isPending } = useWriteContract();
  const [hash, setHash] = useState<`0x${string}` | undefined>();
  const receipt = useWaitForTransactionReceipt({ hash });
  const [mining, setMining] = useState(false);
  const [error, setError] = useState<string>();

  const [form, setForm] = useState({
    name: "", symbol: "", logo: "", description: "",
    twitter: "", telegram: "", discord: "", website: "", farcaster: "",
    quote: zeroAddress as Address,
    openFdv: "10", bondFdv: "100",
    buyTax: 5, sellTax: 5, snipeTax: 50, snipeSeconds: 3,
    restrictionBlocks: 30, maxHold: 5, maxBuy: 5.5,
    creatorBps: 25, buybackBps: 25, dividendsBps: 40, liquidityBps: 10,
    feeRecipient: "",
    firstBuy: "",
  });
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  const { data: launchFee } = useReadContract({
    address: directAddresses.portal, abi: hoodPortalAbi, functionName: "launchFee",
    query: { enabled: Boolean(directAddresses.portal) },
  });
  const { data: initCodeHash } = useReadContract({
    address: directAddresses.deployer, abi: hoodDirectDeployerAbi, functionName: "hookInitCodeHash",
    args: [uniswapV4.poolManager as `0x${string}`],
    query: { enabled: Boolean(directAddresses.deployer) },
  });
  const portalGeneration = useQuery({
    queryKey: ["portal-fee-recipient", directAddresses.portal],
    queryFn: async () => {
      const code = await publicClient!.getCode({ address: directAddresses.portal! });
      return Boolean(code?.toLowerCase().includes(currentCreateLaunchSelector.slice(2).toLowerCase()));
    },
    enabled: Boolean(publicClient && directAddresses.portal),
    staleTime: Infinity,
  });
  const supportsFeeRecipient = portalGeneration.data === true;

  // What this pad takes as a quote, from the same list the curve machine reads.
  const { data: pairData } = useQuery({
    queryKey: ["pairs"],
    queryFn: () => api<{ pairs: PairRow[] }>("/pairs"),
    staleTime: 60_000,
  });
  const pairs = pairData?.pairs ?? [];
  const quote = pairs.find((p) => p.address.toLowerCase() === form.quote.toLowerCase());
  const quoteDec = quote?.decimals ?? pairDecimals(form.quote);
  const quoteSym = quote?.symbol ?? pairSymbol(form.quote);
  const isNative = form.quote === zeroAddress;

  // The salt is fixed the moment this form is opened rather than at the press, because the token's
  // address decides which side of the pool it sorts into, and that decides the direction of both
  // ticks. Predicting it is the only way to compute them before the launch exists.
  const [salt] = useState<`0x${string}`>(() => keccak256(stringToHex(`hood:${Date.now()}:${Math.random()}`)));
  const { data: tokenImplementation } = useReadContract({
    address: directAddresses.portal, abi: hoodPortalAbi, functionName: "tokenImplementation",
    query: { enabled: Boolean(directAddresses.portal) },
  });
  const predictedToken = useMemo(() => {
    if (!address || !directAddresses.deployer || !tokenImplementation) return undefined;
    return predictDirectToken({
      deployer: directAddresses.deployer,
      implementation: tokenImplementation as Address,
      creator: address,
      salt,
    });
  }, [address, tokenImplementation, salt]);

  const ticks = useMemo(() => {
    const open = Number(form.openFdv) || 10;
    const bond = Number(form.bondFdv) || 100;
    const tokenIsZero = predictedToken ? predictedToken.toLowerCase() < form.quote.toLowerCase() : false;
    return directTicks({ openFdv: open, bondFdv: bond, supply: SUPPLY, quoteDecimals: quoteDec, tokenIsZero, tickSpacing: SPACING });
  }, [form.openFdv, form.bondFdv, form.quote, quoteDec, predictedToken]);

  /// What a tick means back in the creator's own units, undoing exactly what `directTicks` did.
  const landedFdv = (tick: number) => {
    const tokenIsZero = predictedToken ? predictedToken.toLowerCase() < form.quote.toLowerCase() : false;
    const raw = Math.pow(1.0001, tick);
    const tokensPerQuote = tokenIsZero ? 1 / raw : raw;
    return (SUPPLY * 10 ** 18) / (tokensPerQuote * 10 ** quoteDec);
  };

  const allocationSum = form.creatorBps + form.buybackBps + form.dividendsBps + form.liquidityBps;
  const feePreset = FEE_PRESETS.find((preset) => Object.entries(preset.values).every(([key, value]) => form[key as keyof typeof form] === value))?.id;
  const splitPreset = SPLIT_PRESETS.find((preset) => Object.entries(preset.values).every(([key, value]) => form[key as keyof typeof form] === value))?.id;
  const openingPreset = OPENING_PRESETS.find((preset) => Object.entries(preset.values).every(([key, value]) => form[key as keyof typeof form] === value))?.id;
  const taxValid = form.buyTax + form.snipeTax <= 99 && form.sellTax + form.snipeTax <= 99 && (form.snipeTax === 0 || form.snipeSeconds > 0);
  const windowValid = form.restrictionBlocks === 0 || (form.maxBuy <= form.maxHold * 1.1 && form.maxHold > 0 && form.maxBuy > 0);
  const ready = Boolean(address && directAddresses.portal && initCodeHash)
    && form.name.length > 0 && form.symbol.length > 0
    && allocationSum === 100 && taxValid && windowValid
    && (!supportsFeeRecipient || form.creatorBps === 0 || form.feeRecipient === "" || isAddress(form.feeRecipient))
    && Number(form.bondFdv) > Number(form.openFdv);

  useEffect(() => {
    if (receipt.isSuccess && receipt.data) {
      const log = receipt.data.logs.find(
        (l) => l.address.toLowerCase() === directAddresses.portal?.toLowerCase() && l.topics.length >= 4,
      );
      if (log) router.push(`/token/0x${log.topics[1]!.slice(26)}`);
    }
  }, [receipt.isSuccess, receipt.data, router]);

  async function launch() {
    if (!address || !directAddresses.portal || !initCodeHash) return;
    setError(undefined);
    setMining(true);
    try {
      // The hook's permissions live in its address, so the salt has to be mined for it. The salt
      // is bound to this wallet on chain, so only this wallet's own earlier launches can collide,
      // and the miner skips those.
      const { salt: hookSalt } = await mineFreeHookSalt(publicClient as never, directAddresses.deployer!, initCodeHash as `0x${string}`, address);
      setMining(false);

      const baseParams = {
        name: form.name,
        symbol: form.symbol,
        logo: form.logo,
        description: form.description,
        socials: {
          twitter: form.twitter, telegram: form.telegram, discord: form.discord,
          website: form.website, farcaster: form.farcaster,
        },
        quote: form.quote,
        supply: parseUnits(String(SUPPLY), 18),
        poolFee: 10_000,
        tickSpacing: SPACING,
        config: {
          buyTaxBps: Math.round(form.buyTax * 100),
          sellTaxBps: Math.round(form.sellTax * 100),
          snipeTaxBps: Math.round(form.snipeTax * 100),
          snipeDecaySeconds: form.snipeSeconds,
          restrictionBlocks: form.restrictionBlocks,
          maxHoldBps: Math.round(form.maxHold * 100),
          maxBuyBps: Math.round(form.maxBuy * 100),
          tickStart: ticks.tickStart,
          tickBond: ticks.tickBond,
          allocations: {
            creatorBps: form.creatorBps * 100,
            buybackBps: form.buybackBps * 100,
            dividendsBps: form.dividendsBps * 100,
            liquidityBps: form.liquidityBps * 100,
          },
        },
        salt,
        initialBuy: form.firstBuy ? parseUnits(form.firstBuy, quoteDec) : 0n,
      };
      const params = supportsFeeRecipient
        ? { ...baseParams, creatorFeeRecipient: form.feeRecipient ? getAddress(form.feeRecipient) : address }
        : baseParams;

      // Only the chain's own currency travels with the transaction; anything else is pulled, and
      // the portal needs an allowance before it can pull it.
      if (!isNative && params.initialBuy > 0n) {
        const allowance = await publicClient!.readContract({
          address: form.quote, abi: erc20Abi, functionName: "allowance", args: [address, directAddresses.portal],
        }) as bigint;
        if (allowance < params.initialBuy) {
          setHash(await writeContractAsync({
            address: form.quote, abi: erc20Abi, functionName: "approve", args: [directAddresses.portal, params.initialBuy],
          }));
          return;
        }
      }

      setHash(await writeContractAsync({
        address: directAddresses.portal, abi: (supportsFeeRecipient ? hoodPortalAbi : legacyPortalAbi) as never, functionName: "createLaunch",
        args: [params, hookSalt] as never, value: ((launchFee as bigint | undefined) ?? 0n) + (isNative ? params.initialBuy : 0n),
      }));
    } catch (e) {
      setMining(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (!directAddresses.portal) {
    return <p className="panel p-6 text-sm dim">Direct launches are not configured on this deployment.</p>;
  }

  const tokenDone = form.name.length > 0 && form.symbol.length > 0;
  const priceDone = Number(form.bondFdv) > Number(form.openFdv);
  const splitDone = allocationSum === 100;
  const fee = (launchFee as bigint | undefined) ?? 0n;
  // The fee is in the chain's own currency whatever the launch is quoted in, so the bar shows it
  // alone and says what the first buy costs beside it, in the quote.
  const firstBuyUnits = form.firstBuy ? parseUnits(form.firstBuy, quoteDec) : 0n;
  const { data: quoteAllowance } = useReadContract({
    address: form.quote, abi: erc20Abi, functionName: "allowance",
    args: [address ?? zeroAddress, directAddresses.portal ?? zeroAddress],
    query: { enabled: !isNative && firstBuyUnits > 0n && Boolean(address && directAddresses.portal) },
  });
  const needsQuoteApproval = !isNative && firstBuyUnits > 0n
    && ((quoteAllowance as bigint | undefined) ?? 0n) < firstBuyUnits;

  // One reason at a time, in the order somebody would hit them.
  const blocked = !address ? "Connect a wallet first. It pays the fee and becomes the creator."
    : !form.name ? "Step 2 needs a name."
    : !form.symbol ? "Step 2 needs a ticker."
    : !priceDone ? "Step 3: the bonding valuation has to be above the opening one."
    : !taxValid ? "Step 4: the opening surcharge plus the buy or sell tax must stay at or below 99%, and a surcharge needs a duration."
    : !splitDone ? `Step 5: the four shares add up to ${allocationSum}%. They have to make 100.`
    : !windowValid ? "Step 6: a single-buy cap cannot exceed 110% of the wallet holding cap."
    : supportsFeeRecipient && form.creatorBps > 0 && form.feeRecipient !== "" && !isAddress(form.feeRecipient) ? "Step 5 needs a valid creator fee recipient."
    : portalGeneration.isLoading ? "Checking the launch contract version."
    : !initCodeHash ? "Still reading the deployer. One moment."
    : undefined;

  const steps: StepState[] = [
    { n: 1, label: "How it launches", done: true },
    { n: 2, label: "The token", done: tokenDone },
    { n: 3, label: "The price", done: priceDone },
    { n: 4, label: "Trading fees", done: taxValid },
    { n: 5, label: "The split", done: splitDone },
    { n: 6, label: "Opening limits", done: windowValid },
  ];

  return (
    <div className="launch-content">
      <div className="launch-guide">
        <Rail steps={steps} />
        <div className="launch-form-stack">
          {chooser}

          <Step n={2} title="The token" purpose="The name, the ticker and the picture people will see on the board. All of it is written on chain and none of it can be edited later." done={tokenDone}>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name" help="The full name, as it should read on the board.">
                <input className="input" value={form.name} onChange={(e) => set("name", e.target.value)} placeholder={brand.id === "ox" ? "Your token" : "Hood Fam"} />
              </Field>
              <Field label="Ticker" help="Letters and numbers, no dollar sign. We add that.">
                <input className="input mono uppercase" value={form.symbol}
                  onChange={(e) => set("symbol", e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} placeholder={brand.id === "ox" ? "TOKEN" : "FAM"} />
              </Field>
            </div>
            <Field label="Description" help="One or two lines. It shows on the token page and in the share card.">
              <textarea className="input min-h-16" value={form.description} onChange={(e) => set("description", e.target.value)} />
            </Field>
            {/* not a Field: that is a <label>, and a label wrapping the picker's own buttons would
                fire the file dialog on every click inside the box. */}
            <div>
              <span className="field-label">Picture</span>
              <ArtworkPicker value={form.logo} onChange={(v) => set("logo", v)} symbol={form.symbol} />
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="X" help="Optional."><input className="input" value={form.twitter} onChange={(e) => set("twitter", e.target.value)} placeholder="https://x.com/" /></Field>
              <Field label="Telegram" help="Optional."><input className="input" value={form.telegram} onChange={(e) => set("telegram", e.target.value)} placeholder="https://t.me/" /></Field>
              <Field label="Discord" help="Optional."><input className="input" value={form.discord} onChange={(e) => set("discord", e.target.value)} placeholder="https://discord.gg/" /></Field>
              <Field label="Website" help="Optional."><input className="input" value={form.website} onChange={(e) => set("website", e.target.value)} placeholder="https://" /></Field>
              <Field label="Farcaster" help="Optional."><input className="input" value={form.farcaster} onChange={(e) => set("farcaster", e.target.value)} placeholder="https://warpcast.com/" /></Field>
            </div>
          </Step>

          <Step n={3} title="What it trades against, and the price it opens at" purpose="Every trade is priced in this, the tax is taken in it, and your share arrives in it. Then the whole supply goes into one position above the opening price: buys walk it up, and when it reaches the bonding valuation the launch is bonded. No migration afterwards, the liquidity has been real and locked the whole time." done={priceDone}>
            <PairChooser pairs={pairs} value={form.quote}
              onPick={(address: Address) => { set("quote", address); set("firstBuy", ""); }} />

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Opens at" help={`Valuation of the whole supply, in ${quoteSym}, at the first trade.`}>
                <input className="input mono" value={form.openFdv}
                  onChange={(e) => set("openFdv", e.target.value.replace(/[^0-9.]/g, ""))} />
              </Field>
              <Field label="Bonds at"
                error={priceDone ? undefined : "This has to be above the opening valuation."}
                help="Valuation at which the launch is considered bonded.">
                <input className="input mono" value={form.bondFdv}
                  onChange={(e) => set("bondFdv", e.target.value.replace(/[^0-9.]/g, ""))} />
              </Field>
            </div>
            <p className="field-note mono">
              Uniswap prices in ticks, so the numbers land on the nearest one: open{" "}
              {landedFdv(ticks.tickStart).toFixed(landedFdv(ticks.tickStart) < 100 ? 3 : 0)} {quoteSym},
              bond {landedFdv(ticks.tickBond).toFixed(landedFdv(ticks.tickBond) < 100 ? 3 : 0)} {quoteSym}{" "}
              {predictedToken ? ` (ticks ${ticks.tickStart} to ${ticks.tickBond}).` : "."}
              {quote && quote.usd > 0 && ` About $${Math.round(landedFdv(ticks.tickStart) * quote.usd).toLocaleString()} at the open.`}
              {!predictedToken && !isNative && " Which side of the pool your token sorts into is decided by its address, so the exact ticks appear once a wallet is connected."}
            </p>
          </Step>

          <Step n={4} title="Trading fees" purpose={`Choose what each trade pays in ${quoteSym}. These rates are permanent after launch; the opening surcharge, if any, expires automatically.`} done={taxValid}>
            <div className="direct-preset-grid direct-preset-grid-three" role="group" aria-label="Trading fee preset">
              {FEE_PRESETS.map((preset) => (
                <button key={preset.id} type="button" className={feePreset === preset.id ? "direct-preset selected" : "direct-preset"}
                  aria-pressed={feePreset === preset.id} onClick={() => setForm((current) => ({ ...current, ...preset.values }))}>
                  <strong>{preset.title}</strong><span>{preset.detail}</span>
                </button>
              ))}
            </div>
            <div className={taxValid ? "direct-impact" : "direct-impact invalid"} role="status">
              <strong>{taxValid ? `${form.buyTax}% buy · ${form.sellTax}% sell` : "Check these fee rates"}</strong>
              <span>{form.snipeTax > 0
                ? `At launch, a buy starts at ${form.buyTax + form.snipeTax}% total tax, then falls to ${form.buyTax}% over ${form.snipeSeconds} seconds.`
                : "No extra opening surcharge. The same rates apply from the first trade."}</span>
              {!taxValid && <span>Keep the opening total at or below 99%, with a duration greater than zero.</span>}
            </div>
            <details className="direct-advanced">
              <summary>Customize fee rates <span>Optional</span></summary>
              <div className="grid gap-4 sm:grid-cols-2">
                <Slider label={`Buy tax ${form.buyTax}%`} hint="1–10% on every buy." min={1} max={10} step={0.5} value={form.buyTax} onChange={(v) => set("buyTax", v)} />
                <Slider label={`Sell tax ${form.sellTax}%`} hint="1–10% on every sell." min={1} max={10} step={0.5} value={form.sellTax} onChange={(v) => set("sellTax", v)} />
                <Slider label={`Extra opening tax ${form.snipeTax}%`} hint="Added to the buy tax at launch, then fades to zero." min={0} max={89} step={1} value={form.snipeTax} onChange={(v) => set("snipeTax", v)} />
                <Slider label={`Fades over ${form.snipeSeconds}s`} hint="Use 0 only when the extra opening tax is 0%." min={0} max={30} step={1} value={form.snipeSeconds} onChange={(v) => set("snipeSeconds", v)} />
              </div>
              {!taxValid && <p className="field-note bad">The opening total cannot exceed 99%, and an opening tax needs a duration.</p>}
            </details>
            <DirectSim buyTax={form.buyTax} sellTax={form.sellTax} snipeTax={form.snipeTax} snipeSeconds={form.snipeSeconds}
              openFdv={Number(form.openFdv)} bondFdv={Number(form.bondFdv)} quoteSymbol={quoteSym} />
          </Step>

          <Step n={5} title="Who receives the fees" purpose="The protocol keeps 10% of collected trading tax. Choose how the other 90% is shared. Your choice is permanent." done={splitDone}>
            <div className="direct-preset-grid" role="group" aria-label="Fee distribution preset">
              {SPLIT_PRESETS.map((preset) => (
                <button key={preset.id} type="button" className={splitPreset === preset.id ? "direct-preset selected" : "direct-preset"}
                  aria-pressed={splitPreset === preset.id} onClick={() => setForm((current) => ({ ...current, ...preset.values }))}>
                  <strong>{preset.title}</strong><span>{preset.detail}</span>
                </button>
              ))}
            </div>
            <div className={splitDone ? "direct-impact" : "direct-impact invalid"} role="status">
              <strong>{splitDone ? "Where the distributable 90% goes" : `Shares total ${allocationSum}% — make them 100%`}</strong>
              <span>Creator {form.creatorBps}% · buyback &amp; burn {form.buybackBps}% · holders {form.dividendsBps}% · locked liquidity {form.liquidityBps}%</span>
            </div>
            <details className="direct-advanced">
              <summary>Make a custom split <span>Optional</span></summary>
              <p className="field-note">These four numbers must add up to 100%. They divide the 90% left after the protocol share.</p>
              <div className="grid gap-4 sm:grid-cols-2">
                <Slider label={`Creator ${form.creatorBps}%`} hint="Claimable by the fee recipient below." min={0} max={100} step={5} value={form.creatorBps} onChange={(v) => set("creatorBps", v)} />
                <Slider label={`Buyback & burn ${form.buybackBps}%`} hint="Used to buy and destroy tokens." min={0} max={100} step={5} value={form.buybackBps} onChange={(v) => set("buybackBps", v)} />
                <Slider label={`Holders ${form.dividendsBps}%`} hint={`Distributed to eligible holders in ${quoteSym}.`} min={0} max={100} step={5} value={form.dividendsBps} onChange={(v) => set("dividendsBps", v)} />
                <Slider label={`Liquidity ${form.liquidityBps}%`} hint="Reinvested into the locked pool." min={0} max={100} step={5} value={form.liquidityBps} onChange={(v) => set("liquidityBps", v)} />
              </div>
              <p className={splitDone ? "field-note good" : "field-note bad"}>
                {splitDone ? "Total: 100% — ready to launch." : `Total: ${allocationSum}%. Adjust the shares until they total 100%.`}
              </p>
            </details>
            {supportsFeeRecipient && form.creatorBps > 0 ? (
              <Field label="Creator fee recipient"
                error={form.feeRecipient && !isAddress(form.feeRecipient) ? "Paste a valid 0x address." : undefined}
                help="Optional. The creator share is claimable only by this address. Leave blank to use your connected wallet.">
                <input className="input mono" value={form.feeRecipient}
                  onChange={(e) => set("feeRecipient", e.target.value.trim())} placeholder={address ?? "0x…"} />
              </Field>
            ) : null}
          </Step>

          <Step n={6} title="Opening limits and first buy" purpose="Choose whether temporary wallet caps apply at launch. Selling is never restricted; any caps expire automatically." done={windowValid}>
            <div className="direct-preset-grid direct-preset-grid-two" role="group" aria-label="Opening limit preset">
              {OPENING_PRESETS.map((preset) => (
                <button key={preset.id} type="button" className={openingPreset === preset.id ? "direct-preset selected" : "direct-preset"}
                  aria-pressed={openingPreset === preset.id} onClick={() => setForm((current) => ({ ...current, ...preset.values }))}>
                  <strong>{preset.title}</strong><span>{preset.detail}</span>
                </button>
              ))}
            </div>
            <div className={windowValid ? "direct-impact" : "direct-impact invalid"} role="status">
              <strong>{windowValid ? (form.restrictionBlocks === 0 ? "No opening limits" : `Limits end after ${form.restrictionBlocks} blocks`) : "Opening caps need adjustment"}</strong>
              <span>{form.restrictionBlocks === 0 ? "Anyone can buy or hold any amount from the start." : `Until then, one wallet can hold up to ${form.maxHold}% of supply and buy up to ${form.maxBuy}% in one transaction.`}</span>
              {!windowValid && <span>One buy cannot exceed 110% of the wallet holding cap.</span>}
            </div>
            <details className="direct-advanced">
              <summary>Customize opening limits <span>Optional</span></summary>
              <div className="grid gap-4 sm:grid-cols-3">
                <Slider label={`Limits last ${form.restrictionBlocks} blocks`} hint="0 disables wallet caps." min={0} max={200} step={10} value={form.restrictionBlocks} onChange={(v) => set("restrictionBlocks", v)} />
                <Slider label={`Wallet holds at most ${form.maxHold}%`} hint="Of supply, while limits last." min={0.5} max={20} step={0.5} value={Math.min(form.maxHold, 20)} onChange={(v) => set("maxHold", v)} />
                <Slider label={`One buy at most ${form.maxBuy}%`} hint="Cannot exceed 110% of the wallet cap." min={0.5} max={20} step={0.5} value={Math.min(form.maxBuy, 20)} onChange={(v) => set("maxBuy", v)} />
              </div>
              {!windowValid && <p className="field-note bad">Lower the single-buy cap to at most 110% of the wallet cap.</p>}
            </details>
            <Field label={`Your first buy in ${quoteSym}`}
              help={`Optional, and it lands inside the launch transaction, before anyone else can trade. The buy cap above applies to it too: first dibs, not the whole open.${
                isNative ? "" : ` Paid in ${quoteSym} out of your wallet, so it takes one approval first.`
              }`}>
              <input className="input mono" inputMode="decimal" value={form.firstBuy}
                onChange={(e) => set("firstBuy", e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0.0" />
            </Field>
          </Step>

          {error && <p className="panel p-3 text-xs text-[var(--color-red)]">{error}</p>}

          <LaunchBar
            cost={`${formatUnits(fee, 18)} ETH`}
            costLabel={form.firstBuy
              ? `launch fee, plus your ${form.firstBuy} ${quoteSym} first buy${isNative ? "" : `, pulled from your wallet in ${quoteSym}`}`
              : "launch fee, plus gas"}
            blocked={blocked}
            busy={mining || isPending || receipt.isLoading}
            busyLabel={mining ? "mining the hook address" : receipt.isLoading ? "waiting for the chain" : "confirm in your wallet"}
            label={needsQuoteApproval ? `Approve ${quoteSym}` : "Create the token"}
            onClick={launch}
          />
        </div>
      </div>

      <aside className="launch-preview">
        <div className="launch-preview-label">Live preview</div>
        <div className="launch-preview-art"><Artwork src={form.logo} symbol={form.symbol || "?"} size={88} rounded="rounded-xl" /></div>
        <h2>{form.name || "Your token"}</h2>
        <p className="launch-preview-symbol">$<span>{form.symbol || "TICKER"}</span></p>
        <div className="launch-preview-details">
          <div className="flex justify-between"><span className="dim">Launch model</span><span className="mono">Direct pool</span></div>
          <div className="flex justify-between"><span className="dim">Quoted in</span><span className="mono">{quoteSym}</span></div>
          <div className="flex justify-between"><span className="dim">Opens at</span><span className="mono">{form.openFdv || "0"} {quoteSym}</span></div>
          <div className="flex justify-between"><span className="dim">Buy / sell tax</span><span className="mono">{form.buyTax}% / {form.sellTax}%</span></div>
          <div className="flex justify-between"><span className="dim">Creator fees to</span><span className="mono">{shortAddress(supportsFeeRecipient ? (form.feeRecipient || address || zeroAddress) : (address || zeroAddress))}</span></div>
          <div className="flex justify-between"><span className="dim">Launch fee</span><span className="mono">{formatUnits(fee, 18)} ETH</span></div>
        </div>
        <WhatHappens items={[
          "We mine an address for your hook, which takes a few seconds and costs nothing.",
          "Your wallet sends one transaction and pays the launch fee.",
          "The token, its pool, its hook and its splitter are created together, and the supply goes straight into a locked position.",
          "You land on the token page and it is tradable in the same block.",
        ]} />
      </aside>
    </div>
  );
}
