"use client";

import { useEffect, useRef } from "react";
import { useLive } from "@/lib/live";

/// Where the money goes, moving.
///
/// The split was a sentence: "60% stakers, 40% buy back and burn". A sentence is read once and
/// believed or not. This is the same numbers as a picture that runs: every trade drops a coin into
/// the trunk, the trunk forks into the legs the creator chose, each coin picks a leg at random in
/// proportion to its share, and the end of each leg does what that leg does when the coin lands on
/// it. The fire flares on a buy back. The vault thumps and pays out to the people who locked. The
/// pool swells. The creator's wallet lights up. Watch it for ten seconds and the percentages are
/// no longer a claim, they are a rate you can see.
///
/// It is driven by the real stream: a trade on this token pushes coins through immediately, and a
/// slow idle drip keeps the shape alive on a quiet token. The legs and their widths come from the
/// launch itself, so a diagram that shows a leg is a leg that exists on chain.

export interface FlowLeg {
  key: "stakers" | "buyback" | "liquidity" | "creator";
  label: string;
  bps: number;
}

const LANES: Record<number, number[]> = {
  1: [160],
  2: [100, 220],
  3: [55, 160, 265],
  4: [40, 120, 200, 280],
};

export function FeeFlow({ legs, token, source = "every trade", waiting }: {
  legs: FlowLeg[];
  token?: string;
  source?: string;
  waiting?: string;
}) {
  const live = legs.filter((l) => l.bps > 0).slice(0, 4);
  const lanes = LANES[live.length] ?? LANES[4];
  const total = live.reduce((n, l) => n + l.bps, 0) || 1;

  const paths = useRef<(SVGPathElement | null)[]>([]);
  const nodes = useRef<(SVGGElement | null)[]>([]);
  const dots = useRef<(SVGCircleElement | null)[]>([]);
  const host = useRef<SVGSVGElement | null>(null);
  const queue = useRef(0);

  // A trade is a real event with a real size, but the picture is about proportion, not size: three
  // coins say "something happened" without pretending to price anything.
  useLive({ tokens: token ? [token] : [], onTrade: () => { queue.current += 3; } });

  useEffect(() => {
    const svg = host.current;
    if (!svg) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    interface Coin { leg: number; t: number; speed: number; on: boolean }
    const coins: Coin[] = dots.current.map(() => ({ leg: 0, t: 0, speed: 0, on: false }));
    const lengths = paths.current.map((p) => p?.getTotalLength() ?? 0);

    function pick(): number {
      // Weighted by share, so the leg that takes most of the fee is the leg most coins go down.
      let r = Math.random() * total;
      for (let i = 0; i < live.length; i++) { r -= live[i].bps; if (r <= 0) return i; }
      return live.length - 1;
    }

    function spawn() {
      const free = coins.findIndex((c) => !c.on);
      if (free < 0) return;
      coins[free] = { leg: pick(), t: 0, speed: 0.26 + Math.random() * 0.12, on: true };
    }

    function land(leg: number) {
      const node = nodes.current[leg];
      if (!node) return;
      // Remove, reflow, re-add: a class that is already there does not restart its animation, and
      // two trades in the same second are exactly when the flare matters most.
      node.classList.remove("ff-hit");
      void node.getBoundingClientRect();
      node.classList.add("ff-hit");
    }

    let raf = 0;
    let last = performance.now();
    let drip = 0;
    let visible = true;

    function frame(now: number) {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      drip += dt;
      if (queue.current > 0 && drip > 0.12) { queue.current--; drip = 0; spawn(); }
      else if (drip > 1.15) { drip = 0; spawn(); }

      for (let i = 0; i < coins.length; i++) {
        const c = coins[i];
        const dot = dots.current[i];
        if (!dot) continue;
        if (!c.on) { dot.style.opacity = "0"; continue; }
        c.t += c.speed * dt;
        if (c.t >= 1) { c.on = false; dot.style.opacity = "0"; land(c.leg); continue; }
        const path = paths.current[c.leg];
        if (!path) { c.on = false; continue; }
        const p = path.getPointAtLength(c.t * lengths[c.leg]);
        dot.setAttribute("cx", String(p.x));
        dot.setAttribute("cy", String(p.y));
        // Fades in off the chip and out into the node, so nothing pops.
        dot.style.opacity = String(Math.min(1, Math.min(c.t, 1 - c.t) * 8));
      }
      raf = requestAnimationFrame(frame);
    }

    function run() {
      cancelAnimationFrame(raf);
      if (!visible || document.hidden) return;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }

    // A diagram nobody is looking at should not cost a frame. Both a hidden tab and a scrolled-past
    // panel stop the loop, which also keeps this page cheap on a phone.
    const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; run(); }, { threshold: 0 });
    io.observe(svg);
    document.addEventListener("visibilitychange", run);
    run();
    return () => { cancelAnimationFrame(raf); io.disconnect(); document.removeEventListener("visibilitychange", run); };
  }, [live.length, total, live]);

  if (live.length === 0) return null;

  return (
    <div className="feeflow">
      <svg ref={host} viewBox="0 0 320 214" className="feeflow-svg" role="img"
        aria-label={`Every trade's fee, split ${live.map((l) => `${Math.round(l.bps / 100)}% ${l.label.toLowerCase()}`).join(", ")}`}>
        <rect x="108" y="6" width="104" height="22" rx="11" className="ff-chip" />
        <text x="160" y="21" className="ff-chip-text">{source}</text>

        {live.map((leg, i) => (
          <path key={leg.key} ref={(el) => { paths.current[i] = el; }} className="ff-lane"
            style={{ strokeWidth: Math.max(2, Math.min(7, (leg.bps / total) * 14)) }}
            d={`M160 30 C 160 82, ${lanes[i]} 78, ${lanes[i]} 140`} />
        ))}

        {live.map((leg, i) => (
          <g key={leg.key} ref={(el) => { nodes.current[i] = el; }} className={`ff-node ff-${leg.key}`}
            style={{ transformOrigin: `${lanes[i]}px 164px` }}>
            <rect x={lanes[i] - 23} y={141} width="46" height="46" rx="14" className="ff-node-box" />
            <g transform={`translate(${lanes[i] - 14}, 150)`}>{GLYPH[leg.key]}</g>
            <text x={lanes[i]} y={200} className="ff-pct">{Math.round(leg.bps / 100)}%</text>
            <text x={lanes[i]} y={211} className="ff-leg">{leg.label.toLowerCase()}</text>
          </g>
        ))}

        {Array.from({ length: 14 }).map((_, i) => (
          <circle key={i} ref={(el) => { dots.current[i] = el; }} r="3.1" className="ff-coin" style={{ opacity: 0 }} />
        ))}
      </svg>
      {waiting && <p className="feeflow-waiting">{waiting}</p>}
    </div>
  );
}

/// 28 by 28, drawn once. Each one is the thing its leg does, not a bullet point about it.
const GLYPH: Record<FlowLeg["key"], React.ReactNode> = {
  // A vault: locked, and it pays.
  stakers: (
    <g className="ff-glyph">
      <rect x="3" y="5" width="22" height="18" rx="3" />
      <circle cx="14" cy="14" r="5" />
      <path d="M14 9v10M9 14h10" />
    </g>
  ),
  // Fire: the supply that came back and did not leave again.
  buyback: (
    <g className="ff-glyph">
      <path className="ff-flame" d="M14 3c3.6 5.4 7.4 6.8 7.4 12.2a7.4 7.4 0 0 1-14.8 0c0-2.8 1.8-4.8 3.7-6.5 0 2.8 1.9 3.7 2.8 1.9.9-1.9.9-4.6.9-7.6z" />
    </g>
  ),
  // Liquid, deeper each time.
  liquidity: (
    <g className="ff-glyph">
      <path d="M2 10c3.7-3 7.4 3 11 0s7.3 3 11 0" />
      <path d="M2 16c3.7-3 7.4 3 11 0s7.3 3 11 0" />
      <path d="M2 22c3.7-3 7.4 3 11 0s7.3 3 11 0" />
    </g>
  ),
  // A wallet with one coin in it.
  creator: (
    <g className="ff-glyph">
      <rect x="3" y="7" width="22" height="16" rx="3" />
      <path d="M3 11h16" />
      <circle cx="20" cy="17" r="2" />
    </g>
  ),
};
