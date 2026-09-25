import type { Address } from "viem";
import { kingAbi } from "../abi.js";
import type { Ctx, Job } from "../context.js";
import { log } from "../log.js";
import { message } from "../queue.js";

/// King of the hill. Every 20 s: for every launch that turned it on (`king_bps > 0`), read the
/// timer and the pot from the splitter; when the timer ran out and there is a pot, settle it.
/// Idempotent by construction: a settled round has an empty pot, and the simulation says so.

export function kingJob(ctx: Ctx): Job {
  return async () => {
    const counts: Record<string, number> = { candidates: 0, running: 0, settled: 0, unreadable: 0 };
    const rows = (await ctx.api.allTokens()).filter((r) => Number(r.king_bps ?? 0) > 0);
    counts.candidates = rows.length;
    const now = BigInt(Math.floor(Date.now() / 1000));
    for (const row of rows) {
      const target = (row.splitter ?? row.pot) as Address | null;
      if (!target) continue;
      const name = row.symbol ?? row.token;
      try {
        const [endsAt, pot] = await ctx.publicClient.multicall({
          allowFailure: true,
          contracts: [
            { address: target, abi: kingAbi, functionName: "kingEndsAt" },
            { address: target, abi: kingAbi, functionName: "kingPot" },
          ],
        });
        if (endsAt.status !== "success" || pot.status !== "success") { counts.unreadable++; continue; }
        const ends = endsAt.result as bigint;
        const amount = pot.result as bigint;
        if (amount === 0n || ends === 0n) continue;
        if (ends >= now) { counts.running++; continue; }
        await ctx.queue.send(`king ${name}`, { address: target, abi: kingAbi, functionName: "settleKing", args: [] });
        counts.settled++;
      } catch (e) {
        log("king", `${name}: ${message(e)}`);
      }
    }
    return counts;
  };
}
