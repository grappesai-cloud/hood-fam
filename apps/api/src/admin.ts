import { timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { createPublicClient, http } from "viem";
import { robinhood } from "@hood/sdk";

import { storageConfigured } from "./uploads.js";

/// One token for everything an operator does: the ticket queue, seasons, the overview. The name
/// is HOOD_ADMIN_TOKEN; SUPPORT_ADMIN_TOKEN still works so a deploy that only set the older name
/// keeps its ticket queue. Read at call time, not at boot, so a token set in a running process
/// (or unset to lock everyone out) takes effect on the next request.
export function isAdmin(req: FastifyRequest): boolean {
  const token = process.env.HOOD_ADMIN_TOKEN || process.env.SUPPORT_ADMIN_TOKEN;
  if (!token) return false;
  const given = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(given), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/// Which third parties are wired. Booleans only: this is shown on the public /health so a deploy
/// can be checked from the outside without ever echoing a key.
export const integrations = () => ({
  assistant: Boolean(process.env.ANTHROPIC_API_KEY),
  art: Boolean(process.env.OPENROUTER_API_KEY),
  relay: Boolean(process.env.RELAY_API_KEY),
  /// The 1-click ETH -> quote -> launch-token path. The on-chain router is the half that cannot be
  /// worked around: without it there is nothing to spend the swapped quote on the curve. The other
  /// half is either Uniswap's routing service (every venue, every hop) or, with no key, the single
  /// v4 hop the pad builds itself, which exists for most pairs but not for all. So this says the
  /// path is offered, and `routingSource` says who builds it; the app asks per pair before offering.
  routing: Boolean(process.env.HOOD_CURVE_ROUTER),
  routingSource: process.env.UNISWAP_API_KEY ? "uniswap" : "local",
  /// false means /uploads/image answers 501 and the wizards fall back to the artwork URL field.
  storage: storageConfigured(),
});

/// The deployed addresses as the process sees them. null, not undefined, so a missing one shows
/// up in JSON instead of vanishing.
export const contracts = () => ({
  factory: process.env.HOOD_FACTORY ?? null,
  feeRouter: process.env.HOOD_FEE_ROUTER ?? null,
  staking: process.env.HOOD_STAKING ?? null,
  graduator: process.env.HOOD_GRADUATOR ?? null,
  curveRouter: process.env.HOOD_CURVE_ROUTER ?? null,
  bridgeFactory: process.env.HOOD_BRIDGE_FACTORY ?? null,
  portal: process.env.HOOD_PORTAL ?? null,
  directDeployer: process.env.HOOD_DIRECT_DEPLOYER ?? null,
  buybackModule: process.env.HOOD_BUYBACK_MODULE ?? null,
  referrals: process.env.HOOD_REFERRALS ?? null,
  // the Bag and its outlets; the house coin stays null until it launches
  bag: process.env.HOOD_BAG ?? null,
  payday: process.env.HOOD_PAYDAY ?? null,
  burnClock: process.env.HOOD_BURN_CLOCK ?? null,
  boosts: process.env.HOOD_BOOSTS ?? null,
  graduationHook: process.env.HOOD_GRADUATION_HOOK ?? null,
  openingAuction: process.env.HOOD_OPENING_AUCTION ?? null, // v3 only
  houseCoin: process.env.HOOD_HOUSE_COIN ?? null,
});

/// The chain's head, for the overview's "how far behind is the indexer". A node that does not
/// answer is null rather than an error: the overview is a dashboard, not a health check.
const chain = createPublicClient({
  chain: robinhood,
  transport: http(process.env.HOOD_RPC ?? robinhood.rpcUrls.default.http[0]),
});

export async function chainHead(): Promise<number | null> {
  try {
    return Number(await chain.getBlockNumber());
  } catch {
    return null;
  }
}
