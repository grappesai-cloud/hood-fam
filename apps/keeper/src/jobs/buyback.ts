import type { Address } from "viem";
import { formatEther, isAddress } from "viem";
import { minOutFromQuote } from "@hood/sdk";
import type { TapeRow } from "../api.js";
import type { Ctx, Job } from "../context.js";
import { log } from "../log.js";
import { message } from "../queue.js";

/// Bots buy the dip. Every 20 s: the tape's newest buyback rows; every one this process has not
/// acted on yet gets one run of the buyback module for its token, floored one percent under the
/// module's own quote of that run. Once per tape row. A row whose pot is already empty (the tick
/// got there first, or a restart replays the tape) quotes zero and is skipped without a
/// transaction, which is what makes the replay safe.

const TAPE = "/bag/tape?kind=buyback_wanted&limit=20";
const REMEMBER = 2_000;

export function buybackJob(ctx: Ctx): Job {
  const seen = new Set<string>();
  return async () => {
    if (!ctx.direct) return { off: 1 };
    const counts: Record<string, number> = { rows: 0, fresh: 0, ran: 0, empty: 0, failed: 0 };
    const data = await ctx.api.get<{ rows: TapeRow[] }>(TAPE);
    if (!data) { ctx.api.noteMissing("buyback", "/bag/tape"); return { ...counts, waiting: 1 }; }
    counts.rows = data.rows.length;
    for (const row of data.rows) {
      const id = `${row.tx}:${row.id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      if (!row.token || !isAddress(row.token)) continue;
      counts.fresh++;
      const token = row.token as Address;
      try {
        const expected = await ctx.direct.quoteBuyback(token);
        if (expected === 0n) { counts.empty++; continue; }
        const floor = minOutFromQuote(expected, 100);
        const hash = await ctx.direct.runBuyback(token, floor);
        log("buyback", `${token} asked in ${row.tx}: run, floor ${formatEther(floor)} tokens -> ${hash}`);
        counts.ran++;
      } catch (e) {
        log("buyback", `${token}: ${message(e)}`);
        counts.failed++;
      }
    }
    if (seen.size > REMEMBER) {
      for (const id of Array.from(seen).slice(0, seen.size - REMEMBER)) seen.delete(id);
    }
    return counts;
  };
}
