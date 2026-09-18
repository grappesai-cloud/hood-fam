import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/// The thing that says a launch happened.
///
/// A launchpad nobody hears about is a launchpad nobody trades on, and the two moments worth
/// hearing about are the same two the board is built around: a token was printed, and a token
/// graduated into a locked pool. This watches the read API for both and posts them.
///
/// Deliberately a reader, not an insider: it holds no key, touches no database and knows nothing
/// the public API does not serve, so the worst a broken announcer can do is stay quiet. It is also
/// why it can be pointed at a preview to see what it would say.
///
/// With no channel configured it still runs and logs every post it would have made, which is the
/// mode to develop it in.

const API = (process.env.HOOD_API ?? "http://api:8080").replace(/\/+$/, "");
const SITE = (process.env.HOOD_SITE ?? "https://hood.fam").replace(/\/+$/, "");
const INTERVAL = Number(process.env.ANNOUNCER_INTERVAL_MS ?? 60_000);
const STATE = process.env.ANNOUNCER_STATE ?? "/state/announcer.json";
/// A launch with no trading behind it is noise. Graduations are always worth saying.
const MIN_USD = Number(process.env.ANNOUNCE_MIN_USD ?? 0);
/// Nothing older than this is ever announced, however far behind the state file is: waking up
/// after a week down and posting a week of launches is worse than saying nothing.
const MAX_AGE_MS = Number(process.env.ANNOUNCE_MAX_AGE_MINUTES ?? 180) * 60_000;

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT = process.env.TELEGRAM_CHAT_ID;
/// Any endpoint that takes {"content": "..."} as JSON, which is Discord's shape and most others'.
const WEBHOOK = process.env.ANNOUNCE_WEBHOOK;

interface Token {
  token: string;
  name: string;
  symbol: string;
  mode: string;
  status: string;
  launched_at: string;
  graduated_at: string | null;
  volume_usd: string | number;
  volume_total: string;
  fee_model: number;
  creator: string;
}

interface State { launchedThrough: string; graduatedThrough: string }

const FEE_MODEL = ["stakers take the fee", "the fee buys and burns", "the fee deepens the pool", "the creator keeps the fee", "no creator fee"];

const iso = (d: Date) => d.toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function loadState(): Promise<State | null> {
  try {
    return JSON.parse(await readFile(STATE, "utf8")) as State;
  } catch {
    return null;
  }
}

async function saveState(state: State): Promise<void> {
  await mkdir(dirname(STATE), { recursive: true }).catch(() => undefined);
  await writeFile(STATE, JSON.stringify(state, null, 1));
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return (await res.json()) as T;
}

/// One post, to every channel that is configured. A channel that fails is logged and skipped
/// rather than thrown: losing Telegram must not also lose the webhook, and neither must stop the
/// watermark from moving, or the next pass would repeat what did go out.
async function post(text: string): Promise<void> {
  console.log(`announce: ${text.replace(/\n/g, " | ")}`);
  if (TELEGRAM_TOKEN && TELEGRAM_CHAT) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: TELEGRAM_CHAT, text, disable_web_page_preview: false }),
      });
      if (!res.ok) console.error(`telegram: ${res.status} ${(await res.text()).slice(0, 200)}`);
    } catch (e) {
      console.error("telegram:", e instanceof Error ? e.message : e);
    }
  }
  if (WEBHOOK) {
    try {
      const res = await fetch(WEBHOOK, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: text }),
      });
      if (!res.ok) console.error(`webhook: ${res.status}`);
    } catch (e) {
      console.error("webhook:", e instanceof Error ? e.message : e);
    }
  }
}

const eth = (wei: string) => (Number(BigInt(wei || "0") / 10n ** 12n) / 1e6).toFixed(3);

function launchLine(t: Token): string {
  const machine = t.mode === "direct"
    ? "the whole supply in the pool from the first block"
    : "on a bonding curve";
  return [
    `${t.name} ($${t.symbol}) just launched on hood.fam.`,
    `${machine}, ${FEE_MODEL[t.fee_model] ?? "its own fee rule"}.`,
    `${SITE}/token/${t.token}`,
  ].join("\n");
}

function graduationLine(t: Token): string {
  return [
    `$${t.symbol} graduated.`,
    `${eth(t.volume_total)} ETH traded on the way, and the position is locked for good.`,
    `${SITE}/token/${t.token}`,
  ].join("\n");
}

async function pass(state: State): Promise<State> {
  const now = Date.now();
  const fresh = (when: string | null) => Boolean(when && now - new Date(when).getTime() < MAX_AGE_MS);

  const { tokens: newest } = await get<{ tokens: Token[] }>("/tokens?limit=50");
  // Oldest first, so a burst of launches reads in the order it happened.
  const launches = newest
    .filter((t) => t.launched_at > state.launchedThrough && fresh(t.launched_at) && Number(t.volume_usd ?? 0) >= MIN_USD)
    .sort((a, b) => a.launched_at.localeCompare(b.launched_at));

  for (const t of launches) {
    await post(launchLine(t));
    state = { ...state, launchedThrough: t.launched_at };
    await saveState(state);
    await sleep(1_000);
  }

  const { tokens: graduated } = await get<{ tokens: Token[] }>("/tokens?status=graduated&sort=graduated&limit=50");
  const grads = graduated
    .filter((t) => t.graduated_at && t.graduated_at > state.graduatedThrough && fresh(t.graduated_at))
    .sort((a, b) => (a.graduated_at ?? "").localeCompare(b.graduated_at ?? ""));

  for (const t of grads) {
    await post(graduationLine(t));
    state = { ...state, graduatedThrough: t.graduated_at! };
    await saveState(state);
    await sleep(1_000);
  }

  return state;
}

async function main() {
  const channels = [TELEGRAM_TOKEN && TELEGRAM_CHAT ? "telegram" : null, WEBHOOK ? "webhook" : null].filter(Boolean);
  console.log(
    channels.length
      ? `announcer: watching ${API}, posting to ${channels.join(" and ")}`
      : `announcer: watching ${API}, no channel configured, so every post is only logged`,
  );

  let state = await loadState();
  if (!state) {
    // A first run has no idea what has already been said, and the honest assumption is "everything".
    // Starting from now means the first thing it posts is the first thing that happens next.
    state = { launchedThrough: iso(new Date()), graduatedThrough: iso(new Date()) };
    await saveState(state);
    console.log("announcer: first run, starting from now and saying nothing about the past");
  }

  for (;;) {
    try {
      state = await pass(state);
    } catch (e) {
      console.error("announcer:", e instanceof Error ? e.message : e);
    }
    await sleep(INTERVAL);
  }
}

await main();
