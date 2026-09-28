import { createHash } from "node:crypto";
import { zeroAddress } from "viem";

import { pool } from "./db.js";
import { chainHead } from "./admin.js";
import { creditLaunch, refreshRollingVolume } from "./indexer.js";
import { usdValue } from "./price.js";
import { accrueStakePoints } from "./stake-accrual.js";
import { award } from "./points.js";
import { recordBasis } from "./pnl.js";
import { tokenArt } from "./demo-art.js";
import { storageConfigured, storeImage } from "./uploads.js";

/// A believable world, written straight into the database.
///
/// What it is for: seeing the product full. Empty tables are honest but they answer nothing about
/// how a board of twelve launches reads, what a wallet page looks like with positions in it, or
/// whether the leaderboard means anything at three thousand points. This writes exactly the rows
/// the indexer would have written if the chain had carried this activity, so every screen, every
/// query and every points rule runs on it unchanged.
///
/// What it is not: it is not on chain. The addresses are hashes, not deployments; no transaction
/// here ever happened; the buy button on a demo token writes to an address that does not exist. The
/// app says so on every page when NEXT_PUBLIC_DEMO is set, and the seeder refuses to run against a
/// deployment whose indexer is following a real chain.
///
/// Everything is derived from one seed string, so the same demo is the same demo: re-seeding does
/// not churn the art bucket and a screenshot taken today matches the world tomorrow.

const DAY = 24 * 60 * 60 * 1000;

/// 4663 makes a block every 100 ms, which is what turns a timestamp back into a block number.
const BLOCKS_PER_SECOND = 10;

/// The head to count back from when the RPC cannot be reached.
const FALLBACK_HEAD = 30_000_000;

const ONE = 10n ** 18n;
const SUPPLY = 1_000_000_000n * ONE;
const CURVE_SUPPLY = (SUPPLY * 80n) / 100n;

/// The curve's two fee legs add up to one percent of the pair amount, which is what the deployed
/// presets charge. The split between them is configuration the row does not carry, so the API
/// reads it from the same environment variables the season take does.
const FEE_BPS = 100n;

/// Where staked tokens sit while they are locked: on chain the staking contract holds them, so the
/// wallet's ERC20 balance drops. The demo keeps that true, or a portfolio would count them twice.
const STAKING = "0x57a4e0000000000000000000000000000000d3ec" as const;
/// Where a creator's locked first buy sits. Not the vault: the vault is the house coin's.
const LOCKER = "0x10c4e0000000000000000000000000000000d3ec" as const;

/// What every launch paid to exist and what an hour on the board costs, as the spec defaults them.
const LAUNCH_FEE = 2_000_000_000_000_000n; // 0.002 ETH
const SLOT_PRICE = 10_000_000_000_000_000n; // 0.01 ETH
/// A Payday share under this rolls into the next hour; a pot push under this waits. The keeper's
/// own defaults.
const PAYDAY_DUST = 10_000_000_000_000n;
const PUSH_FLOOR = 100_000_000_000_000n;
const HOUR = 60 * 60 * 1000;

const eth = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;

export interface SeedOptions {
  /// Clear every table this writes to first. Without it, a database that already holds launches is
  /// left alone: seeding on top of real rows is how a demo turns into a lie nobody can find later.
  wipe?: boolean;
  /// Draw the token art and put it in the bucket. Skipped when no bucket is configured.
  art?: boolean;
  /// How much history to write. The season opens at the start of it.
  days?: number;
  seed?: string;
}

export interface SeedSummary {
  wallets: number;
  launches: number;
  trades: number;
  stakes: number;
  points: number;
  tickets: number;
  showcase: string;
  art: "uploaded" | "skipped";
  from: Date;
  to: Date;
  /// What the Bag's tables got: the tape and every table it is summed from.
  bag: BagSummary;
}

export interface BagSummary {
  tape: number;
  penalties: number;
  potDeposits: number;
  potPayouts: number;
  paydayEpochs: number;
  paydayPayouts: number;
  boosts: number;
  burns: number;
  vaultRewards: number;
  /// Bounty points rows, already counted into the summary's points.
  bountyPoints: number;
}

// ---------------------------------------------------------------- the dice

/// One seed, one world. mulberry32: small, fast, and identical on every machine, which is the only
/// property that matters here.
function rng(seed: string): () => number {
  let a = createHash("sha256").update(seed).digest().readUInt32LE(0);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const digest = (label: string, bytes: number) =>
  `0x${createHash("sha256").update(label).digest("hex").slice(0, bytes * 2)}`;

const addressOf = (label: string) => digest(`hood.fam demo address:${label}`, 20);
const txOf = (label: string) => digest(`hood.fam demo tx:${label}`, 32);

/// The Bag's own addresses in this world. Hashes like everything else here: nothing is deployed.
const BAG = addressOf("bag");
const PAYDAY = addressOf("payday");
const BURN_CLOCK = addressOf("burn-clock");
const HOUSE = addressOf("house");

const pick = <T>(rand: () => number, xs: readonly T[]): T => xs[Math.floor(rand() * xs.length) % xs.length]!;

// ---------------------------------------------------------------- the twelve

type Machine = "curve" | "direct";
type Arc = "graduated" | "climbing" | "steady" | "fading" | "fresh";

/// The four legs of the creator fee, in basis points, the way a launch carries them on chain: they
/// add up to 10,000. A direct launch has no split at all, and carries four zeros for it.
interface Split {
  stakers: number;
  buyback: number;
  liquidity: number;
  creator: number;
}

const NO_SPLIT: Split = { stakers: 0, buyback: 0, liquidity: 0, creator: 0 };

interface Spec {
  name: string;
  symbol: string;
  description: string;
  machine: Machine;
  /// Where the creator leg of the trading fee goes, picked at launch and fixed forever.
  split: Split;
  /// Days the creator's own first buy is held by the locker, 0 for kept in hand. Only a tier,
  /// because the locker only knows tiers: 7, 30, 90 or 180 days.
  firstBuyLockDays: number;
  /// The pad's own coin: the one token the vault accepts, and so the only one anybody locks.
  house?: true;
  arc: Arc;
  /// Days before now that it launched.
  age: number;
  trades: number;
  /// What the whole supply was worth at launch, in the chain's own currency.
  startEth: number;
  /// How much dearer graduation is than the opening price.
  bond: number;
  /// Which wallet printed it. 0 is the showcase wallet.
  creator: number;
}

const SPECS: Spec[] = [
  // The house coin comes first because everything else's stakers leg pays the people holding it.
  // It cannot point its own fee at them: when it launched there was no vault to point at yet.
  { name: "House Coin", symbol: "HOUSE", description: "The pad's own coin. Lock it and every launch on the board pays you a share of its fee.",
    machine: "curve", split: { stakers: 0, buyback: 5_000, liquidity: 5_000, creator: 0 }, firstBuyLockDays: 0, house: true, arc: "climbing", age: 21, trades: 210, startEth: 9, bond: 44, creator: 0 },
  { name: "Green Candle Club", symbol: "GREEN", description: "A club with one rule and no treasurer. Fees go to whoever locks the token.",
    machine: "curve", split: { stakers: 10_000, buyback: 0, liquidity: 0, creator: 0 }, firstBuyLockDays: 30, arc: "graduated", age: 19, trades: 120, startEth: 6.5, bond: 42, creator: 3 },
  { name: "Night Shift", symbol: "NIGHT", description: "For the hours when the desk is empty and the chain is not.",
    machine: "curve", split: { stakers: 2_000, buyback: 6_000, liquidity: 2_000, creator: 0 }, firstBuyLockDays: 0, arc: "graduated", age: 16, trades: 96, startEth: 4.8, bond: 38, creator: 5 },
  { name: "Tape Reader", symbol: "TAPE", description: "Every trade is a sentence. This one reads them out loud.",
    machine: "direct", split: NO_SPLIT, firstBuyLockDays: 0, arc: "graduated", age: 14, trades: 88, startEth: 9.5, bond: 12, creator: 0 },
  { name: "Dollar Slice", symbol: "SLICE", description: "Small bites, cheap fees, no table service.",
    machine: "curve", split: { stakers: 5_000, buyback: 0, liquidity: 3_000, creator: 2_000 }, firstBuyLockDays: 0, arc: "climbing", age: 11, trades: 84, startEth: 5.6, bond: 40, creator: 7 },
  { name: "Quiet Money", symbol: "QUIET", description: "No announcements. The chart does the talking.",
    machine: "direct", split: NO_SPLIT, firstBuyLockDays: 0, arc: "climbing", age: 9, trades: 72, startEth: 8, bond: 14, creator: 2 },
  { name: "Bag Holder Union", symbol: "BAGS", description: "Organised labour for people who did not sell.",
    machine: "curve", split: { stakers: 0, buyback: 0, liquidity: 0, creator: 10_000 }, firstBuyLockDays: 90, arc: "climbing", age: 8, trades: 66, startEth: 4, bond: 36, creator: 0 },
  { name: "Block One", symbol: "BLOCK", description: "The whole supply in the pool from the first block, taxed both ways.",
    machine: "direct", split: NO_SPLIT, firstBuyLockDays: 0, arc: "steady", age: 7, trades: 54, startEth: 7.2, bond: 15, creator: 9 },
  { name: "Small Caps", symbol: "CAPS", description: "Nothing here has a market cap worth writing home about. That is the point.",
    machine: "curve", split: { stakers: 3_000, buyback: 0, liquidity: 7_000, creator: 0 }, firstBuyLockDays: 0, arc: "steady", age: 6, trades: 48, startEth: 3.2, bond: 34, creator: 11 },
  { name: "Exit Liquidity", symbol: "EXIT", description: "Named honestly, which is more than most of them manage.",
    machine: "curve", split: { stakers: 0, buyback: 5_000, liquidity: 0, creator: 5_000 }, firstBuyLockDays: 0, arc: "fading", age: 5, trades: 44, startEth: 4.8, bond: 35, creator: 13 },
  { name: "Paper Hands Anonymous", symbol: "PAPER", description: "Twelve steps, eleven of which are selling.",
    machine: "curve", split: { stakers: 2_500, buyback: 2_500, liquidity: 2_500, creator: 2_500 }, firstBuyLockDays: 7, arc: "fading", age: 4, trades: 38, startEth: 3.5, bond: 30, creator: 6 },
  { name: "Moon Boots", symbol: "BOOTS", description: "Footwear for a trip nobody has booked yet.",
    machine: "curve", split: { stakers: 7_000, buyback: 3_000, liquidity: 0, creator: 0 }, firstBuyLockDays: 0, arc: "fresh", age: 2, trades: 22, startEth: 4.4, bond: 36, creator: 15 },
  { name: "Red Envelope", symbol: "ENVL", description: "Opened once a year, empty the rest of the time.",
    machine: "direct", split: NO_SPLIT, firstBuyLockDays: 0, arc: "fresh", age: 1, trades: 16, startEth: 5.8, bond: 13, creator: 4 },
];

const WALLETS = 90;

/// Nobody in this world ends up holding a quarter of a supply, because nobody does: a buy that
/// would take a wallet past this is handed to somebody else. Without it, the few loud wallets that
/// make a leaderboard interesting also make every holder list look like a rug.
const MAX_HOLD = SUPPLY / 16n;

/// How far along its arc a launch is at `u`, the fraction of its life that has passed. Curve tokens
/// read this as supply sold; direct ones read it as distance travelled towards the graduation tick.
function level(arc: Arc, u: number): number {
  switch (arc) {
    case "graduated": return Math.min(1, Math.pow(u * 1.12, 0.85));
    case "climbing": return 0.88 * Math.pow(u, 0.75);
    case "steady": return 0.3 * (0.85 + 0.3 * Math.sin(u * 7));
    case "fading": return u < 0.45 ? 0.52 * (u / 0.45) : 0.52 - 0.3 * ((u - 0.45) / 0.55);
    case "fresh": return 0.06 * Math.pow(u, 0.7);
  }
}

/// Trades cluster at the start, the way they actually do: a launch is loudest in its first hours.
function tradeTimes(rand: () => number, from: number, to: number, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(from + (to - from) * Math.pow(rand(), 1.7));
  return out.sort((a, b) => a - b);
}

/// A few wallets trade a lot and most trade once or twice, which is what makes a leaderboard worth
/// looking at. The showcase wallet is in the loud half by construction.
function traderPool(rand: () => number): number[] {
  const weighted: number[] = [];
  for (let i = 0; i < WALLETS; i++) {
    // Three wallets do most of the volume, which is what a real board looks like and what makes the
    // rank ladder mean anything: without somebody up at Gold, every row reads the same.
    const weight = i < 3 ? [22, 26, 21][i]! : Math.max(1, Math.round(13 / (1 + i * (0.22 + rand() * 0.2))));
    for (let k = 0; k < weight; k++) weighted.push(i);
  }
  return weighted;
}

// ---------------------------------------------------------------- the shape of one launch

interface Trade {
  token: string;
  side: "buy" | "sell";
  trader: string;
  pairAmount: bigint;
  tokenAmount: bigint;
  fee: bigint;
  price: bigint;
  ts: Date;
  block: number;
  tx: string;
  logIndex: number;
  pairToken: string;
}

interface Built {
  spec: Spec;
  token: string;
  curve: string;
  creator: string;
  launchedAt: Date;
  block: number;
  tx: string;
  trades: Trade[];
  balances: Map<string, bigint>;
  /// Curve machine: where the sale stopped, and when it filled.
  sold: bigint;
  reserve: bigint;
  volumeTotal: bigint;
  price: bigint;
  graduatedAt: Date | null;
  phase: number;
  /// Direct machine.
  ticks: { start: number; bond: number; last: number } | null;
  bonded: boolean;
  /// What the creator bought of their own token in the launch transaction.
  firstBuy: bigint;
}

function buildLaunch(spec: Spec, wallets: string[], now: number, head: number, rand: () => number, pool_: number[]): Built {
  const token = addressOf(`token:${spec.symbol}`);
  const curve = spec.machine === "curve" ? addressOf(`curve:${spec.symbol}`) : zeroAddress;
  const creator = wallets[spec.creator]!;
  const launchedMs = now - spec.age * DAY;
  const blockOf = (ms: number) => Math.max(1, head - Math.round(((now - ms) / 1000) * BLOCKS_PER_SECOND));

  const startPrice = (spec.startEth * 1e18) / 1e9; // the whole supply is a billion tokens
  const bondPrice = startPrice * spec.bond;
  const times = tradeTimes(rand, launchedMs + 45_000, now - 20 * 60_000, spec.trades);

  const balances = new Map<string, bigint>();
  const trades: Trade[] = [];
  let sold = 0n;
  let reserve = 0n;
  let volume = 0n;
  let price = BigInt(Math.round(startPrice));
  let graduatedAt: Date | null = null;
  let lastLevel = 0;

  const priceAt = (fraction: number) => startPrice + (bondPrice - startPrice) * Math.min(1, fraction);

  for (const [i, at] of times.entries()) {
    const u = (at - launchedMs) / Math.max(1, now - launchedMs);
    const target = Math.max(0, Math.min(1, level(spec.arc, u) * (0.94 + rand() * 0.12)));
    let delta = target - lastLevel;
    // A flat step is not a trade. Nudge it into one, in whichever direction the arc is going.
    if (Math.abs(delta) < 0.0015) delta = (rand() < 0.55 ? 1 : -1) * (0.001 + rand() * 0.004);
    const wants = delta > 0 ? "buy" : "sell";

    // Somebody has to hold what is being sold. A seller is drawn from the holders, and if nobody
    // holds anything yet the trade becomes a buy rather than an impossibility.
    const holders = [...balances.entries()].filter(([, b]) => b > ONE);
    const side: "buy" | "sell" = wants === "sell" && holders.length > 0 ? "sell" : "buy";
    let trader: string;
    if (side === "sell") {
      const [who] = pick(rand, holders);
      trader = who;
    } else {
      // Four tries to find somebody who is not already full, then the trade happens anyway: a cap
      // that can deadlock a simulation is worse than a wallet that is slightly too big.
      trader = wallets[pick(rand, pool_)]!;
      for (let tries = 0; tries < 4 && (balances.get(trader) ?? 0n) > MAX_HOLD; tries++) {
        trader = wallets[pick(rand, pool_)]!;
      }
    }

    const midLevel = Math.max(0, Math.min(1, lastLevel + (side === "buy" ? Math.abs(delta) : -Math.abs(delta)) / 2));
    const mid = priceAt(midLevel);
    let tokenAmount = (CURVE_SUPPLY * BigInt(Math.round(Math.abs(delta) * 1e9))) / 1_000_000_000n;
    if (side === "sell") {
      const held = balances.get(trader) ?? 0n;
      if (tokenAmount > held) tokenAmount = held;
    }
    if (tokenAmount <= 0n) continue;

    const pairAmount = (tokenAmount * BigInt(Math.round(mid))) / ONE;
    if (pairAmount <= 0n) continue;
    const fee = (pairAmount * FEE_BPS) / 10_000n;
    const unit = (pairAmount * ONE) / tokenAmount;

    trades.push({
      token, side, trader, pairAmount, tokenAmount, fee, price: unit,
      ts: new Date(at), block: blockOf(at), tx: txOf(`${spec.symbol}:${i}`), logIndex: 3 + (i % 5),
      pairToken: zeroAddress,
    });

    balances.set(trader, (balances.get(trader) ?? 0n) + (side === "buy" ? tokenAmount : -tokenAmount));
    sold += side === "buy" ? tokenAmount : -tokenAmount;
    reserve += side === "buy" ? pairAmount - fee : -(pairAmount + fee);
    volume += pairAmount;
    price = unit;
    lastLevel = Math.max(0, Math.min(1, lastLevel + (side === "buy" ? Math.abs(delta) : -Math.abs(delta))));

    // The curve machine stops here: the supply is gone, the pool opens, and the trades that follow
    // happen somewhere this table does not watch.
    if (spec.machine === "curve" && lastLevel >= 0.999 && !graduatedAt) {
      graduatedAt = new Date(at + 40_000);
      break;
    }
    if (spec.machine === "direct" && lastLevel >= 0.999 && !graduatedAt) graduatedAt = new Date(at + 40_000);
  }

  // The creator's own first buy, backdated to the launch itself, so a creator is never a stranger
  // to their own token.
  const firstBuyTokens = (CURVE_SUPPLY * 3n) / 1000n;
  balances.set(creator, (balances.get(creator) ?? 0n) + firstBuyTokens);

  const ticks = spec.machine === "direct" ? (() => {
    const spacing = 60;
    const round = (t: number) => Math.round(t / spacing) * spacing;
    const start = round(Math.log(1e9 / spec.startEth) / Math.log(1.0001));
    const bond = round(start - Math.log(spec.bond) / Math.log(1.0001));
    const travelled = Math.log(Number(price) / startPrice) / Math.log(1.0001);
    return { start, bond, last: round(start - Math.max(0, travelled)) };
  })() : null;

  return {
    spec, token, curve, creator, launchedAt: new Date(launchedMs), block: blockOf(launchedMs),
    tx: txOf(`launch:${spec.symbol}`), trades, balances, sold, reserve, volumeTotal: volume, price,
    graduatedAt, phase: spec.machine === "curve" ? (graduatedAt ? 2 : 0) : 0,
    ticks, bonded: spec.machine === "direct" && Boolean(graduatedAt),
    firstBuy: firstBuyTokens,
  };
}

// ---------------------------------------------------------------- writing it down

const TABLES = [
  "points", "dividend_events", "fee_events", "stakes", "trades", "balances", "launches",
  "season_snapshots", "support_tickets",
  // the Bag
  "bag_events", "penalties", "pot_deposits", "pot_payouts", "payday_epochs", "payday_payouts",
  "payday_slices", "boosts", "king_rounds", "auctions", "burns", "vault_rewards",
];

export async function wipeDemo(): Promise<void> {
  // launches cascades into trades and balances; the rest are independent. One statement, one
  // transaction, so a half-wiped database is not a state anybody can end up in.
  await pool.query(`truncate ${TABLES.join(", ")} restart identity cascade`);
  await pool.query(`delete from cursors where name = 'main'`);
}

export async function seedDemo(options: SeedOptions = {}): Promise<SeedSummary> {
  const days = options.days ?? 21;
  const rand = rng(options.seed ?? "hood.fam demo v1");
  const now = Date.now();
  const from = new Date(now - days * DAY);

  if (options.wipe) await wipeDemo();

  const { rows: existing } = await pool.query<{ n: string }>(`select count(*) as n from launches`);
  if (Number(existing[0]?.n ?? 0) > 0) {
    throw new Error("this database already has launches in it; pass --wipe to replace them");
  }

  const head = (await chainHead()) ?? FALLBACK_HEAD;
  const wallets = Array.from({ length: WALLETS }, (_, i) => addressOf(`wallet:${i}`));
  const showcase = wallets[0]!;
  const pool_ = traderPool(rand);

  // The season covers exactly the history being written, so every point earned lands inside it.
  await pool.query(
    `insert into seasons (id, name, starts, ends) values (1, 'Season 1', $1, null)
     on conflict (id) do update set name = excluded.name, starts = excluded.starts, ends = null`,
    [from],
  );

  const art = Boolean(options.art && storageConfigured());
  const built = SPECS.map((spec) => buildLaunch(spec, wallets, now, head, rand, pool_));

  for (const [i, b] of built.entries()) {
    const image = art ? (await storeImage(tokenArt(b.spec.symbol))).url : "";
    // A locked first buy sits in the vault, not in the creator's wallet; the balances below move
    // it there, the same way the factory stakes it on chain.
    const locked = b.spec.firstBuyLockDays > 0;
    await pool.query(
      `insert into launches (token, curve, creator, fee_recipient, pair_token, config_id,
         split_stakers_bps, split_buyback_bps, split_liquidity_bps, split_creator_bps,
         first_buy_locked, first_buy_unlock_at,
         name, symbol, image, description, website, twitter, telegram, launched_at, block, tx, mode,
         hook, splitter, locker, pool_id, tick_spacing, pool_fee, buy_tax_bps, sell_tax_bps,
         snipe_tax_bps, snipe_decay_seconds, max_hold_bps, max_buy_bps, restrictions_end_block,
         alloc_creator_bps, alloc_buyback_bps, alloc_dividends_bps, alloc_liquidity_bps,
         total_supply, curve_supply, price, tick_start, tick_bond, last_tick)
       values ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
               $18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43,$44,$45)`,
      [
        // Presets rotate across the world so the board is not twelve launches of one shape.
        b.token, b.curve, b.creator, zeroAddress, b.spec.machine === "direct" ? 0 : i % 3,
        b.spec.split.stakers, b.spec.split.buyback, b.spec.split.liquidity, b.spec.split.creator,
        locked ? b.firstBuy.toString() : "0",
        locked ? new Date(b.launchedAt.getTime() + b.spec.firstBuyLockDays * DAY) : null,
        b.spec.name, b.spec.symbol, image, b.spec.description,
        `https://${b.spec.symbol.toLowerCase()}.example`, `https://x.com/${b.spec.symbol.toLowerCase()}fam`, "",
        b.launchedAt, b.block, b.tx, b.spec.machine,
        b.spec.machine === "direct" ? addressOf(`hook:${b.spec.symbol}`) : null,
        b.spec.machine === "direct" ? addressOf(`splitter:${b.spec.symbol}`) : null,
        b.spec.machine === "direct" ? addressOf(`locker:${b.spec.symbol}`) : null,
        b.spec.machine === "direct" ? digest(`pool:${b.spec.symbol}`, 32) : null,
        b.spec.machine === "direct" ? 60 : null,
        b.spec.machine === "direct" ? 3000 : null,
        b.spec.machine === "direct" ? 300 : null,
        b.spec.machine === "direct" ? 500 : null,
        b.spec.machine === "direct" ? 1500 : null,
        b.spec.machine === "direct" ? 900 : null,
        b.spec.machine === "direct" ? 200 : null,
        b.spec.machine === "direct" ? 100 : null,
        b.spec.machine === "direct" ? b.block + 9000 : null,
        b.spec.machine === "direct" ? 2500 : null,
        b.spec.machine === "direct" ? 2500 : null,
        b.spec.machine === "direct" ? 2500 : null,
        b.spec.machine === "direct" ? 2500 : null,
        SUPPLY.toString(), b.spec.machine === "curve" ? CURVE_SUPPLY.toString() : "0",
        BigInt(Math.round(b.spec.startEth * 1e9)).toString(),
        b.ticks?.start ?? null, b.ticks?.bond ?? null, b.ticks?.last ?? null,
      ],
    );
  }

  // Everything that earns points, in the order it happened, because rank is bought with volume and
  // a wallet's rank at trade forty is not its rank at trade four. Awarding out of order would pay
  // the wrong multiplier on half the board.
  const trades = built.flatMap((b) => b.trades).sort((a, b) => a.ts.getTime() - b.ts.getTime());
  let pointsRows = 0;

  for (const t of trades) {
    await pool.query(
      `insert into trades (token, side, trader, recipient, pair_amount, token_amount, fee, price, block, tx, log_index, ts)
       values ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict (tx, log_index) do nothing`,
      [t.token, t.side, t.trader, t.pairAmount.toString(), t.tokenAmount.toString(), t.fee.toString(),
       t.price.toString(), t.block, t.tx, t.logIndex, t.ts],
    );
    await pool.query(
      `update launches set volume_total = volume_total + $2, trades_total = trades_total + 1, price = $3,
              sold = sold + $4, reserve = reserve + $5
       where token = $1`,
      [t.token, t.pairAmount.toString(), t.price.toString(),
       (t.side === "buy" ? t.tokenAmount : -t.tokenAmount).toString(),
       (t.side === "buy" ? t.pairAmount - t.fee : -(t.pairAmount + t.fee)).toString()],
    );

    // The fee the trade booked, in the shape the router emits it. An Accrued row is one number:
    // where it goes is decided when it is flushed, not when it is booked.
    await pool.query(
      `insert into fee_events (token, kind, amount, result, block, tx, log_index, ts)
       values ($1,'accrued',$2,0,$3,$4,$5,$6) on conflict (tx, log_index) do nothing`,
      [t.token, t.fee.toString(), t.block, t.tx, t.logIndex + 1, t.ts],
    );

    const usd = await usdValue(t.pairToken, t.pairAmount);
    await award({
      address: t.trader, kind: t.side === "buy" ? "trade_buy" : "trade_sell", token: t.token,
      usd, ref: `${t.tx}:${t.logIndex}`, ts: t.ts,
    });
    // The same cost basis the indexer keeps, written by the same function, so the demo world has a
    // profit board rather than a column of zeros. In chronological order for the same reason the
    // points are: an average cost depends on the order the buys arrived in.
    await recordBasis({ token: t.token, address: t.trader, side: t.side, tokenAmount: t.tokenAmount, usd, at: t.ts });
    pointsRows++;
    await creditLaunch(t.token, usd, t.ts);
  }

  // What each launch ended up looking like: the aggregates the loop above moved, plus the two
  // states a row can end in.
  for (const b of built) {
    await pool.query(
      `update launches set phase = $2, graduated_at = $3, bonded = $4, last_tick = $5 where token = $1`,
      [b.token, b.phase, b.graduatedAt, b.bonded, b.ticks?.last ?? null],
    );
  }

  // Holdings. The curve or the pool holds whatever was never sold, which is what makes a holder
  // count honest rather than a count of wallets that happened to trade.
  for (const b of built) {
    for (const [address, balance] of b.balances) {
      if (balance <= 0n) continue;
      await pool.query(
        `insert into balances (token, address, balance) values ($1,$2,$3)
         on conflict (token, address) do update set balance = excluded.balance`,
        [b.token, address, balance.toString()],
      );
    }
    const held = [...b.balances.values()].reduce((sum, v) => sum + (v > 0n ? v : 0n), 0n);
    const rest = SUPPLY - held;
    if (rest > 0n) {
      await pool.query(
        `insert into balances (token, address, balance) values ($1,$2,$3)
         on conflict (token, address) do update set balance = excluded.balance`,
        [b.token, b.spec.machine === "curve" ? b.curve : addressOf(`pool:${b.spec.symbol}`), rest.toString()],
      );
    }
  }

  // Locks. There is one coin to lock, and locking it is what earns the stakers leg of every
  // launch on the board.
  let positionId = 1;
  let stakes = 0;

  // The creator's own first buy, held by the locker from the launch transaction onwards. It earns
  // nothing and it is not a position: it is there to say that the tokens bought ahead of everybody
  // else cannot be sold into the people who bought next.
  for (const b of built.filter((x) => x.spec.firstBuyLockDays > 0)) {
    await pool.query(`update balances set balance = balance - $3 where token = $1 and address = $2`,
      [b.token, b.creator, b.firstBuy.toString()]);
    await pool.query(
      `insert into balances (token, address, balance) values ($1,$2,$3)
       on conflict (token, address) do update set balance = balances.balance + excluded.balance`,
      [b.token, LOCKER, b.firstBuy.toString()]);
  }

  // Locks, and there is only one thing to lock. Everybody in this list holds the house coin; what
  // they earn comes from the whole board, not from the coin itself.
  for (const b of built.filter((x) => x.spec.house)) {
    const holders = [...b.balances.entries()].filter(([, v]) => v > ONE * 1000n);
    for (const [owner, balance] of holders.slice(0, 10)) {
      if (rand() < 0.35) continue;
      const weightBps = pick(rand, [10_000, 12_500, 15_000, 20_000, 25_000]);
      const lockDays = { 10000: 0, 12500: 7, 15000: 30, 20000: 90, 25000: 180 }[weightBps] ?? 0;
      const amount = (balance * BigInt(20 + Math.floor(rand() * 50))) / 100n;
      const createdAt = new Date(b.launchedAt.getTime() + rand() * (now - b.launchedAt.getTime()));
      await pool.query(
        `insert into stakes (position_id, token, owner, amount, unlock_at, weight_bps, active, claimed, created_at)
         values ($1,$2,$3,$4,$5,$6,true,$7,$8)`,
        [positionId, b.token, owner, amount.toString(),
         new Date(createdAt.getTime() + lockDays * DAY), weightBps,
         ((amount * BigInt(Math.floor(rand() * 40))) / 100_000n).toString(), createdAt],
      );
      // On chain the tokens move to the staking contract, so the wallet stops holding them.
      await pool.query(`update balances set balance = balance - $3 where token = $1 and address = $2`,
        [b.token, owner, amount.toString()]);
      await pool.query(
        `insert into balances (token, address, balance) values ($1,$2,$3)
         on conflict (token, address) do update set balance = balances.balance + excluded.balance`,
        [b.token, STAKING, amount.toString()]);

      // No award here: locking is paid for the time it is kept, by the same accrual the indexer
      // runs, called once below. A demo that credited it any other way would be showing numbers
      // the product does not produce.
      positionId++;
      stakes++;
    }
  }

  // The direct machine's money: a sweep splits four ways, and the dividend leg is paid to holders.
  for (const b of built.filter((x) => x.spec.machine === "direct")) {
    const sweeps = 3 + Math.floor(rand() * 3);
    for (let i = 0; i < sweeps; i++) {
      const at = new Date(b.launchedAt.getTime() + ((i + 1) / (sweeps + 1)) * (now - b.launchedAt.getTime()));
      const amount = (b.volumeTotal * BigInt(15 + Math.floor(rand() * 20))) / 10_000n;
      if (amount <= 0n) continue;
      const block = Math.max(1, head - Math.round(((now - at.getTime()) / 1000) * BLOCKS_PER_SECOND));
      await pool.query(
        `insert into fee_events (token, kind, amount, result, block, tx, log_index, ts)
         values ($1,'swept',$2,0,$3,$4,$5,$6) on conflict (tx, log_index) do nothing`,
        [b.token, amount.toString(), block, txOf(`sweep:${b.spec.symbol}:${i}`), 1, at],
      );
      const dividends = (amount * 2500n) / 10_000n;
      const holders = [...b.balances.entries()].filter(([, v]) => v > 0n).slice(0, 8);
      const total = holders.reduce((sum, [, v]) => sum + v, 0n) || 1n;
      for (const [k, [holder, balance]] of holders.entries()) {
        const cut = (dividends * balance) / total;
        if (cut <= 0n) continue;
        await pool.query(
          `insert into dividend_events (token, holder, amount, block, tx, log_index, ts)
           values ($1,$2,$3,$4,$5,$6,$7) on conflict (tx, log_index) do nothing`,
          [b.token, holder, cut.toString(), block, txOf(`dividend:${b.spec.symbol}:${i}`), k + 2, at],
        );
      }
    }
  }

  // The keeper's flushes on the curve machine, so the fee panel has both halves: what came in and
  // where the split sent it. Each leg is floored and the creator's takes the dust, the way the
  // router does it, so the four legs add up to the amount exactly.
  for (const b of built.filter((x) => x.spec.machine === "curve")) {
    const accrued = b.trades.reduce((sum, t) => sum + t.fee, 0n);
    if (accrued <= 0n) continue;
    const at = new Date(Math.min(now - 3 * 60_000, b.launchedAt.getTime() + 0.8 * (now - b.launchedAt.getTime())));
    const block = Math.max(1, head - Math.round(((now - at.getTime()) / 1000) * BLOCKS_PER_SECOND));
    const amount = (accrued * 7n) / 10n;
    const leg = (bps: number) => (amount * BigInt(bps)) / 10_000n;
    const legs = [leg(b.spec.split.stakers), leg(b.spec.split.buyback), leg(b.spec.split.liquidity), leg(b.spec.split.creator)];
    const dust = amount - legs.reduce((sum, v) => sum + v, 0n);
    const shares = [b.spec.split.stakers, b.spec.split.buyback, b.spec.split.liquidity, b.spec.split.creator];
    const last = shares.reduce((keep, bps, k) => (bps > 0 ? k : keep), 0);
    legs[last] = legs[last]! + dust;
    // The buyback leg bought at the last price it traded at and burned what it got.
    const burned = b.price > 0n ? (legs[1]! * ONE) / b.price : 0n;
    await pool.query(
      `insert into fee_events (token, kind, amount, result, to_stakers, to_buyback, to_liquidity, to_creator,
         block, tx, log_index, ts)
       values ($1,'flushed',$2,$3,$4,$5,$6,$7,$8,$9,1,$10) on conflict (tx, log_index) do nothing`,
      [b.token, amount.toString(), burned.toString(),
       legs[0]!.toString(), legs[1]!.toString(), legs[2]!.toString(), legs[3]!.toString(),
       block, txOf(`flush:${b.spec.symbol}`), at],
    );
  }

  // The Bag: what every trade, graduation and penalty paid the platform, and where each piece went.
  const bag = await seedBag(built, wallets, now, head);
  pointsRows += bag.bountyPoints;

  // What every position has earned since it was opened, through the real accrual, so the board
  // shows locking priced the way the running product prices it.
  const accrued = await accrueStakePoints(new Date(now));
  pointsRows += accrued.credited;

  await seedTickets(wallets, now);
  await refreshRollingVolume();
  await pool.query(
    `insert into cursors (name, block) values ('main', $1)
     on conflict (name) do update set block = excluded.block`, [head],
  );

  return {
    wallets: WALLETS, launches: built.length, trades: trades.length, stakes, points: pointsRows,
    tickets: TICKETS.length, showcase, art: art ? "uploaded" : "skipped",
    from, to: new Date(now), bag,
  };
}

// ---------------------------------------------------------------- the Bag

/// Who paid the opening tax, on which launch, how long ago. Bots are wallets nobody printed with;
/// one of them (70) keeps coming back, which is what the snipers' wall is for.
const SNIPES: { symbol: string; bot: number; eth: number; minutesAgo: number }[] = [
  { symbol: "TAPE", bot: 70, eth: 0.42, minutesAgo: 14 * 24 * 60 - 3 },
  { symbol: "TAPE", bot: 71, eth: 0.27, minutesAgo: 14 * 24 * 60 - 5 },
  { symbol: "QUIET", bot: 73, eth: 0.35, minutesAgo: 9 * 24 * 60 - 2 },
  { symbol: "QUIET", bot: 70, eth: 0.06, minutesAgo: 9 * 24 * 60 - 3 },
  { symbol: "BLOCK", bot: 71, eth: 0.22, minutesAgo: 7 * 24 * 60 - 4 },
];

/// Many rows in one statement. The tape is a few thousand rows and a round trip per row is the
/// difference between a second and a minute.
async function insertMany(table: string, columns: string[], rows: unknown[][], conflict: string): Promise<number> {
  let n = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const values = chunk
      .map((r, k) => `(${r.map((_, j) => `$${k * columns.length + j + 1}`).join(",")})`)
      .join(",");
    const { rowCount } = await pool.query(
      `insert into ${table} (${columns.join(",")}) values ${values} ${conflict}`, chunk.flat(),
    );
    n += rowCount ?? 0;
  }
  return n;
}

/// Every table under the Bag, written the way the indexer would have written it from the chain: the
/// tape row for every event, the normalized row next to it, and the splits exactly as BagSplits fixes
/// them, so what the Bag page sums adds up to what it says came in.
async function seedBag(built: Built[], wallets: string[], now: number, head: number): Promise<BagSummary> {
  const blockOf = (ms: number) => Math.max(1, head - Math.round(((now - ms) / 1000) * BLOCKS_PER_SECOND));
  const bySymbol = new Map(built.map((b) => [b.spec.symbol, b]));
  const byToken = new Map(built.map((b) => [b.token, b]));
  const potOf = (b: Built) => addressOf(b.spec.machine === "direct" ? `splitter:${b.spec.symbol}` : `pot:${b.spec.symbol}`);
  // Pieces of the machine hold balances and are not holders: no bounty, no push, no count.
  const machines = new Set<string>([
    STAKING, LOCKER,
    ...built.flatMap((b) => [
      b.curve, addressOf(`pool:${b.spec.symbol}`), addressOf(`hook:${b.spec.symbol}`),
      addressOf(`splitter:${b.spec.symbol}`), addressOf(`locker:${b.spec.symbol}`), potOf(b),
    ]),
  ]);

  // Log indexes per transaction. The trade and its fee row sit low in the receipt; the Bag's rows
  // start at twenty and count up, so no two rows in any table share (tx, log_index).
  const logAt = new Map<string, number>();
  const nextLog = (tx: string) => {
    const n = logAt.get(tx) ?? 20;
    logAt.set(tx, n + 1);
    return n;
  };

  type Row = unknown[];
  const tape: Row[] = [];
  const penalties: Row[] = [];
  const deposits: Row[] = [];
  const payouts: Row[] = [];
  const vault: Row[] = [];
  const paydayPayouts: Row[] = [];
  const slices: Row[] = [];
  const boosts: Row[] = [];
  const burns: Row[] = [];
  const funded = new Map<number, bigint>(); // Payday hour -> what the Bag put in
  const depositedOf = new Map<string, bigint>(); // token -> what its pot booked
  let burnPool = 0n;
  let bountyPoints = 0;

  const line = (
    kind: string, token: string | null, amount: bigint, at: number, tx: string,
    extra: Record<string, unknown> = {}, recipient: string | null = null,
  ) => {
    tape.push([kind, token, zeroAddress, amount.toString(), JSON.stringify(extra), recipient, blockOf(at), tx, nextLog(tx), new Date(at)]);
  };
  /// The Bag took money and split it, house first.
  const intake = (source: string, token: string | null, amount: bigint, legs: [string, string, bigint][], at: number, tx: string) => {
    line("bag_in", token, amount, at, tx, { source });
    for (const [outlet, to, leg] of legs) if (leg > 0n) line("bag_out", null, leg, at, tx, { outlet }, to);
  };
  const feedVault = (amount: bigint, at: number, tx: string) => {
    if (amount <= 0n) return;
    vault.push([zeroAddress, amount.toString(), blockOf(at), tx, nextLog(tx), new Date(at)]);
    line("vault_reward", null, amount, at, tx, {}, STAKING);
  };
  const fundPayday = (amount: bigint, at: number, tx: string, epoch = Math.floor(at / HOUR)) => {
    if (amount <= 0n) return;
    funded.set(epoch, (funded.get(epoch) ?? 0n) + amount);
    line("payday_funded", null, amount, at, tx, { epoch });
  };
  const fundBurn = (amount: bigint, at: number, tx: string) => {
    if (amount <= 0n) return;
    burnPool += amount;
    line("burn_funded", null, amount, at, tx);
  };
  const holdersOf = async (token: string) => {
    const { rows } = await pool.query<{ address: string; balance: string }>(
      `select address, balance from balances where token = $1 and balance > 0 order by balance desc`, [token],
    );
    const people = rows.filter((r) => !machines.has(r.address)).map((r) => ({ address: r.address, balance: BigInt(r.balance) }));
    return { count: rows.length, people, eligible: people.reduce((s, p) => s + p.balance, 0n) };
  };
  /// A pot booked money for its holders.
  const deposit = async (b: Built, reason: string, payer: string, amount: bigint, at: number, tx: string) => {
    if (amount <= 0n) return;
    const h = await holdersOf(b.token);
    deposits.push([b.token, reason, payer, zeroAddress, amount.toString(), h.eligible.toString(), h.count, blockOf(at), tx, nextLog(tx), new Date(at)]);
    line("holders_paid", b.token, amount, at, tx, { reason, payer, eligible_supply: h.eligible.toString(), holders: h.count });
    depositedOf.set(b.token, (depositedOf.get(b.token) ?? 0n) + amount);
  };
  /// The snipers' wall pays the room, the payer excepted, through the same award the indexer uses.
  const bounty = async (b: Built, payer: string, tx: string, logIndex: number, at: number) => {
    const h = await holdersOf(b.token);
    for (const holder of h.people.slice(0, 500)) {
      if (holder.address === payer) continue;
      await award({ address: holder.address, kind: "bounty", token: b.token, usd: 0, ref: `bounty:${tx}:${logIndex}:${holder.address}`, ts: new Date(at) });
      bountyPoints++;
    }
  };

  // Every launch paid to exist, and carries its pot from that moment.
  for (const b of built) {
    const at = b.launchedAt.getTime();
    intake("house", b.token, LAUNCH_FEE, [["house", HOUSE, LAUNCH_FEE]], at, b.tx);
    await pool.query(`update launches set pot = $2, launch_fee = $3 where token = $1`, [b.token, potOf(b), LAUNCH_FEE.toString()]);
  }

  // The Bag's 30 bps of every trade: 10 Vault, 10 Payday, 10 house, in the order they happened.
  // The house coin's own trades send all 30 to the Vault, and its creator leg comes in as well:
  // 20 bps of the trade, half Vault and half house.
  const trades = built.flatMap((b) => b.trades.map((t) => ({ b, t }))).sort((x, y) => x.t.ts.getTime() - y.t.ts.getTime());
  for (const { b, t } of trades) {
    const at = t.ts.getTime();
    const bagIn = (t.pairAmount * 30n) / 10_000n;
    if (bagIn <= 0n) continue;
    if (b.spec.house) {
      intake("trade", b.token, bagIn, [["vault", STAKING, bagIn]], at, t.tx);
      feedVault(bagIn, at, t.tx);
      const leg = (t.pairAmount * 20n) / 10_000n;
      const half = leg / 2n;
      intake("house_coin", b.token, leg, [["house", HOUSE, leg - half], ["vault", STAKING, half]], at, t.tx);
      feedVault(half, at, t.tx);
      continue;
    }
    const toVault = (bagIn * 3333n) / 10_000n;
    const toPayday = (bagIn * 3333n) / 10_000n;
    const toHouse = bagIn - toVault - toPayday;
    intake("trade", b.token, bagIn, [
      ["house", HOUSE, toHouse], ["vault", STAKING, toVault], ["payday", PAYDAY, toPayday],
    ], at, t.tx);
    feedVault(toVault, at, t.tx);
    fundPayday(toPayday, at, t.tx);
  }

  // Every graduation: a tenth of the raise, 23% to the launch's dev, 77% to the burn clock.
  for (const b of built.filter((x) => x.spec.machine === "curve" && x.graduatedAt)) {
    const at = b.graduatedAt!.getTime();
    const tx = txOf(`graduation:${b.spec.symbol}`);
    const fee = b.reserve / 10n;
    if (fee <= 0n) continue;
    const toDev = (fee * 2300n) / 10_000n;
    intake("graduation", b.token, fee, [["dev", b.creator, toDev], ["burn", BURN_CLOCK, fee - toDev]], at, tx);
    fundBurn(fee - toDev, at, tx);
    await pool.query(`update launches set graduation_fee = $2 where token = $1`, [b.token, fee.toString()]);
  }

  // The opening tax: bots that bought in a launch's first seconds. It is trading fee and sits in the
  // trades' own fee already; these rows are the snipers' wall. Everyone holding the token when the
  // bot paid gets a point.
  for (const [i, p] of SNIPES.entries()) {
    const b = bySymbol.get(p.symbol)!;
    const bot = wallets[p.bot]!;
    const at = now - p.minutesAgo * 60_000;
    const tx = txOf(`snipe:${p.symbol}:${i}`);
    const amount = eth(p.eth);
    const h = await holdersOf(b.token);
    const logIndex = nextLog(tx);
    penalties.push([b.token, "snipe", bot, zeroAddress, amount.toString(), "0", "0", h.count, blockOf(at), tx, logIndex, new Date(at)]);
    line("sniped", b.token, amount, at, tx, { payer: bot, holders: h.count });
    await bounty(b, bot, tx, logIndex, at);
  }

  // The creator of BLOCK sold his own token: what he had not claimed went to the holders.
  {
    const b = bySymbol.get("BLOCK")!;
    const at = now - 3 * DAY + 7 * 60_000;
    const tx = txOf("slash:BLOCK");
    const amount = eth(0.12);
    const h = await holdersOf(b.token);
    const logIndex = nextLog(tx);
    penalties.push([b.token, "slash", b.creator, zeroAddress, amount.toString(), amount.toString(), "0", h.count, blockOf(at), tx, logIndex, new Date(at)]);
    line("slash", b.token, amount, at, tx, { reason: "slash", payer: b.creator, to_holders: amount.toString(), to_bag: "0", holders: h.count });
    await deposit(b, "slash", b.creator, amount, at, tx);
    await bounty(b, b.creator, tx, logIndex, at);
  }

  // Boosts: three slots this hour and one bought ahead for the next, each paid by its creator into
  // the Payday of the hour it runs.
  const currentEpoch = Math.floor(now / HOUR);
  const hourStart = currentEpoch * HOUR;
  const slots: [string, number, number][] = [["BOOTS", currentEpoch, 0], ["ENVL", currentEpoch, 1], ["SLICE", currentEpoch, 2], ["PAPER", currentEpoch + 1, 0]];
  for (const [i, [symbol, hour, slot]] of slots.entries()) {
    const b = bySymbol.get(symbol)!;
    const at = Math.min(now - 60_000, hourStart + (i + 1) * 90_000);
    const tx = txOf(`boost:${symbol}:${hour}`);
    boosts.push([hour, slot, b.token, b.creator, SLOT_PRICE.toString(), tx, new Date(at)]);
    line("boost", b.token, SLOT_PRICE, at, tx, { epoch: hour, slot, buyer: b.creator });
    intake("boost", b.token, SLOT_PRICE, [["payday", PAYDAY, SLOT_PRICE]], at, tx);
    fundPayday(SLOT_PRICE, at, tx, hour);
  }

  // Payday. Every closed hour was paid: the older ones are kept as their totals, the last two in
  // full, with the hour's points holders and the slice to the ten launches before the hour's end,
  // worked out the way the keeper works them out. The current hour is open.
  const epochs = [...funded.keys()].filter((e) => e < currentEpoch).sort((a, b) => a - b);
  const detailed = new Set(epochs.slice(-2));
  let carried = 0n;
  let paydayEpochs = 0;
  for (const epoch of epochs) {
    const pot = (funded.get(epoch) ?? 0n) + carried;
    const at = Math.min((epoch + 1) * HOUR + 90_000, now - 30_000);
    const tx = txOf(`payday:${epoch}`);
    const { rows: ten } = await pool.query<{ token: string; pot: string }>(
      `select token, pot from launches where pot is not null and launched_at < $1 order by launched_at desc limit 10`,
      [new Date((epoch + 1) * HOUR)],
    );
    const perPot = ten.length ? (pot * 1000n) / 10_000n / BigInt(ten.length) : 0n;
    const toLaunches = perPot * BigInt(ten.length);
    if (!detailed.has(epoch)) {
      await pool.query(
        `insert into payday_epochs (epoch, asset, funded, to_wallets, to_launches, carried, paid_at, tx)
         values ($1,$2,$3,$4,$5,0,$6,$7) on conflict (epoch, asset) do nothing`,
        [epoch, zeroAddress, (funded.get(epoch) ?? 0n).toString(), (pot - toLaunches).toString(), toLaunches.toString(), new Date(at), tx],
      );
      carried = 0n;
      paydayEpochs++;
      continue;
    }
    for (const l of ten) {
      slices.push([epoch, zeroAddress, l.pot, l.token, perPot.toString(), blockOf(at), tx, nextLog(tx), new Date(at)]);
      line("payday_slice", l.token, perPot, at, tx, { epoch, pot: l.pot }, l.pot);
      await deposit(byToken.get(l.token)!, "payday", PAYDAY, perPot, at, tx);
    }
    const { rows: pts } = await pool.query<{ address: string; points: string }>(
      `select address, sum(amount) as points from points where ts >= $1 and ts < $2 group by address order by points desc`,
      [new Date(epoch * HOUR), new Date((epoch + 1) * HOUR)],
    );
    const total = pts.reduce((s, r) => s + Number(r.points), 0);
    const forWallets = pot - toLaunches;
    let paid = 0n;
    if (total > 0) {
      for (const r of pts) {
        const share = (forWallets * BigInt(Math.round(Number(r.points) * 100))) / BigInt(Math.round(total * 100));
        if (share < PAYDAY_DUST) continue;
        paydayPayouts.push([epoch, zeroAddress, r.address, share.toString(), blockOf(at), tx, nextLog(tx), new Date(at)]);
        line("payday_paid", null, share, at, tx, { epoch, wallet: r.address }, r.address);
        paid += share;
      }
    }
    carried = forWallets - paid;
    await pool.query(
      `insert into payday_epochs (epoch, asset, funded, to_wallets, to_launches, carried, paid_at, tx)
       values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (epoch, asset) do nothing`,
      [epoch, zeroAddress, (funded.get(epoch) ?? 0n).toString(), paid.toString(), toLaunches.toString(), carried.toString(), new Date(at), tx],
    );
    line("payday_epoch", null, paid + toLaunches, at, tx, { epoch, to_wallets: paid.toString(), to_launches: toLaunches.toString(), carried: carried.toString() });
    paydayEpochs++;
  }
  if (funded.has(currentEpoch)) {
    await pool.query(
      `insert into payday_epochs (epoch, asset, funded) values ($1,$2,$3) on conflict (epoch, asset) do nothing`,
      [currentEpoch, zeroAddress, funded.get(currentEpoch)!.toString()],
    );
    paydayEpochs++;
  }

  // The burn clock bought the house coin at the top of the last hour with most of what it held and
  // burned what it got; the rest waits for the next hour.
  {
    const house = built.find((b) => b.spec.house)!;
    const at = (currentEpoch - 1) * HOUR + 20_000;
    const tx = txOf(`burn:${currentEpoch - 1}`);
    const spent = (burnPool * 6n) / 10n;
    const coinBurned = house.price > 0n ? (spent * ONE) / house.price : 0n;
    burns.push([zeroAddress, spent.toString(), coinBurned.toString(), currentEpoch - 1, blockOf(at), tx, nextLog(tx), new Date(at)]);
    line("burn", house.token, spent, at, tx, { spent: spent.toString(), burned: coinBurned.toString(), epoch: currentEpoch - 1 });
    await pool.query(`update launches set total_supply = total_supply - $2, burned = burned + $2 where token = $1`, [house.token, coinBurned.toString()]);
  }

  // The keeper pushed most of every pot to its holders, pro rata, above the floor. QUIET was pushed
  // a moment ago so the token page has a fresh one to show; the rest went out with the last round.
  for (const [token, deposited] of depositedOf) {
    const b = byToken.get(token)!;
    const h = await holdersOf(token);
    if (h.eligible <= 0n) continue;
    const recent = b.spec.symbol === "QUIET";
    const at = recent ? now - 15_000 : now - 8 * 60_000;
    const tx = txOf(`push:${b.spec.symbol}:${Math.floor(at / 60_000)}`);
    const budget = (deposited * 7n) / 10n;
    for (const p of h.people.slice(0, 8)) {
      const cut = (budget * p.balance) / h.eligible;
      if (cut < PUSH_FLOOR) continue;
      payouts.push([token, p.address, zeroAddress, cut.toString(), blockOf(at), tx, nextLog(tx), new Date(at)]);
      line("pushed", token, cut, at, tx, { wallet: p.address }, p.address);
    }
  }

  const skip = "on conflict (tx, log_index) do nothing";
  return {
    tape: await insertMany("bag_events", ["kind", "token", "asset", "amount", "extra", "recipient", "block", "tx", "log_index", "ts"], tape, skip),
    penalties: await insertMany("penalties", ["token", "kind", "payer", "asset", "amount", "to_holders", "to_bag", "holders", "block", "tx", "log_index", "ts"], penalties, skip),
    potDeposits: await insertMany("pot_deposits", ["token", "reason", "payer", "asset", "amount", "eligible_supply", "holders", "block", "tx", "log_index", "ts"], deposits, skip),
    potPayouts: await insertMany("pot_payouts", ["token", "holder", "asset", "amount", "block", "tx", "log_index", "ts"], payouts, skip),
    paydayEpochs,
    paydayPayouts: await insertMany("payday_payouts", ["epoch", "asset", "wallet", "amount", "block", "tx", "log_index", "ts"], paydayPayouts, skip)
      + await insertMany("payday_slices", ["epoch", "asset", "pot", "token", "amount", "block", "tx", "log_index", "ts"], slices, skip),
    boosts: await insertMany("boosts", ["hour_epoch", "slot", "token", "buyer", "paid", "tx", "ts"], boosts, "on conflict (hour_epoch, slot) do nothing"),
    burns: await insertMany("burns", ["asset", "spent", "coin_burned", "epoch", "block", "tx", "log_index", "ts"], burns, skip),
    vaultRewards: await insertMany("vault_rewards", ["asset", "amount", "block", "tx", "log_index", "ts"], vault, skip),
    bountyPoints,
  };
}

const TICKETS = [
  {
    status: "open", subject: "My buy went through but the board still shows nothing",
    summary: "Wallet says the transaction succeeded; the token page has not picked it up. Wants to know whether the indexer is behind or the trade landed somewhere else.",
    page: "/token", source: "assistant",
    transcript: [
      { role: "user", content: "i bought SLICE two minutes ago and my portfolio is still empty" },
      { role: "assistant", content: "Your transaction is on chain. The board reads an indexer that follows the chain a few blocks behind, so a fresh trade shows up a moment later than the wallet confirms it. If it is still missing in a few minutes, send me the transaction hash and I will look at it." },
    ],
  },
  {
    status: "answered", subject: "Can I change the fee split after launch",
    summary: "Creator put the whole creator leg on buyback and wants half of it on stakers instead. Answered: the split is fixed at launch, by design, and the only way to change it is a new launch.",
    page: "/launch", source: "assistant", note: "Explained the immutability and pointed at the docs. No action needed.",
    transcript: [
      { role: "user", content: "i put everything on buy back and burn, can i move half of it to stakers" },
      { role: "assistant", content: "No, and that is deliberate: the four shares are written into the launch and nothing, including us, can move them afterwards. It is the same property that lets a buyer trust what the page says. A new launch with the split you want is the only route." },
    ],
  },
  {
    status: "closed", subject: "Points from a locked position never arrived",
    summary: "Locked a position, expected points immediately. They land when the lock is indexed, which it now is.",
    page: "/airdrop", source: "assistant", note: "Landed on its own once the position was indexed. Nothing to fix.",
    transcript: [
      { role: "user", content: "locked BAGS for 90 days, leaderboard has not moved" },
      { role: "assistant", content: "Locking pays per dollar locked, multiplied by the lock length, and it is credited when the position is indexed rather than when the wallet signs. Your position is on the board now." },
    ],
  },
] as const;

async function seedTickets(wallets: string[], now: number): Promise<void> {
  for (const [i, t] of TICKETS.entries()) {
    const at = new Date(now - (i + 1) * 9 * 60 * 60 * 1000);
    await pool.query(
      `insert into support_tickets (created_at, updated_at, status, address, contact, subject, summary, page, transcript, source, note)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [at, at, t.status, wallets[i + 1]!, `${t.status}${i}@example.com`, t.subject, t.summary, t.page,
       JSON.stringify(t.transcript), t.source, "note" in t ? t.note : null],
    );
  }
}
