import type { Address } from "viem";
import { isAddress } from "viem";
import { openingAuctionAbi } from "../abi.js";
import type { OpenAuction } from "../api.js";
import type { Ctx, Job } from "../context.js";
import { log } from "../log.js";
import { message } from "../queue.js";

/// Sniper auctions. Every 20 s: the API lists auctions that are not settled and whose end block
/// has passed (`/auctions/open`); each one gets `settle(token)`. The contract refuses a second
/// settle, so a stale list costs a failed simulation and nothing else.

export function auctionJob(ctx: Ctx): Job {
  const settled = new Set<string>();
  return async () => {
    if (!ctx.openingAuction) return { off: 1 };
    const counts: Record<string, number> = { open: 0, pending: 0, settled: 0, failed: 0 };
    const data = await ctx.api.get<{ auctions?: OpenAuction[]; rows?: OpenAuction[] }>("/auctions/open");
    if (!data) { ctx.api.noteMissing("auction", "/auctions/open"); return { ...counts, waiting: 1 }; }
    const rows = (data.auctions ?? data.rows ?? []).filter((a) => a && isAddress(a.token) && !a.settled);
    counts.open = rows.length;
    if (rows.length === 0) return counts;
    const head = await ctx.publicClient.getBlockNumber();
    for (const a of rows) {
      const token = a.token.toLowerCase();
      if (settled.has(token)) continue;
      if (BigInt(a.end_block) > head) { counts.pending++; continue; }
      try {
        const sent = await ctx.queue.send(`auction ${a.token}`, {
          address: ctx.openingAuction, abi: openingAuctionAbi, functionName: "settle", args: [a.token as Address],
        });
        counts.settled++;
        if (!sent.dry) settled.add(token);
      } catch (e) {
        log("auction", `${a.token}: ${message(e)}`);
        counts.failed++;
      }
    }
    return counts;
  };
}
