// The router swap encoding for chain 4663, the same one the app uses. The UniversalRouter here is a
// Robinhood fork with an extra `minHopPriceX36` field in every v4 swap struct.
import { encodeAbiParameters, parseAbiParameters } from "viem";

export function buildSwap({ key, zeroForOne, amountIn, minAmountOut, tokenIn, tokenOut }) {
  const actions = "0x060c0f";
  const swapParams = encodeAbiParameters(
    parseAbiParameters("((address,address,uint24,int24,address),bool,uint128,uint128,uint256,bytes)"),
    [[[key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks], zeroForOne, amountIn, minAmountOut, 0n, "0x"]],
  );
  const settle = encodeAbiParameters(parseAbiParameters("address, uint256"), [tokenIn, amountIn]);
  const take = encodeAbiParameters(parseAbiParameters("address, uint256"), [tokenOut, minAmountOut]);
  const inputs = [encodeAbiParameters(parseAbiParameters("bytes, bytes[]"), [actions, [swapParams, settle, take]])];
  return { commands: "0x10", inputs };
}

export const universalRouterAbi = [
  { type: "function", name: "execute", stateMutability: "payable", inputs: [{ type: "bytes" }, { type: "bytes[]" }, { type: "uint256" }], outputs: [] },
];
