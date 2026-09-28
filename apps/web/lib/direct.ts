/// Turning a valuation into a tick, which is the only number the pool understands.
///
/// Against the chain's own currency the token always sorts into currency1, so the pool price is
/// "token wei per wei of quote", which is the supply divided by the valuation. That makes the whole
/// launch describable in the one unit a creator actually thinks in: what is this worth at the open,
/// and what is it worth when it has bonded.
export function fdvToTick(fdvInQuote: number, supply: number, spacing: number): number {
  const price = supply / fdvInQuote;
  const tick = Math.log(price) / Math.log(1.0001);
  return Math.round(tick / spacing) * spacing;
}

export function tickToFdv(tick: number, supply: number): number {
  return supply / Math.pow(1.0001, tick);
}

/// The router encoding lives in the SDK, so the app, the MCP server and the keeper send the same
/// bytes. The UniversalRouter on 4663 is a Robinhood fork with an extra `minHopPriceX36` in every
/// v4 swap struct; `buildSwap` knows, and the canonical encoding reverts with no message.
export { buildSwap, universalRouterAbi } from "@hood/sdk";
import { SNIPE_SCHEDULE_BPS, snipeBpsAt } from "@hood/sdk";

/// How long the opening tax still has to run, as a fraction of its peak and as seconds.
export function snipeCountdown(launchedAt: number, decaySeconds: number, now = Date.now() / 1000) {
  const elapsed = now - launchedAt;
  if (elapsed >= decaySeconds) return { active: false, remaining: 0, fraction: 0 };
  const remaining = decaySeconds - elapsed;
  return { active: true, remaining, fraction: snipeBpsAt(elapsed) / SNIPE_SCHEDULE_BPS[0] };
}
