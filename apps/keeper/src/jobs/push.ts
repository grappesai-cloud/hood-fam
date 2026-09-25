import type { Address } from "viem";
import { potAbi } from "../abi.js";
import type { Ctx, Job } from "../context.js";
import { log } from "../log.js";
import { message } from "../queue.js";

/// Push payouts. Every KEEPER_PUSH_EVERY_MS (five minutes): for every launch with a pot, when
/// what the pot has booked and not yet paid is at least the floor, read the holders from the
/// indexer, keep those whose `pending` is at least KEEPER_PUSH_FLOOR_WEI, and `pushMany` them in
/// batches of 150. The pot pays holders and only holders, so the worst a wrong list can do is
/// waste this wallet's gas; the pending check keeps even that small.

const BATCH = 150;

export function pushJob(ctx: Ctx): Job {
  return async () => {
    const counts: Record<string, number> = { pots: 0, noPot: 0, belowFloor: 0, batches: 0, accounts: 0, failed: 0 };
    const rows = await ctx.api.allTokens();
    for (const row of rows) {
      const pot = (row.pot ?? (row.mode === "direct" ? row.splitter : null)) as Address | null;
      if (!pot) continue;
      const name = row.symbol ?? row.token;
      try {
        const totals = await ctx.publicClient.multicall({
          allowFailure: true,
          contracts: [
            { address: pot, abi: potAbi, functionName: "totalDeposited" },
            { address: pot, abi: potAbi, functionName: "totalPaid" },
          ],
        });
        if (totals[0].status !== "success" || totals[1].status !== "success") {
          // a splitter from before the Bag has no pot interface; nothing to push there
          counts.noPot++;
          continue;
        }
        counts.pots++;
        const unpaid = (totals[0].result as bigint) - (totals[1].result as bigint);
        if (unpaid < ctx.knobs.pushFloorWei) { counts.belowFloor++; continue; }

        const holders = await ctx.api.holders(row.token);
        if (holders.length === 0) continue;
        for (let i = 0; i < holders.length; i += BATCH) {
          const slice = holders.slice(i, i + BATCH) as Address[];
          const pending = await ctx.publicClient.multicall({
            allowFailure: true,
            contracts: slice.map((account) => ({ address: pot, abi: potAbi, functionName: "pending", args: [account] })),
          });
          const eligible = slice.filter((_, j) => pending[j].status === "success" && (pending[j].result as bigint) >= ctx.knobs.pushFloorWei);
          if (eligible.length === 0) continue;
          await ctx.queue.send(`push ${name}`, {
            address: pot, abi: potAbi, functionName: "pushMany", args: [eligible, ctx.knobs.pushFloorWei],
          });
          counts.batches++;
          counts.accounts += eligible.length;
        }
      } catch (e) {
        log("push", `${name} pot ${pot}: ${message(e)}`);
        counts.failed++;
      }
    }
    return counts;
  };
}
