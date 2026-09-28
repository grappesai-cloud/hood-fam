import { createPublicClient, getAddress, http, isAddress, zeroAddress, type Address, type Hex } from "viem";
import { buildSwap, poolIdOf, robinhood, stateViewAbi, uniswapV4, v4QuoterAbi, type PoolKey } from "@hood/sdk";

/// Its own reader: this answers a request and must not queue behind the indexer's block scan.
const chain = createPublicClient({
  chain: robinhood,
  transport: http(process.env.HOOD_RPC ?? robinhood.rpcUrls.default.http[0]),
});

const API = "https://trade-api.gateway.uniswap.org/v1";

type Json = Record<string, unknown>;

async function post(path: string, body: unknown, key: string): Promise<Json> {
  const response = await fetch(`${API}${path}`, {
    method: "POST",
    headers: {
      "accept": "application/json",
      "content-type": "application/json",
      "x-api-key": key,
      "x-universal-router-version": "2.1.1",
      "x-agent-info": JSON.stringify({ decision_origin: "human_mediated", integration_name: "hood.fam", version: "1" }),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const raw = await response.text();
  let json: Json = {};
  try { json = JSON.parse(raw) as Json; } catch { /* handled below */ }
  if (!response.ok) {
    const message = typeof json.detail === "string" ? json.detail
      : typeof json.error === "string" ? json.error
      : typeof json.errorCode === "string" ? json.errorCode
      : `routing service returned ${response.status}`;
    throw new Error(message);
  }
  return json;
}

function object(value: unknown, label: string): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`routing service omitted ${label}`);
  return value as Json;
}

function positiveInteger(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) throw new Error(`routing service returned invalid ${label}`);
  return value;
}

/// Gets an executable ETH -> arbitrary ERC-20 path while keeping the API key server-side. The
/// curve router, not the browser wallet, is deliberately both swapper and recipient: it receives
/// the custom quote and spends it on the bonding curve in the same transaction.
export async function nativeQuoteRoute(tokenOut: Address, amount: string, slippageTolerance: number) {
  const key = process.env.UNISWAP_API_KEY?.trim();
  if (!key) throw new Error("one-click routing is not configured");
  const curveRouter = process.env.HOOD_CURVE_ROUTER?.trim();
  if (!curveRouter || !isAddress(curveRouter)) throw new Error("curve router is not configured");
  const receiver = getAddress(curveRouter);

  const quoted = await post("/quote", {
    type: "EXACT_INPUT",
    amount,
    tokenInChainId: robinhood.id,
    tokenOutChainId: robinhood.id,
    tokenIn: zeroAddress,
    tokenOut,
    swapper: receiver,
    recipient: receiver,
    slippageTolerance,
    routingPreference: "BEST_PRICE",
    protocols: ["V2", "V3", "V4"],
  }, key);
  if (quoted.routing !== "CLASSIC") throw new Error(`unsupported route type: ${String(quoted.routing)}`);
  const quote = object(quoted.quote, "quote");
  const output = object(quote.output, "quote output");
  const quoteOut = positiveInteger(output.amount, "output amount");
  const minQuoteOut = positiveInteger(output.minimumAmount, "minimum output amount");
  const recipient = output.recipient;
  if (typeof recipient !== "string" || !isAddress(recipient) || getAddress(recipient) !== receiver) {
    throw new Error("route output has the wrong recipient");
  }

  const built = await post("/swap", {
    quote,
    permitData: quoted.permitData ?? null,
    simulateTransaction: false,
  }, key);
  const swap = object(built.swap, "swap transaction");
  if (typeof swap.to !== "string" || !isAddress(swap.to) || getAddress(swap.to) !== getAddress(uniswapV4.universalRouter)) {
    throw new Error("route targets an unexpected router");
  }
  if (typeof swap.from !== "string" || !isAddress(swap.from) || getAddress(swap.from) !== receiver) {
    throw new Error("route has the wrong sender");
  }
  if (swap.chainId !== robinhood.id) throw new Error("route is for the wrong chain");
  if (typeof swap.data !== "string" || !/^0x[0-9a-fA-F]+$/.test(swap.data) || swap.data === "0x") {
    throw new Error("route omitted transaction calldata");
  }
  if (positiveInteger(swap.value, "transaction value") !== amount) throw new Error("route changed the ETH input");

  return {
    routerCalldata: swap.data as Hex,
    value: amount,
    quoteOut,
    minQuoteOut,
    requestId: String(quoted.requestId ?? built.requestId ?? ""),
  };
}

// --------------------------------------------------------------- the local route

/// The same one click, without a routing service.
///
/// Uniswap's own routing API needs a key we may not have, and a pad whose best feature is dark
/// because of a missing key is a pad without that feature. But the route people actually need is
/// small: ETH into the asset a launch is priced in. On 4663 the deepest of those live in Uniswap v4
/// pools with no hook, which is exactly the shape the SDK already builds swaps for and the quoter
/// already prices, so this finds the pool, asks the quoter what the swap pays, and hands the
/// UniversalRouter actions straight to `HoodCurveRouter.buyWithNative`.
///
/// It is deliberately one hop. A two hop route through the dollar would have to leave the middle
/// leg inside the router between swaps, which is a different encoding on this chain's fork of the
/// router and cannot be guessed at safely. So a pair with no ETH pool is reported as having no
/// route rather than being sent down a path nobody has run: the app then offers the plain two step,
/// which works for every pair.
const FEE_TIERS: { fee: number; tickSpacing: number }[] = [
  { fee: 100, tickSpacing: 1 },
  { fee: 500, tickSpacing: 10 },
  { fee: 3000, tickSpacing: 60 },
  { fee: 10_000, tickSpacing: 200 },
];

/// Pools do not move. A miss is cached for a shorter while than a hit, so an asset that gets a pool
/// tomorrow starts routing without a restart.
const pools = new Map<string, { key: PoolKey | null; at: number }>();
const POOL_HIT_MS = 60 * 60 * 1000;
const POOL_MISS_MS = 10 * 60 * 1000;

async function ethPoolFor(token: Address): Promise<PoolKey | null> {
  const cached = pools.get(token.toLowerCase());
  if (cached && Date.now() - cached.at < (cached.key ? POOL_HIT_MS : POOL_MISS_MS)) return cached.key;

  let found: PoolKey | null = null;
  for (const tier of FEE_TIERS) {
    // Native ETH is currency0 in v4: it is address zero, which sorts below every token.
    const key: PoolKey = {
      currency0: zeroAddress, currency1: getAddress(token),
      fee: tier.fee, tickSpacing: tier.tickSpacing, hooks: zeroAddress,
    };
    try {
      const id = poolIdOf(key);
      const [slot0, liquidity] = await Promise.all([
        chain.readContract({ address: uniswapV4.stateView, abi: stateViewAbi, functionName: "getSlot0", args: [id] }),
        chain.readContract({ address: uniswapV4.stateView, abi: stateViewAbi, functionName: "getLiquidity", args: [id] }),
      ]);
      if ((slot0 as readonly bigint[])[0] > 0n && (liquidity as bigint) > 0n) { found = key; break; }
    } catch {
      // A tier that does not exist reads as a revert or a zero; either way, try the next one.
    }
  }
  pools.set(token.toLowerCase(), { key: found, at: Date.now() });
  return found;
}

export interface LocalRoute {
  source: "local";
  commands: Hex;
  inputs: Hex[];
  value: string;
  quoteOut: string;
  minQuoteOut: string;
  pool: { fee: number; tickSpacing: number };
}

export async function localNativeRoute(tokenOut: Address, amount: string, slippageTolerance: number): Promise<LocalRoute> {
  const key = await ethPoolFor(tokenOut);
  if (!key) throw new Error("no direct ETH pool for this pair on Robinhood Chain");
  const amountIn = BigInt(amount);
  if (amountIn <= 0n) throw new Error("the amount has to be above zero");

  // The quoter runs the swap for real inside `unlock` and reverts with the number, so this is the
  // price the swap would get in this block rather than a reading of the curve around it.
  const { result } = await chain.simulateContract({
    address: uniswapV4.quoter,
    abi: v4QuoterAbi,
    functionName: "quoteExactInputSingle",
    args: [{ poolKey: key, zeroForOne: true, exactAmount: amountIn, hookData: "0x" }],
  });
  const quoteOut = (result as readonly bigint[])[0];
  if (!quoteOut || quoteOut <= 0n) throw new Error("that pool quoted nothing for this amount");

  // Slippage arrives as a percentage, the way the routing service takes it.
  const bps = BigInt(Math.round(Math.min(Math.max(slippageTolerance, 0.05), 50) * 100));
  const minQuoteOut = (quoteOut * (10_000n - bps)) / 10_000n;
  const { commands, inputs } = buildSwap({
    key, zeroForOne: true, amountIn, minAmountOut: minQuoteOut,
    tokenIn: zeroAddress, tokenOut: getAddress(tokenOut),
  });

  return {
    source: "local",
    commands, inputs,
    value: amountIn.toString(),
    quoteOut: quoteOut.toString(),
    minQuoteOut: minQuoteOut.toString(),
    pool: { fee: key.fee, tickSpacing: key.tickSpacing },
  };
}

/// Is there any path at all for this pair? The app asks before it offers the button, because an
/// offer that fails at the last step is worse than one that was never made.
export async function hasNativeRoute(tokenOut: Address): Promise<boolean> {
  if (process.env.UNISWAP_API_KEY?.trim()) return true;
  try {
    return Boolean(await ethPoolFor(tokenOut));
  } catch {
    return false;
  }
}
