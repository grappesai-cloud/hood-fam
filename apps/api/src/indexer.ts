import {
  createPublicClient, encodeAbiParameters, erc20Abi, http, keccak256, parseAbiItem, stringToHex, toEventSelector, zeroAddress,
  type Address, type Log,
} from "viem";
import { pairAsset, robinhood } from "@hood/sdk";

import { pool, getCursor, getCursorHash, setCursor } from "./db.js";
import { notify } from "./events.js";
import { award } from "./points.js";
import { recordBasis } from "./pnl.js";
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
/// The referral registry the owner writes by hand. Empty on a deployment that has none: the
/// events then never match an address and nothing is written.
const REFERRALS = (process.env.HOOD_REFERRALS ?? "").toLowerCase() as Address;
/// The Bag and its outlets. Every one is optional: a deployment from before the Bag has none of
/// them, and an address left unset never matches a log, so nothing is written for it. The house
/// coin needs no key here: once it exists it is a launch like any other, and the burn clock says
/// what it burned of it.
const BAG = (process.env.HOOD_BAG ?? "").toLowerCase() as Address;
const PAYDAY = (process.env.HOOD_PAYDAY ?? "").toLowerCase() as Address;
const BURN_CLOCK = (process.env.HOOD_BURN_CLOCK ?? "").toLowerCase() as Address;
const BOOSTS = (process.env.HOOD_BOOSTS ?? "").toLowerCase() as Address;
const GRADUATION_HOOK = (process.env.HOOD_GRADUATION_HOOK ?? "").toLowerCase() as Address;
const OPENING_AUCTION = (process.env.HOOD_OPENING_AUCTION ?? "").toLowerCase() as Address;

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
  creatorClaimed: parseAbiItem("event CreatorClaimed(address indexed to, uint256 amount)"),
  protocolClaimed: parseAbiItem("event ProtocolClaimed(address indexed to, uint256 amount)"),
  // the referral leg: set by the owner on the registry, paid by a curve or a splitter on a claim
  referralSet: parseAbiItem("event ReferralSet(address indexed token, address indexed to, uint16 bps)"),
  referralPaid: parseAbiItem("event ReferralPaid(address indexed to, uint256 amount)"),
  // `spent` is what the swap consumed, not the pot: what did not fit under the impact limit is carried
  boughtBack: parseAbiItem("event BoughtBack(address indexed token, uint256 spent, uint256 burned)"),
  v4Swap: parseAbiItem(
    "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
  ),
  // The factory's Launched with the pot appended, for a factory that emits it. Both shapes decode
  // to the same name and the handler takes the pot from the log when it is there.
  launchedWithPot: parseAbiItem(
    "event Launched(address indexed token, address indexed curve, address indexed creator, uint256 configId, address pairToken, (uint16 stakersBps, uint16 buybackBps, uint16 liquidityBps, uint16 creatorBps) feeSplit, address pot)",
  ),
  // the Bag: the enums travel as uint8
  bagIn: parseAbiItem("event BagIn(uint8 indexed source, address indexed asset, uint256 amount, address indexed token)"),
  bagOut: parseAbiItem("event BagOut(uint8 indexed outlet, address indexed asset, uint256 amount, address indexed to)"),
  held: parseAbiItem("event Held(uint8 indexed outlet, address indexed asset, uint256 amount)"),
  // a launch's pot (a HoodPot, or the splitter on a direct launch)
  holdersPaid: parseAbiItem("event HoldersPaid(bytes32 indexed reason, address indexed payer, uint256 amount, uint256 eligibleSupply)"),
  pushed: parseAbiItem("event Pushed(address indexed account, uint256 amount)"),
  kingCrowned: parseAbiItem("event KingCrowned(address indexed king, uint256 pot, uint64 endsAt)"),
  kingWon: parseAbiItem("event KingWon(address indexed king, uint256 amount)"),
  creatorSlashed: parseAbiItem("event CreatorSlashed(address indexed creator, uint256 amount)"),
  // Payday
  paydayFunded: parseAbiItem("event Funded(uint64 indexed epoch, address indexed asset, uint256 amount)"),
  paydayPaid: parseAbiItem("event Paid(uint64 indexed epoch, address indexed asset, address indexed wallet, uint256 amount)"),
  launchSlice: parseAbiItem("event LaunchSlice(uint64 indexed epoch, address indexed asset, address indexed pot, uint256 amount)"),
  epochPaid: parseAbiItem("event EpochPaid(uint64 indexed epoch, address indexed asset, uint256 toWallets, uint256 toLaunches, uint256 carried)"),
  // the burn clock
  burnFunded: parseAbiItem("event Funded(address indexed asset, uint256 amount)"),
  burned: parseAbiItem("event Burned(address indexed asset, uint256 spent, uint256 coinBurned, uint64 indexed epoch)"),
  houseCoinSet: parseAbiItem("event HouseCoinSet(address coin)"),
  // boosts
  boostBought: parseAbiItem("event BoostBought(address indexed token, address indexed buyer, uint64 indexed hourEpoch, uint8 slot, uint256 paid)"),
  slotPriceSet: parseAbiItem("event SlotPriceSet(uint256 price)"),
  // the direct hook's sell side: no token on the log, the hook is the token's
  directPenalty: parseAbiItem("event Penalty(bytes32 indexed reason, address indexed payer, uint256 amount, uint256 toHolders, uint256 toBag, bool isBuy)"),
  buybackTriggered: parseAbiItem("event BuybackTriggered(uint256 spent, uint256 burned)"),
  buybackWanted: parseAbiItem("event BuybackWanted(address token)"),
  // the graduation hook: one hook for every graduated pool, so the log names the token
  poolPenalty: parseAbiItem("event Penalty(bytes32 indexed reason, address indexed payer, address indexed token, uint256 amount, uint256 toHolders, uint256 toBag)"),
  // the sniper auction
  auctionBid: parseAbiItem("event Bid(address indexed token, address indexed bidder, uint256 amount, uint64 endBlock)"),
  auctionSettled: parseAbiItem("event Settled(address indexed token, address indexed winner, uint256 amount, uint256 toHolders, uint256 toLiquidity)"),
  // the Vault being fed, per asset
  rewardNotified: parseAbiItem("event RewardNotified(address indexed asset, uint256 amount)"),
  // The portal's penalty switches and the auction window, said right after PoolOpened. The
  // factory's penaltiesOf answers zero for a direct launch, so this log is the only place they are.
  launchRules: parseAbiItem(
    "event LaunchRules(address indexed token, uint16 jeetTaxBps, uint32 jeetWindowSeconds, uint16 whaleTaxBps, uint24 whaleTickLimit, uint16 kingBps, bool penaltiesToVault, uint32 auctionBlocks, uint64 auctionEndBlock)",
  ),
  auctionRegistered: parseAbiItem("event Registered(address indexed token, uint64 endBlock, uint256 minBid)"),
  // The factory's two lines after Launched: the pot it deployed and the switches it stored. The
  // same facts launchExtras reads back, here straight off the log.
  potDeployed: parseAbiItem("event PotDeployed(address indexed token, address indexed pot)"),
  launchPenalties: parseAbiItem(
    "event LaunchPenalties(address indexed token, (uint16 jeetTaxBps, uint32 jeetWindowSeconds, uint16 whaleTaxBps, uint24 whaleTickLimit, uint16 kingBps, bool penaltiesToVault) penalties)",
  ),
  // Payday could not deliver a share and booked it; the wallet took it later
  paydayOwed: parseAbiItem("event Owed(address indexed wallet, address indexed asset, uint256 amount)"),
  paydayOwedClaimed: parseAbiItem("event OwedClaimed(address indexed wallet, address indexed asset, uint256 amount)"),
  // the house's leg could not be delivered and waits in the Bag; the house took it later
  houseDeferred: parseAbiItem("event HouseDeferred(address indexed asset, uint256 amount)"),
  houseClaimed: parseAbiItem("event HouseClaimed(address indexed asset, uint256 amount)"),
  // the king pot took its slice of a penalty
  kingPotFed: parseAbiItem("event KingPotFed(uint256 amount, uint256 pot)"),
  // the graduation hook let go of the platform fee it held: the creator's leg and the Bag's
  poolClaimsFlushed: parseAbiItem("event ClaimsFlushed(bytes32 indexed id, address indexed token, uint256 toCreator, uint256 toBag)"),
} as const;

/// The factory as the Bag left it: the registry row ends in the pot, and the penalty switches have
/// a view of their own. Read with a try around each, because an older factory answers neither.
const LAUNCH_WITH_POT_ABI = [parseAbiItem(
  "function getLaunch(address token) view returns ((address curve, address creator, address creatorFeeRecipient, address pairToken, uint256 configId, (uint16 stakersBps, uint16 buybackBps, uint16 liquidityBps, uint16 creatorBps) feeSplit, bytes32 symbolHash, bytes32 imageHash, uint64 launchedAt, bool exists, uint8 mode, uint256 firstBuyLocked, uint64 firstBuyUnlockAt, address hook, address splitter, address locker, address pot))",
)];
const PENALTIES_ABI = [parseAbiItem(
  "function penaltiesOf(address token) view returns ((uint16 jeetTaxBps, uint32 jeetWindowSeconds, uint16 whaleTaxBps, uint24 whaleTickLimit, uint16 kingBps, bool penaltiesToVault))",
)];
const LAUNCH_FEE_ABI = [parseAbiItem("function launchFee() view returns (uint256)")];

const TRANSFER_TOPIC = toEventSelector(events.transfer);
const POOL_OPENED_TOPIC = toEventSelector(events.poolOpened);
const EPOCH_PAID_TOPIC = toEventSelector(events.epochPaid);
const topicAddress = (topic: string) => `0x${topic.slice(26)}`.toLowerCase();

const curves = new Map<string, { token: string; pairToken: string; decimals: number }>();
const tokens = new Set<string>();
/// Direct launches are keyed three ways because three different contracts speak for them.
const hooks = new Map<string, string>(); // hook -> token
const splitters = new Map<string, string>(); // splitter -> token
const pools = new Map<string, { token: string; quote: string; tokenIsZero: boolean }>(); // poolId -> launch
const quotes = new Map<string, string>(); // token -> quote, so PoolOpened can tell which way the pair sorts
/// Every pot, keyed by its address: a HoodPot on a curve launch, the splitter on a direct one. Both
/// speak the same two events, so both live in one map.
const pots = new Map<string, string>(); // pot -> token
/// Every contract that holds a launch's tokens as a piece of the machine: the curve, the hook, the
/// splitter, the locker, the pot. They have balances; they are not holders, and no bounty lands on them.
const machines = new Set<string>();

function remember(token: string, parts: { curve?: string | null; hook?: string | null; splitter?: string | null; locker?: string | null; pot?: string | null }) {
  for (const part of [parts.curve, parts.hook, parts.splitter, parts.locker, parts.pot]) {
    if (part && part !== zeroAddress) machines.add(part.toLowerCase());
  }
  if (parts.hook) hooks.set(parts.hook.toLowerCase(), token);
  if (parts.splitter) {
    splitters.set(parts.splitter.toLowerCase(), token);
    pots.set(parts.splitter.toLowerCase(), token);
  }
  if (parts.pot && parts.pot !== zeroAddress) pots.set(parts.pot.toLowerCase(), token);
}

async function loadKnown() {
  const { rows } = await pool.query<{
    token: string; curve: string | null; pair_token: string; mode: string;
    hook: string | null; splitter: string | null; locker: string | null; pot: string | null;
    pool_id: string | null; pair_decimals: number | null;
  }>(`select token, curve, pair_token, mode, hook, splitter, locker, pot, pool_id, pair_decimals from launches`);
  for (const r of rows) {
    const token = r.token.toLowerCase();
    tokens.add(token);
    quotes.set(token, r.pair_token.toLowerCase());
    if (r.curve && r.curve !== zeroAddress) {
      curves.set(r.curve.toLowerCase(), {
        token,
        pairToken: r.pair_token.toLowerCase(),
        // Old rows predate this column. Their only non-native pair was USDG, which has six
        // decimals; new arbitrary pairs keep the scale read at launch.
        decimals: r.pair_decimals ?? (r.pair_token === zeroAddress ? 18 : 6),
      });
    }
    remember(token, r);
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

/// Block timestamps, remembered. The Bag says five things about one trade and every one of them is
/// in the same block, so asking the node once per block rather than once per log is the difference
/// between keeping up and not. Bounded, because the walk never comes back to an old block.
const blockTimes = new Map<string, Date>();
async function blockTime(blockNumber: bigint): Promise<Date> {
  const key = blockNumber.toString();
  const known = blockTimes.get(key);
  if (known) return known;
  const b = await client.getBlock({ blockNumber });
  const at = ts(b);
  if (blockTimes.size >= 1024) {
    const oldest = blockTimes.keys().next().value;
    if (oldest !== undefined) blockTimes.delete(oldest);
  }
  blockTimes.set(key, at);
  return at;
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
    decimals: pairMeta.decimals,
  });
  tokens.add(token);
  quotes.set(token, pair);
  remember(token, { curve });
  await launchExtras(token, "curve", { pot: typeof a.pot === "string" ? a.pot : undefined, block: log.blockNumber! });
  // The 500 for printing is not paid here: see creditLaunch. A token nobody ever trades pays
  // nothing, or printing junk becomes the cheapest way to farm a season.
}

/// What the Bag added to a launch row: its pot, its penalty switches and the fee it paid to exist.
/// Every read is its own try: the factory that answers `getLaunch` with a pot and `penaltiesOf`
/// is newer than the one some deployments still run, and a launch on an older factory must still
/// index, with these columns null rather than the row missing.
async function launchExtras(
  token: string, mode: "curve" | "direct",
  from: { pot?: string; hook?: string; splitter?: string; block: bigint },
) {
  // A direct launch's pot is its splitter, by construction. A curve launch's is on the log when
  // the factory puts it there, and on the registry row otherwise.
  let pot = (mode === "direct" ? from.splitter : from.pot)?.toLowerCase();
  if (!pot || pot === zeroAddress) {
    try {
      const row = (await client.readContract({
        address: FACTORY, abi: LAUNCH_WITH_POT_ABI, functionName: "getLaunch", args: [token as Address],
      })) as { pot: string };
      if (row.pot && row.pot !== zeroAddress) pot = row.pot.toLowerCase();
    } catch {
      // an older factory: the registry row ends before the pot
    }
  }
  if (pot && pot !== zeroAddress) {
    await pool.query(`update launches set pot = $2 where token = $1`, [token, pot]);
    remember(token, { pot });
  }
  // The switches, from the factory's own view. A direct launch's are not there (the factory
  // answers zero for it): the portal says them in LaunchRules, which follows in the same
  // transaction and is the only source for that machine.
  if (mode === "curve") {
    try {
      const p = (await client.readContract({
        address: FACTORY, abi: PENALTIES_ABI, functionName: "penaltiesOf", args: [token as Address],
      })) as PenaltyArgs;
      await writePenalties(token, p);
    } catch {
      // an older factory: the switches stay null, which the app reads as "not told"
    }
  }
  // The fee to exist, as the machine priced it in the launch block. A node serves a recent block's
  // state; when it will not, the column stays null rather than carrying today's price for a launch
  // that paid yesterday's.
  try {
    const fee = (await client.readContract({
      address: mode === "curve" ? FACTORY : PORTAL, abi: LAUNCH_FEE_ABI, functionName: "launchFee", blockNumber: from.block,
    })) as bigint;
    await pool.query(`update launches set launch_fee = $2 where token = $1`, [token, fee.toString()]);
  } catch {
    // no fee view on this machine, or no state for that block any more
  }
}

interface PenaltyArgs {
  jeetTaxBps: number | bigint; jeetWindowSeconds: number | bigint; whaleTaxBps: number | bigint;
  whaleTickLimit: number | bigint; kingBps: number | bigint; penaltiesToVault: boolean;
}

/// The six switches on the launch row. Fixed at launch, so writing them twice writes the same thing.
async function writePenalties(token: string, p: PenaltyArgs) {
  await pool.query(
    `update launches set jeet_tax_bps = $2, jeet_window_seconds = $3, whale_tax_bps = $4, whale_tick_limit = $5,
            king_bps = $6, penalties_to_vault = $7
     where token = $1`,
    [token, Number(p.jeetTaxBps), Number(p.jeetWindowSeconds), Number(p.whaleTaxBps), Number(p.whaleTickLimit),
     Number(p.kingBps), Boolean(p.penaltiesToVault)],
  );
}

/// The factory said where the pot is. Emitted after Launched in the same transaction, so the row
/// is there; on an older factory this never fires and launchExtras has already asked the registry.
async function onPotDeployed(log: Log & { args: Record<string, unknown> }) {
  const token = lower(log.args.token);
  const pot = lower(log.args.pot);
  if (pot === zeroAddress) return;
  await pool.query(`update launches set pot = $2 where token = $1`, [token, pot]);
  remember(token, { pot });
}

/// The factory said the switches, as a struct on the log: the second source for a curve launch.
async function onLaunchPenalties(log: Log & { args: Record<string, unknown> }) {
  await writePenalties(lower(log.args.token), log.args.penalties as PenaltyArgs);
}

/// The portal's word on a direct launch: the switches, and the auction window when there is one.
/// Follows DirectLaunched in the same transaction, so the row exists. An auction is opened here
/// as a row with its end block and nothing in the book yet; the bids fill it in.
async function onLaunchRules(log: Log & { args: Record<string, unknown> }) {
  const a = log.args;
  const token = lower(a.token);
  if (!tokens.has(token)) return;
  const blocks = Number(a.auctionBlocks);
  await writePenalties(token, a as unknown as PenaltyArgs);
  await pool.query(`update launches set auction_blocks = $2 where token = $1`, [token, blocks]);
  if (blocks > 0) await openAuction(token, (a.auctionEndBlock as bigint).toString());
}

/// The auction contract's own word on the window. Same transaction as LaunchRules, same row.
async function onAuctionRegistered(log: Log & { args: Record<string, unknown> }) {
  const a = log.args;
  const token = lower(a.token);
  if (!tokens.has(token)) return;
  await openAuction(token, (a.endBlock as bigint).toString());
}

/// An auction row with its end block. Only the end block is set on a row that exists, so a
/// re-read of the launch block never empties a book the bids have since filled.
async function openAuction(token: string, endBlock: string) {
  await pool.query(
    `insert into auctions (token, end_block, bids, settled, updated_at) values ($1,$2,0,false,now())
     on conflict (token) do update set end_block = excluded.end_block, updated_at = now()`,
    [token, endBlock],
  );
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
  // Cost basis follows the tokens, not the points: a wallet that pays itself still bought
  // something, and its profit page should say so even though the trade scores nothing.
  if (written[0]) await recordBasis({ token: curve.token, address: scorer, side, tokenAmount, usd, at: when });
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
  let feeRecipient = (a.creator as string).toLowerCase();
  try {
    feeRecipient = ((await client.readContract({
      address: splitter as Address,
      abi: [parseAbiItem("function creator() view returns (address)")],
      functionName: "creator",
    })) as string).toLowerCase();
  } catch (err) {
    console.warn(`direct launch ${token}: could not read fee recipient`, err instanceof Error ? err.message : err);
  }

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
     values ($1,$2,$3,$4,$5,0,'','',$6,$7,$8,'direct',$9,$10,$11,$12,$13,$14,$15,$16)
     on conflict (token) do nothing
     returning token`,
    [
      token, zeroAddress, (a.creator as string).toLowerCase(), feeRecipient, quote, when,
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
  remember(token, { hook, splitter, locker });
  await launchExtras(token, "direct", { hook, splitter, block: log.blockNumber! });

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
  if (written[0]) await recordBasis({ token: launch.token, address: trader, side, tokenAmount, usd, at: when });
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
  const token = (a.token as string).toLowerCase();
  const { rows: written } = await pool.query(
    `insert into fee_events (token, kind, amount, result, to_stakers, to_buyback, to_liquidity, to_creator,
       block, tx, log_index, ts)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict (tx, log_index) do nothing
     returning id, ts`,
    [
      token, kind, (a.amount as bigint).toString(),
      (a.tokensBurned as bigint | undefined)?.toString() ?? "0",
      leg("toStakers"), leg("toBuyback"), leg("toLiquidity"), leg("toCreator"),
      log.blockNumber!.toString(), log.transactionHash, log.logIndex, await blockTime(log.blockNumber!),
    ],
  );
  // A flush is money leaving along the split, which is what the ledger page lists; a booking is
  // not a payout and nobody is waiting on it.
  if (written[0] && kind === "flushed") {
    await notify("fee", { token, kind, amount: (a.amount as bigint).toString(), tx: log.transactionHash, at: written[0].ts });
  }
}

/// Money the direct machine moved, one row per event, in the same table the curve's router writes.
/// A sweep carries its legs the way a flush does (`result` is the dividends leg, the one column the
/// curve's router never fills), so the ledger can say where a direct launch's tax went, not only
/// that it went.
async function directFeeEvent(
  log: Log, token: string, kind: string, amount: bigint, result: bigint,
  legs: { toCreator?: bigint; toBuyback?: bigint; toLiquidity?: bigint; recipient?: string } = {},
) {
  const { rows: written } = await pool.query(
    `insert into fee_events (token, kind, amount, result, to_creator, to_buyback, to_liquidity, recipient, block, tx, log_index, ts)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict (tx, log_index) do nothing
     returning id, ts`,
    [token, kind, amount.toString(), result.toString(),
      legs.toCreator?.toString() ?? null, legs.toBuyback?.toString() ?? null, legs.toLiquidity?.toString() ?? null,
      legs.recipient?.toLowerCase() ?? null,
      log.blockNumber!.toString(), log.transactionHash, log.logIndex, await blockTime(log.blockNumber!)],
  );
  if (written[0] && kind !== "bought_back") {
    await notify("fee", { token, kind, amount: amount.toString(), tx: log.transactionHash, at: written[0].ts });
  }
}

// ---------------------------------------------------------------- the Bag

/// Where money came from and where it went, as the Bag's two enums name it. The contract emits the
/// index; the tape stores the word, so a row reads on its own.
const BAG_SOURCES = ["trade", "graduation", "penalty", "house", "house_coin"] as const;
const BAG_OUTLETS = ["house", "vault", "payday", "burn", "confetti"] as const;
const sourceName = (i: unknown) => BAG_SOURCES[Number(i)] ?? String(i);
const outletName = (i: unknown) => BAG_OUTLETS[Number(i)] ?? String(i);

/// A pot says why it was paid as the hash of a word (BagReasons); this turns it back into the word.
const REASONS = ["snipe", "jeet", "whale", "confetti", "slash", "auction", "payday", "dividends", "lp_fees", "king"] as const;
const reasonByHash = new Map<string, string>(REASONS.map((r) => [keccak256(stringToHex(r)).toLowerCase(), r]));
const reasonName = (hash: unknown) => reasonByHash.get(String(hash).toLowerCase()) ?? String(hash);

/// What a launch's pot pays in: the launch's own quote.
const assetOf = (token: string) => quotes.get(token) ?? zeroAddress;
const lower = (v: unknown) => String(v).toLowerCase();

/// The token a pot-side contract speaks for: a HoodPot, a splitter (the pot of a direct launch,
/// and where the king and the slash are announced) or the direct hook.
const launchOf = (address: string) => pots.get(address) ?? splitters.get(address) ?? hooks.get(address);

interface TapeRow {
  kind: string;
  token?: string | null;
  asset?: string | null;
  amount: bigint;
  extra?: Record<string, unknown>;
  recipient?: string | null;
}

/// One row on the money tape and the live frame that goes with it. Answers with the row when this
/// pass wrote it and null when it was already there, so every aggregate that cannot be replayed
/// (a funded total, a bid count) hangs off that answer and a range read twice moves nothing twice.
async function tape(log: Log, row: TapeRow): Promise<{ id: string; ts: Date } | null> {
  const when = await blockTime(log.blockNumber!);
  const extra = row.extra ?? {};
  const { rows } = await pool.query<{ id: string; ts: Date }>(
    `insert into bag_events (kind, token, asset, amount, extra, recipient, block, tx, log_index, ts)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict (tx, log_index) do nothing
     returning id, ts`,
    [row.kind, row.token ?? null, row.asset ?? null, row.amount.toString(), JSON.stringify(extra), row.recipient ?? null,
     log.blockNumber!.toString(), log.transactionHash, log.logIndex, when],
  );
  if (!rows[0]) return null;
  await notify("bag", {
    kind: row.kind, token: row.token ?? null, asset: row.asset ?? null, amount: row.amount.toString(),
    tx: log.transactionHash, at: when, extra,
  });
  return rows[0];
}

/// How many wallets hold the token right now: the same count the token page shows. Balances are
/// block-accurate here because logs are handled in order, so "right now" is the penalty's own block.
async function holderCount(token: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `select count(*) as n from balances where token = $1 and balance > 0`, [token],
  );
  return Number(rows[0]?.n ?? 0);
}

/// The wall of shame pays the room: every wallet holding the token when a bot paid gets a bounty
/// point, biggest holders first, up to a cap so a token with ten thousand holders does not turn one
/// penalty into ten thousand rows. The payer is not paid for being there, and neither is any piece
/// of the machine that happens to hold a balance (the curve, the pool, the locker, the pot).
const BOUNTY_MAX_HOLDERS = 500;

async function bounty(token: string, payer: string, log: Log, when: Date): Promise<number> {
  const { rows } = await pool.query<{ address: string }>(
    `select address from balances where token = $1 and balance > 0 order by balance desc limit $2`,
    [token, BOUNTY_MAX_HOLDERS + 16],
  );
  let paid = 0;
  for (const r of rows) {
    if (paid >= BOUNTY_MAX_HOLDERS) break;
    const holder = r.address.toLowerCase();
    if (holder === payer || SYSTEM.has(holder) || machines.has(holder)) continue;
    await award({
      address: holder, kind: "bounty", token, usd: 0,
      ref: `bounty:${log.transactionHash}:${log.logIndex}:${holder}`, ts: when,
    });
    paid++;
  }
  return paid;
}

async function onBagIn(log: Log & { args: Record<string, unknown> }) {
  const a = log.args;
  const token = lower(a.token);
  await tape(log, {
    kind: "bag_in", token: token === zeroAddress ? null : token, asset: lower(a.asset), amount: a.amount as bigint,
    extra: { source: sourceName(a.source) },
  });
}

async function onBagOut(log: Log & { args: Record<string, unknown> }) {
  const a = log.args;
  await tape(log, {
    kind: "bag_out", asset: lower(a.asset), amount: a.amount as bigint, recipient: lower(a.to),
    extra: { outlet: outletName(a.outlet) },
  });
}

async function onHeld(log: Log & { args: Record<string, unknown> }) {
  const a = log.args;
  await tape(log, { kind: "held", asset: lower(a.asset), amount: a.amount as bigint, extra: { outlet: outletName(a.outlet) } });
}

/// A penalty from either machine: the direct hook's (no token on the log, the hook is the token's)
/// or the graduation hook's (one hook for every pool, so the log names the token). Both split the
/// same way, 80 to the pot and 20 into the Bag, and both feed the wall of shame.
async function onPenalty(log: Log & { args: Record<string, unknown> }, token: string) {
  const a = log.args;
  const reason = reasonName(a.reason);
  const payer = lower(a.payer);
  const amount = a.amount as bigint;
  const toHolders = a.toHolders as bigint;
  const toBag = a.toBag as bigint;
  const asset = assetOf(token);
  const when = await blockTime(log.blockNumber!);
  const holders = await holderCount(token);
  const { rows: written } = await pool.query<{ id: string }>(
    `insert into penalties (token, kind, payer, asset, amount, to_holders, to_bag, holders, block, tx, log_index, ts)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict (tx, log_index) do nothing
     returning id`,
    [token, reason, payer, asset, amount.toString(), toHolders.toString(), toBag.toString(), holders,
     log.blockNumber!.toString(), log.transactionHash, log.logIndex, when],
  );
  await tape(log, {
    kind: "penalty", token, asset, amount,
    extra: {
      reason, payer, to_holders: toHolders.toString(), to_bag: toBag.toString(), holders,
      ...(typeof a.isBuy === "boolean" ? { is_buy: a.isBuy } : {}),
    },
  });
  // The bounty's own refs make it idempotent, but a re-read would still walk the holders for
  // nothing, so it only runs when the penalty itself was new.
  if (written[0]) await bounty(token, payer, log, when);
}

/// The creator sold their own token: what they had not claimed goes to the holders, in the same
/// transaction. It is a penalty on the wall like any other, with the creator as the payer.
async function onCreatorSlashed(log: Log & { args: Record<string, unknown> }, token: string) {
  const a = log.args;
  const creator = lower(a.creator);
  const amount = a.amount as bigint;
  const asset = assetOf(token);
  const when = await blockTime(log.blockNumber!);
  const holders = await holderCount(token);
  const { rows: written } = await pool.query<{ id: string }>(
    `insert into penalties (token, kind, payer, asset, amount, to_holders, to_bag, holders, block, tx, log_index, ts)
     values ($1,'slash',$2,$3,$4,$4,0,$5,$6,$7,$8,$9) on conflict (tx, log_index) do nothing
     returning id`,
    [token, creator, asset, amount.toString(), holders, log.blockNumber!.toString(), log.transactionHash, log.logIndex, when],
  );
  await tape(log, {
    kind: "slash", token, asset, amount,
    extra: { reason: "slash", payer: creator, to_holders: amount.toString(), to_bag: "0", holders },
  });
  if (written[0]) await bounty(token, creator, log, when);
}

/// A pot booked money for its holders. The reason says who paid and why; the count says how many
/// wallets it was split across, which is what the tape line reads out.
async function onHoldersPaid(log: Log & { args: Record<string, unknown> }, token: string) {
  const a = log.args;
  const reason = reasonName(a.reason);
  const payer = lower(a.payer);
  const amount = a.amount as bigint;
  const eligible = a.eligibleSupply as bigint;
  const asset = assetOf(token);
  const when = await blockTime(log.blockNumber!);
  const holders = await holderCount(token);
  await pool.query(
    `insert into pot_deposits (token, reason, payer, asset, amount, eligible_supply, holders, block, tx, log_index, ts)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict (tx, log_index) do nothing`,
    [token, reason, payer, asset, amount.toString(), eligible.toString(), holders,
     log.blockNumber!.toString(), log.transactionHash, log.logIndex, when],
  );
  await tape(log, {
    kind: "holders_paid", token, asset, amount,
    extra: { reason, payer, eligible_supply: eligible.toString(), holders },
  });
}

/// A pot paid a wallet, whether the keeper pushed it or the wallet claimed.
async function onPushed(log: Log & { args: Record<string, unknown> }, token: string) {
  const a = log.args;
  const holder = lower(a.account);
  const amount = a.amount as bigint;
  const asset = assetOf(token);
  const when = await blockTime(log.blockNumber!);
  await pool.query(
    `insert into pot_payouts (token, holder, asset, amount, block, tx, log_index, ts)
     values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (tx, log_index) do nothing`,
    [token, holder, asset, amount.toString(), log.blockNumber!.toString(), log.transactionHash, log.logIndex, when],
  );
  await tape(log, { kind: "pushed", token, asset, amount, recipient: holder, extra: { wallet: holder } });
}

/// King of the hill. A crown is every buy while the round is open: the same row moves to the new
/// king with the new pot and the new timer, so one row is one round from first crown to win.
async function onKingCrowned(log: Log & { args: Record<string, unknown> }, token: string) {
  const a = log.args;
  const king = lower(a.king);
  const potAmount = a.pot as bigint;
  const endsAt = new Date(Number(a.endsAt) * 1000);
  const asset = assetOf(token);
  const written = await tape(log, {
    kind: "king_crowned", token, asset, amount: potAmount, extra: { king, ends_at: endsAt.toISOString() },
  });
  if (!written) return;
  const { rows } = await pool.query<{ id: string }>(
    `update king_rounds set king = $2, pot = $3, ends_at = $4, tx = $5, log_index = $6
     where id = (select id from king_rounds where token = $1 and won_at is null order by id desc limit 1)
     returning id`,
    [token, king, potAmount.toString(), endsAt, log.transactionHash, log.logIndex],
  );
  if (!rows[0]) {
    await pool.query(
      `insert into king_rounds (token, king, pot, ends_at, tx, log_index) values ($1,$2,$3,$4,$5,$6)
       on conflict (tx, log_index) do nothing`,
      [token, king, potAmount.toString(), endsAt, log.transactionHash, log.logIndex],
    );
  }
  await notify("king", { token, king, pot: potAmount.toString(), ends_at: endsAt });
}

async function onKingWon(log: Log & { args: Record<string, unknown> }, token: string) {
  const a = log.args;
  const king = lower(a.king);
  const amount = a.amount as bigint;
  const when = await blockTime(log.blockNumber!);
  const written = await tape(log, {
    kind: "king_won", token, asset: assetOf(token), amount, recipient: king, extra: { king },
  });
  if (!written) return;
  const { rows } = await pool.query<{ id: string }>(
    `update king_rounds set won_amount = $2, won_at = $3, king = $4
     where id = (select id from king_rounds where token = $1 and won_at is null order by id desc limit 1)
     returning id`,
    [token, amount.toString(), when, king],
  );
  if (!rows[0]) {
    // A win with no crown on record (the crown was before the indexer's start): the round is
    // written from the win alone, so the page still says who won what.
    await pool.query(
      `insert into king_rounds (token, king, pot, ends_at, won_amount, won_at, tx, log_index)
       values ($1,$2,$3,$4,$3,$4,$5,$6) on conflict (tx, log_index) do nothing`,
      [token, king, amount.toString(), when, log.transactionHash, log.logIndex],
    );
  }
  await notify("king", { token, king, pot: "0", ends_at: null, won: { king, amount: amount.toString() } });
}

async function onPaydayFunded(log: Log & { args: Record<string, unknown> }) {
  const a = log.args;
  const epoch = (a.epoch as bigint).toString();
  const asset = lower(a.asset);
  const amount = a.amount as bigint;
  const written = await tape(log, { kind: "payday_funded", asset, amount, extra: { epoch: Number(epoch) } });
  if (!written) return; // funded is a running sum, and a re-read must not add to it twice
  await pool.query(
    `insert into payday_epochs (epoch, asset, funded) values ($1,$2,$3)
     on conflict (epoch, asset) do update set funded = payday_epochs.funded + excluded.funded`,
    [epoch, asset, amount.toString()],
  );
}

async function onPaydayPaid(log: Log & { args: Record<string, unknown> }) {
  const a = log.args;
  const epoch = (a.epoch as bigint).toString();
  const asset = lower(a.asset);
  const wallet = lower(a.wallet);
  const amount = a.amount as bigint;
  const when = await blockTime(log.blockNumber!);
  await pool.query(
    `insert into payday_payouts (epoch, asset, wallet, amount, block, tx, log_index, ts)
     values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (tx, log_index) do nothing`,
    [epoch, asset, wallet, amount.toString(), log.blockNumber!.toString(), log.transactionHash, log.logIndex, when],
  );
  await tape(log, { kind: "payday_paid", asset, amount, recipient: wallet, extra: { epoch: Number(epoch), wallet } });
}

async function onLaunchSlice(log: Log & { args: Record<string, unknown> }) {
  const a = log.args;
  const epoch = (a.epoch as bigint).toString();
  const asset = lower(a.asset);
  const potAddress = lower(a.pot);
  const amount = a.amount as bigint;
  const token = pots.get(potAddress) ?? null;
  const when = await blockTime(log.blockNumber!);
  await pool.query(
    `insert into payday_slices (epoch, asset, pot, token, amount, block, tx, log_index, ts)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (tx, log_index) do nothing`,
    [epoch, asset, potAddress, token, amount.toString(), log.blockNumber!.toString(), log.transactionHash, log.logIndex, when],
  );
  await tape(log, {
    kind: "payday_slice", token, asset, amount, recipient: potAddress, extra: { epoch: Number(epoch), pot: potAddress },
  });
}

async function onEpochPaid(log: Log & { args: Record<string, unknown> }) {
  const a = log.args;
  const epoch = (a.epoch as bigint).toString();
  const asset = lower(a.asset);
  const toWallets = a.toWallets as bigint;
  const toLaunches = a.toLaunches as bigint;
  const carried = a.carried as bigint;
  const when = await blockTime(log.blockNumber!);
  // Not a running sum: the log says the whole outcome, so writing it twice writes the same thing.
  await pool.query(
    `insert into payday_epochs (epoch, asset, to_wallets, to_launches, carried, paid_at, tx)
     values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (epoch, asset) do update set to_wallets = excluded.to_wallets, to_launches = excluded.to_launches,
       carried = excluded.carried, paid_at = excluded.paid_at, tx = excluded.tx`,
    [epoch, asset, toWallets.toString(), toLaunches.toString(), carried.toString(), when, log.transactionHash],
  );
  await tape(log, {
    kind: "payday_epoch", asset, amount: toWallets + toLaunches,
    extra: { epoch: Number(epoch), to_wallets: toWallets.toString(), to_launches: toLaunches.toString(), carried: carried.toString() },
  });
}

async function onBurnFunded(log: Log & { args: Record<string, unknown> }) {
  const a = log.args;
  await tape(log, { kind: "burn_funded", asset: lower(a.asset), amount: a.amount as bigint });
}

async function onBurned(log: Log & { args: Record<string, unknown> }) {
  const a = log.args;
  const asset = lower(a.asset);
  const spent = a.spent as bigint;
  const coinBurned = a.coinBurned as bigint;
  const epoch = (a.epoch as bigint).toString();
  const when = await blockTime(log.blockNumber!);
  await pool.query(
    `insert into burns (asset, spent, coin_burned, epoch, block, tx, log_index, ts)
     values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (tx, log_index) do nothing`,
    [asset, spent.toString(), coinBurned.toString(), epoch, log.blockNumber!.toString(), log.transactionHash, log.logIndex, when],
  );
  await tape(log, {
    kind: "burn", asset, amount: spent, extra: { spent: spent.toString(), burned: coinBurned.toString(), epoch: Number(epoch) },
  });
}

async function onBoostBought(log: Log & { args: Record<string, unknown> }) {
  const a = log.args;
  const token = lower(a.token);
  const buyer = lower(a.buyer);
  const hour = (a.hourEpoch as bigint).toString();
  const slot = Number(a.slot);
  const paid = a.paid as bigint;
  const when = await blockTime(log.blockNumber!);
  await pool.query(
    `insert into boosts (hour_epoch, slot, token, buyer, paid, tx, ts) values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (hour_epoch, slot) do nothing`,
    [hour, slot, token, buyer, paid.toString(), log.transactionHash, when],
  );
  await tape(log, { kind: "boost", token, asset: zeroAddress, amount: paid, extra: { epoch: Number(hour), slot, buyer } });
}

async function onBuybackTriggered(log: Log & { args: Record<string, unknown> }, token: string) {
  const a = log.args;
  const spent = a.spent as bigint;
  const burned = a.burned as bigint;
  await tape(log, {
    kind: "buyback", token, asset: assetOf(token), amount: spent, extra: { spent: spent.toString(), burned: burned.toString() },
  });
}

/// The hook could not buy in the same transaction and asks the keeper to. The tape row is what the
/// keeper polls for.
async function onBuybackWanted(log: Log & { args: Record<string, unknown> }, token: string) {
  await tape(log, { kind: "buyback_wanted", token, asset: assetOf(token), amount: 0n });
}

async function onAuctionBid(log: Log & { args: Record<string, unknown> }) {
  const a = log.args;
  const token = lower(a.token);
  if (!tokens.has(token)) return;
  const bidder = lower(a.bidder);
  const amount = a.amount as bigint;
  const endBlock = (a.endBlock as bigint).toString();
  const written = await tape(log, {
    kind: "auction_bid", token, asset: assetOf(token), amount, extra: { bidder, end_block: Number(endBlock) },
  });
  if (!written) return; // the bid count is a running sum
  await pool.query(
    `insert into auctions (token, end_block, top_bidder, top_bid, bids, updated_at) values ($1,$2,$3,$4,1,now())
     on conflict (token) do update set
       end_block = excluded.end_block,
       top_bidder = case when excluded.top_bid >= auctions.top_bid then excluded.top_bidder else auctions.top_bidder end,
       top_bid = greatest(auctions.top_bid, excluded.top_bid),
       bids = auctions.bids + 1,
       updated_at = now()`,
    [token, endBlock, bidder, amount.toString()],
  );
}

async function onAuctionSettled(log: Log & { args: Record<string, unknown> }) {
  const a = log.args;
  const token = lower(a.token);
  if (!tokens.has(token)) return;
  const winner = lower(a.winner);
  const amount = a.amount as bigint;
  const toHolders = a.toHolders as bigint;
  const toLiquidity = a.toLiquidity as bigint;
  await tape(log, {
    kind: "auction_settled", token, asset: assetOf(token), amount, recipient: winner,
    extra: { winner, to_holders: toHolders.toString(), to_liquidity: toLiquidity.toString() },
  });
  await pool.query(
    `insert into auctions (token, top_bidder, top_bid, settled, winner, to_holders, to_liquidity, updated_at)
     values ($1,$2,$3,true,$2,$4,$5,now())
     on conflict (token) do update set
       settled = true, winner = excluded.winner, top_bid = greatest(auctions.top_bid, excluded.top_bid),
       to_holders = excluded.to_holders, to_liquidity = excluded.to_liquidity, updated_at = now()`,
    [token, winner, amount.toString(), toHolders.toString(), toLiquidity.toString()],
  );
}

/// The Vault was fed. One row per asset per feeding, which is what the lock page sums.
async function onRewardNotified(log: Log & { args: Record<string, unknown> }) {
  const a = log.args;
  const asset = lower(a.asset);
  const amount = a.amount as bigint;
  const when = await blockTime(log.blockNumber!);
  await pool.query(
    `insert into vault_rewards (asset, amount, block, tx, log_index, ts) values ($1,$2,$3,$4,$5,$6)
     on conflict (tx, log_index) do nothing`,
    [asset, amount.toString(), log.blockNumber!.toString(), log.transactionHash, log.logIndex, when],
  );
  await tape(log, { kind: "vault_reward", asset, amount, recipient: STAKING });
}

/// Payday could not deliver a wallet's share (a contract that refuses ether, a token that would
/// not move) and booked it instead. It is still that wallet's win for the hour, and EpochPaid's
/// toWallets counts it, so it is a payout row like a Paid one: the epoch is on the EpochPaid log
/// of the same transaction, which follows this one and has not been handled yet.
const owedEpochs = new Map<string, string | null>();
async function epochOfPayTx(hash: `0x${string}`): Promise<string | null> {
  const known = owedEpochs.get(hash);
  if (known !== undefined) return known;
  let epoch: string | null = null;
  try {
    const receipt = await client.getTransactionReceipt({ hash });
    for (const l of receipt.logs) {
      if (l.address.toLowerCase() === PAYDAY && l.topics[0] === EPOCH_PAID_TOPIC && l.topics[1]) {
        epoch = BigInt(l.topics[1]).toString();
        break;
      }
    }
  } catch {
    // the receipt will not come: the tape row is still written, the payout row waits for a rescan
  }
  if (owedEpochs.size >= 256) owedEpochs.clear();
  owedEpochs.set(hash, epoch);
  return epoch;
}

async function onPaydayOwed(log: Log & { args: Record<string, unknown> }) {
  const a = log.args;
  const asset = lower(a.asset);
  const wallet = lower(a.wallet);
  const amount = a.amount as bigint;
  const when = await blockTime(log.blockNumber!);
  const epoch = await epochOfPayTx(log.transactionHash!);
  if (epoch != null) {
    await pool.query(
      `insert into payday_payouts (epoch, asset, wallet, amount, block, tx, log_index, ts)
       values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (tx, log_index) do nothing`,
      [epoch, asset, wallet, amount.toString(), log.blockNumber!.toString(), log.transactionHash, log.logIndex, when],
    );
  } else {
    console.warn(`payday: Owed in ${log.transactionHash} without an EpochPaid alongside; no payout row for it`);
  }
  await tape(log, {
    kind: "payday_owed", asset, amount, recipient: wallet,
    extra: { epoch: epoch == null ? null : Number(epoch), wallet, booked: true },
  });
}

/// The wallet took what was booked. The win was counted when it was booked, so this is a tape
/// line and not a second payout row: the portfolio's Payday total must not say it twice.
async function onPaydayOwedClaimed(log: Log & { args: Record<string, unknown> }) {
  const a = log.args;
  const wallet = lower(a.wallet);
  await tape(log, {
    kind: "payday_owed_claimed", asset: lower(a.asset), amount: a.amount as bigint, recipient: wallet, extra: { wallet },
  });
}

/// The house's leg could not be delivered and waits in the Bag, then the house took it. Neither
/// moves the totals (BagOut said the outlet when the leg was cut); the tape says where it sat.
async function onHouseDeferred(log: Log & { args: Record<string, unknown> }) {
  const a = log.args;
  await tape(log, { kind: "house_deferred", asset: lower(a.asset), amount: a.amount as bigint });
}

async function onHouseClaimed(log: Log & { args: Record<string, unknown> }) {
  const a = log.args;
  await tape(log, { kind: "house_claimed", asset: lower(a.asset), amount: a.amount as bigint });
}

/// The king pot took its slice of a penalty. The pot after the feed rides along, so the tape can
/// say what the crown is worth without asking the splitter.
async function onKingPotFed(log: Log & { args: Record<string, unknown> }, token: string) {
  const a = log.args;
  const amount = a.amount as bigint;
  await tape(log, {
    kind: "king_fed", token, asset: assetOf(token), amount, extra: { pot: (a.pot as bigint).toString() },
  });
}

/// The graduation hook let go of the platform fee it had been holding for a pool: the creator's
/// thirty basis points and the Bag's seventy, in one line.
async function onPoolClaimsFlushed(log: Log & { args: Record<string, unknown> }) {
  const a = log.args;
  const token = lower(a.token);
  if (!tokens.has(token)) return;
  const toCreator = a.toCreator as bigint;
  const toBag = a.toBag as bigint;
  await tape(log, {
    kind: "flush_graduated", token, asset: assetOf(token), amount: toCreator + toBag,
    extra: { pool_id: lower(a.id), to_creator: toCreator.toString(), to_bag: toBag.toString() },
  });
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
        await directFeeEvent(log, splitters.get(address)!, "swept", l.args.total as bigint, l.args.dividends as bigint, {
          toCreator: l.args.creator as bigint, toBuyback: l.args.buyback as bigint, toLiquidity: l.args.liquidity as bigint,
        });
      }
      break;
    case "CreatorClaimed":
      if (splitters.has(address)) {
        await directFeeEvent(log, splitters.get(address)!, "creator_claimed", l.args.amount as bigint, 0n);
      }
      break;
    case "ProtocolClaimed":
      // Both machines say it in the same shape. A curve books the protocol's thirty basis points
      // and pays them on a permissionless claim; the row is what the ledger shows as the
      // protocol's leg, the one leg the launch's own split never mentions.
      if (splitters.has(address)) {
        await directFeeEvent(log, splitters.get(address)!, "protocol_claimed", l.args.amount as bigint, 0n);
      } else if (curves.has(address)) {
        await directFeeEvent(log, curves.get(address)!.token, "protocol_claimed", l.args.amount as bigint, 0n);
      }
      break;
    case "ReferralPaid": {
      // A slice of the protocol's share, paid to whoever the owner named for this launch. Both
      // machines emit it from the contract that holds the share, next to their ProtocolClaimed.
      const token = splitters.get(address) ?? curves.get(address)?.token;
      if (token) {
        await directFeeEvent(log, token, "referral_paid", l.args.amount as bigint, 0n, { recipient: l.args.to as string });
      }
      break;
    }
    case "ReferralSet":
      if (REFERRALS && address === REFERRALS) {
        const to = (l.args.to as string).toLowerCase();
        const bps = Number(l.args.bps);
        await pool.query(
          `update launches set referral_to = $2, referral_bps = $3 where token = $1`,
          [(l.args.token as string).toLowerCase(), bps > 0 ? to : null, bps > 0 ? bps : null],
        );
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
        // The fee the raise paid the Bag, straight off the log. Written on its own so a curve that
        // graduated before this column existed still picks it up on a rescan.
        await pool.query(`update launches set graduation_fee = $2 where curve = $1`, [
          address, (l.args.graduationFee as bigint).toString(),
        ]);
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
    // the Bag and its outlets; every address below is optional and an unset one matches nothing
    case "BagIn": if (BAG && address === BAG) await onBagIn(l); break;
    case "BagOut": if (BAG && address === BAG) await onBagOut(l); break;
    case "Held": if (BAG && address === BAG) await onHeld(l); break;
    case "HoldersPaid": { const token = pots.get(address); if (token) await onHoldersPaid(l, token); break; }
    case "Pushed": { const token = pots.get(address); if (token) await onPushed(l, token); break; }
    case "KingCrowned": { const token = launchOf(address); if (token) await onKingCrowned(l, token); break; }
    case "KingWon": { const token = launchOf(address); if (token) await onKingWon(l, token); break; }
    case "CreatorSlashed": { const token = launchOf(address); if (token) await onCreatorSlashed(l, token); break; }
    case "Funded":
      // Two contracts say Funded with different shapes; the epoch is only on Payday's.
      if (PAYDAY && address === PAYDAY && "epoch" in l.args) await onPaydayFunded(l);
      else if (BURN_CLOCK && address === BURN_CLOCK) await onBurnFunded(l);
      break;
    case "Paid": if (PAYDAY && address === PAYDAY) await onPaydayPaid(l); break;
    case "LaunchSlice": if (PAYDAY && address === PAYDAY) await onLaunchSlice(l); break;
    case "EpochPaid": if (PAYDAY && address === PAYDAY) await onEpochPaid(l); break;
    case "Burned": if (BURN_CLOCK && address === BURN_CLOCK) await onBurned(l); break;
    case "HouseCoinSet":
      if (BURN_CLOCK && address === BURN_CLOCK) console.log(`bag: the house coin is ${lower(l.args.coin)}`);
      break;
    case "BoostBought": if (BOOSTS && address === BOOSTS) await onBoostBought(l); break;
    case "SlotPriceSet":
      if (BOOSTS && address === BOOSTS) console.log(`bag: a boost slot now costs ${String(l.args.price)} wei`);
      break;
    case "Penalty":
      // Same name from two hooks: the graduation hook names the token, the direct hook is the token's.
      if (GRADUATION_HOOK && address === GRADUATION_HOOK && typeof l.args.token === "string") {
        const token = lower(l.args.token);
        if (tokens.has(token)) await onPenalty(l, token);
      } else if (hooks.has(address)) {
        await onPenalty(l, hooks.get(address)!);
      }
      break;
    case "BuybackTriggered": if (hooks.has(address)) await onBuybackTriggered(l, hooks.get(address)!); break;
    case "BuybackWanted": if (hooks.has(address)) await onBuybackWanted(l, hooks.get(address)!); break;
    case "Bid": if (OPENING_AUCTION && address === OPENING_AUCTION) await onAuctionBid(l); break;
    case "Settled": if (OPENING_AUCTION && address === OPENING_AUCTION) await onAuctionSettled(l); break;
    case "Registered": if (OPENING_AUCTION && address === OPENING_AUCTION) await onAuctionRegistered(l); break;
    case "LaunchRules": if (address === PORTAL) await onLaunchRules(l); break;
    case "PotDeployed": if (address === FACTORY) await onPotDeployed(l); break;
    case "LaunchPenalties": if (address === FACTORY) await onLaunchPenalties(l); break;
    case "Owed": if (PAYDAY && address === PAYDAY) await onPaydayOwed(l); break;
    case "OwedClaimed": if (PAYDAY && address === PAYDAY) await onPaydayOwedClaimed(l); break;
    case "HouseDeferred": if (BAG && address === BAG) await onHouseDeferred(l); break;
    case "HouseClaimed": if (BAG && address === BAG) await onHouseClaimed(l); break;
    case "KingPotFed": { const token = launchOf(address); if (token) await onKingPotFed(l, token); break; }
    case "ClaimsFlushed":
      // Same name from two hooks: the graduation hook names the token and both legs; the direct
      // hook's one-number flush is visible in its splitter's Swept and is not written here.
      if (GRADUATION_HOOK && address === GRADUATION_HOOK && typeof l.args.token === "string") await onPoolClaimsFlushed(l);
      break;
    case "RewardNotified": if (address === STAKING) await onRewardNotified(l); break;
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
        await setCursor("main", cursor);
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
    // What goes in the row is the NEXT block to index, with the hash of the LAST one indexed,
    // because that is exactly the pair the loop reads back: `cursor` is where to start, and
    // `reorged()` checks the header at `cursor - 1` against the stored hash. Storing `end` with
    // `hash(end)` instead, as this did, made every restart re-index a block it had already counted
    // and then compare the wrong header, which reads as a reorg that never heals: the indexer
    // stopped dead on its next restart and refused to move again.
    const last = await client.getBlock({ blockNumber: end }).catch(() => null);
    cursor = end + 1n;
    await setCursor("main", cursor, last?.hash ?? undefined);
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
