import {
  type Address,
  type Hash,
  type PublicClient,
  type WalletClient,
  concatHex,
  encodeAbiParameters,
  getAddress,
  keccak256,
  maxUint256,
  numberToHex,
  parseAbiParameters,
  slice,
  zeroAddress,
} from "viem";

import {
  hoodPortalAbi,
  hoodDirectDeployerAbi,
  hoodLaunchHookAbi,
  hoodRevenueSplitterAbi,
  hoodLockerAbi,
  hoodBuybackModuleAbi,
  hoodLaunchTokenAbi,
} from "./abi.generated.js";
import { uniswapV4 } from "./chains.js";
import { minOutFromQuote, quoteBuybackRun, quoteDirectSwap } from "./quote.js";
import { type PoolKey, buildSwap, permit2Abi, universalRouterAbi } from "./swap.js";

const erc20Abi = [
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;
const MAX_UINT160 = (1n << 160n) - 1n;
const MAX_UINT48 = (1n << 48n) - 1n;

/// The low fourteen bits a hook address has to carry for Uniswap v4 to let it see swaps and return
/// a delta on both sides. Everything else about the address is free, which is why the salt is mined.
export const HOOK_FLAGS = 0xcc;
const FLAG_MASK = 0x3fff;

export interface DirectAddresses {
  portal: Address;
  deployer: Address;
  buybackModule: Address;
}

/// A launch's own contracts, all four of them, from the portal's registry.
export interface DirectLaunchRow {
  token: Address;
  quote: Address;
  hook: Address;
  splitter: Address;
  locker: Address;
  creator: Address;
  positionId: bigint;
  launchedAt: number;
  restrictionsEndBlock: bigint;
  exists: boolean;
}

/// Mines a CREATE2 salt whose address carries the hook permission bits.
/// @dev Fourteen bits, so about sixteen thousand hashes on average: under a second in a browser.
///      The initcode hash comes from the deployer contract, so a change in the hook's bytecode can
///      never leave a stale miner producing addresses that no longer validate. The portal binds
///      the salt to the creator before CREATE2 (`keccak256(abi.encode(creator, salt))`), so the
///      miner binds it the same way: two creators mining from zero never collide, and a salt seen
///      in the mempool is useless to anybody else.
export function mineHookSalt(deployer: Address, initCodeHash: `0x${string}`, creator: Address, start = 0n, limit = 2_000_000n) {
  const deployerBytes = getAddress(deployer);
  for (let i = start; i < start + limit; i++) {
    const salt = numberToHex(i, { size: 32 });
    const bound = keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [creator, salt]));
    const hash = keccak256(concatHex(["0xff", deployerBytes, bound, initCodeHash]));
    const address = getAddress(`0x${slice(hash, 12).slice(2)}`);
    if ((Number(BigInt(address) & BigInt(FLAG_MASK)) & FLAG_MASK) === HOOK_FLAGS) {
      return { salt, hook: address, attempts: Number(i - start) + 1 };
    }
  }
  throw new Error("no hook salt found in range");
}

/// Like `mineHookSalt`, but skips any address that already has code on it: the same creator
/// launching twice from the same starting salt would land on their own first hook.
export async function mineFreeHookSalt(
  publicClient: PublicClient,
  deployer: Address,
  initCodeHash: `0x${string}`,
  creator: Address,
  start = 0n,
) {
  let from = start;
  for (let round = 0; round < 64; round++) {
    const found = mineHookSalt(deployer, initCodeHash, creator, from);
    const code = await publicClient.getCode({ address: found.hook });
    if (!code || code === "0x") return found;
    from = BigInt(found.salt) + 1n;
  }
  throw new Error("could not find a free hook address");
}

export interface DirectLaunchInput {
  name: string;
  symbol: string;
  logo?: string;
  description?: string;
  socials?: { twitter?: string; telegram?: string; discord?: string; website?: string; farcaster?: string };
  quote?: Address;
  /// Who claims the creator allocation. Defaults to the launching wallet.
  creatorFeeRecipient?: Address;
  supply?: bigint;
  poolFee?: number;
  tickSpacing?: number;
  /// Taxes are per side and fixed forever: 100 to 1000 bps.
  buyTaxBps?: number;
  sellTaxBps?: number;
  /// The surcharge at the open, decaying to nothing. Launch tax plus this is capped at 9,900.
  snipeTaxBps?: number;
  snipeDecaySeconds?: number;
  /// Pons-style opening window. Zero disables it entirely, launch block included.
  restrictionBlocks?: number;
  maxHoldBps?: number;
  maxBuyBps?: number;
  /// Where the price starts and where the launch counts as bonded.
  tickStart: number;
  tickBond: number;
  /// The creator's nine tenths, split four ways. Must add up to 10,000.
  allocations?: { creatorBps: number; buybackBps: number; dividendsBps: number; liquidityBps: number };
  salt?: `0x${string}`;
  /// Quote spent on the creator's own first buy, inside the launch transaction. The window's buy
  /// cap applies to it, so it is first dibs, not the whole open.
  initialBuy?: bigint;
}

export interface DirectSwapInput {
  token: Address;
  side: "buy" | "sell";
  /// Quote units for a buy, token units for a sell.
  amountIn: bigint;
  /// How far under the quote the floor sits. One percent unless said otherwise.
  slippageBps?: number;
  /// How long the router will still accept the swap, counted from the chain's own clock rather
  /// than this machine's. Ten minutes unless said otherwise.
  deadlineSeconds?: number;
}

const DEFAULTS = {
  supply: 1_000_000_000n * 10n ** 18n,
  poolFee: 10_000,
  tickSpacing: 200,
  buyTaxBps: 500,
  sellTaxBps: 500,
  snipeTaxBps: 5_000,
  snipeDecaySeconds: 3,
  restrictionBlocks: 30,
  maxHoldBps: 500,
  maxBuyBps: 550,
  allocations: { creatorBps: 2_500, buybackBps: 2_500, dividendsBps: 4_000, liquidityBps: 1_000 },
} as const;

export function createDirectClient({
  publicClient,
  walletClient,
  addresses,
}: {
  publicClient: PublicClient;
  walletClient?: WalletClient;
  addresses: DirectAddresses;
}) {
  const account = () => {
    const a = walletClient?.account;
    if (!a) throw new Error("this call needs a wallet");
    return a;
  };

  async function write(to: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[], value?: bigint): Promise<Hash> {
    const { request } = await publicClient.simulateContract({
      address: to, abi: abi as never, functionName, args: args as never, value, account: account(),
    });
    return walletClient!.writeContract(request as never);
  }

  /// Mines a hook salt for this wallet on this deployment whose address is still FREE: the salt
  /// is bound to the creator, so only this wallet's own earlier launches can be in the way.
  async function hookSalt(start = 0n, creator?: Address) {
    const who = creator ?? walletClient?.account?.address;
    if (!who) throw new Error("hookSalt needs a creator address or a wallet");
    const initCodeHash = (await publicClient.readContract({
      address: addresses.deployer, abi: hoodDirectDeployerAbi, functionName: "hookInitCodeHash",
      args: [uniswapV4.poolManager as Address],
    })) as `0x${string}`;
    return mineFreeHookSalt(publicClient, addresses.deployer, initCodeHash, who, start);
  }

  async function launchFee(): Promise<bigint> {
    return publicClient.readContract({ address: addresses.portal, abi: hoodPortalAbi, functionName: "launchFee" }) as Promise<bigint>;
  }

  async function launch(input: DirectLaunchInput) {
    const allocations = input.allocations ?? DEFAULTS.allocations;
    const sum = allocations.creatorBps + allocations.buybackBps + allocations.dividendsBps + allocations.liquidityBps;
    if (sum !== 10_000) throw new Error(`allocations must add up to 10000, got ${sum}`);

    const spacing = input.tickSpacing ?? DEFAULTS.tickSpacing;
    if (input.tickStart % spacing !== 0 || input.tickBond % spacing !== 0) {
      throw new Error(`ticks must be multiples of the spacing (${spacing})`);
    }

    const { salt: hookSaltValue } = await hookSalt();
    const fee = await launchFee();
    const params = {
      name: input.name,
      symbol: input.symbol,
      logo: input.logo ?? "",
      description: input.description ?? "",
      socials: {
        twitter: input.socials?.twitter ?? "",
        telegram: input.socials?.telegram ?? "",
        discord: input.socials?.discord ?? "",
        website: input.socials?.website ?? "",
        farcaster: input.socials?.farcaster ?? "",
      },
      quote: input.quote ?? zeroAddress,
      creatorFeeRecipient: input.creatorFeeRecipient ?? account().address,
      supply: input.supply ?? DEFAULTS.supply,
      poolFee: input.poolFee ?? DEFAULTS.poolFee,
      tickSpacing: spacing,
      config: {
        buyTaxBps: input.buyTaxBps ?? DEFAULTS.buyTaxBps,
        sellTaxBps: input.sellTaxBps ?? DEFAULTS.sellTaxBps,
        snipeTaxBps: input.snipeTaxBps ?? DEFAULTS.snipeTaxBps,
        snipeDecaySeconds: input.snipeDecaySeconds ?? DEFAULTS.snipeDecaySeconds,
        restrictionBlocks: input.restrictionBlocks ?? DEFAULTS.restrictionBlocks,
        maxHoldBps: input.maxHoldBps ?? DEFAULTS.maxHoldBps,
        maxBuyBps: input.maxBuyBps ?? DEFAULTS.maxBuyBps,
        tickStart: input.tickStart,
        tickBond: input.tickBond,
        allocations,
      },
      salt: input.salt ?? keccak256(encodeAbiParameters(parseAbiParameters("string, uint256"), [input.symbol, BigInt(Date.now())])),
      initialBuy: input.initialBuy ?? 0n,
    };

    const isNative = (params.quote as string).toLowerCase() === zeroAddress;
    const value = isNative ? fee + params.initialBuy : fee;
    if (!isNative && params.initialBuy > 0n) {
      // the portal pulls the quote for the first buy from the creator
      const allowance = (await publicClient.readContract({
        address: params.quote as Address,
        abi: [{ type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] }],
        functionName: "allowance", args: [account().address, addresses.portal],
      })) as bigint;
      if (allowance < params.initialBuy) {
        const h = await write(params.quote as Address, [
          { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
        ], "approve", [addresses.portal, params.initialBuy]);
        await publicClient.waitForTransactionReceipt({ hash: h });
      }
    }

    const hash = await write(addresses.portal, hoodPortalAbi, "createLaunch", [params, hookSaltValue], value);
    return { hash, hookSalt: hookSaltValue, launchFee: fee, value };
  }

  /// How far a launch is from bonding, the way Pons publishes it.
  async function graduationStatus(token: Address) {
    const [currentTick, bondTick, progressBps, bonded] = (await publicClient.readContract({
      address: addresses.portal, abi: hoodPortalAbi, functionName: "graduationStatus", args: [token],
    })) as [number, number, bigint, boolean];
    return { currentTick, bondTick, progressBps: Number(progressBps), bonded };
  }

  async function getLaunch(token: Address): Promise<DirectLaunchRow> {
    const row = (await publicClient.readContract({
      address: addresses.portal, abi: hoodPortalAbi, functionName: "getLaunch", args: [token],
    })) as Record<string, unknown>;
    return {
      token: row.token as Address,
      quote: row.quote as Address,
      hook: row.hook as Address,
      splitter: row.splitter as Address,
      locker: row.locker as Address,
      creator: row.creator as Address,
      positionId: row.positionId as bigint,
      launchedAt: Number(row.launchedAt),
      restrictionsEndBlock: row.restrictionsEndBlock as bigint,
      exists: Boolean(row.exists),
    };
  }

  /// What a trade pays right now, and how much of that is the snipe surcharge still burning off.
  async function taxes(hook: Address) {
    const [buy, sell, snipe, bonded, baseBuy, baseSell] = await publicClient.multicall({
      allowFailure: false,
      contracts: [
        { address: hook, abi: hoodLaunchHookAbi, functionName: "currentTaxBps", args: [true] },
        { address: hook, abi: hoodLaunchHookAbi, functionName: "currentTaxBps", args: [false] },
        { address: hook, abi: hoodLaunchHookAbi, functionName: "currentSnipeBps" },
        { address: hook, abi: hoodLaunchHookAbi, functionName: "bonded" },
        { address: hook, abi: hoodLaunchHookAbi, functionName: "buyTaxBps" },
        { address: hook, abi: hoodLaunchHookAbi, functionName: "sellTaxBps" },
      ] as never,
    }) as unknown as [bigint, bigint, bigint, boolean, number, number];
    return {
      buyBps: Number(buy), sellBps: Number(sell), snipeBps: Number(snipe), bonded,
      baseBuyBps: Number(baseBuy), baseSellBps: Number(baseSell),
    };
  }

  async function buckets(splitter: Address) {
    const [creator, buyback, liquidity, dividends, allocations] = await publicClient.multicall({
      allowFailure: false,
      contracts: [
        { address: splitter, abi: hoodRevenueSplitterAbi, functionName: "creatorClaimable" },
        { address: splitter, abi: hoodRevenueSplitterAbi, functionName: "buybackPot" },
        { address: splitter, abi: hoodRevenueSplitterAbi, functionName: "liquidityPot" },
        { address: splitter, abi: hoodRevenueSplitterAbi, functionName: "dividendsHeld" },
        { address: splitter, abi: hoodRevenueSplitterAbi, functionName: "allocations" },
      ] as never,
    }) as unknown as [bigint, bigint, bigint, bigint, readonly number[]];
    return {
      creatorClaimable: creator, buybackPot: buyback, liquidityPot: liquidity, dividendsHeld: dividends,
      allocations: {
        creatorBps: Number(allocations[0]), buybackBps: Number(allocations[1]),
        dividendsBps: Number(allocations[2]), liquidityBps: Number(allocations[3]),
      },
    };
  }

  /// What `sweep()` would divide right now: the splitter's balance minus what it already booked.
  async function unaccounted(splitter: Address, quote: Address): Promise<bigint> {
    const [balance, accounted] = await Promise.all([
      quote === zeroAddress
        ? publicClient.getBalance({ address: splitter })
        : (publicClient.readContract({
            address: quote,
            abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }],
            functionName: "balanceOf", args: [splitter],
          }) as Promise<bigint>),
      publicClient.readContract({ address: splitter, abi: hoodRevenueSplitterAbi, functionName: "accounted" }) as Promise<bigint>,
    ]);
    return balance > accounted ? balance - accounted : 0n;
  }

  const pendingDividends = (splitter: Address, account: Address) =>
    publicClient.readContract({
      address: splitter, abi: hoodRevenueSplitterAbi, functionName: "pendingDividends", args: [account],
    }) as Promise<bigint>;

  /// Reads the on-chain metadata the way Pons publishes it, so an explorer needs no backend.
  async function metadata(token: Address) {
    const [logo, description, socials, pool] = await publicClient.multicall({
      allowFailure: false,
      contracts: [
        { address: token, abi: hoodLaunchTokenAbi, functionName: "logo" },
        { address: token, abi: hoodLaunchTokenAbi, functionName: "description" },
        { address: token, abi: hoodLaunchTokenAbi, functionName: "socials" },
        { address: token, abi: hoodLaunchTokenAbi, functionName: "liquidityPool" },
      ] as never,
    }) as unknown as [string, string, Record<string, string>, Address];
    return { logo, description, socials, pool };
  }

  // writes, all of them permissionless except the creator's own claim
  const claimDividends = (splitter: Address, account: Address) =>
    write(splitter, hoodRevenueSplitterAbi, "claimDividends", [account]);
  const claimCreator = (splitter: Address, to: Address) =>
    write(splitter, hoodRevenueSplitterAbi, "claim", [to]);
  const pushLiquidity = (splitter: Address) => write(splitter, hoodRevenueSplitterAbi, "pushLiquidity", []);
  const sweep = (splitter: Address) => write(splitter, hoodRevenueSplitterAbi, "sweep", []);
  const harvest = (locker: Address) => write(locker, hoodLockerAbi, "harvestFees", []);
  /// Buy-side tax waits as an ERC-6909 claim until the next swap; this sends it on now.
  const flushClaims = (hook: Address) => write(hook, hoodLaunchHookAbi, "flushClaims", []);
  const claimsHeld = (hook: Address) =>
    publicClient.readContract({ address: hook, abi: hoodLaunchHookAbi, functionName: "claimsHeld" }) as Promise<bigint>;
  const deepen = (locker: Address) => write(locker, hoodLockerAbi, "deepen", []);
  /// A donation is credited to whatever is in range, so the locker refuses to send one while a
  /// stranger's position is standing there. Ask before spending the gas.
  const canDeepen = (locker: Address) =>
    publicClient.readContract({ address: locker, abi: hoodLockerAbi, functionName: "canDeepen" }) as Promise<boolean>;

  /// What a run would burn right now, by running it in a call. Zero when there is nothing to spend.
  const quoteBuyback = (token: Address) =>
    quoteBuybackRun({ publicClient, buybackModule: addresses.buybackModule, token });
  /// Without a floor of the caller's, the run is quoted first and sent one percent under it. A
  /// floor of zero is never sent from here.
  const runBuyback = async (token: Address, minTokensOut?: bigint) => {
    let floor = minTokensOut;
    if (floor === undefined) {
      const expected = await quoteBuyback(token);
      if (expected === 0n) throw new Error("the buyback would buy nothing right now");
      floor = minOutFromQuote(expected, 100);
    }
    return write(addresses.buybackModule, hoodBuybackModuleAbi, "run", [token, floor]);
  };

  /// The protocol's tenth is booked by `sweep` and pushed by nobody: somebody has to pull it.
  const protocolClaimable = (splitter: Address) =>
    publicClient.readContract({ address: splitter, abi: hoodRevenueSplitterAbi, functionName: "protocolClaimable" }) as Promise<bigint>;
  const claimProtocol = (splitter: Address) => write(splitter, hoodRevenueSplitterAbi, "claimProtocol", []);

  // ---------------------------------------------------------------- trading the pool

  /// The pool a launch trades on, as its locker holds it: the same key the router is given.
  async function poolKey(locker: Address): Promise<PoolKey> {
    const k = await publicClient.readContract({ address: locker, abi: hoodLockerAbi, functionName: "poolKey" });
    return { currency0: k.currency0, currency1: k.currency1, fee: Number(k.fee), tickSpacing: Number(k.tickSpacing), hooks: k.hooks };
  }

  /// What a buy or a sell returns this second, tax and pool fee taken, and the floor to send with
  /// it. The number is the chain's own quoter running the swap, hook and all.
  async function quote({ token, side, amountIn, slippageBps = 100 }: DirectSwapInput) {
    const launch = await getLaunch(token);
    if (!launch.exists) throw new Error("not a direct launch");
    const key = await poolKey(launch.locker);
    const tokenIn = side === "buy" ? launch.quote : token;
    const tokenOut = side === "buy" ? token : launch.quote;
    const q = await quoteDirectSwap({ publicClient, poolKey: key, tokenIn, amountIn });
    return { ...q, key, tokenIn, tokenOut, minAmountOut: minOutFromQuote(q.amountOut, slippageBps) };
  }

  /// The router never pulls an ERC-20 itself: it asks Permit2 to. So the token has to be approved
  /// to Permit2, and Permit2 told the router may spend it. Both once, both only when missing.
  async function ensureRouterAllowance(token: Address, amount: bigint) {
    const owner = account().address;
    const router = uniswapV4.universalRouter as Address;
    const permit2 = uniswapV4.permit2 as Address;
    const toPermit2 = await publicClient.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner, permit2] });
    if (toPermit2 < amount) {
      const h = await write(token, erc20Abi, "approve", [permit2, maxUint256]);
      await publicClient.waitForTransactionReceipt({ hash: h });
    }
    const [allowed, expiry] = await publicClient.readContract({
      address: permit2, abi: permit2Abi, functionName: "allowance", args: [owner, token, router],
    });
    if (allowed < amount || Number(expiry) <= Math.floor(Date.now() / 1000)) {
      const h = await write(permit2, permit2Abi, "approve", [token, router, MAX_UINT160, Number(MAX_UINT48)]);
      await publicClient.waitForTransactionReceipt({ hash: h });
    }
  }

  /// Trades a launch's pool through the UniversalRouter, the floor from a fresh quote. Paying in
  /// the chain's own currency needs no approval; an ERC-20 on the way in goes through Permit2.
  async function swap(input: DirectSwapInput) {
    const q = await quote(input);
    if (q.amountOut === 0n) throw new Error("the pool quotes nothing for this trade");
    const native = q.tokenIn.toLowerCase() === zeroAddress;
    if (!native) await ensureRouterAllowance(q.tokenIn, input.amountIn);
    const { commands, inputs } = buildSwap({
      key: q.key, zeroForOne: q.zeroForOne, amountIn: input.amountIn, minAmountOut: q.minAmountOut,
      tokenIn: q.tokenIn, tokenOut: q.tokenOut,
    });
    // The deadline is compared against the block's clock, not this machine's. Taking it from
    // Date.now() means any host running more than ten minutes behind the chain, and any fork that
    // has been warped forward, fails every swap with TransactionDeadlinePassed before the pool is
    // ever touched. Ask the chain what time it is.
    const latest = await publicClient.getBlock();
    const request = {
      address: uniswapV4.universalRouter as Address,
      abi: universalRouterAbi,
      functionName: "execute" as const,
      args: [commands, inputs, latest.timestamp + BigInt(input.deadlineSeconds ?? 600)] as const,
      value: native ? input.amountIn : 0n,
      account: account(),
    };
    // The opening surcharge decays between the estimate and the block that executes the swap,
    // and the hook's gas moves with it. A third more keeps the swap from dying in its bookkeeping.
    const gas = await publicClient.estimateContractGas(request);
    const hash: Hash = await walletClient!.writeContract({ ...request, gas: (gas * 13n) / 10n } as never);
    return { hash, amountOut: q.amountOut, minAmountOut: q.minAmountOut };
  }

  return {
    addresses, hookSalt, launchFee, launch, getLaunch, graduationStatus, taxes, buckets, pendingDividends, metadata, unaccounted,
    claimDividends, claimCreator, pushLiquidity, sweep, harvest, deepen, canDeepen, runBuyback, flushClaims, claimsHeld,
    quoteBuyback, protocolClaimable, claimProtocol, poolKey, quote, swap,
  };
}

export type DirectClient = ReturnType<typeof createDirectClient>;

/// Where a direct launch's token will land, before it exists.
///
/// The whole supply opens as one position on one side of the price, and which side depends on
/// whether the token address sorts under the quote's or over it. That is decided by an address
/// nobody has yet, so the app has to work it out the way the portal will: a deterministic clone of
/// the token implementation, salted with the creator and their own salt.
export function predictDirectToken(
  { deployer, implementation, creator, salt }:
  { deployer: Address; implementation: Address; creator: Address; salt: `0x${string}` },
): Address {
  const bound = keccak256(encodeAbiParameters(parseAbiParameters("address, bytes32"), [creator, salt]));
  // EIP-1167: the minimal proxy's creation code, hashed, is what CREATE2 commits to.
  const initCode = concatHex([
    "0x3d602d80600a3d3981f3363d3d373d3d3d363d73",
    implementation.toLowerCase() as `0x${string}`,
    "0x5af43d82803e903d91602b57fd5bf3",
  ]);
  const hash = keccak256(concatHex(["0xff", deployer, bound, keccak256(initCode)]));
  return getAddress(`0x${hash.slice(26)}`);
}

export interface DirectTicks {
  tickStart: int24Like;
  tickBond: int24Like;
}
type int24Like = number;

/// The two ticks a direct launch opens and bonds at, from the two valuations a creator thinks in.
///
/// A pool's price is token1 per token0 in RAW units, so three things decide the number: how many
/// decimals the quote has, how many the token has, and which of the two sorted into currency0. Get
/// any of them wrong and the launch opens at a valuation nobody chose, which is why this is one
/// function with one test rather than a line in a form.
export function directTicks(
  { openFdv, bondFdv, supply, quoteDecimals, tokenIsZero, tickSpacing, tokenDecimals = 18 }: {
    /// What the whole supply is worth at the open, in whole quote units (5,000 dollars, 2 ETH).
    openFdv: number;
    bondFdv: number;
    /// Whole tokens minted.
    supply: number;
    quoteDecimals: number;
    tokenIsZero: boolean;
    tickSpacing: number;
    tokenDecimals?: number;
  },
): DirectTicks {
  const raw = (fdv: number) => {
    // tokens per quote, in raw units: (supply * 10^td) / (fdv * 10^qd)
    const tokensPerQuote = (supply * 10 ** tokenDecimals) / (fdv * 10 ** quoteDecimals);
    // token1 per token0: if the token is currency0 the pool quotes the other way round
    return tokenIsZero ? 1 / tokensPerQuote : tokensPerQuote;
  };
  const toTick = (price: number) => {
    const tick = Math.log(price) / Math.log(1.0001);
    return Math.round(tick / tickSpacing) * tickSpacing;
  };
  return { tickStart: toTick(raw(openFdv)), tickBond: toTick(raw(bondFdv)) };
}
