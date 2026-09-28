"use client";

import { useEffect, useRef } from "react";

export const IDLE_LOCK_MS = 15 * 60_000;

/// Calls `onIdle` once nobody has touched the page for `ms`. A desk left open on a shared screen
/// should not stay able to sign, so an unlocked set forgets itself after a quarter of an hour of no
/// pointer, key or scroll. The check runs on an interval rather than a single timer, because a
/// background tab's timers are throttled and a long timer there can fire very late.
export function useIdleLock(active: boolean, onIdle: () => void, ms = IDLE_LOCK_MS) {
  const last = useRef(Date.now());
  const idle = useRef(onIdle);
  idle.current = onIdle;

  useEffect(() => {
    if (!active) return;
    last.current = Date.now();
    const touch = () => { last.current = Date.now(); };
    const events = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const;
    events.forEach((e) => window.addEventListener(e, touch, { passive: true }));
    const timer = window.setInterval(() => {
      if (Date.now() - last.current >= ms) idle.current();
    }, 15_000);
    return () => {
      events.forEach((e) => window.removeEventListener(e, touch));
      window.clearInterval(timer);
    };
  }, [active, ms]);
}
