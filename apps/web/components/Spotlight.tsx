"use client";

import { useEffect } from "react";

/// Light that follows the pointer across a glass surface. Lifted from the Night Agents landing,
/// where it is `.card-spotlight` with `--mouse-x` and `--mouse-y` fed from JS, and narrowed to one
/// delegated listener for the whole document rather than one per card: a board can hold sixty
/// cards, and sixty listeners for a highlight is sixty too many.
///
/// It does nothing at all for anybody who asked for less motion, and nothing on a touch screen,
/// where there is no pointer to follow.
export function Spotlight() {
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (!window.matchMedia("(hover: hover)").matches) return;

    let frame = 0;
    let pending: { el: HTMLElement; x: number; y: number } | undefined;

    const paint = () => {
      frame = 0;
      if (!pending) return;
      pending.el.style.setProperty("--mx", `${pending.x}px`);
      pending.el.style.setProperty("--my", `${pending.y}px`);
      pending = undefined;
    };

    const move = (e: PointerEvent) => {
      const el = (e.target as Element | null)?.closest?.(".spot") as HTMLElement | null;
      if (!el) return;
      const r = el.getBoundingClientRect();
      pending = { el, x: e.clientX - r.left, y: e.clientY - r.top };
      // One write per frame: pointermove fires far faster than the screen refreshes, and setting a
      // custom property on every event is how a highlight turns into jank.
      if (!frame) frame = requestAnimationFrame(paint);
    };

    document.addEventListener("pointermove", move, { passive: true });
    return () => {
      document.removeEventListener("pointermove", move);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  return null;
}
