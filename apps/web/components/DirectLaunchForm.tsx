"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { formatEther, keccak256, parseEther, stringToHex, zeroAddress } from "viem";
import { useAccount, usePublicClient, useReadContract, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { hoodPortalAbi, hoodDirectDeployerAbi, mineFreeHookSalt, uniswapV4 } from "@hood/sdk";
import { directAddresses } from "@/lib/config";
import { fdvToTick, tickToFdv } from "@/lib/direct";
import { Artwork } from "@/components/Artwork";
import { ArtworkPicker } from "@/components/ArtworkPicker";

const SUPPLY = 1_000_000_000;
const SPACING = 200;

/// The other machine. A creator here is not choosing a curve, they are choosing a price to open at,
/// a price to bond at, what the trade costs, and who that cost pays.
export function DirectLaunchForm() {
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

  const ticks = useMemo(() => {
    const open = Number(form.openFdv) || 10;
    const bond = Number(form.bondFdv) || 100;
    return { tickStart: fdvToTick(open, SUPPLY, SPACING), tickBond: fdvToTick(bond, SUPPLY, SPACING) };
  }, [form.openFdv, form.bondFdv]);

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
      const { salt } = await mineFreeHookSalt(publicClient as never, directAddresses.deployer!, initCodeHash as `0x${string}`, address);
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
        quote: zeroAddress as `0x${string}`,
        supply: parseEther(String(SUPPLY)),
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
        salt: keccak256(stringToHex(`${form.symbol}:${Date.now()}`)),
        initialBuy: form.firstBuy ? parseEther(form.firstBuy) : 0n,
      };

      setHash(await writeContractAsync({
        address: directAddresses.portal, abi: hoodPortalAbi, functionName: "createLaunch",
        args: [params, salt], value: ((launchFee as bigint | undefined) ?? 0n) + params.initialBuy,
      }));
    } catch (e) {
      setMining(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (!directAddresses.portal) {
    return <p className="panel p-6 text-sm dim">Direct launches are not configured on this deployment.</p>;
  }

  return (
    <div className="launch-content">
    <div className="launch-form-stack space-y-4">
      <section className="panel space-y-3 p-4">
        <h2 className="font-semibold">Token details</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="name">
            <input className="input" value={form.name} onChange={(e) => set("name", e.target.value)} />
          </Field>
          <Field label="ticker">
            <input className="input mono uppercase" value={form.symbol}
              onChange={(e) => set("symbol", e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} />
          </Field>
        </div>
        <Field label="description">
          <textarea className="input min-h-16" value={form.description} onChange={(e) => set("description", e.target.value)} />
        </Field>
        {/* not a Field: that is a <label>, and a label wrapping the picker's own buttons would fire
            the file dialog on every click inside the box. */}
        <div>
          <span className="mb-1 block text-xs dim">artwork</span>
          <ArtworkPicker value={form.logo} onChange={(v) => set("logo", v)} symbol={form.symbol} />
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="x"><input className="input" value={form.twitter} onChange={(e) => set("twitter", e.target.value)} /></Field>
          <Field label="telegram"><input className="input" value={form.telegram} onChange={(e) => set("telegram", e.target.value)} /></Field>
          <Field label="discord"><input className="input" value={form.discord} onChange={(e) => set("discord", e.target.value)} /></Field>
          <Field label="website"><input className="input" value={form.website} onChange={(e) => set("website", e.target.value)} /></Field>
          <Field label="farcaster"><input className="input" value={form.farcaster} onChange={(e) => set("farcaster", e.target.value)} /></Field>
        </div>
      </section>

      <section className="panel space-y-3 p-4">
        <h2 className="font-semibold">Price</h2>
        <p className="text-xs dim">
          The whole supply goes into one position above the opening price. Buys walk the price up
          through it, and when it reaches the bonding valuation the launch is bonded. There is no
          migration afterwards: the liquidity has been real and locked the whole time.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="opens at (ETH valuation)">
            <input className="input mono" value={form.openFdv}
              onChange={(e) => set("openFdv", e.target.value.replace(/[^0-9.]/g, ""))} />
          </Field>
          <Field label="bonds at (ETH valuation)">
            <input className="input mono" value={form.bondFdv}
              onChange={(e) => set("bondFdv", e.target.value.replace(/[^0-9.]/g, ""))} />
          </Field>
        </div>
        <p className="text-xs dim mono">
          ticks {ticks.tickStart} to {ticks.tickBond} · actual open {tickToFdv(ticks.tickStart, SUPPLY).toFixed(2)} ETH
          · actual bond {tickToFdv(ticks.tickBond, SUPPLY).toFixed(2)} ETH
        </p>
      </section>

      <section className="panel space-y-3 p-4">
        <h2 className="font-semibold">The tax</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Slider label={`buy ${form.buyTax}%`} min={1} max={10} step={0.5} value={form.buyTax} onChange={(v) => set("buyTax", v)} />
          <Slider label={`sell ${form.sellTax}%`} min={1} max={10} step={0.5} value={form.sellTax} onChange={(v) => set("sellTax", v)} />
          <Slider label={`opening surcharge ${form.snipeTax}%`} min={0} max={89} step={1} value={form.snipeTax} onChange={(v) => set("snipeTax", v)} />
          <Slider label={`decaying over ${form.snipeSeconds}s`} min={0} max={30} step={1} value={form.snipeSeconds} onChange={(v) => set("snipeSeconds", v)} />
        </div>
        <p className="text-xs dim">Fixed at launch. Nobody, including us, can change them afterwards.</p>
      </section>

      <section className="panel space-y-3 p-4">
        <h2 className="font-semibold">Where your nine tenths go</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Slider label={`you ${form.creatorBps}%`} min={0} max={100} step={5} value={form.creatorBps} onChange={(v) => set("creatorBps", v)} />
          <Slider label={`buy back and burn ${form.buybackBps}%`} min={0} max={100} step={5} value={form.buybackBps} onChange={(v) => set("buybackBps", v)} />
          <Slider label={`holders ${form.dividendsBps}%`} min={0} max={100} step={5} value={form.dividendsBps} onChange={(v) => set("dividendsBps", v)} />
          <Slider label={`liquidity ${form.liquidityBps}%`} min={0} max={100} step={5} value={form.liquidityBps} onChange={(v) => set("liquidityBps", v)} />
        </div>
        <p className={`text-xs ${allocationSum === 100 ? "dim" : "text-[var(--color-red)]"}`}>
          {allocationSum === 100 ? "adds up" : `adds up to ${allocationSum}%, it has to be 100`}
          . The protocol takes a tenth before this split, always.
        </p>
      </section>

      <section className="panel space-y-3 p-4">
        <h2 className="font-semibold">The opening window</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <Slider label={`${form.restrictionBlocks} blocks`} min={0} max={200} step={10} value={form.restrictionBlocks} onChange={(v) => set("restrictionBlocks", v)} />
          <Slider label={`hold at most ${form.maxHold}%`} min={0.5} max={20} step={0.5} value={form.maxHold} onChange={(v) => set("maxHold", v)} />
          <Slider label={`buy at most ${form.maxBuy}%`} min={0.5} max={20} step={0.5} value={form.maxBuy} onChange={(v) => set("maxBuy", v)} />
        </div>
        <p className="text-xs dim">
          The launch block is yours alone, and for the blocks after it no wallet may take more than
          its share. Selling is never restricted, and every limit expires by itself.
        </p>
        <Field label="your first buy (ETH, optional, inside the launch transaction)">
          <input className="input mono" inputMode="decimal" value={form.firstBuy}
            onChange={(e) => set("firstBuy", e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0.0" />
        </Field>
        <p className="text-xs dim">
          It lands before anyone else can trade, and the buy cap applies to it: first dibs, not the whole open.
        </p>
      </section>

      {error && <p className="panel p-3 text-xs text-[var(--color-red)]">{error}</p>}

      <button className="btn w-full" disabled={!ready || mining || isPending || receipt.isLoading} onClick={launch}>
        {!address ? "connect a wallet"
          : mining ? "mining the hook address"
          : isPending || receipt.isLoading ? "printing"
          : "print it"}
      </button>
    </div>
    <aside className="launch-preview">
      <div className="launch-preview-label">LIVE PREVIEW</div>
      <div className="launch-preview-art"><Artwork src={form.logo} symbol={form.symbol || "?"} size={88} rounded="rounded-xl" /></div>
      <h2>{form.name || "Your token"}</h2>
      <p className="launch-preview-symbol">$<span>{form.symbol || "TICKER"}</span></p>
      <div className="launch-preview-details">
        <div className="flex justify-between"><span>Launch model</span><span className="mono">Direct pool</span></div>
        <div className="flex justify-between"><span>Opens at</span><span className="mono">{form.openFdv || "—"} ETH</span></div>
        <div className="flex justify-between"><span>Buy / sell tax</span><span className="mono">{form.buyTax}% / {form.sellTax}%</span></div>
        <div className="flex justify-between"><span>Launch fee</span><span className="mono">{formatEther((launchFee as bigint | undefined) ?? 0n)} ETH</span></div>
      </div>
      <p className="launch-preview-note">Preview only. Your wallet confirms the final transaction.</p>
    </aside>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs dim">{label}</span>
      {children}
    </label>
  );
}

function Slider({ label, min, max, step, value, onChange }: {
  label: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs dim">{label}</span>
      <input type="range" className="w-full accent-[var(--color-lime)]"
        min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}
