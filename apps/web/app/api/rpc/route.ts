import { NextResponse } from "next/server";

const DEFAULT_RPC = "https://rpc.mainnet.chain.robinhood.com";

// The browser only needs public chain reads, gas simulation, and one write: relaying a transaction
// that is already signed. Injected wallets still submit their own; the team desk signs in the page
// with keys that never leave it, so it needs somewhere to hand the signed bytes. That is not a free
// broadcaster: a raw transaction pays its own gas from its own sender, and nothing here can sign.
// Anything that would ask the node to sign (eth_sendTransaction, eth_sign) stays out.
const METHODS = new Set([
  "eth_blockNumber",
  "eth_call",
  "eth_chainId",
  "eth_createAccessList",
  "eth_estimateGas",
  "eth_feeHistory",
  "eth_gasPrice",
  "eth_getBalance",
  "eth_getBlockByHash",
  "eth_getBlockByNumber",
  "eth_getBlockReceipts",
  "eth_getCode",
  "eth_getLogs",
  "eth_getProof",
  "eth_getStorageAt",
  "eth_getTransactionByHash",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
  "eth_maxPriorityFeePerGas",
  "eth_sendRawTransaction",
]);

interface RpcCall { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown }

function permitted(value: unknown): boolean {
  const calls = Array.isArray(value) ? value : [value];
  return calls.length > 0 && calls.length <= 25 && calls.every((call) => {
    if (!call || typeof call !== "object") return false;
    const rpc = call as RpcCall;
    return rpc.jsonrpc === "2.0" && typeof rpc.method === "string" && METHODS.has(rpc.method);
  });
}

export async function POST(req: Request) {
  try {
    const raw = await req.text();
    if (raw.length === 0 || raw.length > 256_000) {
      return NextResponse.json({ error: "invalid RPC request size" }, { status: 413 });
    }
    const body = JSON.parse(raw) as unknown;
    if (!permitted(body)) {
      return NextResponse.json({ error: "RPC method is not available through the web proxy" }, { status: 403 });
    }

    const upstream = process.env.HOOD_RPC?.trim() || DEFAULT_RPC;
    const response = await fetch(upstream, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw,
      cache: "no-store",
    });
    return new Response(await response.arrayBuffer(), {
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") || "application/json" },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "RPC proxy failed" },
      { status: 502 },
    );
  }
}
