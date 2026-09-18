import { createPublicClient, createWalletClient, http, formatEther, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  createHoodClient, createDirectClient, robinhood, addressesFromEnv, minOutFromQuote, quoteDirectSwap,
  uniswapV4GraduatorAbi, type PoolKey,
} from "@hood/sdk";

/// The keeper does the jobs that are permissionless on purpose: opening a pool for a curve that
/// sold out, pushing booked fees through a token's model, pulling the fees a locked position
/// earned. None of it needs privileges, which is the point: if this process dies, anybody can do
/// its work from a wallet, and the protocol keeps running. It just would not be instant.
const RPC = process.env.HOOD_RPC ?? robinhood.rpcUrls.default.http[0]!;
const API = process.env.HOOD_API;
const INTERVAL = Number(process.env.KEEPER_INTERVAL_MS ?? 20_000);
/// Below this, pushing fees costs more gas than it moves.
const MIN_FLUSH = BigInt(process.env.KEEPER_MIN_FLUSH_WEI ?? "1000000000000000"); // 0.001 ETH

const pk = process.env.KEEPER_PRIVATE_KEY;
if (!pk) throw new Error("KEEPER_PRIVATE_KEY is not set. Generate a wallet for this project and nothing else.");

const account = privateKeyToAccount(pk as `0x${string}`);
const publicClient = createPublicClient({ chain: robinhood, transport: http(RPC) });
const walletClient = createWalletClient({ account, chain: robinhood, transport: http(RPC) });
const hood = createHoodClient({ publicClient: publicClient as never, walletClient: walletClient as never, addresses: addressesFromEnv() });

interface Row {
  token: string;
  curve: string;
  phase: number;
  fee_model: number;
  mode?: "curve" | "direct";
  splitter?: string | null;
  locker?: string | null;
  pair_token?: string;
}

const direct = process.env.HOOD_PORTAL
  ? createDirectClient({
      publicClient: publicClient as never,
      walletClient: walletClient as never,
      addresses: {
        portal: process.env.HOOD_PORTAL as `0x${string}`,
        deployer: process.env.HOOD_DIRECT_DEPLOYER as `0x${string}`,
        buybackModule: process.env.HOOD_BUYBACK_MODULE as `0x${string}`,
      },
    })
  : undefined;

async function tokens(): Promise<Row[]> {
  if (!API) throw new Error("HOOD_API is not set: the keeper reads the token list from the indexer");
  const res = await fetch(`${API}/tokens?limit=200`);
  if (!res.ok) throw new Error(`indexer: ${res.status}`);
  return ((await res.json()) as { tokens: Row[] }).tokens;
}

async function tick() {
  const rows = await tokens();
  for (const row of rows) {
    const token = row.token as Address;
    try {
      // A direct launch has no curve to finalize and no fee router to flush. What it has is a
      // splitter that needs telling money arrived, a pot that buys back, a position that earns.
      if (row.mode === "direct") {
        if (!direct || !row.splitter || !row.locker) continue;
        // The indexer says which tokens are worth looking at; the portal says what a launch's
        // contracts are. A database this process does not own must never be able to point its key
        // at an address of somebody else's choosing.
        const onChain = await direct.getLaunch(token);
        if (!onChain.exists) continue;
        const splitter = onChain.splitter;
        const locker = onChain.locker;

        // sweep only when something arrived; an empty sweep is a transaction for nothing
        if ((await direct.unaccounted(splitter, (row as { pair_token?: string }).pair_token as Address ?? "0x0000000000000000000000000000000000000000")) > 0n) {
          await publicClient.waitForTransactionReceipt({ hash: await direct.sweep(splitter) }).catch(() => {});
        }

        // The protocol's tenth is booked by the sweep and pushed by nobody: nothing reaches the
        // treasury until somebody pulls it, and that somebody is this process.
        const owed = await direct.protocolClaimable(splitter);
        if (owed > 0n) {
          const hash = await direct.claimProtocol(splitter);
          console.log(`claimProtocol ${row.token} ${formatEther(owed)} -> ${hash}`);
          await publicClient.waitForTransactionReceipt({ hash });
        }

        const buckets = await direct.buckets(splitter);
        if (buckets.liquidityPot >= MIN_FLUSH) {
          const hash = await direct.pushLiquidity(splitter);
          console.log(`pushLiquidity ${row.token} ${formatEther(buckets.liquidityPot)} -> ${hash}`);
          await publicClient.waitForTransactionReceipt({ hash });
          // The locker only donates onto its own position, so a stranger parked in the range means
          // the pot waits rather than paying them. Nothing is lost by waiting; a transaction is.
          if (await direct.canDeepen(locker).catch(() => false)) {
            await direct.deepen(locker).catch(() => {});
          }
        }
        if (buckets.buybackPot >= MIN_FLUSH) {
          // A run swaps a real pool, so its floor is a quote of this very run, one percent under.
          // The module stops at its impact limit and carries the rest, which the quote already knows.
          const expected = await direct.quoteBuyback(token);
          if (expected === 0n) {
            console.log(`buyback ${row.token} skipped: the run would buy nothing right now`);
          } else {
            const minTokensOut = minOutFromQuote(expected, 100);
            const hash = await direct.runBuyback(token, minTokensOut);
            console.log(`buyback ${row.token} ${formatEther(buckets.buybackPot)} min ${formatEther(minTokensOut)} -> ${hash}`);
            await publicClient.waitForTransactionReceipt({ hash });
          }
        }
        // The position's own fees, on a slower cadence than the rest.
        if (Math.random() < 0.1) await direct.harvest(locker).catch(() => {});
        continue;
      }

      // Same rule on this side: the registry says what a launch's curve is, not the database.
      const launch = await hood.getLaunch(token);
      if (!launch.exists || launch.curve === "0x0000000000000000000000000000000000000000") continue;
      const curve = launch.curve as Address;

      // 1. a curve that sold out is a pool waiting to be opened
      if (row.phase === 1) {
        const hash = await hood.finalize(curve);
        console.log(`finalize ${row.token} -> ${hash}`);
        await publicClient.waitForTransactionReceipt({ hash });
        continue;
      }

      // 2. fees the pool earned belong to the token's model, not to this contract
      if (row.phase === 2) {
        try {
          const hash = await hood.collect(token);
          console.log(`collect ${row.token} -> ${hash}`);
          await publicClient.waitForTransactionReceipt({ hash });
        } catch { /* nothing to collect is the normal case, not an error */ }
      }

      // 3. the protocol's own legs are booked on the curve and pulled by anybody, so that a
      //    treasury which cannot take a transfer can never stop a trade. This is the anybody.
      const booked = await hood.protocolClaimable(curve);
      if (booked >= MIN_FLUSH) {
        const hash = await hood.claimProtocol(curve);
        console.log(`claimProtocol ${row.token} ${formatEther(booked)} -> ${hash}`);
        await publicClient.waitForTransactionReceipt({ hash });
      }

      // 4. push whatever is booked through the model
      const accrued = await hood.creatorFees(token);
      if (accrued < MIN_FLUSH) continue;

      if (row.fee_model === 1 && row.phase !== 2) {
        // A buy on the curve moves the curve's price, so a floorless buyback is a sandwich waiting
        // to happen here too. The floor is the curve's own quote for this exact size, one percent
        // under; the curve is deterministic, so the only thing that can move it is somebody
        // trading in between, which is precisely what the floor is for.
        const [tokensOut] = await hood.quoteCurveBuy(curve, accrued);
        if (tokensOut === 0n) { console.log(`buyback ${row.token}: the curve quotes nothing, skipped`); continue; }
        const hash = await hood.flushBuyback(token, minOutFromQuote(tokensOut, 100));
        console.log(`buyback ${row.token} ${formatEther(accrued)} on the curve -> ${hash}`);
      } else if (row.fee_model === 1 && row.phase === 2) {
        // a graduated buyback has to swap, and a swap without a floor is a gift to sandwichers:
        // the floor is the quoter's answer for the graduated pool, one percent under
        const [key] = (await publicClient.readContract({
          address: hood.addresses.graduator, abi: uniswapV4GraduatorAbi, functionName: "positionOf", args: [token],
        })) as unknown as [PoolKey, bigint];
        const pair = ((row as { pair_token?: string }).pair_token ?? "0x0000000000000000000000000000000000000000") as Address;
        const { amountOut } = await quoteDirectSwap({ publicClient, poolKey: key, tokenIn: pair, amountIn: accrued });
        if (amountOut === 0n) { console.log(`buyback ${row.token}: quote is zero, skipped`); continue; }
        const hash = await hood.flushBuyback(token, minOutFromQuote(amountOut, 100));
        console.log(`buyback ${row.token} ${formatEther(accrued)} floor ${amountOut * 99n / 100n} -> ${hash}`);
      } else {
        const hash = await hood.flush(token);
        console.log(`flush ${row.token} ${formatEther(accrued)} -> ${hash}`);
      }
    } catch (e) {
      console.error(`keeper ${row.token}:`, e instanceof Error ? e.message : e);
    }
  }
}

console.log(`keeper up as ${account.address}, every ${INTERVAL}ms`);
for (;;) {
  try { await tick(); } catch (e) { console.error("keeper:", e); }
  await new Promise((r) => setTimeout(r, INTERVAL));
}
