"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { erc20Abi, formatUnits, getAddress, isAddress, keccak256, parseUnits, stringToHex, zeroAddress, type Address } from "viem";
import { useAccount, usePublicClient, useReadContract, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { useQuery } from "@tanstack/react-query";
import { directTicks, hoodPortalAbi, hoodDirectDeployerAbi, mineFreeHookSalt, predictDirectToken, uniswapV4 } from "@hood/sdk";
import { directAddresses } from "@/lib/config";
import { api, type PairRow } from "@/lib/api";
import { pairDecimals, pairSymbol, shortAddress } from "@/lib/format";
import { detectPortalGeneration, portalTakesExempt, portalTakesTeam, portalAbis } from "@/lib/launchAbi";
import { Artwork } from "@/components/Artwork";
import { ArtworkPicker } from "@/components/ArtworkPicker";
import { Field, LaunchBar, LaunchFeeExample, LaunchReview, PairChooser, Slider, Step, WhatHappens, WizardNav, WizardProgress } from "@/components/LaunchUI";
import { DirectSim } from "@/components/Sim";
import { exemptAddresses, exemptProblem, OPENING_TAX_SUMMARY, OpeningTax, openingReviewRows, parseExempt } from "@/components/OpeningTax";
import { EMPTY_LEG, legsProblem, TeamLegsEditor, units, type LegForm } from "@/components/TeamLegsEditor";
import { brand } from "@/brands";

const SUPPLY = 1_000_000_000;
const SPACING = 200;
function safeUnits(value: string, decimals: number) {
  try { return parseUnits(value || "0", decimals); } catch { return 0n; }
}
/// The fourth step is the opening tax: the same schedule on every launch, and the creator only names
/// who skips it. A fee preset sets what a trade costs, which is the same from the first trade.
const STEPS = ["Token", "Market", "Economics", "Opening", "Review"] as const;
const REVIEW = STEPS.length - 1;
const FEE_PRESETS = [
  { id: "low", title: "Low tax", detail: "1% buy · 1% sell", values: { buyTax: 1, sellTax: 1 } },
  { id: "standard", title: "Standard", detail: "5% buy · 5% sell", values: { buyTax: 5, sellTax: 5 } },
  { id: "high", title: "High tax", detail: "10% buy · 10% sell, the most the portal allows", values: { buyTax: 10, sellTax: 10 } },
] as const;
const SPLIT_PRESETS = [
  { id: "balanced", title: "Share it around", detail: "40% holders · 25% creator", values: { creatorBps: 25, buybackBps: 25, dividendsBps: 40, liquidityBps: 10 } },
  { id: "creator", title: "Pay the creator", detail: "50% creator · 30% holders", values: { creatorBps: 50, buybackBps: 10, dividendsBps: 30, liquidityBps: 10 } },
  { id: "holders", title: "Reward holders", detail: "65% to eligible holders", values: { creatorBps: 10, buybackBps: 15, dividendsBps: 65, liquidityBps: 10 } },
  { id: "burn", title: "Buy back the token", detail: "60% to buyback & burn", values: { creatorBps: 10, buybackBps: 60, dividendsBps: 20, liquidityBps: 10 } },
] as const;

// The deployed portal's generation is read off its bytecode (lib/launchAbi.ts). This form writes the
// DirectConfig with the opening tax's `exempt` list and nothing older: a build pointed at an earlier
// portal says so instead of launching on rules the page no longer describes.

/// The other machine. A creator here is not choosing a curve, they are choosing a price to open at,
/// a price to bond at, what the trade costs, and who that cost pays.
export function DirectLaunchForm({ chooser }: { chooser: React.ReactNode }) {
  const [activeStep, setActiveStep] = useState(0);
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const router = useRouter();
  const { writeContractAsync, isPending } = useWriteContract();
  const [hash, setHash] = useState<`0x${string}` | undefined>();
  const receipt = useWaitForTransactionReceipt({ hash });
  const [mining, setMining] = useState(false);
  const [error, setError] = useState<string>();
  const [reviewedFingerprint, setReviewedFingerprint] = useState("");

  const [form, setForm] = useState({
    name: "", symbol: "", logo: "", description: "",
    twitter: "", telegram: "", discord: "", website: "", farcaster: "",
    quote: zeroAddress as Address,
    openFdv: "10", bondFdv: "100",
    buyTax: 1, sellTax: 1,
    creatorBps: 25, buybackBps: 25, dividendsBps: 40, liquidityBps: 10,
    feeRecipient: "",
    firstBuy: "",
  });
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));
  const setTaxes = (values: { buyTax: number; sellTax: number }) => setForm((current) => ({ ...current, ...values }));

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
    queryKey: ["portal-generation", directAddresses.portal],
    queryFn: async () => {
      const code = await publicClient!.getCode({ address: directAddresses.portal! });
      return { generation: detectPortalGeneration(code) ?? null, team: portalTakesTeam(code) };
    },
    enabled: Boolean(publicClient && directAddresses.portal),
    staleTime: Infinity,
  });
  const generation = portalGeneration.data?.generation ?? undefined;
  const supportsTeam = portalGeneration.data?.team ?? false;
  /// Block zero on the direct machine: declared team wallets that buy in the launch transaction.
  /// With a team the creator's single first buy is off; the team list is the first buy.
  const [teamOn, setTeamOn] = useState(false);
  const [teamLegs, setTeamLegs] = useState<LegForm[]>([{ ...EMPTY_LEG }]);
  const [teamGas, setTeamGas] = useState("0.0005");
  /// The v4 portal: the one opening-tax schedule on every launch, no wallet caps, no creator
  /// snipe settings, and a list of wallets that do not pay it.
  const supportsExempt = portalTakesExempt(generation);
  const [exemptText, setExemptText] = useState("");
  const exemptList = parseExempt(exemptText);

  // What this pad takes as a quote, from the same list the curve machine reads.
  const { data: pairData, isFetching: pairsLoading, isError: pairsError } = useQuery({
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
  const taxValid = form.buyTax <= 10 && form.sellTax <= 10;
  const firstBuyValid = !form.firstBuy || /^\d+(?:\.\d*)?$/.test(form.firstBuy)
    && (!form.firstBuy.includes(".") || (form.firstBuy.split(".")[1]?.length ?? 0) <= quoteDec);
  const openingError = exemptProblem(exemptList);
  const teamTotal = teamOn ? teamLegs.reduce((s, l) => s + units(l.amount, quoteDec), 0n) : 0n;
  const teamGasEach = teamOn ? units(teamGas, 18) : 0n;
  const teamError = teamOn ? (!supportsTeam ? "The launch contract on this deployment does not take team wallets yet." : legsProblem(teamLegs, quoteDec)) : undefined;
  const reviewedTerms = JSON.stringify({ form, exemptText, launchFee: String(launchFee ?? 0n), generation, teamOn, teamLegs, teamGas });
  const reviewed = reviewedFingerprint === reviewedTerms;

  useEffect(() => {
    if (receipt.isSuccess && receipt.data) {
      const log = receipt.data.logs.find(
        (l) => l.address.toLowerCase() === directAddresses.portal?.toLowerCase() && l.topics.length >= 4,
      );
      if (log) router.push(`/token/0x${log.topics[1]!.slice(26)}`);
    }
  }, [receipt.isSuccess, receipt.data, router]);

  async function launch() {
    if (!address || !directAddresses.portal || !initCodeHash || !reviewed || !generation) return;
    setError(undefined);
    setMining(true);
    try {
      // The hook's permissions live in its address, so the salt has to be mined for it. The salt
      // is bound to this wallet on chain, so only this wallet's own earlier launches can collide,
      // and the miner skips those.
      const { salt: hookSalt } = await mineFreeHookSalt(publicClient as never, directAddresses.deployer!, initCodeHash as `0x${string}`, address);
      setMining(false);

      // DirectConfig in the contract's order: the taxes, the ticks, the split, the exempt wallets.
      const allocations = {
        creatorBps: form.creatorBps * 100,
        buybackBps: form.buybackBps * 100,
        dividendsBps: form.dividendsBps * 100,
        liquidityBps: form.liquidityBps * 100,
      };
      const config = {
        buyTaxBps: Math.round(form.buyTax * 100),
        sellTaxBps: Math.round(form.sellTax * 100),
        tickStart: ticks.tickStart,
        tickBond: ticks.tickBond,
        allocations,
        exempt: exemptAddresses(exemptText),
      };
      const params = {
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
        config,
        salt,
        initialBuy: teamOn ? 0n : safeUnits(form.firstBuy, quoteDec),
        creatorFeeRecipient: form.feeRecipient ? getAddress(form.feeRecipient) : address,
      };

      if (teamOn) {
        if (!isNative) {
          const allowance = await publicClient!.readContract({
            address: form.quote, abi: erc20Abi, functionName: "allowance", args: [address, directAddresses.portal],
          }) as bigint;
          if (allowance < teamTotal) {
            setHash(await writeContractAsync({
              address: form.quote, abi: erc20Abi, functionName: "approve", args: [directAddresses.portal, teamTotal],
            }));
            return;
          }
        }
        const legArgs = teamLegs.map((l) => ({
          wallet: getAddress(l.wallet.trim()), pairIn: units(l.amount, quoteDec), minTokensOut: 0n, lock: BigInt(l.lock), gas: teamGasEach,
        }));
        const teamValue = ((launchFee as bigint | undefined) ?? 0n) + (isNative ? teamTotal : 0n) + teamGasEach * BigInt(legArgs.length);
        // Simulated first, so a leg the portal refuses reads as its reason, not as a failed receipt.
        await publicClient!.simulateContract({
          account: address, address: directAddresses.portal, abi: portalAbis[generation] as never, functionName: "createTeamLaunch",
          args: [params, hookSalt, legArgs] as never, value: teamValue,
        });
        setHash(await writeContractAsync({
          address: directAddresses.portal, abi: portalAbis[generation] as never, functionName: "createTeamLaunch",
          args: [params, hookSalt, legArgs] as never, value: teamValue,
        }));
        return;
      }

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
        address: directAddresses.portal, abi: portalAbis[generation] as never, functionName: "createLaunch",
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
  const feeDisplay = launchFee === undefined ? "Reading fee…" : `${formatUnits(fee, 18)} ETH`;
  // The fee is in the chain's own currency whatever the launch is quoted in, so the bar shows it
  // alone and says what the first buy costs beside it, in the quote.
  const firstBuyUnits = safeUnits(form.firstBuy, quoteDec);
  const { data: quoteAllowance } = useReadContract({
    address: form.quote, abi: erc20Abi, functionName: "allowance",
    args: [address ?? zeroAddress, directAddresses.portal ?? zeroAddress],
    query: { enabled: !isNative && firstBuyUnits > 0n && Boolean(address && directAddresses.portal) },
  });
  const needsQuoteApproval = !isNative && firstBuyUnits > 0n
    && ((quoteAllowance as bigint | undefined) ?? 0n) < firstBuyUnits;
  // The example trade: 1 quote unit bought after the open. The platform's 1% comes off first and
  // is split 30/70 between the creator and the Bag; the creator's own tax is all the creator's,
  // divided four ways by the splitter.
  const buyFee = form.buyTax / 100;
  const feeAmount = (part: number) => `${(buyFee * part / 100).toFixed(4)} ${quoteSym}`;
  const recipient = form.feeRecipient || address || "your connected wallet";

  // One reason at a time, in the order somebody would hit them.
  const blocked = !address ? "Connect a wallet first. It pays the fee and becomes the creator."
    : !form.name ? "Enter a token name."
    : !form.symbol ? "Enter a ticker."
    : !priceDone ? "The bonding valuation must be above the opening one."
    : !taxValid ? "Each trade tax is at most 10%."
    : !splitDone ? `The four fee shares add up to ${allocationSum}%; they must total 100%.`
    : !firstBuyValid ? `Enter a valid first-buy amount with at most ${quoteDec} decimal places.`
    : form.creatorBps > 0 && form.feeRecipient !== "" && !isAddress(form.feeRecipient) ? "Enter a valid creator-fee address."
    : openingError ? openingError
    : teamError ? teamError
    : launchFee === undefined ? "Reading the launch fee from chain."
    : !reviewed ? "Review and acknowledge the permanent launch terms."
    : portalGeneration.isLoading ? "Checking the launch contract version."
    : portalGeneration.isSuccess && !generation ? "The launch contract at this address answers to no createLaunch this app knows."
    : !supportsExempt ? "This launch contract is an older version than this app launches on."
    : !initCodeHash ? "Still reading the deployer. One moment."
    : undefined;

  const nextBlocked = activeStep === 0 ? (!form.name ? "Enter a token name." : !form.symbol ? "Enter a ticker." : undefined)
    : activeStep === 1 ? (!priceDone ? "Bonding valuation must be above opening valuation." : !firstBuyValid ? "Enter a valid first-buy amount." : undefined)
    : activeStep === 2 ? (!splitDone ? `Fee shares total ${allocationSum}%; they must total 100%.`
      : form.creatorBps > 0 && form.feeRecipient !== "" && !isAddress(form.feeRecipient) ? "Enter a valid creator-fee address."
      : undefined)
    : openingError;
  const moveTo = (step: number) => {
    setActiveStep(step);
    requestAnimationFrame(() => document.getElementById("launch-flow")?.scrollIntoView({ block: "start", behavior: "auto" }));
  };

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
            <details className="launch-advanced"><summary>Add social links <span>Optional</span></summary><div className="launch-advanced-body grid gap-4 sm:grid-cols-3">
              <Field label="X" help="Optional."><input className="input" value={form.twitter} onChange={(e) => set("twitter", e.target.value)} placeholder="https://x.com/" /></Field>
              <Field label="Telegram" help="Optional."><input className="input" value={form.telegram} onChange={(e) => set("telegram", e.target.value)} placeholder="https://t.me/" /></Field>
              <Field label="Discord" help="Optional."><input className="input" value={form.discord} onChange={(e) => set("discord", e.target.value)} placeholder="https://discord.gg/" /></Field>
              <Field label="Website" help="Optional."><input className="input" value={form.website} onChange={(e) => set("website", e.target.value)} placeholder="https://" /></Field>
              <Field label="Farcaster" help="Optional."><input className="input" value={form.farcaster} onChange={(e) => set("farcaster", e.target.value)} placeholder="https://warpcast.com/" /></Field>
            </div></details>
          </Step>
          )}

          {activeStep === 1 && (<>
          <Step n={2} title="Market and opening price" purpose="Choose what buyers pay with, plus the opening and bonding valuation. Liquidity is locked from the first trade." done={priceDone}>
            <PairChooser pairs={pairs} value={form.quote} loading={pairsLoading} error={pairsError} compact
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
            <p className="field-note mono">Actual pool prices: {landedFdv(ticks.tickStart).toFixed(landedFdv(ticks.tickStart) < 100 ? 3 : 0)} → {landedFdv(ticks.tickBond).toFixed(landedFdv(ticks.tickBond) < 100 ? 3 : 0)} {quoteSym} after tick rounding.</p>
            <details className="launch-advanced"><summary>First buy <span>Optional{form.firstBuy ? ` · ${form.firstBuy} ${quoteSym}` : ""}</span></summary><div className="launch-advanced-body launch-optionals">
            <p className="field-note">No wallet limits: anyone may buy and hold any amount. The first seconds are priced instead, by the opening tax every launch runs ({OPENING_TAX_SUMMARY}).</p>
            {!teamOn && (
              <Field label={`Your first buy in ${quoteSym}`} help="Optional. Bought in the launch transaction, before anyone else can trade.">
                <input className="input mono" inputMode="decimal" value={form.firstBuy}
                  onChange={(e) => set("firstBuy", e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0.0" />
              </Field>
            )}
            <label className="team-toggle">
              <input type="checkbox" checked={teamOn} disabled={!supportsTeam && !teamOn} onChange={(e) => setTeamOn(e.target.checked)} />
              <span>
                <b>Team wallets in the launch transaction</b>
                <span className="field-note">{supportsTeam
                  ? "Declared wallets buy before anyone else, each one published as the team on the token page. A locked wallet's tokens wait in the token lock."
                  : "Not available on this launch contract yet."}</span>
              </span>
            </label>
            {teamOn && (
              <>
                <TeamLegsEditor legs={teamLegs} onChange={setTeamLegs} symbol={quoteSym} decimals={quoteDec} />
                <Field label="Gas per wallet, in ETH" help="Sent to every team wallet with its tokens. 0 for none.">
                  <input className="input mono" value={teamGas} onChange={(e) => setTeamGas(e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" />
                </Field>
                {teamError && <p className="field-note bad">{teamError}</p>}
              </>
            )}
            </div></details>
          </Step>
          </>)}

          {activeStep === 2 && (<>
          <Step n={3} title="Your tax, and who gets it" purpose="The platform takes 1% of every trade: 0.70% to you, 0.30% into the Bag. Your own tax on top is all yours. Set its rate, then split it four ways." done={taxValid && splitDone}>
            <details className="launch-advanced"><summary>Trade tax: {form.buyTax}% buy · {form.sellTax}% sell <span>Change if needed</span></summary><div className="launch-advanced-body launch-optionals">
            <div className="direct-preset-grid direct-preset-grid-three" role="group" aria-label="Trading fee preset">
              {FEE_PRESETS.map((preset) => (
                <button key={preset.id} type="button" className={feePreset === preset.id ? "direct-preset selected" : "direct-preset"}
                  aria-pressed={feePreset === preset.id} onClick={() => setTaxes(preset.values)}>
                  <strong>{preset.title}</strong><span>{preset.detail}</span>
                </button>
              ))}
            </div>
            <div className={taxValid ? "direct-impact" : "direct-impact invalid"} role="status">
              <strong>{taxValid ? `${form.buyTax}% buy · ${form.sellTax}% sell, plus the platform's 1%` : "Check these fee rates"}</strong>
              <span>{`On top, in the launch's first three seconds, the opening tax every launch runs (${OPENING_TAX_SUMMARY}). It is on the next step.`}</span>
              {!taxValid && <span>Each trade tax is at most 10%.</span>}
            </div>
            <details className="direct-advanced">
              <summary>Customize fee rates <span>Optional</span></summary>
              <div className="grid gap-4 sm:grid-cols-2">
                <Slider label={`Buy tax ${form.buyTax}%`} hint="1 to 10% on every buy." min={1} max={10} step={0.5} value={form.buyTax} onChange={(v) => setTaxes({ buyTax: v, sellTax: form.sellTax })} />
                <Slider label={`Sell tax ${form.sellTax}%`} hint="1 to 10% on every sell." min={1} max={10} step={0.5} value={form.sellTax} onChange={(v) => setTaxes({ buyTax: form.buyTax, sellTax: v })} />
              </div>
              <DirectSim buyTax={form.buyTax} sellTax={form.sellTax}
                openFdv={Number(form.openFdv)} bondFdv={Number(form.bondFdv)} quoteSymbol={quoteSym} />
            </details>
            </div></details>

          <div className="fee-outcome-section" role="group" aria-label="Fee destination"><span className="field-label">Choose an outcome</span>
            <div className="direct-preset-grid" role="group" aria-label="Fee distribution preset">
              {SPLIT_PRESETS.map((preset) => (
                <button key={preset.id} type="button" className={splitPreset === preset.id ? "direct-preset selected" : "direct-preset"}
                  aria-pressed={splitPreset === preset.id} onClick={() => setForm((current) => ({ ...current, ...preset.values }))}>
                  <strong>{preset.title}</strong><span>{preset.detail}</span>
                </button>
              ))}
            </div>
            <p className={splitDone ? "field-note" : "field-note bad"} role="status">
              Creator {form.creatorBps}% · burn {form.buybackBps}% · holders {form.dividendsBps}% · liquidity {form.liquidityBps}%{splitDone ? "" : ` · total ${allocationSum}%, must be 100%`}
            </p>
            <details className="launch-advanced"><summary>See where a fee goes <span>Optional</span></summary><div className="launch-advanced-body"><LaunchFeeExample title={`If someone buys with 1 ${quoteSym} after opening`} description={`The platform takes 1% of every trade: 0.70% to you, 0.30% into the Bag. Your ${form.buyTax}% buy tax is ${buyFee.toFixed(4)} ${quoteSym} on top, and here is where it goes:`}
              rows={[
                { label: "Platform, 1% of the trade", value: `0.0100 ${quoteSym}` },
                { label: "  of which to you, 0.70%", value: `0.0070 ${quoteSym}` },
                { label: "  of which into the Bag, 0.30%", value: `0.0030 ${quoteSym}` },
                { label: `Your tax, ${form.buyTax}% of the trade`, value: `${buyFee.toFixed(4)} ${quoteSym}` },
                { label: "  creator address", value: feeAmount(form.creatorBps) },
                { label: "  buyback and burn", value: feeAmount(form.buybackBps) },
                { label: "  holders", value: feeAmount(form.dividendsBps) },
                { label: "  locked liquidity", value: feeAmount(form.liquidityBps) },
              ]}
              note="Illustrative amounts before rounding. The opening tax in the first three seconds, the pool fee and price movement can also change what a trade pays. A sell uses the sell-tax rate." /></div></details>
            <details className="direct-advanced">
              <summary>Make a custom split <span>Optional</span></summary>
              <p className="field-note">These four numbers must add up to 100%. They divide your tax, all of it. The platform's 1% is taken before it and is not yours to split.</p>
              <div className="grid gap-4 sm:grid-cols-2">
                <Slider label={`Creator ${form.creatorBps}%`} hint="Claimable by the fee recipient below." min={0} max={100} step={5} value={form.creatorBps} onChange={(v) => set("creatorBps", v)} />
                <Slider label={`Buyback & burn ${form.buybackBps}%`} hint="Used to buy and destroy tokens." min={0} max={100} step={5} value={form.buybackBps} onChange={(v) => set("buybackBps", v)} />
                <Slider label={`Holders ${form.dividendsBps}%`} hint={`Distributed to eligible holders in ${quoteSym}.`} min={0} max={100} step={5} value={form.dividendsBps} onChange={(v) => set("dividendsBps", v)} />
                <Slider label={`Liquidity ${form.liquidityBps}%`} hint="Reinvested into the locked pool." min={0} max={100} step={5} value={form.liquidityBps} onChange={(v) => set("liquidityBps", v)} />
              </div>
              <p className={splitDone ? "field-note good" : "field-note bad"}>
                {splitDone ? "Total: 100%. Ready to launch." : `Total: ${allocationSum}%. Adjust the shares until they total 100%.`}
              </p>
            </details>
            {form.creatorBps > 0 ? (
              <Field label="Creator fee recipient"
                error={form.feeRecipient && !isAddress(form.feeRecipient) ? "Paste a valid 0x address." : undefined}
                help="Optional. The creator share is claimable only by this address. Leave blank to use your connected wallet.">
                <input className="input mono" value={form.feeRecipient}
                  onChange={(e) => set("feeRecipient", e.target.value.trim())} placeholder={address ?? "0x…"} />
              </Field>
            ) : null}
          </div>
          </Step>
          </>)}

          {activeStep === 3 && (
          <Step n={4} title="The opening tax" purpose="The same on every launch: what a buy pays in your token's first three seconds, and who does not pay it." done={!openingError}>
            <OpeningTax value={exemptText} onChange={setExemptText} machine="direct" />
          </Step>
          )}

          {activeStep === REVIEW && (
          <Step n={5} title="Review before signing" purpose="Check the permanent launch rules and cost before opening your wallet." done={reviewed}>
            <LaunchReview reviewed={reviewed} onReviewed={(checked) => setReviewedFingerprint(checked ? reviewedTerms : "")}
              rows={[
                { label: "Token", value: `${form.name || "Unnamed"} ($${form.symbol || "no ticker"})` },
                { label: "Launch", value: `Direct locked pool, quoted in ${quoteSym}` },
                { label: "Price path", value: `${form.openFdv} to ${form.bondFdv} ${quoteSym} valuation` },
                { label: "Platform fee", value: "1% of every trade: 0.70% to you, 0.30% into the Bag" },
                { label: "Your tax", value: `${form.buyTax}% buy · ${form.sellTax}% sell` },
                { label: "Your tax goes to", value: `Creator ${form.creatorBps}% · burn ${form.buybackBps}% · holders ${form.dividendsBps}% · liquidity ${form.liquidityBps}%` },
                { label: "Creator address", value: recipient },
                ...(teamOn ? [{ label: "Team wallets", value: `${teamLegs.length} wallets, ${formatUnits(teamTotal, quoteDec)} ${quoteSym} in the launch transaction${teamGasEach > 0n ? `, ${teamGas} ETH gas each` : ""}; published as the team` }] : []),
                ...openingReviewRows(exemptList),
                { label: "Launch cost", value: `${feeDisplay} plus gas${form.firstBuy ? ` · ${form.firstBuy} ${quoteSym} first buy` : ""}` },
              ]}
              note="This is not a profit estimate. The pool price can move in either direction; buyers may lose money. If you use a non-native quote token, the first buy may require a separate approval." />
          </Step>
          )}

          {error && <p className="panel p-3 text-xs text-[var(--color-red)]">{error}</p>}

          {activeStep < REVIEW ? <WizardNav current={activeStep} count={STEPS.length} onBack={() => moveTo(activeStep - 1)} onNext={() => moveTo(activeStep + 1)}
            nextBlocked={nextBlocked} cost={feeDisplay} /> : <LaunchBar
            cost={feeDisplay}
            costLabel={form.firstBuy
              ? `launch fee, plus your ${form.firstBuy} ${quoteSym} first buy${isNative ? "" : `, pulled from your wallet in ${quoteSym}`}`
              : "launch fee, plus gas"}
            blocked={blocked}
            busy={mining || isPending || receipt.isLoading}
            busyLabel={mining ? "mining the hook address" : receipt.isLoading ? "waiting for the chain" : "confirm in your wallet"}
            label={needsQuoteApproval ? `Approve ${quoteSym}` : "Create the token"}
            onClick={launch}
          ><button type="button" className="btn btn-ghost" onClick={() => moveTo(REVIEW - 1)}>Back</button></LaunchBar>}
        </div>
      </div>

      <aside className="launch-preview">
        <div className="launch-preview-label">Live preview</div>
        <div className="launch-preview-art"><Artwork src={form.logo} symbol={form.symbol || "?"} size={88} rounded="rounded-xl" /></div>
        <h2>{form.name || "Your token"}</h2>
        <p className="launch-preview-symbol">$<span>{form.symbol || "TICKER"}</span></p>
        <div className="launch-preview-details">
          <div className="flex justify-between"><span className="dim">Launch model</span><span className="mono">Direct pool</span></div>
          <div className="flex justify-between"><span className="dim">Opens at</span><span className="mono">{form.openFdv || "0"} {quoteSym}</span></div>
          <div className="flex justify-between"><span className="dim">Buy / sell tax</span><span className="mono">{form.buyTax}% / {form.sellTax}%</span></div>
          <div className="flex justify-between"><span className="dim">Creator fees to</span><span className="mono">{shortAddress(form.feeRecipient || address || zeroAddress)}</span></div>
          <div className="flex justify-between"><span className="dim">Opening tax</span><span className="mono">99% → 0 in 3s</span></div>
        </div>
        {activeStep === REVIEW && <WhatHappens items={[
          "We mine an address for your hook, which takes a few seconds and costs nothing.",
          "Your wallet sends one transaction and pays the launch fee.",
          "The token, its pool, its hook and its splitter are created together, and the supply goes straight into a locked position.",
          "You land on the token page and it is tradable in the same block.",
        ]} />}
      </aside>
    </div>
  );
}
