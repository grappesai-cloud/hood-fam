"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { API } from "./config";
import type { ChatMessage } from "./chat";

/// The market, pushed.
///
/// Every page on this app reads the indexer on a timer, and a timer is a compromise: six seconds of
/// staleness on a token page, thirty on the board. The stream closes that gap without replacing
/// anything underneath it. A `trade`, a `launch` or a `graduated` event invalidates exactly the
/// react-query keys the pages already read the market through, so the numbers refresh themselves
/// through the same queries, with the same shapes, and the polling intervals stay where they are as
/// the fallback. If the stream never connects, or dies and cannot come back, the app is the app it
/// was before this file existed.
///
/// One connection for the whole app, not one per component. A browser allows six connections to an
/// origin over HTTP/1.1, and a page with a board, a tape and a chat on it would spend three of them
/// on the same stream. Components subscribe here; the union of what they asked for decides the one
/// URL that is open.

export interface LiveTrade {
  token: string;
  side: "buy" | "sell";
  trader: string;
  /// Base units, as decimal strings: the amounts are bigger than a double can hold exactly.
  pairAmount: string;
  tokenAmount: string;
  price: string;
  tx: string;
  at: string;
}

export interface LiveLaunch {
  token: string;
  symbol: string;
  name: string;
  creator: string;
  mode: string;
  at: string;
}

export interface LiveGraduated {
  token: string;
  at: string;
}

export interface LiveOptions {
  /// Which launches this listener cares about. Empty means the whole market, which is what a board
  /// wants and what a token page never does.
  tokens?: string[];
  onTrade?: (trade: LiveTrade) => void;
  onLaunch?: (launch: LiveLaunch) => void;
  onGraduated?: (event: LiveGraduated) => void;
  onMessage?: (message: ChatMessage) => void;
}

const EVENTS = ["trade", "launch", "graduated", "message"] as const;
type EventName = (typeof EVENTS)[number];

interface Listener {
  tokens: string[];
  deliver: (name: EventName, payload: unknown) => void;
}

const listeners = new Set<Listener>();
const watchers = new Set<() => void>();

let source: EventSource | null = null;
/// The token list the open stream was opened with, so a subscription that changes nothing does not
/// tear the connection down and build it again.
let openFor: string | null = null;
let attempts = 0;
let connecting: ReturnType<typeof setTimeout> | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;
let lastEvent = 0;
let live = false;

/// The union of what every listener asked for, in the spelling it was asked in. Addresses are
/// compared without case because one page can hold the address as the URL spells it and another as
/// the indexer spells it, and two spellings of one launch would open two streams.
function wanted(): string {
  const tokens = new Map<string, string>();
  for (const listener of listeners) {
    if (!listener.tokens.length) return "";
    for (const token of listener.tokens) {
      const lower = token.toLowerCase();
      if (!tokens.has(lower)) tokens.set(lower, token);
    }
  }
  return [...tokens.values()].join(",");
}

function announce(next: boolean) {
  if (live === next) return;
  live = next;
  for (const notify of watchers) notify();
}

function drop() {
  if (source) {
    try {
      source.close();
    } catch {
      /* a source the browser has already given up on */
    }
    source = null;
  }
  openFor = null;
  announce(false);
}

function alive() {
  lastEvent = Date.now();
  attempts = 0;
  announce(true);
}

/// The API says `ping` every twenty five seconds precisely so a client can tell a quiet market from
/// a dead connection. A proxy that drops the socket without closing it leaves an EventSource that
/// is open and silent for ever, and the missing pings are the only sign of it.
function watch() {
  if (heartbeat) return;
  heartbeat = setInterval(() => {
    if (!source || Date.now() - lastEvent < 70_000) return;
    drop();
    schedule();
  }, 20_000);
}

function stop() {
  drop();
  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
  if (retry) {
    clearTimeout(retry);
    retry = null;
  }
  if (calm) {
    clearTimeout(calm);
    calm = null;
  }
  pending.clear();
  attempts = 0;
}

/// Backoff, because the endpoint may simply not be there. An EventSource reconnects by itself every
/// few seconds whatever the answer was, which against a 404 is a flood; closing it and coming back
/// on a doubling delay is the same patience a reconnect deserves and none of the noise.
function schedule() {
  if (retry || !listeners.size) return;
  const wait = Math.min(30_000, 1_000 * 2 ** Math.min(attempts, 5));
  attempts += 1;
  // Jitter, so every tab that was open when the API restarted does not come back on the same tick.
  retry = setTimeout(() => {
    retry = null;
    connect();
  }, wait + Math.random() * 500);
}

/// The keys the market is already read through, named where the pages name them.
///
/// `app/page.tsx` holds the board on ["stats"], ["tokens", sort, q] and ["tape"]; the pit brand's
/// shell runs a tape of its own on ["pit-tape"]. A token page holds ["token"], ["trades"] and
/// ["holders"], all keyed by address, and the chart adds ["candles"]. Inventing new keys here would
/// leave the old ones to their timers and refresh nothing anybody is looking at.
const BOARD_QUERIES = new Set(["tokens", "stats", "tape", "pit-tape", "activity", "top-traders"]);
const TOKEN_QUERIES = new Set(["token", "trades", "holders", "candles"]);

/// A busy launch trades several times a second. Refetching on each one would redraw the board under
/// the reader's cursor and reorder the rows they were halfway through, so events are collected and
/// the pages are refreshed at most this often. The first event of a quiet minute still lands at once.
const CALM_MS = 3_000;

/// The app has one query client, and this is it: whichever one the hooks are mounted against. It is
/// taken in an effect rather than at render, so nothing here runs while React is drawing.
let client: QueryClient | null = null;
const pending = new Set<string>();
let calm: ReturnType<typeof setTimeout> | null = null;
let refreshed = 0;

function flush() {
  if (calm) {
    clearTimeout(calm);
    calm = null;
  }
  refreshed = Date.now();
  const tokens = new Set(pending);
  pending.clear();
  const target = client;
  if (!target) return;
  // Matched by hand rather than by key, because an address is a string with two spellings and
  // react-query compares keys exactly.
  void target.invalidateQueries({
    predicate: (query) => {
      const [name, argument] = query.queryKey as [unknown, unknown];
      if (typeof name !== "string") return false;
      if (BOARD_QUERIES.has(name)) return true;
      if (!TOKEN_QUERIES.has(name) || typeof argument !== "string") return false;
      return tokens.has(argument.toLowerCase());
    },
  });
}

function queue(token?: string) {
  if (token) pending.add(token.toLowerCase());
  const wait = CALM_MS - (Date.now() - refreshed);
  if (wait <= 0) flush();
  else if (!calm) calm = setTimeout(flush, wait);
}

function receive(name: EventName, event: MessageEvent) {
  alive();
  let payload: unknown;
  try {
    payload = JSON.parse(String(event.data));
  } catch {
    return;
  }
  const token = (payload as { token?: unknown }).token;
  // Once per event, not once per component listening to it. Three subscribers on a token page
  // asking for the same refresh is three requests for one trade, because invalidating a query that
  // is already in flight cancels it and starts it again.
  if (name === "trade" || name === "graduated") queue(typeof token === "string" ? token : undefined);
  else if (name === "launch") queue();
  for (const listener of listeners) {
    if (listener.tokens.length) {
      if (typeof token !== "string") continue;
      if (!listener.tokens.some((t) => t.toLowerCase() === token.toLowerCase())) continue;
    }
    try {
      listener.deliver(name, payload);
    } catch {
      /* a page that throws on an event is a bug in that page, not a reason to lose the stream */
    }
  }
}

function connect() {
  if (typeof window === "undefined") return;
  if (!listeners.size) {
    stop();
    return;
  }
  const tokens = wanted();
  if (source && openFor === tokens) return;
  drop();
  try {
    const opened = new EventSource(tokens ? `${API}/stream?tokens=${encodeURIComponent(tokens)}` : `${API}/stream`);
    source = opened;
    openFor = tokens;
    lastEvent = Date.now();
    opened.onopen = () => {
      if (source === opened) alive();
    };
    opened.onerror = () => {
      // Distinguishing "the API is restarting" from "there is no such endpoint" is not possible
      // from here: both arrive as this one event with nothing on it. Both are answered the same way.
      if (source === opened) {
        drop();
        schedule();
      }
    };
    opened.addEventListener("ping", () => {
      if (source === opened) alive();
    });
    for (const name of EVENTS) {
      opened.addEventListener(name, (event) => {
        if (source === opened) receive(name, event as MessageEvent);
      });
    }
    watch();
  } catch {
    // A base URL the browser will not build a source from is a stream that will never open, and the
    // constructor throwing must not reach the effect that called it.
    drop();
    schedule();
  }
}

/// Mounting a page mounts several subscribers in one tick, and each of them can change the union.
/// Deciding once, after the tick, opens one connection instead of three.
function plan() {
  if (connecting) return;
  connecting = setTimeout(() => {
    connecting = null;
    connect();
  }, 0);
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  plan();
  return () => {
    listeners.delete(listener);
    if (listeners.size) plan();
    else stop();
  };
}

/// Whether the app is being pushed to at this moment. A page uses it to say so, and to say nothing
/// rather than claim "live" while it is really polling.
export function useLiveStatus(): boolean {
  // The server knows nothing about a connection and neither does the first client render, or the
  // two would not agree.
  return useSyncExternalStore(
    (notify) => {
      watchers.add(notify);
      return () => watchers.delete(notify);
    },
    () => live,
    () => false,
  );
}

export function useLive(options: LiveOptions = {}): boolean {
  const queryClient = useQueryClient();
  // The callbacks are new objects on every render and the subscription must not be. The token list
  // is the only thing that decides it.
  const latest = useRef(options);
  latest.current = options;
  const watching = (options.tokens ?? []).filter(Boolean).join(",").toLowerCase();

  useEffect(() => {
    client = queryClient;
    const unsubscribe = subscribe({
      tokens: watching ? watching.split(",") : [],
      deliver(name, payload) {
        const handlers = latest.current;
        if (name === "trade") handlers.onTrade?.(payload as LiveTrade);
        else if (name === "launch") handlers.onLaunch?.(payload as LiveLaunch);
        else if (name === "graduated") handlers.onGraduated?.(payload as LiveGraduated);
        else handlers.onMessage?.(payload as ChatMessage);
      },
    });
    return unsubscribe;
  }, [watching, queryClient]);

  return useLiveStatus();
}
