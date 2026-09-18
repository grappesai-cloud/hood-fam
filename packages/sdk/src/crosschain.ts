import type { Address } from "viem";

/// Buying a hood.fam token from another chain, in one signature.
///
/// The route is Relay: the user signs one transaction on their own chain, Relay's solver delivers
/// on 4663 and, in the same delivery, calls the curve so the tokens land in their wallet here.
/// Relay lists chain 4663 natively (ETH and USDG, deposits enabled), which is why this is one
/// signature and not a bridge followed by a swap.
///
/// Relay's quote endpoint requires an API key. Without one the SDK still gives you a working
/// hosted link, which is the honest fallback: the user finishes on relay.link and comes back.
const RELAY_API = "https://api.relay.link";

export interface RelayCall {
  to: Address;
  data: `0x${string}`;
  value: string;
}

export interface CrossChainBuyParams {
  user: Address;
  recipient?: Address;
  originChainId: number;
  originCurrency?: Address;
  amount: string;
  /// The curve to buy from, and the call that buys. Build it with client.encodeBuyCall.
  call?: RelayCall;
  apiKey?: string;
  referrer?: string;
}

export interface RelayQuote {
  steps: {
    id: string;
    kind: string;
    items: { status: string; data: { to: Address; data: `0x${string}`; value: string; chainId: number; maxFeePerGas?: string } }[];
  }[];
  fees?: Record<string, unknown>;
  details?: Record<string, unknown>;
}

export async function relayChains(): Promise<{ id: number; name: string; displayName: string }[]> {
  const res = await fetch(`${RELAY_API}/chains`);
  if (!res.ok) throw new Error(`relay chains: ${res.status}`);
  const json = (await res.json()) as { chains: { id: number; name: string; displayName: string }[] };
  return json.chains;
}

/// True when this deployment can quote cross-chain buys in-app rather than handing off to relay.link.
export const canQuoteCrossChain = (apiKey = process.env.RELAY_API_KEY) => Boolean(apiKey);

export async function quoteCrossChainBuy(p: CrossChainBuyParams): Promise<RelayQuote> {
  const apiKey = p.apiKey ?? process.env.RELAY_API_KEY;
  if (!apiKey) throw new Error("no RELAY_API_KEY: use crossChainBuyLink() instead, or get a key from Relay");

  const body: Record<string, unknown> = {
    user: p.user,
    recipient: p.recipient ?? p.user,
    originChainId: p.originChainId,
    originCurrency: p.originCurrency ?? "0x0000000000000000000000000000000000000000",
    destinationChainId: 4663,
    destinationCurrency: "0x0000000000000000000000000000000000000000",
    tradeType: "EXACT_INPUT",
    amount: p.amount,
    referrer: p.referrer ?? "hood.fam",
  };
  if (p.call) body.txs = [p.call];

  const res = await fetch(`${RELAY_API}/quote`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`relay quote: ${res.status} ${await res.text()}`);
  return (await res.json()) as RelayQuote;
}

/// The no-key path: a hosted Relay page that lands the funds on 4663, in the user's own wallet.
export function crossChainBuyLink(params: { fromChainId: number; amount?: string; recipient?: Address }): string {
  const u = new URL("https://relay.link/bridge/robinhood");
  u.searchParams.set("fromChainId", String(params.fromChainId));
  u.searchParams.set("toChainId", "4663");
  if (params.amount) u.searchParams.set("amount", params.amount);
  if (params.recipient) u.searchParams.set("recipient", params.recipient);
  return u.toString();
}
