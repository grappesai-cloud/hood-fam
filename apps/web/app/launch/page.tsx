"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { parseEther, parseUnits, zeroAddress, type Address } from "viem";
import { useAccount, useReadContract, useReadContracts, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { hoodFactoryAbi, FEE_MODELS, feeModelToIndex } from "@hood/sdk";
import { addresses } from "@/lib/config";
import { fmt } from "@/lib/format";
import { DirectLaunchForm } from "@/components/DirectLaunchForm";
import { ArtworkPicker } from "@/components/ArtworkPicker";
import { Choice, Field, LaunchBar, Rail, Step, WhatHappens, type StepState } from "@/components/LaunchUI";

interface CurvePreset {
  totalSupply: bigint; curveSupplyBps: number; startCap: bigint; graduationCap: bigint;
  liquidityBps: number; protocolFeeBps: number; creatorFeeBps: number; enabled: boolean;
}

const MODEL_COPY: Record<string, { title: string; body: string }> = {
  staking: { title: "Stakers take it", body: "Everyone who locks the token earns the trading fee, more for a longer lock." },
  buyback: { title: "Buy back and burn", body: "The fee buys the token and destroys it. Supply only goes down." },
  liquidity: { title: "Deepen the liquidity", body: "The fee is added to the pool the token graduates into." },
  creator: { title: "You keep it", body: "The fee pays the address you name. Transferable later, by you only." },
  zero: { title: "No creator fee", body: "Traders pay the protocol fee and nothing else. Cheapest to trade." },
};

const MACHINES = {
  curve: {
    title: "Bonding curve",
    body: "Buyers trade against a rising curve. When it sells out, the raise and the rest of the supply move into a Uniswap pool that is locked forever.",
    meta: "the pump.fun shape",
  },
  direct: {
    title: "Straight to the pool",
    body: "The whole supply opens in a real Uniswap pool from the first block, above your opening price. No curve, no migration, and every trade pays a tax you set.",
    meta: "liquidity from block one",
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
    feeModel: "staking" as (typeof FEE_MODELS)[number], configId: 0, pairToken: zeroAddress as Address,
    firstBuy: "",
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

  const isNative = form.pairToken === zeroAddress;
  const pair = isNative ? "ETH" : "USDG";
  const firstBuyWei = form.firstBuy ? (isNative ? parseEther(form.firstBuy) : parseUnits(form.firstBuy, 6)) : 0n;
  const value = (launchFee as bigint | undefined ?? 0n) + (isNative ? firstBuyWei : 0n);
  const tokenDone = form.name.length > 0 && form.symbol.length > 0 && symbolFree !== false;

  // One reason at a time, in the order somebody would hit them. A button that is off without saying
  // why is the single thing this page used to do worst.
  const blocked = !address ? "Connect a wallet first. It pays the fee and becomes the creator."
    : !form.name ? "Step 2 needs a name."
    : !form.symbol ? "Step 2 needs a ticker."
    : symbolFree === false ? "That ticker is locked by a launch that is trading right now."
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
        feeModel: feeModelToIndex[form.feeModel], creatorFeeRecipient: address,
        firstBuy: firstBuyWei, salt, econ: (econ as `0x${string}`) ?? `0x${"0".repeat(64)}`,
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

          <Step n={3} title="Where the trading fee goes" purpose="Every trade pays a fee. You choose once, here, who it pays. This is the promise a buyer can check on chain, and nobody can change it afterwards, including us." done>
            <div className="grid gap-2 sm:grid-cols-2">
              {FEE_MODELS.map((m) => (
                <Choice key={m} selected={form.feeModel === m} onClick={() => set("feeModel", m)}
                  title={MODEL_COPY[m]!.title} body={MODEL_COPY[m]!.body} />
              ))}
            </div>
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
            <Field label={`Your first buy in ${pair}`}
              help="Optional, and it lands inside the launch transaction, so nobody can get in ahead of you. Leave it empty to launch without buying.">
              <input className="input mono" inputMode="decimal" value={form.firstBuy}
                onChange={(e) => set("firstBuy", e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0.0" />
            </Field>
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
          <Row label="Fee rule" value={MODEL_COPY[form.feeModel]!.title} />
          <Row label="Launch fee" value={`${fmt((launchFee as bigint | undefined) ?? 0n, 18, 6)} ETH`} />
          <Row label="Terms pinned" value={econ ? `${(econ as string).slice(0, 10)}…` : "reading"} />
        </div>
        <WhatHappens items={[
          "Your wallet sends one transaction and pays the launch fee.",
          "The token, its curve and its fee rule are created together.",
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
