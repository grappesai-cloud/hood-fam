"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLive } from "@/lib/live";

/// The market, heard.
///
/// Three cues, synthesised on the spot out of two oscillator envelopes each: nothing is downloaded,
/// nothing can 404, and the whole thing weighs a few hundred bytes of code rather than a folder of
/// audio. A buy on this launch is one short note, ninety percent of the way to the pool is a rise,
/// and graduation is three notes.
///
/// The rules matter more than the notes. It is off until somebody turns it on, the choice is
/// remembered, the audio context is only ever built inside a real gesture because every browser
/// refuses one built anywhere else, nothing plays into a tab nobody is looking at, and for a reader
/// who asked for less motion there is no toggle and no sound at all. Quiet and short on purpose:
/// this is a market, not a slot machine.

const KEY = "hood.sound";
/// The last tenth of the road to the pool, which is the part worth hearing about.
const NEAR = 0.9;
/// A launch can trade several times a second, and a note per trade is a fire alarm.
const MIN_GAP_MS = 900;

type Cue = "buy" | "near" | "graduated";

/// Frequency, when it starts, how long it lasts, how loud it peaks. Peaks stay under a tenth so a
/// cue sits under whatever the reader is already listening to.
const CUES: Record<Cue, [number, number, number, number][]> = {
  buy: [[523.25, 0, 0.11, 0.05]],
  near: [[587.33, 0, 0.1, 0.045], [880, 0.09, 0.16, 0.05]],
  graduated: [[523.25, 0, 0.12, 0.05], [659.25, 0.1, 0.12, 0.05], [783.99, 0.2, 0.3, 0.055]],
};

export function Sound({ token, progress }: { token: string; progress: number }) {
  /// Whether this reader is one the app makes any sound for at all. It is a media query, so it is
  /// only knowable on the client, and it can change while the page is open.
  const [allowed, setAllowed] = useState(false);
  const [on, setOn] = useState(false);
  const audio = useRef<AudioContext | null>(null);
  const spoke = useRef(0);
  const enabled = useRef(false);
  enabled.current = on && allowed;
  /// Whether this launch was already inside the last tenth when the page opened, so arriving on a
  /// launch at ninety five percent is not announced as a crossing that never happened.
  const near = useRef(progress >= NEAR);

  useEffect(() => {
    const quiet = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setAllowed(!quiet.matches);
    apply();
    quiet.addEventListener("change", apply);
    // The choice is per browser and the app is the only thing that writes it; anything else in
    // there, or no storage at all in a private window, is simply off.
    try {
      setOn(localStorage.getItem(KEY) === "on");
    } catch {
      /* a browser that refuses storage is a browser that starts quiet */
    }
    return () => quiet.removeEventListener("change", apply);
  }, []);

  /// The context, built or resumed. Safari suspends one whenever the tab loses focus, so resuming
  /// is not something that happens once.
  const wake = useCallback(() => {
    if (!audio.current) {
      const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      audio.current = new Ctor();
    }
    if (audio.current.state === "suspended") void audio.current.resume();
    return audio.current;
  }, []);

  const play = useCallback(
    (cue: Cue) => {
      if (!enabled.current) return;
      // A tab nobody is looking at is a tab that says nothing. Browsers throttle timers there and
      // a note that arrives out of its envelope is a click rather than a cue.
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      const now = Date.now();
      if (cue === "buy" && now - spoke.current < MIN_GAP_MS) return;
      // The context is never built here: a cue is not a gesture, and one built outside a gesture
      // is born suspended. If the gesture has not happened yet the cue is simply missed.
      const ctx = audio.current;
      if (!ctx || ctx.state !== "running") return;
      spoke.current = now;
      const start = ctx.currentTime + 0.01;
      for (const [freq, at, dur, peak] of CUES[cue]) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(freq, start + at);
        // An envelope rather than a switch: gain that jumps from nothing to something is a click
        // on every device, and exponential ramps cannot touch zero, hence the near zero floor.
        gain.gain.setValueAtTime(0.0001, start + at);
        gain.gain.exponentialRampToValueAtTime(peak, start + at + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + at + dur);
        osc.connect(gain).connect(ctx.destination);
        osc.start(start + at);
        osc.stop(start + at + dur + 0.02);
      }
    },
    [],
  );

  // The launch this toggle sits on, and only that one: the tape underneath it is this launch's
  // trades, and a note for a buy the reader cannot see on screen is a note they cannot place.
  useLive({
    tokens: [token],
    onTrade: (trade) => {
      if (trade.side === "buy") play("buy");
    },
    onGraduated: () => play("graduated"),
  });

  // The stream carries trades, not progress, so the crossing is read off the number the page
  // already refreshes on every trade.
  useEffect(() => {
    const inside = progress >= NEAR;
    const before = near.current;
    near.current = inside;
    if (inside && !before) play("near");
  }, [progress, play]);

  // Sound that was left on in an earlier session still needs a gesture before a browser will let
  // anything through, so the first touch or key anywhere on the page arms it.
  useEffect(() => {
    if (!on || !allowed || audio.current) return;
    const arm = () => wake();
    document.addEventListener("pointerdown", arm, { once: true, passive: true });
    document.addEventListener("keydown", arm, { once: true });
    return () => {
      document.removeEventListener("pointerdown", arm);
      document.removeEventListener("keydown", arm);
    };
  }, [on, allowed, wake]);

  // A reader who turns motion off mid session has turned this off too.
  useEffect(() => {
    if (allowed) return;
    void audio.current?.close();
    audio.current = null;
  }, [allowed]);

  useEffect(
    () => () => {
      void audio.current?.close();
      audio.current = null;
    },
    [],
  );

  const toggle = () => {
    const next = !on;
    setOn(next);
    try {
      localStorage.setItem(KEY, next ? "on" : "off");
    } catch {
      /* private window: the choice holds for this tab, which is still a working toggle */
    }
    if (next) {
      // This click is the gesture the browser was waiting for, and the confirmation is the buy
      // cue itself, so nobody turns it on and wonders what they agreed to.
      const ctx = wake();
      if (ctx) {
        enabled.current = true;
        spoke.current = 0;
        // Resuming is a promise, and a note scheduled on a context that is still suspended is a
        // note nobody hears, so the confirmation waits for the context to actually be running.
        void ctx.resume().then(() => play("buy"));
      }
    } else {
      void audio.current?.close();
      audio.current = null;
    }
  };

  // No toggle for a reader who asked for less motion, because a control that says it makes a sound
  // and then makes none is worse than no control. The first client render matches the server's.
  if (!allowed) return null;

  return (
    <div className="sound-row">
      <button
        type="button"
        className={on ? "sound-toggle is-on" : "sound-toggle"}
        aria-pressed={on}
        aria-label="Play a short sound on a buy, at ninety percent of the way to the pool, and on graduation"
        title="A short sound on a buy, at ninety percent of the way to the pool, and on graduation"
        onClick={toggle}
      >
        <i className="sound-dot" aria-hidden="true" />
        {on ? "sound on" : "sound off"}
        <span className="sound-what">buys, 90%, graduation</span>
      </button>
    </div>
  );
}
