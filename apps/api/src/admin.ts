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
  bridgeFactory: process.env.HOOD_BRIDGE_FACTORY ?? null,
  portal: process.env.HOOD_PORTAL ?? null,
  directDeployer: process.env.HOOD_DIRECT_DEPLOYER ?? null,
  buybackModule: process.env.HOOD_BUYBACK_MODULE ?? null,
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
