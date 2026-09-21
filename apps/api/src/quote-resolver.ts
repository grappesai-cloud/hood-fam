import { createPublicClient, erc20Abi, getAddress, http, isAddress, parseAbi, zeroAddress, type Address } from "viem";
import { robinhood } from "@hood/sdk";

const USDG = getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
const V3_FACTORY = getAddress("0x1f7d7550B1b028f7571E69A784071F0205FD2EfA");
const FEES = [100, 500, 3_000, 10_000] as const;
const MIN_DEPTH_USD = Number(process.env.CUSTOM_QUOTE_MIN_USD ?? 25_000);

const client = createPublicClient({
  chain: robinhood,
  transport: http(process.env.HOOD_RPC ?? robinhood.rpcUrls.default.http[0]!),
});

const factoryAbi = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
const poolAbi = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)",
  "function liquidity() view returns (uint128)",
  "function token0() view returns (address)",
]);

export interface ResolvedQuote {
  address: Address;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: string;
  compatible: boolean;
  hasLiquidity: boolean;
  liquiditySafe: boolean;
  depthUsd: number;
  usd: number;
  pool: null | { kind: "v3"; address: Address; fee: number };
  warnings: string[];
}

const cache = new Map<string, { at: number; value: ResolvedQuote }>();

/// Resolve an arbitrary quote from chain state. This is deliberately advisory: the factory is the
/// final compatibility check, while this tells a creator whether buyers can acquire the parent coin.
export async function resolveQuote(raw: string): Promise<ResolvedQuote> {
  if (!isAddress(raw) || raw.toLowerCase() === zeroAddress) throw new Error("not an ERC-20 address");
  const address = getAddress(raw);
  const hit = cache.get(address.toLowerCase());
  if (hit && Date.now() - hit.at < 60_000) return hit.value;

  const code = await client.getBytecode({ address });
  if (!code || code === "0x") throw new Error("address has no contract code");

  const [nameRead, symbolRead, decimalsRead, supplyRead] = await Promise.allSettled([
    client.readContract({ address, abi: erc20Abi, functionName: "name" }),
    client.readContract({ address, abi: erc20Abi, functionName: "symbol" }),
    client.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
    client.readContract({ address, abi: erc20Abi, functionName: "totalSupply" }),
  ]);
  if (decimalsRead.status !== "fulfilled" || supplyRead.status !== "fulfilled") {
    throw new Error("contract does not expose ERC-20 decimals and totalSupply");
  }
  const decimals = Number(decimalsRead.value);
  const warnings: string[] = [];
  if (decimals > 18) warnings.push("More than 18 decimals: the curve refuses this token.");

  const pools = await Promise.all(FEES.map(async (fee) => {
    try {
      const pool = await client.readContract({
        address: V3_FACTORY, abi: factoryAbi, functionName: "getPool", args: [address, USDG, fee],
      });
      if (pool === zeroAddress) return null;
      const [slot0, liquidity, token0, dollars] = await Promise.all([
        client.readContract({ address: pool, abi: poolAbi, functionName: "slot0" }),
        client.readContract({ address: pool, abi: poolAbi, functionName: "liquidity" }),
        client.readContract({ address: pool, abi: poolAbi, functionName: "token0" }),
        client.readContract({ address: USDG, abi: erc20Abi, functionName: "balanceOf", args: [pool] }),
      ]);
      if (liquidity === 0n || slot0[0] === 0n) return null;
      const depthUsd = Number(dollars) / 1e6;
      const raw = (Number(slot0[0]) / 2 ** 96) ** 2;
      const assetIsToken0 = token0.toLowerCase() === address.toLowerCase();
      const scale = 10 ** (decimals - 6);
      const usd = assetIsToken0 ? raw * scale : scale / raw;
      if (!Number.isFinite(usd) || usd <= 0) return null;
      return { pool: getAddress(pool), fee, depthUsd, usd };
    } catch {
      return null;
    }
  }));
  const best = pools.filter((p): p is NonNullable<typeof p> => Boolean(p))
    .sort((a, b) => b.depthUsd - a.depthUsd)[0];
  if (!best) warnings.push("No live USDG liquidity was found. Buyers may not be able to acquire this quote token.");
  else if (best.depthUsd < MIN_DEPTH_USD) warnings.push(`Only about $${Math.round(best.depthUsd).toLocaleString()} of USDG depth was found.`);
  // No static check can prove a token will never add a tax or blacklist the curve later. The curve
  // measures transfers and rejects taxed inputs, so say exactly what was and was not established.
  warnings.push("Transfer taxes and future blacklist changes cannot be proven off-chain; taxed transfers revert on the curve.");

  const value: ResolvedQuote = {
    address,
    name: nameRead.status === "fulfilled" ? nameRead.value : "Unknown token",
    symbol: symbolRead.status === "fulfilled" ? symbolRead.value : "TOKEN",
    decimals,
    totalSupply: supplyRead.value.toString(),
    compatible: decimals <= 18,
    hasLiquidity: Boolean(best),
    liquiditySafe: Boolean(best && best.depthUsd >= MIN_DEPTH_USD),
    depthUsd: best?.depthUsd ?? 0,
    usd: best?.usd ?? 0,
    pool: best ? { kind: "v3", address: best.pool, fee: best.fee } : null,
    warnings,
  };
  cache.set(address.toLowerCase(), { at: Date.now(), value });
  return value;
}
