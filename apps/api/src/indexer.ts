import {
  createPublicClient, encodeAbiParameters, erc20Abi, http, keccak256, parseAbiItem, toEventSelector, zeroAddress,
  type Address, type Log,
} from "viem";
import { pairAsset, robinhood } from "@hood/sdk";

import { pool, getCursor, getCursorHash, setCursor } from "./db.js";
import { notify } from "./events.js";
import { award } from "./points.js";
import { usdValue } from "./price.js";
import { SYSTEM } from "./system.js";
import { accrueStakePoints, settleStake } from "./stake-accrual.js";

/// The chain reader. Three facts about 4663 shape everything here:
///   - blocks are 100ms, so "catch up from genesis" is not a thing anyone does; start at the
///     deployment block
///   - the public RPC rejects large getLogs ranges and rate limits parallel bursts, so this walks
///     forward in chunks, one request at a time, and halves the chunk whenever a range is refused
///   - there is no JSON-RPC batching, so multicall is the only way to ask several questions at once
const RPC = process.env.HOOD_RPC ?? robinhood.rpcUrls.default.http[0]!;
const client = createPublicClient({ chain: robinhood, transport: http(RPC) });

const FACTORY = (process.env.HOOD_FACTORY ?? "").toLowerCase() as Address;
const PORTAL = (process.env.HOOD_PORTAL ?? "").toLowerCase() as Address;
const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const STAKING = (process.env.HOOD_STAKING ?? "").toLowerCase() as Address;
const FEE_ROUTER = (process.env.HOOD_FEE_ROUTER ?? "").toLowerCase() as Address;
const GRADUATOR = (process.env.HOOD_GRADUATOR ?? "").toLowerCase() as Address;
const BUYBACK_MODULE = (process.env.HOOD_BUYBACK_MODULE ?? "").toLowerCase() as Address;

const START_BLOCK = BigInt(process.env.HOOD_START_BLOCK ?? "0");

/// How far behind the head to stay. Everything here accumulates (a balance is a running sum, a
/// volume is a running total), so a block that is indexed and then reorged out leaves numbers that
/// nothing recomputes. Blocks are 100ms, so a dozen of them is a second and change of lag in
/// exchange for not indexing what the chain has not settled on.
const CONFIRMATIONS = BigInt(process.env.HOOD_CONFIRMATIONS ?? "12");
const MAX_CHUNK = BigInt(process.env.HOOD_LOG_CHUNK ?? "5000");

const events = {
  launched: parseAbiItem(
    "event Launched(address indexed token, address indexed curve, address indexed creator, uint256 configId, address pairToken, (uint16 stakersBps, uint16 buybackBps, uint16 liquidityBps, uint16 creatorBps) feeSplit)",
  ),
  firstBuyLocked: parseAbiItem(
    "event FirstBuyLocked(address indexed token, address indexed creator, uint256 positionId, uint256 amount, uint64 unlockAt)",
  ),
  launchMetadata: parseAbiItem(
    "event LaunchMetadata(address indexed token, string name, string symbol, string image, string description, string website, string twitter, string telegram)",
  ),
  bought: parseAbiItem("event Bought(address indexed buyer, address indexed to, uint256 pairIn, uint256 tokensOut, uint256 fee)"),
  sold: parseAbiItem("event Sold(address indexed seller, address indexed to, uint256 tokensIn, uint256 pairOut, uint256 fee)"),
  soldOut: parseAbiItem("event SoldOut(uint256 reserve)"),
  graduated: parseAbiItem("event Graduated(uint256 tokenAmount, uint256 pairAmount, uint256 graduationFee)"),
  donated: parseAbiItem("event Donated(address indexed from, uint256 amount)"),
  staked: parseAbiItem("event Staked(uint256 indexed id, address indexed token, address indexed owner, uint256 amount, uint64 unlockAt, uint32 weightBps)"),
  unstaked: parseAbiItem("event Unstaked(uint256 indexed id, uint256 amount)"),
  claimed: parseAbiItem("event Claimed(uint256 indexed id, address indexed to, address indexed asset, uint256 amount)"),
  demoted: parseAbiItem("event Demoted(uint256 indexed id, uint32 weightBps)"),
  accrued: parseAbiItem("event Accrued(address indexed token, uint256 amount)"),
  flushed: parseAbiItem(
    "event Flushed(address indexed token, uint256 amount, uint256 toStakers, uint256 toBuyback, uint256 toLiquidity, uint256 toCreator, uint256 tokensBurned)",
  ),
  transfer: parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)"),
  // the direct machine
  directLaunched: parseAbiItem(
    "event DirectLaunched(address indexed token, address indexed creator, address indexed quote, address hook, address splitter, address locker, uint256 positionId, uint64 restrictionsEndBlock, uint256 initialBuy)",
  ),
  claimsFlushed: parseAbiItem("event ClaimsFlushed(uint256 amount)"),
  directMetadata: parseAbiItem(
    "event DirectMetadata(address indexed token, string name, string symbol, string logo, string description)",
  ),
  // the pool's shape, published by the portal right after DirectLaunched so nobody has to ask the hook
  poolOpened: parseAbiItem(
    "event PoolOpened(address indexed token, bytes32 indexed poolId, uint24 fee, int24 tickSpacing, int24 tickStart, int24 tickBond, uint16 buyTaxBps, uint16 sellTaxBps, uint16 snipeTaxBps, uint32 snipeDecaySeconds, uint16 maxHoldBps, uint16 maxBuyBps)",
  ),
  taxed: parseAbiItem("event Taxed(bool isBuy, uint256 fee, uint256 volume)"),
  bondedEvent: parseAbiItem("event Bonded(uint64 at, int24 tick)"),
  swept: parseAbiItem(
    "event Swept(uint256 total, uint256 protocol, uint256 creator, uint256 buyback, uint256 dividends, uint256 liquidity)",
  ),
  dividendsClaimed: parseAbiItem("event DividendsClaimed(address indexed holder, uint256 amount)"),
  protocolClaimed: parseAbiItem("event ProtocolClaimed(address indexed to, uint256 amount)"),
  // `spent` is what the swap consumed, not the pot: what did not fit under the impact limit is carried
  boughtBack: parseAbiItem("event BoughtBack(address indexed token, uint256 spent, uint256 burned)"),
  v4Swap: parseAbiItem(
    "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
  ),
} as const;

const TRANSFER_TOPIC = toEventSelector(events.transfer);
const POOL_OPENED_TOPIC = toEventSelector(events.poolOpened);
const topicAddress = (topic: string) => `0x${topic.slice(26)}`.toLowerCase();

const curves = new Map<string, { token: string; pairToken: string; decimals: number }>();
const tokens = new Set<string>();
/// Direct launches are keyed three ways because three different contracts speak for them.
const hooks = new Map<string, string>(); // hook -> token
const splitters = new Map<string, string>(); // splitter -> token
const pools = new Map<string, { token: string; quote: string; tokenIsZero: boolean }>(); // poolId -> launch
const quotes = new Map<string, string>(); // token -> quote, so PoolOpened can tell which way the pair sorts

async function loadKnown() {
  const { rows } = await pool.query<{
    token: string; curve: string | null; pair_token: string; mode: string;
    hook: string | null; splitter: string | null; pool_id: string | null;
  }>(`select token, curve, pair_token, mode, hook, splitter, pool_id from launches`);
  for (const r of rows) {
    const token = r.token.toLowerCase();
    tokens.add(token);
    quotes.set(token, r.pair_token.toLowerCase());
    if (r.curve && r.curve !== zeroAddress) {
      curves.set(r.curve.toLowerCase(), {
        token,
        pairToken: r.pair_token.toLowerCase(),
        decimals: r.pair_token === zeroAddress ? 18 : 6,
      });
    }
    if (r.hook) hooks.set(r.hook.toLowerCase(), token);
    if (r.splitter) splitters.set(r.splitter.toLowerCase(), token);
    if (r.pool_id) {
      pools.set(r.pool_id.toLowerCase(), {
        token,
        quote: r.pair_token.toLowerCase(),
        tokenIsZero: token < r.pair_token.toLowerCase(),
      });
    }
  }
}

/// The price before anybody has traded, so a fresh launch does not show a market cap of zero.
async function startPrice(curve: Address): Promise<string> {
  try {
    const p = (await client.readContract({
      address: curve, abi: [parseAbiItem("function price() view returns (uint256)")], functionName: "price",
    })) as bigint;
    return p.toString();
  } catch {
    return "0";
  }
}

const ts = (block: { timestamp: bigint }) => new Date(Number(block.timestamp) * 1000);

async function blockTime(blockNumber: bigint): Promise<Date> {
  const b = await client.getBlock({ blockNumber });
  return ts(b);
}

// ---------------------------------------------------------------- handlers

/// A launch is announced to the live feed when it has a name, which is one event later than when
/// it exists: the factory emits Launched and the portal DirectLaunched, and the prose follows in
/// the same transaction. A feed told about the row first would carry a launch with no ticker on it.
/// Only launches this pass actually inserted are queued, so healing a gap, which reads a range that
/// was already indexed, does not announce a token the whole world saw yesterday.
const unannounced = new Set<string>();

async function announce(row: { token: string; symbol: string; name: string; creator: string; mode: string; launched_at: Date } | undefined) {
  if (!row || !unannounced.delete(row.token)) return;
  await notify(
    "launch",
    { token: row.token, symbol: row.symbol, name: row.name, creator: row.creator, mode: row.mode, at: row.launched_at },
    // A name and a ticker are whatever the launcher typed, so this is the one event that can
    // outgrow a NOTIFY payload and has to be refetchable.
    { token: row.token },
  );
}

/// What a launch trades against, asked of the asset itself. A pad that lets a creator be paid in
/// a tokenised share has to read the scale rather than assume it: six decimals for the dollar,
/// eighteen for a share, and an asset allowed after this code shipped still has to come out right.
const pairMeta = new Map<string, { symbol: string; decimals: number }>();
async function pairMetadata(pairToken: string): Promise<{ symbol: string; decimals: number }> {
  if (pairToken === zeroAddress) return { symbol: "ETH", decimals: 18 };
  const cached = pairMeta.get(pairToken);
  if (cached) return cached;
  const known = pairAsset(pairToken);
  if (known) {
    pairMeta.set(pairToken, { symbol: known.symbol, decimals: known.decimals });
    return pairMeta.get(pairToken)!;
  }
  try {
    const [symbol, decimals] = await Promise.all([
      client.readContract({ address: pairToken as Address, abi: erc20Abi, functionName: "symbol" }),
      client.readContract({ address: pairToken as Address, abi: erc20Abi, functionName: "decimals" }),
    ]);
    pairMeta.set(pairToken, { symbol: symbol as string, decimals: Number(decimals) });
  } catch {
    // An asset that will not say. The row keeps nulls and the app falls back to its own registry.
    pairMeta.set(pairToken, { symbol: "", decimals: 18 });
  }
  return pairMeta.get(pairToken)!;
}

async function onLaunched(log: Log & { args: Record<string, unknown> }) {
  const a = log.args;
  const token = (a.token as string).toLowerCase();
  const curve = (a.curve as string).toLowerCase();
  // The split is one non-indexed tuple at the end of the log, four shares of the creator fee that
  // add up to 10,000. It is written once here because the contract writes it once, at launch.
  const split = a.feeSplit as { stakersBps: number; buybackBps: number; liquidityBps: number; creatorBps: number };
  // The prose (name, symbol, artwork, links) arrives in LaunchMetadata, emitted in the same
  // transaction right after this one. The row is created here and filled in there.
  const pair = (a.pairToken as string).toLowerCase();
  const pairMeta = await pairMetadata(pair);
  const { rows: created } = await pool.query<{ token: string }>(
    `insert into launches (token, curve, creator, fee_recipient, pair_token, config_id,
       split_stakers_bps, split_buyback_bps, split_liquidity_bps, split_creator_bps,
       pair_symbol, pair_decimals,
       name, symbol, launched_at, block, tx, mode)
     values ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10,$11,'','',$12,$13,$14,'curve')
     on conflict (token) do nothing
     returning token`,
    [
      token, curve, (a.creator as string).toLowerCase(), pair,
      Number(a.configId),
      Number(split.stakersBps), Number(split.buybackBps), Number(split.liquidityBps), Number(split.creatorBps),
      pairMeta.symbol, pairMeta.decimals,
      await blockTime(log.blockNumber!), log.blockNumber!.toString(), log.transactionHash,
    ],
  );
  if (created[0]) unannounced.add(token);
  // The curve's shape never changes, so it is read once, here, and the moving parts (sold,
  // reserve, price) are kept up to date from the trade events themselves rather than by asking
  // the node again after every buy.
  const [curveSupply, lpSupply] = await client.multicall({
    allowFailure: false,
    contracts: [
      { address: curve as Address, abi: [parseAbiItem("function curveSupply() view returns (uint256)")], functionName: "curveSupply" },
      { address: curve as Address, abi: [parseAbiItem("function lpSupply() view returns (uint256)")], functionName: "lpSupply" },
    ],
  });
  await pool.query(`update launches set curve_supply = $2, total_supply = $3, price = $4 where token = $1`, [
    token, curveSupply.toString(), (curveSupply + lpSupply).toString(), await startPrice(curve as Address),
  ]);

  curves.set(curve, {
    token,
    pairToken: (a.pairToken as string).toLowerCase(),
    decimals: (a.pairToken as string).toLowerCase() === zeroAddress ? 18 : 6,
  });
  tokens.add(token);
  // The 500 for printing is not paid here: see creditLaunch. A token nobody ever trades pays
  // nothing, or printing junk becomes the cheapest way to farm a season.
}

/// The creator's own first buy, staked in their name in the same transaction as the launch. Only
/// fired when a lock happened, and always after Launched, so the row is already there. The amount
/// and the unlock go on the row rather than into a table of their own: the app shows "dev locked"
/// next to the launch, and one launch can only ever lock once.
async function onFirstBuyLocked(log: Log & { args: Record<string, unknown> }) {
  await pool.query(
    `update launches set first_buy_locked = $2, first_buy_unlock_at = $3 where token = $1`,
    [
      (log.args.token as string).toLowerCase(),
      (log.args.amount as bigint).toString(),
      new Date(Number(log.args.unlockAt as bigint) * 1000),
    ],
  );
}

async function onTrade(log: Log & { args: Record<string, unknown> }, side: "buy" | "sell") {
  const curve = curves.get(log.address.toLowerCase());
  if (!curve) return;
  const a = log.args;
  const pairAmount = (side === "buy" ? a.pairIn : a.pairOut) as bigint;
  const tokenAmount = (side === "buy" ? a.tokensOut : a.tokensIn) as bigint;
  const trader = ((side === "buy" ? a.buyer : a.seller) as string).toLowerCase();
  const recipient = (a.to as string).toLowerCase();
  const price = tokenAmount === 0n ? 0n : (pairAmount * 10n ** 18n) / tokenAmount;
  const when = await blockTime(log.blockNumber!);

  const { rows: written } = await pool.query<{ id: string }>(
    `insert into trades (token, side, trader, recipient, pair_amount, token_amount, fee, price, block, tx, log_index, ts)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict (tx, log_index) do nothing
     returning id`,
    [curve.token, side, trader, recipient, pairAmount.toString(), tokenAmount.toString(),
     (a.fee as bigint).toString(), price.toString(), log.blockNumber!.toString(), log.transactionHash, log.logIndex, when],
  );

  // sold and reserve move by exactly what the event says, so the progress bar is right without a
  // second round trip to the node.
  const fee = a.fee as bigint;
  const soldDelta = side === "buy" ? tokenAmount : -tokenAmount;
  const reserveDelta = side === "buy" ? pairAmount - fee : -(pairAmount + fee);
  await pool.query(
    `update launches set volume_total = volume_total + $2, trades_total = trades_total + 1,
            price = $3, sold = sold + $4, reserve = reserve + $5
     where token = $1`,
    [curve.token, pairAmount.toString(), price.toString(), soldDelta.toString(), reserveDelta.toString()],
  );

  // The feed is fed once the trade and the row it moved are both in, and only when this pass is
  // the one that wrote it: rereading a range the node refused earlier must not print the same
  // trade on every screen a second time.
  if (written[0]) {
    await notify("trade", {
      token: curve.token, side, trader, pairAmount: pairAmount.toString(), tokenAmount: tokenAmount.toString(),
      price: price.toString(), tx: log.transactionHash, at: when,
    });
  }

  // A buy is credited to whoever ends up holding the tokens, not to whoever sent the transaction:
  // the launch's own first buy is sent BY the factory and lands in the creator's wallet. A sell is
  // credited to the seller, who is the one giving up the position.
  const scorer = side === "buy" ? recipient : trader;
  const usd = await usdValue(curve.pairToken, pairAmount);
  const selfDealt = await paysItself(curve.token, scorer);
  if (!SYSTEM.has(scorer) && !selfDealt) {
    await award({
      address: scorer, kind: side === "buy" ? "trade_buy" : "trade_sell", token: curve.token,
      usd, ref: `${log.transactionHash}:${log.logIndex}`, ts: when,
    });
  }
  if (!selfDealt) await creditLaunch(curve.token, usd, when);
}

async function onTransfer(log: Log & { args: Record<string, unknown> }) {
  const token = log.address.toLowerCase();
  if (!tokens.has(token)) return;
  const from = (log.args.from as string).toLowerCase();
  const to = (log.args.to as string).toLowerCase();
  const value = log.args.value as bigint;
  if (value === 0n) return;
  const move = async (address: string, delta: bigint) => {
    if (address === zeroAddress) return;
    await pool.query(
      `insert into balances (token, address, balance) values ($1,$2,$3)
       on conflict (token, address) do update set balance = balances.balance + $3`,
      [token, address, delta.toString()],
    );
  };
  await move(from, -value);
  await move(to, value);
  // A burn is supply leaving for good: a buyback, the locker burning the token side of a harvest.
  // The cap is price times what is left, so what is left has to shrink with it.
  if (to === zeroAddress) {
    await pool.query(
      `update launches set total_supply = total_supply - $2, burned = burned + $2 where token = $1`,
      [token, value.toString()],
    );
  }
}

async function onStaked(log: Log & { args: Record<string, unknown> }) {
  const a = log.args;
  const token = (a.token as string).toLowerCase();
  const owner = (a.owner as string).toLowerCase();
  const amount = a.amount as bigint;
  const when = await blockTime(log.blockNumber!);
  await pool.query(
    `insert into stakes (position_id, token, owner, amount, unlock_at, weight_bps, created_at)
     values ($1,$2,$3,$4,to_timestamp($5),$6,$7) on conflict (position_id) do nothing`,
    [Number(a.id), token, owner, amount.toString(), Number(a.unlockAt), Number(a.weightBps), when],
  );
  // No points here. A lock is paid for the time it is kept, not for the act of opening it, which
  // is what stake-accrual.ts does on its own clock. See POINTS for why.
}

/// v4 has no pool contract: a pool is an id inside the PoolManager. The id is the hash of the key,
/// which the indexer rebuilds from what the launch published.
function poolIdOf(token: string, quote: string, fee: number, spacing: number, hook: string): string {
  const [c0, c1] = quote < token ? [quote, token] : [token, quote];
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [c0 as Address, c1 as Address, fee, spacing, hook as Address],
    ),
  ).toLowerCase();
}

function registerPool(poolId: string, token: string, quote: string) {
  pools.set(poolId, { token, quote, tokenIsZero: token < quote });
}

async function onDirectLaunched(log: Log & { args: Record<string, unknown> }) {
  const a = log.args;
  const token = (a.token as string).toLowerCase();
  const quote = (a.quote as string).toLowerCase();
  const hook = (a.hook as string).toLowerCase();
  const splitter = (a.splitter as string).toLowerCase();
  const locker = (a.locker as string).toLowerCase();
  const when = await blockTime(log.blockNumber!);

  // The launch transaction says what the supply is: the clone mints all of it to the portal, and
  // the portal burns the dust the liquidity maths could not place. It is read off the receipt
  // rather than from `totalSupply()`, because on a catch-up the live figure already carries every
  // buyback burn that came later, and the Transfer handler would then take those off twice. The
  // same receipt says whether the portal announced the pool's shape, or whether the hook has to
  // be asked the way launches from before that event were.
  const quoteMeta = await pairMetadata(quote);
  const receipt = await client.getTransactionReceipt({ hash: log.transactionHash! });
  let minted = 0n;
  let burned = 0n;
  let announced = false;
  for (const l of receipt.logs) {
    const at = l.address.toLowerCase();
    if (at === PORTAL && l.topics[0] === POOL_OPENED_TOPIC) announced = true;
    if (at !== token || l.topics[0] !== TRANSFER_TOPIC || l.topics.length < 3) continue;
    const value = BigInt(l.data);
    if (topicAddress(l.topics[1]!) === zeroAddress) minted += value;
    if (topicAddress(l.topics[2]!) === zeroAddress) burned += value;
  }
  if (minted === 0n) {
    burned = 0n;
    try {
      minted = (await client.readContract({
        address: token as Address, abi: [parseAbiItem("function totalSupply() view returns (uint256)")], functionName: "totalSupply",
      })) as bigint;
    } catch (err) {
      console.warn(`direct launch ${token}: could not read its supply yet`, err instanceof Error ? err.message : err);
    }
  }

  // The split columns stay at their zero default: a direct launch's tax never reaches the fee
  // router, it is split in its own splitter, and that allocation lands in alloc_*_bps below.
  const { rows: created } = await pool.query<{ token: string }>(
    `insert into launches (token, curve, creator, fee_recipient, pair_token, config_id,
       name, symbol, launched_at, block, tx, mode, hook, splitter, locker, restrictions_end_block,
       total_supply, burned, pair_symbol, pair_decimals)
     values ($1,$2,$3,$3,$4,0,'','',$5,$6,$7,'direct',$8,$9,$10,$11,$12,$13,$14,$15)
     on conflict (token) do nothing
     returning token`,
    [
      token, zeroAddress, (a.creator as string).toLowerCase(), quote, when,
      log.blockNumber!.toString(), log.transactionHash, hook, splitter, locker,
      (a.restrictionsEndBlock as bigint).toString(), (minted - burned).toString(), burned.toString(),
      // The direct machine takes the same quotes as the curve, so its rows need the same scale on
      // them: six decimals for the dollar, eighteen for a share, and the board has to know which.
      quoteMeta.symbol, quoteMeta.decimals,
    ],
  );
  if (created[0]) unannounced.add(token);

  hooks.set(hook, token);
  splitters.set(splitter, token);
  quotes.set(token, quote);
  tokens.add(token);

  // The four roads are fixed at launch, so one read is the truth forever. They are what tells the
  // app whether holders are paid on this launch at all.
  try {
    const alloc = (await client.readContract({
      address: splitter as Address,
      abi: [parseAbiItem("function allocations() view returns (uint16 creatorBps, uint16 buybackBps, uint16 dividendsBps, uint16 liquidityBps)")],
      functionName: "allocations",
    })) as readonly [number, number, number, number];
    await pool.query(
      `update launches set alloc_creator_bps = $2, alloc_buyback_bps = $3, alloc_dividends_bps = $4, alloc_liquidity_bps = $5
       where token = $1`,
      [token, Number(alloc[0]), Number(alloc[1]), Number(alloc[2]), Number(alloc[3])],
    );
  } catch (err) {
    console.warn(`direct launch ${token}: could not read its allocations yet`, err instanceof Error ? err.message : err);
  }

  // PoolOpened follows in this same transaction and carries the pool's shape. A launch from
  // before that event existed has to be asked: the hook and the portal still hold every number.
  if (!announced) await shapeFromHook(token, quote, hook);

  // The 500 for printing waits for the token to trade: see creditLaunch.
}

/// The pool's shape, straight from the portal. Nothing here needs a call back into the hook, which
/// is what a screener or a bot following the chain from logs alone was missing.
async function onPoolOpened(log: Log & { args: Record<string, unknown> }) {
  const a = log.args;
  const token = (a.token as string).toLowerCase();
  const poolId = (a.poolId as string).toLowerCase();
  const quote = quotes.get(token);
  if (!quote) return; // DirectLaunched always precedes this, so an unknown token is not ours
  const tickStart = Number(a.tickStart);
  // The opening price stands until the first swap, which follows in log order and overwrites it.
  const price = priceFromTick(tickStart, token < quote);
  await pool.query(
    `update launches set pool_id = $2, pool_fee = $3, tick_spacing = $4, tick_start = $5, tick_bond = $6,
            last_tick = $5, price = $7, buy_tax_bps = $8, sell_tax_bps = $9, snipe_tax_bps = $10,
            snipe_decay_seconds = $11, max_hold_bps = $12, max_buy_bps = $13
     where token = $1`,
    [
      token, poolId, Number(a.fee), Number(a.tickSpacing), tickStart, Number(a.tickBond), price.toString(),
      Number(a.buyTaxBps), Number(a.sellTaxBps), Number(a.snipeTaxBps), Number(a.snipeDecaySeconds),
      Number(a.maxHoldBps), Number(a.maxBuyBps),
    ],
  );
  registerPool(poolId, token, quote);
}

/// The fallback for launches indexed from before PoolOpened existed: the portal's constants for the
/// pool key, and the hook and the portal for the rest.
async function shapeFromHook(token: string, quote: string, hook: string) {
  const [poolFee, tickSpacing] = [10_000, 200];
  const poolId = poolIdOf(token, quote, poolFee, tickSpacing, hook);
  await pool.query(`update launches set pool_id = $2, pool_fee = $3, tick_spacing = $4 where token = $1`, [
    token, poolId, poolFee, tickSpacing,
  ]);
  registerPool(poolId, token, quote);
  try {
    const hookAbi = [
      parseAbiItem("function tickBond() view returns (int24)"),
      parseAbiItem("function buyTaxBps() view returns (uint16)"),
      parseAbiItem("function sellTaxBps() view returns (uint16)"),
      parseAbiItem("function snipeTaxBps() view returns (uint16)"),
      parseAbiItem("function snipeDecaySeconds() view returns (uint32)"),
    ];
    const [tickBond, tickStartRaw, buyTax, sellTax, snipeTax, snipeDecay] = await client.multicall({
      allowFailure: false,
      contracts: [
        { address: hook as Address, abi: hookAbi, functionName: "tickBond" },
        {
          address: PORTAL,
          abi: [parseAbiItem("function startTick(address) view returns (int24)")],
          functionName: "startTick",
          args: [hook as Address],
        },
        { address: hook as Address, abi: hookAbi, functionName: "buyTaxBps" },
        { address: hook as Address, abi: hookAbi, functionName: "sellTaxBps" },
        { address: hook as Address, abi: hookAbi, functionName: "snipeTaxBps" },
        { address: hook as Address, abi: hookAbi, functionName: "snipeDecaySeconds" },
      ],
    }) as unknown as [number, number, number, number, number, number];
    const tickStart = Number(tickStartRaw);
    const price = priceFromTick(tickStart, token < quote);
    await pool.query(
      `update launches set tick_start = $2, tick_bond = $3, last_tick = $2, price = $4,
              buy_tax_bps = $5, sell_tax_bps = $6, snipe_tax_bps = $7, snipe_decay_seconds = $8
       where token = $1`,
      [token, tickStart, Number(tickBond), price.toString(), Number(buyTax), Number(sellTax), Number(snipeTax), Number(snipeDecay)],
    );
  } catch (err) {
    console.warn(`direct launch ${token}: could not read its shape yet`, err instanceof Error ? err.message : err);
  }
}

async function onLaunchMetadata(log: Log & { args: Record<string, unknown> }) {
  const a = log.args;
  const { rows } = await pool.query(
    `update launches set name = $2, symbol = $3, image = $4, description = $5, website = $6, twitter = $7, telegram = $8
     where token = $1
     returning token, symbol, name, creator, mode, launched_at`,
    [(a.token as string).toLowerCase(), a.name, a.symbol, a.image, a.description, a.website, a.twitter, a.telegram],
  );
  await announce(rows[0]);
}

async function onDirectMetadata(log: Log & { args: Record<string, unknown> }) {
  const a = log.args;
  const { rows } = await pool.query(
    `update launches set name = $2, symbol = $3, image = $4, description = $5 where token = $1
     returning token, symbol, name, creator, mode, launched_at`,
    [(a.token as string).toLowerCase(), a.name, a.symbol, a.logo, a.description],
  );
  await announce(rows[0]);
}

/// Pair wei per 1e18 token wei at a tick. price = 1.0001^tick is currency1 per currency0 in raw
/// units; which way round that is depends on which currency the token sorted into.
function priceFromTick(tick: number, tokenIsZero: boolean): bigint {
  const raw = Math.pow(1.0001, tick); // currency1 per currency0
  const quotePerToken = tokenIsZero ? raw : 1 / raw;
  return BigInt(Math.round(quotePerToken * 1e18));
}

/// The person behind a v4 swap: for a buy, whoever received the token out of the PoolManager in
/// that transaction; for a sell, whoever sent it in. System contracts are never the person.
const traderCache = new Map<string, string>();
async function traderOf(log: Log, token: string, side: "buy" | "sell"): Promise<string> {
  const key = `${log.transactionHash}:${side}`;
  const cached = traderCache.get(key);
  if (cached) return cached;
  const receipt = await client.getTransactionReceipt({ hash: log.transactionHash! });
  // Whoever the tokens moved for. If that was one of our own contracts (a buyback, a harvest), the
  // trade belongs to the contract and scores nothing, even though a person paid the gas for it.
  let who: string | undefined;
  for (const l of receipt.logs) {
    if (l.address.toLowerCase() !== token || l.topics[0] !== TRANSFER_TOPIC) continue;
    const from = topicAddress(l.topics[1]!);
    const to = topicAddress(l.topics[2]!);
    if (side === "buy" && from === POOL_MANAGER) { who = to; break; }
    if (side === "sell" && to === POOL_MANAGER) { who = from; break; }
  }
  who ??= receipt.from.toLowerCase();
  traderCache.set(key, who);
  return who;
}

/// Who a launch's fee comes back to.
///
/// Points are paid per dollar traded, and the season pool is divided pro rata, so the cheapest way
/// to farm both is to trade against yourself on a launch whose fee you collect: on the direct
/// machine a creator can take up to 90% of the tax they just paid, which drops the real cost of
/// wash volume to the pool fee and the protocol's tenth. So a trade by the wallet the fee goes back
/// to earns no points and does not count towards the volume that unlocks the 500 for printing. It
/// is still a trade, it still moves the price, it simply does not score.
///
/// This is one half of the answer. The other half is a decision about the season pool itself, and
/// it is not a decision code can make: see docs/AIRDROP.md.
const payees = new Map<string, { creator: string; feeRecipient: string }>();

async function paysItself(token: string, scorer: string): Promise<boolean> {
  let p = payees.get(token);
  if (!p) {
    const { rows } = await pool.query<{ creator: string; fee_recipient: string | null }>(
      `select creator, fee_recipient from launches where token = $1`, [token],
    );
    if (!rows[0]) return false;
    p = {
      creator: rows[0].creator.toLowerCase(),
      feeRecipient: (rows[0].fee_recipient ?? "").toLowerCase(),
    };
    payees.set(token, p);
  }
  return scorer === p.creator || (p.feeRecipient !== "" && scorer === p.feeRecipient);
}

/// A trade on a direct launch is a v4 Swap on that launch's pool. The amounts are signed from the
/// pool's point of view, so the sign says which side the trader was on.
async function onV4Swap(log: Log & { args: Record<string, unknown> }) {
  const poolId = (log.args.id as string).toLowerCase();
  const launch = pools.get(poolId);
  if (!launch) return;

  const amount0 = log.args.amount0 as bigint;
  const amount1 = log.args.amount1 as bigint;
  // v4 reports the SWAPPER's deltas: negative is what they paid in, positive what they took out.
  const quoteDelta = launch.tokenIsZero ? amount1 : amount0;
  const tokenDelta = launch.tokenIsZero ? amount0 : amount1;
  const side = quoteDelta < 0n ? "buy" : "sell";
  const quoteAmount = quoteDelta < 0n ? -quoteDelta : quoteDelta;
  const tokenAmount = tokenDelta < 0n ? -tokenDelta : tokenDelta;
  if (tokenAmount === 0n || quoteAmount === 0n) return;

  const price = (quoteAmount * 10n ** 18n) / tokenAmount;
  const when = await blockTime(log.blockNumber!);
  // `sender` is whoever called the PoolManager: the router, the portal on a first buy, the
  // buyback module. The person is whoever the token moved for, which the Transfer in the same
  // transaction says; fall back to the transaction's origin.
  const trader = await traderOf(log, launch.token, side);

  const { rows: written } = await pool.query<{ id: string }>(
    `insert into trades (token, side, trader, recipient, pair_amount, token_amount, fee, price, block, tx, log_index, ts)
     values ($1,$2,$3,$3,$4,$5,0,$6,$7,$8,$9,$10) on conflict (tx, log_index) do nothing
     returning id`,
    [launch.token, side, trader, quoteAmount.toString(), tokenAmount.toString(), price.toString(),
     log.blockNumber!.toString(), log.transactionHash, log.logIndex, when],
  );
  await pool.query(
    `update launches set volume_total = volume_total + $2, trades_total = trades_total + 1, price = $3, last_tick = $4
     where token = $1`,
    [launch.token, quoteAmount.toString(), price.toString(), Number(log.args.tick)],
  );
  if (written[0]) {
    await notify("trade", {
      token: launch.token, side, trader, pairAmount: quoteAmount.toString(), tokenAmount: tokenAmount.toString(),
      price: price.toString(), tx: log.transactionHash, at: when,
    });
  }

  const usd = await usdValue(launch.quote, quoteAmount);
  const selfDealt = await paysItself(launch.token, trader);
  if (!SYSTEM.has(trader) && !selfDealt) {
    await award({
      address: trader, kind: side === "buy" ? "trade_buy" : "trade_sell", token: launch.token,
      usd, ref: `${log.transactionHash}:${log.logIndex}`, ts: when,
    });
  }
  if (!selfDealt) await creditLaunch(launch.token, usd, when);
}

/// Points for printing are earned by a token that trades, not by a token that exists. The 500 lands
/// the first time a launch crosses LAUNCH_POINTS_MIN_USD of volume, in whatever season that happens
/// to be, and the ref is the token itself so it can never be paid twice. Without this, a season
/// pool makes printing empty tokens at the launch fee the cheapest points on the board.
const LAUNCH_POINTS_MIN_USD = Number(process.env.LAUNCH_POINTS_MIN_USD ?? 1000);

export async function creditLaunch(token: string, usd: number, when: Date) {
  if (usd <= 0) return;
  const { rows } = await pool.query<{ creator: string; volume_usd: string; paid: Date | null }>(
    `update launches set volume_usd = volume_usd + $2 where token = $1
     returning creator, volume_usd, launch_points_at as paid`,
    [token, usd.toFixed(2)],
  );
  const row = rows[0];
  if (!row || row.paid || Number(row.volume_usd) < LAUNCH_POINTS_MIN_USD) return;
  await award({ address: row.creator, kind: "launch", token, usd: 0, ref: `launch:${token}`, ts: when });
  await pool.query(`update launches set launch_points_at = $2 where token = $1 and launch_points_at is null`, [token, when]);
}

/// Money the fee router moved. `Accrued` is one number, what a trade booked. `Flushed` is that pot
/// leaving along the token's split, so it carries the four destinations and whatever the buyback
/// leg burned. The four legs are kept because they are the only place the money is ever counted:
/// the split on the launch row says the shares, these rows say what was actually paid on them.
async function onFeeEvent(log: Log & { args: Record<string, unknown> }, kind: "accrued" | "flushed") {
  const a = log.args;
  const leg = (name: string) => (kind === "flushed" ? (a[name] as bigint).toString() : null);
  await pool.query(
    `insert into fee_events (token, kind, amount, result, to_stakers, to_buyback, to_liquidity, to_creator,
       block, tx, log_index, ts)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict (tx, log_index) do nothing`,
    [
      (a.token as string).toLowerCase(), kind, (a.amount as bigint).toString(),
      (a.tokensBurned as bigint | undefined)?.toString() ?? "0",
      leg("toStakers"), leg("toBuyback"), leg("toLiquidity"), leg("toCreator"),
      log.blockNumber!.toString(), log.transactionHash, log.logIndex, await blockTime(log.blockNumber!),
    ],
  );
}

/// Money the direct machine moved, one row per event, in the same table the curve's router writes.
async function directFeeEvent(log: Log, token: string, kind: string, amount: bigint, result: bigint) {
  await pool.query(
    `insert into fee_events (token, kind, amount, result, block, tx, log_index, ts)
     values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (tx, log_index) do nothing`,
    [token, kind, amount.toString(), result.toString(), log.blockNumber!.toString(), log.transactionHash, log.logIndex, await blockTime(log.blockNumber!)],
  );
}

// ---------------------------------------------------------------- the loop

async function handle(log: Log & { eventName?: string; args?: Record<string, unknown> }) {
  const address = log.address.toLowerCase();
  const l = log as Log & { args: Record<string, unknown> };
  switch (log.eventName) {
    case "Launched": if (address === FACTORY) await onLaunched(l); break;
    case "FirstBuyLocked": if (address === FACTORY) await onFirstBuyLocked(l); break;
    case "LaunchMetadata": if (address === FACTORY) await onLaunchMetadata(l); break;
    case "Bought": await onTrade(l, "buy"); break;
    case "Sold": await onTrade(l, "sell"); break;
    case "Transfer": await onTransfer(l); break;
    case "Staked": if (address === STAKING) await onStaked(l); break;
    case "Unstaked":
      if (address === STAKING) {
        // Pay what it earned up to the block it left in, then close it. The other order would lose
        // everything since the last hourly credit.
        await settleStake(Number(l.args.id), await blockTime(l.blockNumber!));
        await pool.query(`update stakes set active = false where position_id = $1`, [Number(l.args.id)]);
      }
      break;
    case "Claimed":
      if (address === STAKING) {
        // One vault takes fees from launches paired against different things, so a claim has an
        // asset now. `claimed` stays the running total in the chain's own currency, which is what
        // the app shows; `claimed_by_asset` carries the rest, including it, without pretending a
        // stablecoin and an ether are the same number.
        const asset = (l.args.asset as string).toLowerCase();
        const paid = (l.args.amount as bigint).toString();
        await pool.query(
          `update stakes
              set claimed = claimed + case when $3 = $4 then $2::numeric else 0 end,
                  claimed_by_asset = jsonb_set(
                    claimed_by_asset, array[$3],
                    to_jsonb((coalesce(claimed_by_asset ->> $3, '0')::numeric + $2::numeric)::text), true)
            where position_id = $1`,
          [Number(l.args.id), paid, asset, zeroAddress],
        );
      }
      break;
    case "Demoted":
      if (address === STAKING) await pool.query(`update stakes set weight_bps = $2 where position_id = $1`, [Number(l.args.id), Number(l.args.weightBps)]);
      break;
    case "DirectLaunched": if (address === PORTAL) await onDirectLaunched(l); break;
    case "DirectMetadata": if (address === PORTAL) await onDirectMetadata(l); break;
    case "PoolOpened": if (address === PORTAL) await onPoolOpened(l); break;
    case "Swap": if (address === POOL_MANAGER) await onV4Swap(l); break;
    case "Bonded":
      // Graduation is the same milestone on both machines, so the same column dates it.
      if (hooks.has(address)) {
        // `and not bonded` is what makes the announcement below fire once. The latch never unsets,
        // so a second pass over the same block has nothing left to change anyway.
        const { rows } = await pool.query<{ token: string; graduated_at: Date }>(
          `update launches set bonded = true, graduated_at = coalesce(graduated_at, $2) where hook = $1 and not bonded
           returning token, graduated_at`,
          [address, await blockTime(log.blockNumber!)],
        );
        if (rows[0]) await notify("graduated", { token: rows[0].token, at: rows[0].graduated_at });
      }
      break;
    case "Taxed": break; // the swap itself carries the volume; the tax is visible in the splitter
    case "Swept":
      if (splitters.has(address)) {
        await directFeeEvent(log, splitters.get(address)!, "swept", l.args.total as bigint, l.args.dividends as bigint);
      }
      break;
    case "ProtocolClaimed":
      if (splitters.has(address)) {
        await directFeeEvent(log, splitters.get(address)!, "protocol_claimed", l.args.amount as bigint, 0n);
      }
      break;
    case "BoughtBack":
      // The module and the graduator both say it, in the same shape: what was spent, what burned.
      // The burn itself reaches the supply through Transfer; this row is the money side.
      if (address === BUYBACK_MODULE || address === GRADUATOR) {
        await directFeeEvent(log, (l.args.token as string).toLowerCase(), "bought_back", l.args.spent as bigint, l.args.burned as bigint);
      }
      break;
    case "DividendsClaimed":
      if (splitters.has(address)) {
        await pool.query(
          `insert into dividend_events (token, holder, amount, block, tx, log_index, ts)
           values ($1,$2,$3,$4,$5,$6,$7) on conflict (tx, log_index) do nothing`,
          [
            splitters.get(address), (l.args.holder as string).toLowerCase(), (l.args.amount as bigint).toString(),
            log.blockNumber!.toString(), log.transactionHash, log.logIndex, await blockTime(log.blockNumber!),
          ],
        );
      }
      break;
    case "Accrued": if (address === FEE_ROUTER) await onFeeEvent(l, "accrued"); break;
    case "Flushed": if (address === FEE_ROUTER) await onFeeEvent(l, "flushed"); break;
    case "SoldOut":
      if (curves.has(address)) await pool.query(`update launches set phase = 1 where curve = $1`, [address]);
      break;
    case "Graduated":
      if (curves.has(address)) {
        // The reserve left the curve for the pool; it is not sitting there any more. `phase < 2`
        // keeps a reread of the same block from moving graduated_at to today and announcing it
        // again: a curve graduates once.
        const { rows } = await pool.query<{ token: string; graduated_at: Date }>(
          `update launches set phase = 2, graduated_at = now(), reserve = 0 where curve = $1 and phase < 2
           returning token, graduated_at`, [address],
        );
        if (rows[0]) await notify("graduated", { token: rows[0].token, at: rows[0].graduated_at });
      }
      break;
    default: break;
  }
}

async function readRange(from: bigint, to: bigint): Promise<void> {
  const logs = await client.getLogs({ events: Object.values(events), fromBlock: from, toBlock: to });
  logs.sort((a, b) => Number(a.blockNumber! - b.blockNumber!) || a.logIndex! - b.logIndex!);
  for (const log of logs) await handle(log as never);
}

/// A range the node refused, written down rather than only logged. Recorded only for a failure to
/// FETCH: a range that came back and then blew up inside a handler is our own bug, and re-reading
/// it later would replay whatever did land. That case is left to fail loudly and retry the same
/// blocks instead.
async function recordGap(from: bigint, to: bigint, err: unknown): Promise<void> {
  await pool.query(
    `insert into indexer_gaps (from_block, to_block, reason, kind) values ($1,$2,$3,'gap')
     on conflict (from_block, to_block) do nothing`,
    [from.toString(), to.toString(), (err instanceof Error ? err.message : String(err)).slice(0, 300)],
  );
}

/// A block we indexed is no longer the block at that height. Reading the range again would not fix
/// it: every aggregate here is accumulated, so a replay counts the same trades twice. What this can
/// do is refuse to pretend: the range is recorded as a reorg, `/ready` fails while it is open, and
/// a human decides between reindexing from scratch and accepting the drift.
async function recordReorg(at: bigint, was: string, now: string): Promise<void> {
  await pool.query(
    `insert into indexer_gaps (from_block, to_block, reason, kind) values ($1,$1,$2,'reorg')
     on conflict (from_block, to_block) do nothing`,
    [at.toString(), `indexed ${was}, chain now has ${now}`.slice(0, 300)],
  );
  console.error(`indexer: reorg at block ${at}: indexed ${was}, chain now has ${now}`);
}

/// Has the ground moved under the last block we indexed? One header fetch per pass.
async function reorged(cursor: bigint): Promise<boolean> {
  if (cursor <= START_BLOCK) return false;
  const known = await getCursorHash("main");
  if (!known) return false;
  const at = cursor - 1n;
  try {
    const block = await client.getBlock({ blockNumber: at });
    if (block.hash && block.hash !== known) {
      await recordReorg(at, known, block.hash);
      return true;
    }
  } catch {
    // A header we cannot fetch is not evidence of anything; the next pass asks again.
  }
  return false;
}

export interface GapReport {
  open: number;
  blocks: number;
  oldest: string | null;
  /// Ranges that were indexed and then stopped being true. These are not retried, because every
  /// aggregate here accumulates and a replay would double count.
  reorgs: number;
}

export async function openGaps(): Promise<GapReport> {
  const { rows } = await pool.query<{ open: string; blocks: string | null; oldest: string | null; reorgs: string }>(
    `select count(*) as open, coalesce(sum(to_block - from_block + 1), 0) as blocks,
            min(from_block)::text as oldest,
            count(*) filter (where kind = 'reorg') as reorgs
     from indexer_gaps where healed_at is null`,
  );
  const r = rows[0];
  return {
    open: Number(r?.open ?? 0), blocks: Number(r?.blocks ?? 0), oldest: r?.oldest ?? null,
    reorgs: Number(r?.reorgs ?? 0),
  };
}

/// Asks again for the ranges the node would not serve. The usual reason one failed is a node having
/// a minute, and the usual fix is asking later, so this runs on the indexer's own slow clock as
/// well as from the admin route. A range that fails again is left open for the next pass.
export async function rescanGaps(limit = 5): Promise<{ tried: number; healed: number }> {
  const { rows } = await pool.query<{ from_block: string; to_block: string }>(
    `select from_block, to_block from indexer_gaps
     where healed_at is null and kind = 'gap' order by from_block limit $1`,
    [limit],
  );
  let healed = 0;
  for (const gap of rows) {
    try {
      await readRange(BigInt(gap.from_block), BigInt(gap.to_block));
      await pool.query(
        `update indexer_gaps set healed_at = now() where from_block = $1 and to_block = $2`,
        [gap.from_block, gap.to_block],
      );
      healed++;
      console.log(`indexer: filled the gap at ${gap.from_block}-${gap.to_block}`);
    } catch (err) {
      console.error(`indexer: gap ${gap.from_block}-${gap.to_block} still refused`, err);
    }
  }
  return { tried: rows.length, healed };
}

async function scan(from: bigint, to: bigint, chunk: bigint): Promise<bigint> {
  let cursor = from;
  let size = chunk;
  while (cursor <= to) {
    const end = cursor + size - 1n > to ? to : cursor + size - 1n;
    let logs;
    try {
      logs = await client.getLogs({ events: Object.values(events), fromBlock: cursor, toBlock: end });
    } catch (err) {
      if (size <= 32n) {
        // Walking past a range the node will not serve keeps the indexer alive, and that is the
        // right call: the alternative is stopping forever over one flaky minute. But what is walked
        // past is trades, points and balances that exist nowhere else, so it is written down.
        // `/ready` fails while a gap is open, `/admin/overview` counts them, and rescanGaps closes
        // them.
        console.error(`indexer: giving up on ${cursor}-${end}`, err);
        await recordGap(cursor, end, err);
        cursor = end + 1n;
        await setCursor("main", end);
        continue;
      }
      size = size / 2n; // the node refused the range; ask for less
      await new Promise((r) => setTimeout(r, 400));
      continue;
    }

    // Handling is our own code. If it throws, the range is not a gap and must not be walked past:
    // let it out, so the loop above retries the same blocks and the error is loud.
    logs.sort((a, b) => Number(a.blockNumber! - b.blockNumber!) || a.logIndex! - b.logIndex!);
    for (const log of logs) await handle(log as never);
    // The hash goes in with the number: next pass compares it and notices a reorg.
    const last = await client.getBlock({ blockNumber: end }).catch(() => null);
    await setCursor("main", end, last?.hash ?? undefined);
    cursor = end + 1n;
    if (size < MAX_CHUNK) size = size * 2n > MAX_CHUNK ? MAX_CHUNK : size * 2n;
  }
  return cursor;
}

export async function refreshRollingVolume() {
  await pool.query(
    `update launches l set volume_24h = coalesce((
       select sum(pair_amount) from trades t where t.token = l.token and t.ts > now() - interval '24 hours'
     ), 0)`,
  );
}

export async function runIndexer() {
  if (!FACTORY) throw new Error("HOOD_FACTORY is not set");
  await loadKnown();
  let cursor = await getCursor("main", START_BLOCK);
  console.log(`indexer: starting at block ${cursor}`);

  let accruedAt = 0;
  for (;;) {
    try {
      const head = await client.getBlockNumber();
      // Never index the last few blocks: see CONFIRMATIONS.
      const settled = head > CONFIRMATIONS ? head - CONFIRMATIONS : 0n;
      if (await reorged(cursor)) {
        // Keep serving, stop pretending. `/ready` is already failing by the time this line runs.
        await new Promise((r) => setTimeout(r, 5_000));
      } else if (settled >= cursor) {
        cursor = await scan(cursor, settled, MAX_CHUNK);
      }
      await refreshRollingVolume();
      // Locked positions earn while nothing happens on chain, so this cannot hang off an event.
      // It rides the indexer's loop on a slower clock: one pass every few minutes, and each pass
      // skips any position that has not been open long enough since its last credit.
      if (Date.now() - accruedAt > Number(process.env.STAKE_ACCRUAL_EVERY_MS ?? 300_000)) {
        accruedAt = Date.now();
        await accrueStakePoints();
        await rescanGaps();
      }
    } catch (err) {
      console.error("indexer:", err);
    }
    await new Promise((r) => setTimeout(r, Number(process.env.HOOD_POLL_MS ?? 1500)));
  }
}
