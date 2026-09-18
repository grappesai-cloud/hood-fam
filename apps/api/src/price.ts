import { createPublicClient, http, parseAbiItem, zeroAddress, type Address } from "viem";
import { robinhood } from "@hood/sdk";

/// What a pair amount is worth in dollars.
///
/// Its own module rather than a corner of the indexer, because the indexer is not the only thing
/// that has to price something any more: the stake accrual credits points for dollars locked, and
/// the season take reports dollars earned. A module that everything can import is also a module
/// that cannot take part in an import cycle, which is what this is really avoiding.

const RPC = process.env.HOOD_RPC ?? robinhood.rpcUrls.default.http[0]!;
const client = createPublicClient({ chain: robinhood, transport: http(RPC) });

const ETH_USD_FEED = "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9" as Address;

/// Volume has to be priced in dollars for points to mean anything across pairs. The Chainlink
/// ETH/USD feed on 4663 is the source; the last good answer is kept, because a feed that hiccups
/// for a minute must not quietly price a day of trading at zero. HOOD_ETH_USD is the floor under
/// that: on a chain with no feed at all (a local run), it is the only price there is.
const FALLBACK_ETH_USD = Number(process.env.HOOD_ETH_USD ?? 0);
let ethUsd = { price: FALLBACK_ETH_USD, at: 0 };
let warnedNoPrice = false;

export async function ethUsdPrice(): Promise<number> {
  if (Date.now() - ethUsd.at < 60_000 && ethUsd.price > 0) return ethUsd.price;
  try {
    const answer = (await client.readContract({
      address: ETH_USD_FEED,
      abi: [parseAbiItem("function latestAnswer() view returns (int256)")],
      functionName: "latestAnswer",
    })) as bigint;
    if (answer > 0n) ethUsd = { price: Number(answer) / 1e8, at: Date.now() };
  } catch {
    ethUsd = { price: ethUsd.price || FALLBACK_ETH_USD, at: Date.now() };
  }
  if (ethUsd.price === 0 && !warnedNoPrice) {
    warnedNoPrice = true;
    console.warn(
      "no ETH/USD price: trades in the native pair are being credited zero points. " +
      "Set HOOD_ETH_USD, or point HOOD_RPC at a chain that carries the Chainlink feed.",
    );
  }
  return ethUsd.price;
}

export async function usdValue(pairToken: string, amount: bigint): Promise<number> {
  if (pairToken === zeroAddress.toLowerCase()) return (Number(amount) / 1e18) * (await ethUsdPrice());
  return Number(amount) / 1e6; // the dollar pairs on this chain are six decimals
}
