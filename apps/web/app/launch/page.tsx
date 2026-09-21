"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { isAddress, parseEther, parseUnits, zeroAddress, type Address } from "viem";
import { useAccount, useReadContract, useReadContracts, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { hoodFactoryAbi, hoodStakingAbi, BPS, FEE_LEG_LABEL, LOCK_TIERS } from "@hood/sdk";
import { addresses } from "@/lib/config";
import { fmt } from "@/lib/format";
import { DirectLaunchForm } from "@/components/DirectLaunchForm";
import { ArtworkPicker } from "@/components/ArtworkPicker";
import { Choice, Field, LaunchBar, Rail, Slider, Step, WhatHappens, type StepState } from "@/components/LaunchUI";
import { CurveSim } from "@/components/Sim";

interface CurvePreset {
  totalSupply: bigint; curveSupplyBps: number; startCap: bigint; graduationCap: bigint;
  liquidityBps: number; protocolFeeBps: number; creatorFeeBps: number; enabled: boolean;
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
  const [hash, setHash] = useState<`0x${string}` | undefined>();
  const receipt = useWaitForTransactionReceipt({ hash });

  const [form, setForm] = useState({
    name: "", symbol: "", description: "", image: "", website: "", twitter: "", telegram: "",
    configId: 0, pairToken: zeroAddress as Address,
    firstBuy: "",
    // Percentages here, basis points on chain: a slider a person drags should be in the unit they
    // think in, and the conversion belongs at the edge, once.
    stakers: 100, buyback: 0, liquidity: 0, creator: 0,
    feeRecipient: "",
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
    setForm((f) => (f.stakers === 100 && f.buyback === 0 && f.liquidity === 0 && f.creator === 0
      ? { ...f, stakers: 0, buyback: 50, liquidity: 50 }
      : f));
  }, [houseToken, canPayStakers]);

  const { data: launchFee } = useReadContract({
    address: addresses.factory, abi: hoodFactoryAbi, functionName: "launchFee",
  });
  const { data: symbolFree } = useReadContract({
    address: addresses.factory, abi: hoodFactoryAbi, functionName: "isSymbolAvailable",
    args: [form.symbol], query: { enabled: form.symbol.length > 0 },
  });
  const { data: econ } = useReadContract({
    address: addresses.factory, abi: hoodFactoryAbi, functionName: "previewLaunchEconomics",
    args: [BigInt(form.configId), form.pairToken], query: { refetchInterval: 15_000 },
  });

  useEffect(() => {
    if (receipt.isSuccess && receipt.data) {
      const log = receipt.data.logs.find((l) => l.address.toLowerCase() === addresses.factory.toLowerCase() && l.topics.length >= 4);
      if (log) router.push(`/token/0x${log.topics[1]!.slice(26)}`);
    }
  }, [receipt.isSuccess, receipt.data, router]);

  const chosen = ((configs ?? []) as { result?: CurvePreset }[])[form.configId]?.result;
  const isNative = form.pairToken === zeroAddress;
  const pair = isNative ? "ETH" : "USDG";
  const firstBuyWei = form.firstBuy ? (isNative ? parseEther(form.firstBuy) : parseUnits(form.firstBuy, 6)) : 0n;
  const value = (launchFee as bigint | undefined ?? 0n) + (isNative ? firstBuyWei : 0n);
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
    : form.stakers > 0 && !canPayStakers ? "Step 3 cannot pay stakers yet: the pad's own coin has not been named on chain."
    : splitTotal !== 100 ? `Step 3 has to add up to 100%. It is at ${splitTotal}%.`
    : !recipientOk ? "Step 3 needs a valid address for the fee, or none at all."
    : form.creator > 0 && !recipient ? "Step 3 pays the creator leg to an address, and there is none."
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
    setHash(await writeContractAsync({
      address: addresses.factory, abi: hoodFactoryAbi, functionName: "launch",
      args: [{
        name: form.name, symbol: form.symbol, image: form.image, description: form.description,
        website: form.website, twitter: form.twitter, telegram: form.telegram,
        pairToken: form.pairToken, configId: BigInt(form.configId),
        feeSplit: {
          stakersBps: form.stakers * 100, buybackBps: form.buyback * 100,
          liquidityBps: form.liquidity * 100, creatorBps: form.creator * 100,
        },
        creatorFeeRecipient: (recipient || address) as Address,
        firstBuy: firstBuyWei, firstBuyLock: BigInt(form.firstBuyLock),
        salt, econ: (econ as `0x${string}`) ?? `0x${"0".repeat(64)}`,
      }],
      value,
    }));
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
            {form.creator > 0 && (
              <Field label="Who the creator share pays"
                help="Leave it empty and it pays the wallet doing this launch. A team usually wants its own Safe here. Only that address can hand the stream on later."
                error={recipientOk ? undefined : "That is not an address."}>
                <input className="input mono" placeholder={address ?? "0x..."} value={form.feeRecipient}
                  onChange={(e) => set("feeRecipient", e.target.value.trim())} />
              </Field>
            )}
          </Step>

          <Step n={4} title="The curve, and your first buy" purpose="How much supply trades on the curve, what valuation it starts and graduates at, and whether you want the first buy in the same transaction." done>
            <div className="grid gap-2">
              {((configs ?? []) as { result?: CurvePreset }[]).map((c, i) => {
                const cfg = c.result;
                if (!cfg?.enabled) return null;
                const dec = isNative ? 18 : 6;
                return (
                  <Choice key={i} selected={form.configId === i} onClick={() => set("configId", i)}
                    title={`Starts at ${fmt(cfg.startCap, dec, 3)} ${pair}, graduates at ${fmt(cfg.graduationCap, dec, 3)} ${pair}`}
                    body={`${cfg.curveSupplyBps / 100}% of the supply trades on the curve. The rest goes into the pool at graduation, locked.`}
                    meta={`${(cfg.protocolFeeBps + cfg.creatorFeeBps) / 100}% per trade`} />
                );
              })}
            </div>
            {chosen && (
              <CurveSim
                p0={(chosen.startCap * 10n ** 18n) / chosen.totalSupply}
                p1={(chosen.graduationCap * 10n ** 18n) / chosen.totalSupply}
                curveSupply={(chosen.totalSupply * BigInt(chosen.curveSupplyBps)) / 10_000n}
                totalSupply={chosen.totalSupply}
                dec={isNative ? 18 : 6}
                sym={pair}
                feeBps={chosen.protocolFeeBps + chosen.creatorFeeBps}
                ticker={form.symbol}
              />
            )}

            <Field label={`Your first buy in ${pair}`}
              help="Optional, and it lands inside the launch transaction, so nobody can get in ahead of you. Leave it empty to launch without buying.">
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
            cost={`${fmt(value, 18, 6)} ETH`}
            costLabel={form.firstBuy ? `${fmt((launchFee as bigint | undefined) ?? 0n, 18, 6)} fee plus your ${form.firstBuy} first buy` : "launch fee, plus gas"}
            blocked={blocked}
            busy={isPending || receipt.isLoading}
            busyLabel={receipt.isLoading ? "waiting for the chain" : "confirm in your wallet"}
            label="Create the token"
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
