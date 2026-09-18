import { createPublicClient, http, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { robinhood, uniswapV4, uniswapV4GraduatorAbi } from "../../packages/sdk/dist/index.js";
import { buildSwap, universalRouterAbi } from "./swap.mjs";
const RPC = "http://127.0.0.1:8545";
const chain = { ...robinhood, rpcUrls: { default: { http: [RPC] } } };
const pc = createPublicClient({ chain, transport: http(RPC) });
const token = "0x818c232fc2b04b4ec098c6ec54a35551000ba5d8";
const [key] = await pc.readContract({ address: process.env.HOOD_GRADUATOR, abi: uniswapV4GraduatorAbi, functionName: "positionOf", args: [token] });
console.log("key from graduator:", key);
const alice = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const { commands, inputs } = buildSwap({ key: { currency0: key.currency0, currency1: key.currency1, fee: key.fee, tickSpacing: key.tickSpacing, hooks: key.hooks }, zeroForOne: true, amountIn: 50000000000000000n, minAmountOut: 0n, tokenIn: zeroAddress, tokenOut: token });
try {
  const gas = await pc.estimateContractGas({ address: uniswapV4.universalRouter, abi: universalRouterAbi, functionName: "execute", args: [commands, inputs, BigInt(Math.floor(Date.now()/1000)+600)], value: 50000000000000000n, account: alice });
  console.log("estimate ok:", gas);
} catch (e) { console.log("ESTIMATE FAILED:", e.shortMessage || e.message, "\n", (e.details || "").slice(0, 300)); }
