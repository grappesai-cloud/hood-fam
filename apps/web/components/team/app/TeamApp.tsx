"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useAccount, useBalance, useConnect, useDisconnect } from "wagmi";
import { brand } from "@/brands";
import { API } from "@/lib/config";
import { fmt, imageUrl, shortAddress } from "@/lib/format";
import { usePreferredConnector } from "@/lib/safe";
import { importDraft, newDraft, useDrafts, type Draft } from "./drafts";
import { lockAll, useUnlocked } from "./walletSets";
import { useIdleLock } from "../useIdleLock";
import {
  IconBack, IconChevron, IconCoins, IconDashboard, IconDoc, IconFilter, IconImport, IconPanel, IconRocket,
  IconSearch, IconTracker, IconWallet,
} from "./icons";
import "./team-app.css";

/// The team console's own frame: drafts down the left, the form in the middle, the chain's pulse
/// along the bottom. It sits over the site's shell for every page under /launch/team, so the
/// console reads as one tool, the way a launch desk should, and the site is one link away.

export function TeamApp({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const path = usePathname();
  const params = useSearchParams();

  // A route change on a phone closes the drawer, so the page it opened is what shows.
  useEffect(() => { setOpen(false); }, [path, params]);

  // The site's shell has transformed ancestors, and a fixed box inside one is fixed to it rather
  // than to the window, so the console mounts on <body> itself. The providers still wrap it: a
  // portal keeps React context.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
    document.documentElement.classList.add("tapp-open");
    return () => document.documentElement.classList.remove("tapp-open");
  }, []);
  if (!mounted) return null;

  return createPortal(
    <div className={`tapp${collapsed ? " tapp-collapsed" : ""}`}>
      <WalletSetsGuard />
      <aside className={`tapp-side${open ? " open" : ""}`} aria-label="Team console">
        <Sidebar onCollapse={() => { if (open) setOpen(false); else setCollapsed((c) => !c); }} />
      </aside>
      {open && <button type="button" className="tapp-scrim" aria-label="Close menu" onClick={() => setOpen(false)} />}
      <div className="tapp-body">
        <div className="tapp-mobilebar">
          <button type="button" className="tapp-icon-btn" aria-label="Open menu" onClick={() => setOpen(true)}><IconPanel size={18} /></button>
          <span className="tapp-brand-name">{brand.name}</span>
          <span className="tapp-tag">Block 0</span>
        </div>
        {collapsed && (
          <button type="button" className="tapp-icon-btn tapp-expand" aria-label="Show the sidebar" onClick={() => setCollapsed(false)}><IconPanel size={18} /></button>
        )}
        <main className="tapp-main">{children}</main>
      </div>
      <StatusBar />
    </div>,
    document.body,
  );
}

/// The open wallet sets forget their keys after 15 minutes without input, whichever page of the
/// console is showing: the keys live in one place, so the lock does too.
function WalletSetsGuard() {
  const { accounts } = useUnlocked();
  useIdleLock(accounts.length > 0, lockAll);
  return null;
}

function Sidebar({ onCollapse }: { onCollapse: () => void }) {
  const drafts = useDrafts();
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();
  const [q, setQ] = useState("");
  const [onlyLive, setOnlyLive] = useState(false);
  const [featuresOpen, setFeaturesOpen] = useState(true);
  const search = useRef<HTMLInputElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const [importError, setImportError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); search.current?.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const needle = q.trim().toLowerCase().replace(/^\$/, "");
  const shown = drafts
    .filter((d) => !onlyLive || d.token)
    .filter((d) => !needle || d.name.toLowerCase().includes(needle) || d.symbol.toLowerCase().includes(needle) || (d.token ?? "").toLowerCase().includes(needle));
  const current = params.get("draft");
  const watching = params.get("token")?.toLowerCase();

  function create() {
    const d = newDraft();
    router.push(`/launch/team?draft=${d.id}`);
  }

  async function onFile(f: File | undefined) {
    setImportError(null);
    if (!f) return;
    try {
      const d = importDraft(JSON.parse(await f.text()));
      if (!d) throw new Error("bad");
      router.push(`/launch/team?draft=${d.id}`);
    } catch {
      setImportError("That file is not a launch draft.");
    }
    if (file.current) file.current.value = "";
  }

  const features = [
    { href: "/launch/team/wallets", label: "Wallets", icon: <IconWallet size={17} /> },
    { href: "/launch/team/desk", label: "Desk", icon: <IconCoins size={17} /> },
    { href: "/launch/team/tracker", label: "Tracker", icon: <IconTracker size={17} /> },
    { href: "/launch/team/dashboard", label: "Dashboard", icon: <IconDashboard size={17} /> },
  ];

  return (
    <>
      <div className="tapp-side-head">
        <Link href="/launch/team" className="tapp-brand">
          <span className="tapp-brand-dot" aria-hidden="true" />
          <span className="tapp-brand-name">{brand.name}</span>
          <span className="tapp-brand-ver">block 0</span>
        </Link>
        <button type="button" className="tapp-icon-btn" aria-label="Hide the sidebar" onClick={onCollapse}><IconPanel size={18} /></button>
      </div>

      <div className="tapp-search-row">
        <label className="tapp-search">
          <IconSearch size={16} />
          <input ref={search} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search launches" />
          <kbd>⌘K</kbd>
        </label>
        <button type="button" className={`tapp-icon-btn${onlyLive ? " on" : ""}`} aria-pressed={onlyLive} title={onlyLive ? "Showing launched only" : "Show launched only"} onClick={() => setOnlyLive((v) => !v)}>
          <IconFilter size={16} />
        </button>
      </div>

      <nav className="tapp-drafts" aria-label="Launches">
        {shown.length === 0 && (
          <p className="tapp-empty">{drafts.length ? "Nothing matches." : "No launches yet. Create one below."}</p>
        )}
        {shown.map((d) => (
          <DraftRow key={d.id} d={d} active={path === "/launch/team" && (d.id === current || (!!d.token && d.token.toLowerCase() === watching))} />
        ))}
      </nav>

      <div className="tapp-features">
        <button type="button" className="tapp-features-head" aria-expanded={featuresOpen} onClick={() => setFeaturesOpen((v) => !v)}>
          Features <IconChevron size={14} className={featuresOpen ? "" : "rot"} />
        </button>
        {featuresOpen && features.map((f) => (
          <Link key={f.href} href={f.href} className={`tapp-feature${path === f.href ? " active" : ""}`}>
            {f.icon}{f.label}
          </Link>
        ))}
        <Link href="/discover" className="tapp-feature dim"><IconBack size={17} />Back to {brand.name}</Link>
      </div>

      <div className="tapp-side-foot">
        <Funder />
        {importError && <p className="tapp-error">{importError}</p>}
        <div className="tapp-side-actions">
          <button type="button" className="tapp-btn" onClick={() => file.current?.click()}><IconImport size={16} />Import</button>
          <input ref={file} type="file" accept="application/json,.json" hidden onChange={(e) => onFile(e.target.files?.[0])} />
          <button type="button" className="tapp-btn tapp-btn-accent" onClick={create}><IconRocket size={16} />Create Launch</button>
        </div>
      </div>
    </>
  );
}

function DraftRow({ d, active }: { d: Draft; active: boolean }) {
  const href = d.token ? `/launch/team?token=${d.token}` : `/launch/team?draft=${d.id}`;
  const img = d.image ? imageUrl(d.image) : "";
  return (
    <Link href={href} className={`tapp-draft${active ? " active" : ""}`}>
      <span className="tapp-avatar">
        {img ? <img src={img} alt="" /> : <span>{(d.symbol || d.name || "?").slice(0, 2).toUpperCase()}</span>}
      </span>
      <span className="tapp-draft-text">
        <strong>${d.symbol || "TICKER"}</strong>
        <small>{d.name || "Untitled"}</small>
      </span>
      <span className={`tapp-badge${d.token ? " live" : ""}`}>{d.token ? "Live" : "Draft"}</span>
    </Link>
  );
}

function Funder() {
  const { address, isConnected } = useAccount();
  const { data: balance } = useBalance({ address });
  const { connect, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const connector = usePreferredConnector();
  const [open, setOpen] = useState(false);

  if (!isConnected) {
    return (
      <button type="button" className="tapp-funder" disabled={isPending || !connector} onClick={() => connector && connect({ connector })}>
        <IconWallet size={16} /><span>{isPending ? "Connecting…" : "Connect funder wallet"}</span>
      </button>
    );
  }
  return (
    <div className="tapp-funder-wrap">
      <button type="button" className="tapp-funder" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <IconWallet size={16} />
        <span>Funder <em className="mono">{shortAddress(address!)}</em></span>
        <IconChevron size={16} className={open ? "rot180" : ""} />
      </button>
      {open && (
        <div className="tapp-funder-menu">
          <div className="row"><span>Balance</span><strong className="mono">{balance ? `${fmt(balance.value, 18, 4)} ETH` : "…"}</strong></div>
          <div className="row"><span>Address</span><strong className="mono">{shortAddress(address!)}</strong></div>
          <p>This wallet pays for the launch and every team buy in it.</p>
          <button type="button" className="tapp-btn" onClick={() => { setOpen(false); disconnect(); }}>Disconnect</button>
        </div>
      )}
    </div>
  );
}

interface PairRow { symbol: string; usd: number | null }

function StatusBar() {
  const health = useQuery({
    queryKey: ["tapp-health"],
    queryFn: async () => {
      const t0 = performance.now();
      const res = await fetch(`${API}/health`, { cache: "no-store" });
      const ms = Math.round(performance.now() - t0);
      if (!res.ok) throw new Error(String(res.status));
      return { ms };
    },
    refetchInterval: 30_000,
    retry: false,
  });
  const pairs = useQuery({
    queryKey: ["tapp-pairs"],
    queryFn: async () => ((await (await fetch(`${API}/pairs`, { cache: "no-store" })).json()) as { pairs: PairRow[] }).pairs,
    refetchInterval: 60_000,
  });
  const eth = pairs.data?.find((p) => p.symbol === "ETH")?.usd;
  const up = health.isSuccess;
  return (
    <footer className="tapp-status">
      <span className={`tapp-live${up ? "" : health.isLoading ? " wait" : " down"}`}>
        <i />{up ? `All services are live · ${health.data.ms}ms` : health.isLoading ? "Checking services" : "API unreachable"}
      </span>
      <span className="tapp-prices">
        {eth ? <span className="mono">ETH ${eth.toLocaleString("en-US", { maximumFractionDigits: 0 })}</span> : null}
        <span className="dim">Robinhood Chain</span>
      </span>
      <span className="tapp-links">
        <Link href="/docs"><IconDoc size={14} />Documentation</Link>
      </span>
    </footer>
  );
}
