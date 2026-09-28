import { createPublicClient, http, parseAbiItem, type Address } from "viem";
import { robinhood } from "@hood/sdk";
import { pool } from "./db.js";
import { SYSTEM } from "./system.js";

/// The team's watch on its own launch: a message to a private chat when wallets that are not the
/// team's buy a block-zero launch in its first minutes.
///
/// It says what happened and nothing else. It never trades, never signs and holds no key: what the
/// team does about a crowded open is theirs to decide, on the team launch console or the desk.
///
/// Off unless TEAM_ALERT_TELEGRAM_TOKEN and TEAM_ALERT_TELEGRAM_CHAT are set; with neither, the
/// lines it would have sent are logged, which is the mode to develop it in. It is a separate bot
/// and chat from the public announcer on purpose: this one is for the team, not the floor.

const TOKEN = process.env.TEAM_ALERT_TELEGRAM_TOKEN?.trim();
const CHAT = process.env.TEAM_ALERT_TELEGRAM_CHAT?.trim();
const SITE = (process.env.TEAM_ALERT_SITE ?? process.env.NEXT_PUBLIC_SITE_URL ?? "https://famdotfun.com").replace(/\/+$/, "");
/// How long after a launch outside buys are worth a message.
const WINDOW_MS = Number(process.env.TEAM_ALERT_WINDOW_MINUTES ?? 15) * 60_000;
/// Buys are gathered for this long and sent as one message per token, so a burst is one line.
const BATCH_MS = Number(process.env.TEAM_ALERT_BATCH_SECONDS ?? 15) * 1_000;
/// A trade older than this when the indexer reaches it is history (a catch-up after a restart),
/// not news, and is not sent.
const FRESH_MS = Number(process.env.TEAM_ALERT_FRESH_SECONDS ?? 120) * 1_000;

interface Buy {
  wallet: string;
  pairAmount: bigint;
  tokenAmount: bigint;
  at: Date;
  tx: string;
}

interface Pending {
  buys: Buy[];
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, Pending>();
/// token -> { launched_at, symbol, supply, pair } for team launches, and null for launches that
/// are not; read once per token.
const launches = new Map<string, { launchedAt: Date; symbol: string; supply: bigint; decimals: number; pairSymbol: string } | null>();

async function teamLaunch(token: string) {
  if (launches.has(token)) return launches.get(token)!;
  const { rows } = await pool.query<{
    launched_at: Date; symbol: string; total_supply: string | null; team_legs: number; pair_decimals: number | null; pair_symbol: string | null;
  }>(
    `select launched_at, symbol, total_supply, team_legs, pair_decimals, pair_symbol from launches where token = $1`,
    [token],
  );
  const r = rows[0];
  // The row is written before its TeamLeg events are read, so "not yet a team launch" is not
  // remembered: only a launch old enough that its legs must be in is settled as "not one".
  if (!r) return null;
  if (!r.team_legs) {
    if (Date.now() - r.launched_at.getTime() > WINDOW_MS) launches.set(token, null);
    return null;
  }
  const value = {
    launchedAt: r.launched_at, symbol: r.symbol, supply: BigInt(r.total_supply ?? "0"),
    decimals: r.pair_decimals ?? 18, pairSymbol: r.pair_symbol ?? "ETH",
  };
  launches.set(token, value);
  return value;
}

/// Addresses that hold tokens for the machine, not for a person: every protocol contract, this
/// launch's own parts, and the token lock, which holds the team's locked legs in their names.
let tokenLock: string | null | undefined;
async function machineHolders(token: string): Promise<string[]> {
  if (tokenLock === undefined) {
    try {
      const client = createPublicClient({ chain: robinhood, transport: http(process.env.HOOD_RPC ?? robinhood.rpcUrls.default.http[0]!) });
      tokenLock = String(await client.readContract({
        address: process.env.HOOD_FACTORY as Address, abi: [parseAbiItem("function firstBuyLocker() view returns (address)")],
        functionName: "firstBuyLocker",
      })).toLowerCase();
    } catch {
      tokenLock = null;
    }
  }
  const { rows } = await pool.query<{ curve: string | null; locker: string | null; splitter: string | null; hook: string | null; pot: string | null }>(
    `select curve, locker, splitter, hook, pot from launches where token = $1`, [token],
  );
  const own = rows[0] ? Object.values(rows[0]).filter((v): v is string => Boolean(v)) : [];
  return [...SYSTEM, ...own, ...(tokenLock ? [tokenLock] : []), "0x000000000000000000000000000000000000dead"]
    .map((a) => a.toLowerCase());
}

async function isTeam(token: string, wallet: string) {
  const { rows } = await pool.query(`select 1 from team_wallets where token = $1 and wallet = $2`, [token, wallet]);
  return rows.length > 0;
}

function amount(v: bigint, decimals: number, digits = 4): string {
  const s = v.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).slice(0, digits).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

function pct(part: bigint, whole: bigint): string {
  if (whole === 0n) return "?";
  return `${(Number((part * 1_000_000n) / whole) / 10_000).toFixed(2)}%`;
}

async function send(text: string) {
  if (!TOKEN || !CHAT) {
    console.log(`team alert (no chat configured):\n${text}`);
    return;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT, text, disable_web_page_preview: true }),
    });
    if (!res.ok) console.warn(`team alert: telegram answered ${res.status}`);
  } catch (err) {
    console.warn("team alert: telegram unreachable", err instanceof Error ? err.message : err);
  }
}

async function flush(token: string) {
  const p = pending.get(token);
  pending.delete(token);
  const launch = launches.get(token);
  if (!p || !launch) return;
  const seconds = (at: Date) => Math.max(0, Math.round((at.getTime() - launch.launchedAt.getTime()) / 1000));
  const bought = p.buys.reduce((s, b) => s + b.tokenAmount, 0n);
  const { rows } = await pool.query<{ outside: string | null }>(
    `select sum(b.balance) as outside from balances b
      where b.token = $1 and b.balance > 0
        and not exists (select 1 from team_wallets t where t.token = b.token and t.wallet = b.address)
        and b.address <> all($2::text[])`,
    [token, await machineHolders(token)],
  );
  const lines = p.buys.slice(0, 8).map((b) =>
    `  ${b.wallet.slice(0, 6)}…${b.wallet.slice(-4)} bought ${pct(b.tokenAmount, launch.supply)} for ${amount(b.pairAmount, launch.decimals)} ${launch.pairSymbol}, ${seconds(b.at)} s after launch`);
  if (p.buys.length > 8) lines.push(`  and ${p.buys.length - 8} more`);
  await send([
    `$${launch.symbol}: ${p.buys.length} outside ${p.buys.length === 1 ? "buy" : "buys"}, ${pct(bought, launch.supply)} of the supply`,
    ...lines,
    `Outside wallets hold about ${pct(BigInt(rows[0]?.outside ?? "0"), launch.supply)} now.`,
    `${SITE}/token/${token}`,
  ].join("\n"));
}

/// Called by the indexer for every buy it writes, on both machines.
export async function teamWatch(input: { token: string; wallet: string; pairAmount: bigint; tokenAmount: bigint; at: Date; tx: string }) {
  try {
    if (Date.now() - input.at.getTime() > FRESH_MS) return;
    const launch = await teamLaunch(input.token);
    if (!launch) return;
    if (input.at.getTime() - launch.launchedAt.getTime() > WINDOW_MS) return;
    if (await isTeam(input.token, input.wallet)) return;
    let p = pending.get(input.token);
    if (!p) {
      p = { buys: [], timer: setTimeout(() => void flush(input.token), BATCH_MS) };
      pending.set(input.token, p);
    }
    p.buys.push(input);
  } catch (err) {
    console.warn("team alert failed", err instanceof Error ? err.message : err);
  }
}
