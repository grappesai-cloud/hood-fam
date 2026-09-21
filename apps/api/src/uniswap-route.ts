import { getAddress, isAddress, zeroAddress, type Address, type Hex } from "viem";
import { robinhood, uniswapV4 } from "@hood/sdk";

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
      "x-agent-info": JSON.stringify({ decision_origin: "human_mediated", integration_name: "ox.family", version: "1" }),
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
