import { type Address, type Hex, encodeAbiParameters, keccak256, parseAbiParameters } from "viem";

/// A v4 pool is its key: the two currencies in address order, the fee, the spacing and the hook.
export interface PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

/// The id the PoolManager files a pool under: the hash of its key, encoded as the struct is.
export function poolIdOf(key: PoolKey): Hex {
  return keccak256(encodeAbiParameters(
    parseAbiParameters("address, address, uint24, int24, address"),
    [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
  ));
}

/// The UniversalRouter on 4663 is a Robinhood fork: every v4 swap struct carries an extra
/// `minHopPriceX36` between `amountOutMinimum` and `hookData`. Encoding it the canonical way reads
/// the hook data offset as the price floor and reverts inside the callback with no message.
const SWAP_EXACT_IN_SINGLE = 0x06;
const SETTLE_ALL = 0x0c;
const TAKE_ALL = 0x0f;
const CMD_V4_SWAP = 0x10;

/// One exact-input swap through the router, settled and taken in full. `minAmountOut` is the
/// floor the router enforces; the same number goes into TAKE_ALL so a short fill cannot be taken.
export function buildSwap(params: {
  key: PoolKey;
  zeroForOne: boolean;
  amountIn: bigint;
  minAmountOut: bigint;
  tokenIn: Address;
  tokenOut: Address;
}) {
  const actions = `0x${[SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL]
    .map((a) => a.toString(16).padStart(2, "0"))
    .join("")}` as Hex;

  const swapParams = encodeAbiParameters(
    parseAbiParameters(
      "((address,address,uint24,int24,address),bool,uint128,uint128,uint256,bytes)",
    ),
    [[
      [params.key.currency0, params.key.currency1, params.key.fee, params.key.tickSpacing, params.key.hooks],
      params.zeroForOne,
      params.amountIn,
      params.minAmountOut,
      0n, // minHopPriceX36, the fork's extra field
      "0x",
    ]] as never,
  );

  const settle = encodeAbiParameters(parseAbiParameters("address, uint256"), [params.tokenIn, params.amountIn]);
  const take = encodeAbiParameters(parseAbiParameters("address, uint256"), [params.tokenOut, params.minAmountOut]);

  const inputs = [
    encodeAbiParameters(parseAbiParameters("bytes, bytes[]"), [actions, [swapParams, settle, take]]),
  ];
  const commands = `0x${CMD_V4_SWAP.toString(16).padStart(2, "0")}` as Hex;
  return { commands, inputs };
}

export const universalRouterAbi = [
  {
    type: "function",
    name: "execute",
    stateMutability: "payable",
    inputs: [{ type: "bytes" }, { type: "bytes[]" }, { type: "uint256" }],
    outputs: [],
  },
  // The router's own reverts. Without them a failed swap comes back as a bare selector and
  // "not found on the provided ABI", which sends whoever is debugging it looking in the wrong
  // contract: `0x5bf6f916` is the deadline, not the pool, not the hook and not the token.
  { type: "error", name: "TransactionDeadlinePassed", inputs: [] },
  { type: "error", name: "V4TooLittleReceived", inputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "error", name: "V4TooMuchRequested", inputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "error", name: "InvalidCommandType", inputs: [{ type: "uint256" }] },
  { type: "error", name: "ETHNotAccepted", inputs: [] },
  { type: "error", name: "ExecutionFailed", inputs: [{ type: "uint256" }, { type: "bytes" }] },
] as const;

/// The router never pulls an ERC-20 itself: it asks Permit2 to. So an ERC-20 on the way in needs
/// the token approved to Permit2, and Permit2 told that the router may spend it. Both once.
export const permit2Abi = [
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }, { type: "address" }], outputs: [{ type: "uint160" }, { type: "uint48" }, { type: "uint48" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "address" }, { type: "uint160" }, { type: "uint48" }], outputs: [] },
] as const;
