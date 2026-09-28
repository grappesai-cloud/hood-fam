import { createPublicClient, createWalletClient, http, isAddress, zeroAddress, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  createHoodClient, createDirectClient, robinhood, addressesFromEnv, hoodFeeRouterAbi, PAIR_ASSETS, pairAsset,
} from "@hood/sdk";
import { Api } from "./api.js";
import type { Ctx, Job } from "./context.js";
import { heartbeat, log, logError } from "./log.js";
import { WriteQueue, message, queuedWallet } from "./queue.js";
import { tickJob } from "./jobs/tick.js";
import { paydayJob } from "./jobs/payday.js";
import { burnJob } from "./jobs/burn.js";
import { pushJob } from "./jobs/push.js";

/// The keeper. One wallet, one write queue, four loops on their own clocks:
///   tick      every KEEPER_INTERVAL_MS (20 s)   finalize, collect, claim, flush, direct sweeps
///   payday    every 60 s                        pay the closed hour by points
///   burn      every 60 s                        buy the house coin with the burn share, burn it
///   push      every KEEPER_PUSH_EVERY_MS (5 m)  push every pot's dividends to wallets
/// Most jobs are permissionless. Curve-fee buybacks, payday and the burn clock need the Safe to
/// appoint this wallet; until it does they log and wait, they never crash the process.
/// KEEPER_DRY_RUN=1 simulates every write and says what it would send, without sending.

const RPC = process.env.HOOD_RPC ?? robinhood.rpcUrls.default.http[0]!;
const API = process.env.HOOD_API;
const DRY_RUN = process.env.KEEPER_DRY_RUN === "1" || process.env.KEEPER_DRY_RUN === "true";

const intEnv = (name: string, fallback: number) => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number, got ${raw}`);
  return n;
};
const weiEnv = (name: string, fallback: string) => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return BigInt(fallback);
  try { return BigInt(raw); } catch { throw new Error(`${name} must be an integer in wei, got ${raw}`); }
};
const addressEnv = (name: string): Address | undefined => {
  const raw = process.env[name];
  if (!raw) return undefined;
  if (!isAddress(raw) || raw === zeroAddress) throw new Error(`${name} is not an address: ${raw}`);
  return raw as Address;
};

const knobs = {
  tickEveryMs: intEnv("KEEPER_INTERVAL_MS", 20_000),
  /// Below this, pushing fees costs more gas than it moves.
  minFlushWei: weiEnv("KEEPER_MIN_FLUSH_WEI", "1000000000000000"), // 0.001 ETH
  paydayDustWei: weiEnv("KEEPER_PAYDAY_DUST_WEI", "10000000000000"), // 1e13
  pushFloorWei: weiEnv("KEEPER_PUSH_FLOOR_WEI", "100000000000000"), // 1e14
  pushEveryMs: intEnv("KEEPER_PUSH_EVERY_MS", 300_000),
  burnSlippageBps: intEnv("KEEPER_BURN_SLIPPAGE_BPS", 100),
};
if (knobs.burnSlippageBps > 5_000) throw new Error("KEEPER_BURN_SLIPPAGE_BPS over 5000 is not a floor, it is a gift");

const pk = process.env.KEEPER_PRIVATE_KEY;
if (!pk) throw new Error("KEEPER_PRIVATE_KEY is not set. Generate a wallet for this project and nothing else.");
if (!API) throw new Error("HOOD_API is not set: the keeper reads the token list from the indexer");

const account = privateKeyToAccount(pk as `0x${string}`);
const publicClient = createPublicClient({ chain: robinhood, transport: http(RPC), pollingInterval: 500 });
const rawWallet = createWalletClient({ account, chain: robinhood, transport: http(RPC) });
const queue = new WriteQueue(publicClient as never, rawWallet as never, account, DRY_RUN);
// every SDK write lands in the queue: the SDK simulates, hands the request over, the queue sends
const walletClient = queuedWallet(rawWallet as never, queue);
const addresses = addressesFromEnv();
const hood = createHoodClient({ publicClient: publicClient as never, walletClient: walletClient as never, addresses });
const direct = process.env.HOOD_PORTAL
  ? createDirectClient({
      publicClient: publicClient as never,
      walletClient: walletClient as never,
      addresses: {
        portal: process.env.HOOD_PORTAL as Address,
        deployer: process.env.HOOD_DIRECT_DEPLOYER as Address,
        buybackModule: process.env.HOOD_BUYBACK_MODULE as Address,
      },
    })
  : undefined;
const api = new Api(API);

/// Which assets the Bag, Payday and the burn clock can hold: the SDK's pair list plus every quote
/// a launch actually uses, deduplicated, native first.
let assetsCache: { at: number; list: Address[] } | undefined;
async function assets(): Promise<Address[]> {
  if (assetsCache && Date.now() - assetsCache.at < 60_000) return assetsCache.list;
  const set = new Map<string, Address>();
  set.set(zeroAddress, zeroAddress);
  for (const p of PAIR_ASSETS) set.set(p.address.toLowerCase(), p.address);
  try {
    for (const row of await api.allTokens()) {
      const q = row.pair_token;
      if (q && isAddress(q) && !set.has(q.toLowerCase())) set.set(q.toLowerCase(), q as Address);
    }
  } catch (e) {
    log("boot", `asset list without the indexer's quotes this time: ${message(e)}`);
  }
  assetsCache = { at: Date.now(), list: Array.from(set.values()) };
  return assetsCache.list;
}
function symbol(asset: string): string {
  if (asset === zeroAddress) return "ETH";
  return pairAsset(asset)?.symbol ?? asset;
}

const ctx: Ctx = {
  publicClient: publicClient as never,
  account,
  queue,
  api,
  hood,
  direct,
  payday: addressEnv("HOOD_PAYDAY"),
  burnClock: addressEnv("HOOD_BURN_CLOCK"),
  boosts: addressEnv("HOOD_BOOSTS"),
  bag: addressEnv("HOOD_BAG"),
  buybacksAppointed: false,
  knobs,
  assets,
  symbol,
};

// ---------------------------------------------------------------------------------------- boot

log("boot", `keeper ${account.address} on ${RPC}, api ${API}${DRY_RUN ? ", DRY RUN: nothing is sent" : ""}`);
log("boot", `knobs tick=${knobs.tickEveryMs}ms push=${knobs.pushEveryMs}ms minFlush=${knobs.minFlushWei} paydayDust=${knobs.paydayDustWei} pushFloor=${knobs.pushFloorWei} burnSlippage=${knobs.burnSlippageBps}bps`);

// The old guard threw here when the fee router's keeper was somebody else, which crash-looped the
// container against a router the Safe had not pointed at this wallet yet. It is a flag now: only
// the curve buyback paths need it, and the tick re-reads it every five minutes.
try {
  const appointed = (await publicClient.readContract({ address: addresses.feeRouter, abi: hoodFeeRouterAbi, functionName: "keeper" })) as Address;
  ctx.buybacksAppointed = appointed.toLowerCase() === account.address.toLowerCase();
  log("boot", ctx.buybacksAppointed
    ? `fee router ${addresses.feeRouter}: this wallet is the keeper, curve buybacks on`
    : `fee router ${addresses.feeRouter}: keeper is ${appointed}, not this wallet; curve buybacks OFF until the Safe calls setKeeper, everything else runs`);
} catch (e) {
  log("boot", `fee router ${addresses.feeRouter}: could not read keeper() (${message(e)}); curve buybacks off for now`);
}

const jobLine = (name: string, addr: Address | undefined, what: string) =>
  log("boot", addr ? `${name}: ${addr}, ${what}` : `${name}: no address in env, job off`);
jobLine("payday (HOOD_PAYDAY)", ctx.payday, "pays the closed hour every 60 s");
jobLine("burn clock (HOOD_BURN_CLOCK)", ctx.burnClock, "burns the house coin every 60 s");
log("boot", ctx.boosts ? `boosts (HOOD_BOOSTS): ${ctx.boosts}, read only, users buy slots themselves` : "boosts (HOOD_BOOSTS): no address in env, nothing to do here anyway");
log("boot", ctx.bag ? `bag (HOOD_BAG): ${ctx.bag}` : "bag (HOOD_BAG): no address in env");
log("boot", direct ? `direct machine: portal ${process.env.HOOD_PORTAL}, buyback module ${process.env.HOOD_BUYBACK_MODULE}` : "direct machine: HOOD_PORTAL not set, direct launches off");
log("boot", `push payouts: every pot, every ${knobs.pushEveryMs}ms, floor ${knobs.pushFloorWei} wei`);

// ---------------------------------------------------------------------------------------- loops

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/// Each loop runs on its own clock and never waits for another: a slow token walk in the tick
/// cannot push the hourly jobs late. The queue is the only shared thing, and it only serializes
/// the transactions.
function loop(name: string, everyMs: number, job: Job) {
  void (async () => {
    for (;;) {
      const t0 = Date.now();
      try {
        const counts = await job();
        heartbeat(name, Date.now() - t0, counts);
      } catch (e) {
        logError(name, `iteration failed: ${message(e)}`);
      }
      await sleep(everyMs);
    }
  })();
}

loop("tick", knobs.tickEveryMs, tickJob(ctx));
loop("payday", 60_000, paydayJob(ctx));
loop("burn", 60_000, burnJob(ctx));
loop("push", knobs.pushEveryMs, pushJob(ctx));

process.on("unhandledRejection", (e) => logError("process", `unhandled rejection: ${message(e)}`));
