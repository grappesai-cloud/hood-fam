"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { erc20Abi, formatUnits, keccak256, parseUnits, stringToHex, zeroAddress, type Address } from "viem";
import { useAccount, usePublicClient, useReadContract, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { useQuery } from "@tanstack/react-query";
import { directTicks, hoodPortalAbi, hoodDirectDeployerAbi, mineFreeHookSalt, predictDirectToken, uniswapV4 } from "@hood/sdk";
import { directAddresses } from "@/lib/config";
import { api, type PairRow } from "@/lib/api";
import { pairDecimals, pairSymbol } from "@/lib/format";
import { Artwork } from "@/components/Artwork";
import { ArtworkPicker } from "@/components/ArtworkPicker";
import { Choice, Field, LaunchBar, PairChooser, Rail, Slider, Step, WhatHappens, type StepState } from "@/components/LaunchUI";
import { DirectSim } from "@/components/Sim";

const SUPPLY = 1_000_000_000;
const SPACING = 200;

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
  const ready = Boolean(address && directAddresses.portal && initCodeHash)
    && form.name.length > 0 && form.symbol.length > 0
    && allocationSum === 100
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
        address: directAddresses.portal, abi: hoodPortalAbi, functionName: "createLaunch",
        args: [params, hookSalt], value: ((launchFee as bigint | undefined) ?? 0n) + (isNative ? params.initialBuy : 0n),
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
    : !splitDone ? `Step 5: the four shares add up to ${allocationSum}%. They have to make 100.`
    : !initCodeHash ? "Still reading the deployer. One moment."
    : undefined;

  const steps: StepState[] = [
    { n: 1, label: "How it launches", done: true },
    { n: 2, label: "The token", done: tokenDone },
    { n: 3, label: "The price", done: priceDone },
    { n: 4, label: "The tax", done: true },
    { n: 5, label: "The split", done: splitDone },
    { n: 6, label: "The opening", done: true },
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
                <input className="input" value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Hood Fam" />
              </Field>
              <Field label="Ticker" help="Letters and numbers, no dollar sign. We add that.">
                <input className="input mono uppercase" value={form.symbol}
                  onChange={(e) => set("symbol", e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} placeholder="FAM" />
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

          <Step n={4} title="The tax on every trade" purpose="What a buy and a sell cost, in ETH, on top of the pool fee. Fixed at launch: nobody, including us, can change them afterwards." done>
            <div className="grid gap-4 sm:grid-cols-2">
              <Slider label={`Buy tax ${form.buyTax}%`} hint="Between 1 and 10." min={1} max={10} step={0.5} value={form.buyTax} onChange={(v) => set("buyTax", v)} />
              <Slider label={`Sell tax ${form.sellTax}%`} hint="Between 1 and 10." min={1} max={10} step={0.5} value={form.sellTax} onChange={(v) => set("sellTax", v)} />
              <Slider label={`Opening surcharge ${form.snipeTax}%`} hint="An extra tax at the very open, on top of the buy tax." min={0} max={89} step={1} value={form.snipeTax} onChange={(v) => set("snipeTax", v)} />
              <Slider label={`Gone after ${form.snipeSeconds}s`} hint="The surcharge falls to nothing over this many seconds." min={0} max={30} step={1} value={form.snipeSeconds} onChange={(v) => set("snipeSeconds", v)} />
            </div>
            <DirectSim buyTax={form.buyTax} sellTax={form.sellTax} snipeTax={form.snipeTax} snipeSeconds={form.snipeSeconds} />
          </Step>

          <Step n={5} title="Where your nine tenths go" purpose="The protocol keeps a tenth of the tax, always. You decide what happens to the rest, once, here. The four shares have to add up to 100." done={splitDone}>
            <div className="grid gap-4 sm:grid-cols-2">
              <Slider label={`You ${form.creatorBps}%`} hint="Claimable by you whenever you want it." min={0} max={100} step={5} value={form.creatorBps} onChange={(v) => set("creatorBps", v)} />
              <Slider label={`Buy back and burn ${form.buybackBps}%`} hint="Buys the token on the open market and destroys it." min={0} max={100} step={5} value={form.buybackBps} onChange={(v) => set("buybackBps", v)} />
              <Slider label={`Holders ${form.dividendsBps}%`} hint="Paid out to everyone holding, in ETH." min={0} max={100} step={5} value={form.dividendsBps} onChange={(v) => set("dividendsBps", v)} />
              <Slider label={`Liquidity ${form.liquidityBps}%`} hint="Goes back into the locked position, deepening the pool." min={0} max={100} step={5} value={form.liquidityBps} onChange={(v) => set("liquidityBps", v)} />
            </div>
            <p className={splitDone ? "field-note good" : "field-note bad"}>
              {splitDone ? "Adds up to 100." : `Adds up to ${allocationSum}%. It has to be 100.`}
            </p>
          </Step>

          <Step n={6} title="The opening, and your first buy" purpose="How hard it is for one wallet to take the whole open. Selling is never restricted, and every limit here expires by itself." done>
            <div className="grid gap-4 sm:grid-cols-3">
              <Slider label={`Limits last ${form.restrictionBlocks} blocks`} hint="About a tenth of a second each on this chain." min={0} max={200} step={10} value={form.restrictionBlocks} onChange={(v) => set("restrictionBlocks", v)} />
              <Slider label={`Hold at most ${form.maxHold}%`} hint="Of the supply, per wallet, while the limits last." min={0.5} max={20} step={0.5} value={form.maxHold} onChange={(v) => set("maxHold", v)} />
              <Slider label={`Buy at most ${form.maxBuy}%`} hint="Per transaction, while the limits last." min={0.5} max={20} step={0.5} value={form.maxBuy} onChange={(v) => set("maxBuy", v)} />
            </div>
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

