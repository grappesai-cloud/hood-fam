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

export default function LaunchPage() {
  const [machine, setMachine] = useState<"curve" | "direct">("curve");
  return (
    <div className="launch-shell space-y-4">
      <header className="page-intro">
        <div className="section-kicker">ROBINHOOD CHAIN</div>
        <h1>Create token</h1>
        <p>Choose a launch model, set the details and confirm in your wallet.</p>
      </header>

      <div className="machine-options grid gap-2 sm:grid-cols-2">
        <button onClick={() => setMachine("curve")} aria-pressed={machine === "curve"}
          className={`rounded-xl border p-3 text-left ${machine === "curve" ? "border-[var(--color-lime)]" : "border-[var(--color-line)]"}`}>
          <div className="text-sm font-semibold">Bonding curve</div>
          <div className="text-xs dim">
            Trade on a rising curve, then graduate into a locked pool. Choose one permanent fee rule.
          </div>
        </button>
        <button onClick={() => setMachine("direct")} aria-pressed={machine === "direct"}
          className={`rounded-xl border p-3 text-left ${machine === "direct" ? "border-[var(--color-lime)]" : "border-[var(--color-line)]"}`}>
          <div className="text-sm font-semibold">Straight to the pool</div>
          <div className="text-xs dim">
            Launch directly into a pool. The trade tax splits four ways from the first block.
          </div>
        </button>
      </div>

      {machine === "curve" ? <CurveLaunchForm /> : <div className="direct-launch-wrap"><DirectLaunchForm /></div>}
    </div>
  );
}

function CurveLaunchForm() {
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
  const firstBuyWei = form.firstBuy ? (isNative ? parseEther(form.firstBuy) : parseUnits(form.firstBuy, 6)) : 0n;
  const value = (launchFee as bigint | undefined ?? 0n) + (isNative ? firstBuyWei : 0n);
  const ready = Boolean(address) && form.name.length > 0 && form.symbol.length > 0 && symbolFree !== false;

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
    <div className="launch-form-stack space-y-4">
      <p className="text-sm dim">Your token, curve, pool and fee rule are created in one transaction. An initial buy is optional.</p>

      <section className="panel space-y-3 p-4">
        <h2>Token details</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="name">
            <input className="input" value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Hood Fam" />
          </Field>
          <Field label="ticker" hint={form.symbol && symbolFree === false ? "locked by a hot launch right now" : undefined}>
            <input className="input mono uppercase" value={form.symbol}
              onChange={(e) => set("symbol", e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} placeholder="FAM" />
          </Field>
        </div>
        <Field label="description">
          <textarea className="input min-h-20" value={form.description} onChange={(e) => set("description", e.target.value)} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="website"><input className="input" value={form.website} onChange={(e) => set("website", e.target.value)} /></Field>
          <Field label="x"><input className="input" value={form.twitter} onChange={(e) => set("twitter", e.target.value)} /></Field>
          <Field label="telegram"><input className="input" value={form.telegram} onChange={(e) => set("telegram", e.target.value)} /></Field>
        </div>
      </section>

      <section className="panel space-y-3 p-4">
        <h2 className="font-semibold">Art</h2>
        <ArtworkPicker value={form.image} onChange={(v) => set("image", v)} symbol={form.symbol}
          ai promptHint={`${form.name} ${form.symbol} token logo`.trim()} />
        <p className="text-xs dim">Stored as a link. The launch itself only carries the address of the picture.</p>
      </section>

      <section className="panel space-y-2 p-4">
        <h2 className="font-semibold">Where the fee goes</h2>
        <p className="text-xs dim">Locked at launch. This is the promise a buyer can check on chain.</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {FEE_MODELS.map((m) => (
            <button key={m} onClick={() => set("feeModel", m)} aria-pressed={form.feeModel === m}
              className={`rounded-xl border p-3 text-left ${
                form.feeModel === m ? "border-[var(--color-lime)]" : "border-[var(--color-line)]"
              }`}>
              <div className="text-sm font-semibold">{MODEL_COPY[m]!.title}</div>
              <div className="text-xs dim">{MODEL_COPY[m]!.body}</div>
            </button>
          ))}
        </div>
      </section>

      <section className="panel space-y-3 p-4">
        <h2 className="font-semibold">Shape of the curve</h2>
        <div className="grid gap-2">
          {((configs ?? []) as { result?: CurvePreset }[]).map((c, i) => {
            const cfg = c.result;
            if (!cfg?.enabled) return null;
            const dec = form.pairToken === zeroAddress ? 18 : 6;
            return (
              <button key={i} onClick={() => set("configId", i)} aria-pressed={form.configId === i}
                className={`flex items-center justify-between rounded-xl border p-3 text-left text-sm ${
                  form.configId === i ? "border-[var(--color-lime)]" : "border-[var(--color-line)]"
                }`}>
                <span>
                  starts at {fmt(cfg.startCap, dec, 3)} · graduates at {fmt(cfg.graduationCap, dec, 3)}
                  <span className="dim"> · {cfg.curveSupplyBps / 100}% on the curve</span>
                </span>
                <span className="mono text-xs dim">{(cfg.protocolFeeBps + cfg.creatorFeeBps) / 100}% fee</span>
              </button>
            );
          })}
        </div>
        <Field label={`your first buy (${isNative ? "ETH" : "USDG"}, optional)`}>
          <input className="input mono" inputMode="decimal" value={form.firstBuy}
            onChange={(e) => set("firstBuy", e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0.0" />
        </Field>
      </section>

      <section className="panel space-y-2 p-4 text-xs">
        <Row label="launch fee" value={`${fmt((launchFee as bigint | undefined) ?? 0n, 18, 6)} ETH`} />
        <Row label="your first buy" value={`${form.firstBuy || "0"} ${isNative ? "ETH" : "USDG"}`} />
        <Row label="total" value={`${fmt(value, 18, 6)} ETH`} />
        <Row label="economics pinned" value={econ ? `${(econ as string).slice(0, 10)}…` : "reading"} />
        <p className="dim">
          The economics hash is read now and sent with the launch. If anything about the preset moves before
          your transaction lands, it reverts instead of launching on terms you did not agree to.
        </p>
      </section>

      <button className="btn w-full" disabled={!ready || isPending || receipt.isLoading} onClick={launch}>
        {!address ? "connect a wallet" : isPending || receipt.isLoading ? "printing" : "print it"}
      </button>
    </div>
    <aside className="launch-preview">
      <div className="launch-preview-label">LIVE PREVIEW</div>
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
      </div>
      <p className="launch-preview-note">Preview only. Your wallet confirms the final transaction.</p>
    </aside>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs dim">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-[var(--color-red)]">{hint}</span>}
    </label>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between"><span className="dim">{label}</span><span className="mono">{value}</span></div>;
}
