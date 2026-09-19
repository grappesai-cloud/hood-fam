"use client";

import { useEffect, useRef, useState } from "react";

/// A number that resolves out of a scramble when it changes, the way Lighter's hero text settles
/// into a word. On a market page it is not an ornament: it is the thing that tells you at a glance
/// that a figure just moved, which a number that silently swaps from 8.524 to 8.910 never does.
///
/// It only ever scrambles the characters it is about to replace, keeps the width fixed so nothing
/// on the page shifts, and does nothing at all for anybody who asked for less motion.
const GLYPHS = "0123456789#%$*+=-";

export function Ticker({ value, className }: { value: string; className?: string }) {
  const [shown, setShown] = useState(value);
  const previous = useRef(value);
  const frame = useRef(0);

  useEffect(() => {
    if (value === previous.current) return;
    previous.current = value;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setShown(value);
      return;
    }

    const started = performance.now();
    const settle = 420;
    const tick = (now: number) => {
      const done = Math.min(1, (now - started) / settle);
      // Characters lock in from the left, so the number reads as arriving rather than as noise.
      const locked = Math.floor(done * value.length);
      const out = value
        .split("")
        .map((ch, i) => (i < locked || ch === " " || ch === "." || ch === "," ? ch : GLYPHS[Math.floor(Math.random() * GLYPHS.length)]))
        .join("");
      setShown(out);
      if (done < 1) frame.current = requestAnimationFrame(tick);
      else setShown(value);
    };
    frame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame.current);
  }, [value]);

  return <span className={className} style={{ fontVariantNumeric: "tabular-nums" }}>{shown}</span>;
}
