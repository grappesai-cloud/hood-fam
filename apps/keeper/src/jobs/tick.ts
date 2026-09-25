import { type Address, formatEther, zeroAddress } from "viem";
import { hoodFeeRouterAbi, minOutFromQuote, quoteDirectSwap, uniswapV4GraduatorAbi, type PoolKey } from "@hood/sdk";
import type { Ctx, Job } from "../context.js";
import { log } from "../log.js";
import { message } from "../queue.js";

/// The original per-token loop: finalize sold-out curves, collect pool fees, pull the protocol's
/// legs, push each launch's model. Every write goes through the queue (the SDK clients were built
/// on the queued wallet), so it shares the nonce with the Bag jobs and never races them.
///
/// Curve fee buybacks are the one thing here that needs an appointment: only the fee router's
/// keeper may pick a buyback's floor. When this wallet is not appointed those paths are skipped
/// with a log line, and everything permissionless keeps running.

export function tickJob(ctx: Ctx): Job {
  const { hood, direct, publicClient, queue } = ctx;
  const MIN_FLUSH = ctx.knobs.minFlushWei;
  // the boot already read it once; the first re-read is five minutes later
  let lastAppointmentCheck = Date.now();
  let saidNotAppointed = false;

  async function refreshAppointment() {
    if (Date.now() - lastAppointmentCheck < 300_000) return;
    lastAppointmentCheck = Date.now();
    try {
      const appointed = (await publicClient.readContract({
        address: hood.addresses.feeRouter, abi: hoodFeeRouterAbi, functionName: "keeper",
      })) as Address;
      const ok = appointed.toLowerCase() === ctx.account.address.toLowerCase();
      if (ok !== ctx.buybacksAppointed) {
        ctx.buybacksAppointed = ok;
        log("tick", ok
          ? `fee router keeper is now this wallet: curve buybacks on`
          : `fee router keeper is ${appointed}, not this wallet: curve buybacks off (flush without a buyback still runs)`);
      }
    } catch (e) {
      log("tick", `could not read feeRouter.keeper(): ${message(e)}`);
    }
  }

  return async () => {
    await refreshAppointment();
    const counts: Record<string, number> = { tokens: 0, direct: 0, curve: 0, writes: 0, buybacksSkipped: 0, errors: 0 };
    const rows = await ctx.api.allTokens();
    counts.tokens = rows.length;
    for (const row of rows) {
      const token = row.token as Address;
      try {
        // A direct launch has no curve to finalize and no fee router to flush. What it has is a
        // splitter that needs telling money arrived, a pot that buys back, a position that earns.
        if (row.mode === "direct") {
          if (!direct || !row.splitter || !row.locker) continue;
          counts.direct++;
          // The indexer says which tokens are worth looking at; the portal says what a launch's
          // contracts are. A database this process does not own must never be able to point its key
          // at an address of somebody else's choosing.
          const onChain = await direct.getLaunch(token);
          if (!onChain.exists) continue;
          const splitter = onChain.splitter;
          const locker = onChain.locker;

          // sweep only when something arrived; an empty sweep is a transaction for nothing
          if ((await direct.unaccounted(splitter, (row.pair_token as Address | undefined) ?? zeroAddress)) > 0n) {
            await queue.wait(await direct.sweep(splitter)).catch(() => {});
            counts.writes++;
          }

          // The protocol's tenth is booked by the sweep and pushed by nobody: nothing reaches the
          // treasury until somebody pulls it, and that somebody is this process.
          const owed = await direct.protocolClaimable(splitter);
          if (owed > 0n) {
            const hash = await direct.claimProtocol(splitter);
            log("tick", `claimProtocol ${row.token} ${formatEther(owed)} -> ${hash}`);
            await queue.wait(hash);
            counts.writes++;
          }

          const buckets = await direct.buckets(splitter);
          if (buckets.liquidityPot >= MIN_FLUSH) {
            const hash = await direct.pushLiquidity(splitter);
            log("tick", `pushLiquidity ${row.token} ${formatEther(buckets.liquidityPot)} -> ${hash}`);
            await queue.wait(hash);
            counts.writes++;
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
              log("tick", `buyback ${row.token} skipped: the run would buy nothing right now`);
            } else {
              const minTokensOut = minOutFromQuote(expected, 100);
              const hash = await direct.runBuyback(token, minTokensOut);
              log("tick", `buyback ${row.token} ${formatEther(buckets.buybackPot)} min ${formatEther(minTokensOut)} -> ${hash}`);
              await queue.wait(hash);
              counts.writes++;
            }
          }
          // The position's own fees, on a slower cadence than the rest.
          if (Math.random() < 0.1) await direct.harvest(locker).catch(() => {});
          continue;
        }

        // Same rule on this side: the registry says what a launch's curve is, not the database.
        const launch = await hood.getLaunch(token);
        if (!launch.exists || launch.curve === zeroAddress) continue;
        counts.curve++;
        const curve = launch.curve as Address;

        // 1. a curve that sold out is a pool waiting to be opened
        if (row.phase === 1) {
          const hash = await hood.finalize(curve);
          log("tick", `finalize ${row.token} -> ${hash}`);
          await queue.wait(hash);
          counts.writes++;
          continue;
        }

        // 2. fees the pool earned belong to the token's model, not to this contract
        if (row.phase === 2) {
          try {
            const hash = await hood.collect(token);
            log("tick", `collect ${row.token} -> ${hash}`);
            await queue.wait(hash);
            counts.writes++;
          } catch { /* nothing to collect is the normal case, not an error */ }
        }

        // 3. the protocol's own legs are booked on the curve and pulled by anybody, so that a
        //    treasury which cannot take a transfer can never stop a trade. This is the anybody.
        const booked = await hood.protocolClaimable(curve);
        if (booked >= MIN_FLUSH) {
          const hash = await hood.claimProtocol(curve);
          log("tick", `claimProtocol ${row.token} ${formatEther(booked)} -> ${hash}`);
          await queue.wait(hash);
          counts.writes++;
        }

        // 4. push whatever is booked through the model
        const accrued = await hood.creatorFees(token);
        if (accrued < MIN_FLUSH) continue;

        if (row.fee_model === 1) {
          if (!ctx.buybacksAppointed) {
            // Not this wallet's call to make: the floor of a buyback is the appointed keeper's.
            if (!saidNotAppointed) {
              log("tick", `buyback ${row.token}: ${formatEther(accrued)} accrued but this wallet is not the fee router keeper; skipped (said once)`);
              saidNotAppointed = true;
            }
            counts.buybacksSkipped++;
            continue;
          }
          if (row.phase !== 2) {
            // A buy on the curve moves the curve's price, so a floorless buyback is a sandwich waiting
            // to happen here too. The floor is the curve's own quote for this exact size, one percent
            // under; the curve is deterministic, so the only thing that can move it is somebody
            // trading in between, which is precisely what the floor is for.
            const [tokensOut] = await hood.quoteCurveBuy(curve, accrued);
            if (tokensOut === 0n) { log("tick", `buyback ${row.token}: the curve quotes nothing, skipped`); continue; }
            const hash = await hood.flushBuyback(token, minOutFromQuote(tokensOut, 100));
            log("tick", `buyback ${row.token} ${formatEther(accrued)} on the curve -> ${hash}`);
            counts.writes++;
          } else {
            // a graduated buyback has to swap, and a swap without a floor is a gift to sandwichers:
            // the floor is the quoter's answer for the graduated pool, one percent under
            const [key] = (await publicClient.readContract({
              address: hood.addresses.graduator, abi: uniswapV4GraduatorAbi, functionName: "positionOf", args: [token],
            })) as unknown as [PoolKey, bigint];
            const pair = (row.pair_token ?? zeroAddress) as Address;
            const { amountOut } = await quoteDirectSwap({ publicClient, poolKey: key, tokenIn: pair, amountIn: accrued });
            if (amountOut === 0n) { log("tick", `buyback ${row.token}: quote is zero, skipped`); continue; }
            const hash = await hood.flushBuyback(token, minOutFromQuote(amountOut, 100));
            log("tick", `buyback ${row.token} ${formatEther(accrued)} floor ${(amountOut * 99n) / 100n} -> ${hash}`);
            counts.writes++;
          }
        } else {
          const hash = await hood.flush(token);
          log("tick", `flush ${row.token} ${formatEther(accrued)} -> ${hash}`);
          counts.writes++;
        }
      } catch (e) {
        log("tick", `${row.token}: ${message(e)}`);
        counts.errors++;
      }
    }
    return counts;
  };
}
