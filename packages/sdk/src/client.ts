import {
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
  type WalletClient,
  keccak256,
  toHex,
  zeroAddress,
  encodeFunctionData,
} from "viem";

import {
  hoodFactoryAbi,
  hoodCurveAbi,
  hoodCurveRouterAbi,
  hoodTokenAbi,
  hoodFeeRouterAbi,
  hoodStakingAbi,
  uniswapV4GraduatorAbi,
  hoodBridgeFactoryAbi,
  hoodOFTAdapterAbi,
} from "./abi.generated.js";
import { type HoodAddresses, layerZero, routes, type RouteName } from "./chains.js";
import {
  type CurveConfig,
  type CurveState,
  type FeeSplit,
  type Launch,
  type LaunchParamsInput,
  type StakePosition,
  launchParamsSchema,
  phaseFromIndex,
} from "./types.js";

const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

export interface HoodClientOptions {
  publicClient: PublicClient;
  walletClient?: WalletClient;
  addresses: HoodAddresses;
}

const WAD = 10n ** 18n;

export function createHoodClient({ publicClient, walletClient, addresses }: HoodClientOptions) {
  const account = () => {
    const a = walletClient?.account;
    if (!a) throw new Error("this call needs a wallet: pass walletClient to createHoodClient");
    return a;
  };
  const chain = () => walletClient?.chain ?? publicClient.chain;

  async function write(
    to: Address,
    abi: readonly unknown[],
    functionName: string,
    args: readonly unknown[],
    value?: bigint,
  ): Promise<Hash> {
    const { request } = await publicClient.simulateContract({
      address: to,
      abi: abi as never,
      functionName,
      args: args as never,
      value,
      account: account(),
    });
    return walletClient!.writeContract(request as never);
  }

  // ------------------------------------------------------------------ reads

  async function configCount(): Promise<number> {
    const n = await publicClient.readContract({
      address: addresses.factory,
      abi: hoodFactoryAbi,
      functionName: "configCount",
    });
    return Number(n);
  }

  async function getConfig(configId: number | bigint): Promise<CurveConfig> {
    const c = (await publicClient.readContract({
      address: addresses.factory,
      abi: hoodFactoryAbi,
      functionName: "getConfig",
      args: [BigInt(configId)],
    })) as CurveConfig;
    return c;
  }

  async function listConfigs(): Promise<(CurveConfig & { configId: number })[]> {
    const n = await configCount();
    const out: (CurveConfig & { configId: number })[] = [];
    for (let i = 0; i < n; i++) out.push({ ...(await getConfig(i)), configId: i });
    return out;
  }

  async function getLaunch(token: Address): Promise<Launch> {
    const l = (await publicClient.readContract({
      address: addresses.factory,
      abi: hoodFactoryAbi,
      functionName: "getLaunch",
      args: [token],
    })) as Record<string, unknown>;
    return {
      curve: l.curve as Address,
      creator: l.creator as Address,
      creatorFeeRecipient: l.creatorFeeRecipient as Address,
      pairToken: l.pairToken as Address,
      configId: l.configId as bigint,
      feeSplit: l.feeSplit as FeeSplit,
      firstBuyLocked: (l.firstBuyLocked ?? 0n) as bigint,
      firstBuyUnlockAt: Number(l.firstBuyUnlockAt ?? 0),
      symbolHash: l.symbolHash as `0x${string}`,
      imageHash: l.imageHash as `0x${string}`,
      launchedAt: Number(l.launchedAt),
      exists: Boolean(l.exists),
    };
  }

  /// Everything about one market in a single multicall.
  async function getCurveState(curve: Address): Promise<CurveState> {
    const call = (functionName: string) => ({ address: curve, abi: hoodCurveAbi, functionName }) as const;
    const results = await publicClient.multicall({
      allowFailure: false,
      contracts: [
        call("token"), call("pairToken"), call("phase"), call("sold"), call("reserve"), call("bonus"),
        call("curveSupply"), call("lpSupply"), call("price"), call("p0"), call("p1"),
        call("remaining"), call("raiseTarget"), call("protocolFeeBps"), call("creatorFeeBps"), call("liquidityBps"),
      ] as never,
    });
    const [token, pairToken, phase, sold, reserve, bonus, curveSupply, lpSupply, price, p0, p1,
      remaining, raiseTarget, protocolFeeBps, creatorFeeBps, liquidityBps] = results as unknown as [
      Address, Address, number, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint,
      bigint, bigint, number, number, number,
    ];
    const totalSupply = curveSupply + lpSupply;
    return {
      token, pairToken,
      phase: phaseFromIndex(Number(phase)),
      sold, reserve, bonus, curveSupply, lpSupply, price, p0, p1, remaining, raiseTarget,
      protocolFeeBps: Number(protocolFeeBps),
      creatorFeeBps: Number(creatorFeeBps),
      liquidityBps: Number(liquidityBps),
      progress: curveSupply === 0n ? 0 : Number((sold * 10_000n) / curveSupply) / 10_000,
      marketCap: (price * totalSupply) / WAD,
    };
  }

  async function quoteBuy(curve: Address, pairIn: bigint) {
    const [tokensOut, pairSpent, fee] = (await publicClient.readContract({
      address: curve, abi: hoodCurveAbi, functionName: "quoteBuy", args: [pairIn],
    })) as [bigint, bigint, bigint];
    return { tokensOut, pairSpent, fee };
  }

  async function quoteBuyExactOut(curve: Address, tokensOut: bigint) {
    const [pairIn, fee] = (await publicClient.readContract({
      address: curve, abi: hoodCurveAbi, functionName: "quoteBuyExactOut", args: [tokensOut],
    })) as [bigint, bigint];
    return { pairIn, fee };
  }

  async function quoteSell(curve: Address, tokensIn: bigint) {
    const [pairOut, fee] = (await publicClient.readContract({
      address: curve, abi: hoodCurveAbi, functionName: "quoteSell", args: [tokensIn],
    })) as [bigint, bigint];
    return { pairOut, fee };
  }

  async function previewLaunchEconomics(configId: number | bigint, pairToken: Address) {
    return publicClient.readContract({
      address: addresses.factory, abi: hoodFactoryAbi, functionName: "previewLaunchEconomics",
      args: [BigInt(configId), pairToken],
    }) as Promise<`0x${string}`>;
  }

  async function isSymbolAvailable(symbol: string) {
    return publicClient.readContract({
      address: addresses.factory, abi: hoodFactoryAbi, functionName: "isSymbolAvailable", args: [symbol],
    }) as Promise<boolean>;
  }

  async function creatorFees(token: Address): Promise<bigint> {
    return publicClient.readContract({
      address: addresses.feeRouter, abi: hoodFeeRouterAbi, functionName: "accrued", args: [token],
    }) as Promise<bigint>;
  }

  async function tokenMeta(token: Address) {
    const [name, symbol, totalSupply] = await publicClient.multicall({
      allowFailure: false,
      contracts: [
        { address: token, abi: erc20Abi, functionName: "name" },
        { address: token, abi: erc20Abi, functionName: "symbol" },
        { address: token, abi: erc20Abi, functionName: "totalSupply" },
      ] as never,
    }) as unknown as [string, string, bigint];
    return { name, symbol, totalSupply };
  }

  async function balanceOf(token: Address, who: Address): Promise<bigint> {
    if (token === zeroAddress) return publicClient.getBalance({ address: who });
    return publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] }) as Promise<bigint>;
  }

  async function getStakePosition(id: bigint): Promise<StakePosition> {
    const [pos, all, house] = await Promise.all([
      publicClient.readContract({ address: addresses.staking, abi: hoodStakingAbi, functionName: "positions", args: [id] }) as Promise<[Address, bigint, bigint, number]>,
      publicClient.readContract({ address: addresses.staking, abi: hoodStakingAbi, functionName: "pendingAll", args: [id] }) as Promise<[readonly Address[], readonly bigint[]]>,
      houseToken(),
    ]);
    return {
      id,
      token: house,
      owner: pos[0],
      amount: pos[1],
      unlockAt: Number(pos[2]),
      weightBps: Number(pos[3]),
      pending: all[0].map((asset, i) => ({ asset, amount: all[1][i]! })),
    };
  }

  /// The one coin this pad's vault accepts. Zero while the owner has not named it yet, which is
  /// also the only state in which a launch cannot point its fee at stakers.
  async function houseToken(): Promise<Address> {
    return publicClient.readContract({
      address: addresses.staking, abi: hoodStakingAbi, functionName: "houseToken",
    }) as Promise<Address>;
  }

  async function weightFor(lockSeconds: number): Promise<number> {
    const w = await publicClient.readContract({
      address: addresses.staking, abi: hoodStakingAbi, functionName: "weightFor", args: [BigInt(lockSeconds)],
    });
    return Number(w);
  }

  // ------------------------------------------------------------------ writes

  async function launch(input: LaunchParamsInput) {
    const p = launchParamsSchema.parse(input);
    const config = await getConfig(p.configId as number);
    if (!config.enabled) throw new Error(`config ${p.configId} is disabled`);

    const firstBuy = BigInt(p.firstBuy as string | bigint);
    const launchFee = (await publicClient.readContract({
      address: addresses.factory, abi: hoodFactoryAbi, functionName: "launchFee",
    })) as bigint;

    const econ = p.econ ?? (await previewLaunchEconomics(p.configId as number, p.pairToken as Address));
    const salt = p.salt ?? keccak256(toHex(`${p.symbol}:${Date.now()}:${Math.random()}`));
    const isNative = (p.pairToken as Address).toLowerCase() === zeroAddress;

    if (!isNative && firstBuy > 0n) {
      await ensureAllowance(p.pairToken as Address, addresses.factory, firstBuy);
    }

    const args = [{
      name: p.name,
      symbol: p.symbol,
      image: p.image,
      description: p.description,
      website: p.website,
      twitter: p.twitter,
      telegram: p.telegram,
      pairToken: p.pairToken as Address,
      configId: BigInt(p.configId as number),
      feeSplit: p.feeSplit,
      creatorFeeRecipient: (p.creatorFeeRecipient ?? account().address) as Address,
      firstBuy,
      firstBuyLock: BigInt(p.firstBuyLock ?? 0),
      salt,
      econ,
    }];

    const value = isNative ? launchFee + firstBuy : launchFee;
    const hash = await write(addresses.factory, hoodFactoryAbi, "launch", args, value);
    return { hash, salt, econ, launchFee, value };
  }

  /// Permissionless custom quote launch. The curve's caps are expressed in the quote token's own
  /// smallest units; the factory reads and validates its decimals and records this config forever.
  async function launchCustom(input: LaunchParamsInput, config: CurveConfig) {
    const p = launchParamsSchema.parse(input);
    const pairToken = p.pairToken as Address;
    if (pairToken.toLowerCase() === zeroAddress) throw new Error("custom quote must be an ERC-20");
    if (config.pairToken.toLowerCase() !== pairToken.toLowerCase()) throw new Error("config quote does not match launch quote");

    const firstBuy = BigInt(p.firstBuy as string | bigint);
    const launchFee = (await publicClient.readContract({
      address: addresses.factory, abi: hoodFactoryAbi, functionName: "launchFee",
    })) as bigint;
    if (firstBuy > 0n) await ensureAllowance(pairToken, addresses.factory, firstBuy);
    const salt = p.salt ?? keccak256(toHex(`${p.symbol}:${Date.now()}:${Math.random()}`));
    const launchParams = {
      name: p.name, symbol: p.symbol, image: p.image, description: p.description,
      website: p.website, twitter: p.twitter, telegram: p.telegram,
      pairToken, configId: 0n, feeSplit: p.feeSplit,
      creatorFeeRecipient: (p.creatorFeeRecipient ?? account().address) as Address,
      firstBuy, firstBuyLock: BigInt(p.firstBuyLock ?? 0), salt,
      econ: `0x${"0".repeat(64)}` as Hex,
    };
    const hash = await write(addresses.factory, hoodFactoryAbi, "launchCustom", [launchParams, { ...config, enabled: true }], launchFee);
    return { hash, salt, launchFee, value: launchFee };
  }

  /// Executes a one- or multi-hop UniversalRouter route with native ETH, then spends the exact quote
  /// output on the selected curve. Both legs revert together when either slippage floor is missed.
  async function buyWithNativeRoute(params: {
    curve: Address;
    nativeIn: bigint;
    minQuoteOut: bigint;
    minTokensOut: bigint;
    commands: Hex;
    inputs: Hex[];
    deadline: bigint;
    to?: Address;
  }) {
    if (!addresses.curveRouter) throw new Error("HOOD_CURVE_ROUTER is not configured");
    return write(addresses.curveRouter, hoodCurveRouterAbi, "buyWithNative", [
      params.curve, params.minQuoteOut, params.minTokensOut, params.to ?? account().address,
      params.commands, params.inputs, params.deadline,
    ], params.nativeIn);
  }

  /// Executes complete UniversalRouter calldata returned by a route builder, then buys the curve.
  async function buyWithNativeCalldata(params: {
    curve: Address;
    nativeIn: bigint;
    minQuoteOut: bigint;
    minTokensOut: bigint;
    routerCalldata: Hex;
    to?: Address;
  }) {
    if (!addresses.curveRouter) throw new Error("HOOD_CURVE_ROUTER is not configured");
    return write(addresses.curveRouter, hoodCurveRouterAbi, "buyWithNativeCalldata", [
      params.curve, params.minQuoteOut, params.minTokensOut, params.to ?? account().address,
      params.routerCalldata,
    ], params.nativeIn);
  }

  /// Reads the token and curve address out of the launch receipt.
  async function launchResult(hash: Hash) {
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const log = receipt.logs.find((l) => l.address.toLowerCase() === addresses.factory.toLowerCase() && l.topics.length >= 4);
    if (!log) throw new Error("no Launched event in the receipt");
    const token = `0x${log.topics[1]!.slice(26)}` as Address;
    const curve = `0x${log.topics[2]!.slice(26)}` as Address;
    return { token, curve, receipt };
  }

  async function ensureAllowance(token: Address, spender: Address, amount: bigint) {
    if (token === zeroAddress) return;
    const current = (await publicClient.readContract({
      address: token, abi: erc20Abi, functionName: "allowance", args: [account().address, spender],
    })) as bigint;
    if (current >= amount) return;
    const hash = await write(token, erc20Abi, "approve", [spender, amount]);
    await publicClient.waitForTransactionReceipt({ hash });
  }

  async function buy(curve: Address, pairIn: bigint, opts: { minTokensOut?: bigint; to?: Address } = {}) {
    const state = await getCurveState(curve);
    const isNative = state.pairToken === zeroAddress;
    if (!isNative) await ensureAllowance(state.pairToken, curve, pairIn);
    const to = opts.to ?? account().address;
    return write(curve, hoodCurveAbi, "buy", [pairIn, opts.minTokensOut ?? 0n, to], isNative ? pairIn : undefined);
  }

  async function buyExactOut(curve: Address, tokensOut: bigint, maxPairIn: bigint, to?: Address) {
    const state = await getCurveState(curve);
    const isNative = state.pairToken === zeroAddress;
    if (!isNative) await ensureAllowance(state.pairToken, curve, maxPairIn);
    return write(curve, hoodCurveAbi, "buyExactOut", [tokensOut, maxPairIn, to ?? account().address], isNative ? maxPairIn : undefined);
  }

  async function sell(curve: Address, tokensIn: bigint, opts: { minPairOut?: bigint; to?: Address } = {}) {
    const state = await getCurveState(curve);
    await ensureAllowance(state.token, curve, tokensIn);
    return write(curve, hoodCurveAbi, "sell", [tokensIn, opts.minPairOut ?? 0n, opts.to ?? account().address]);
  }

  async function donate(curve: Address, amount: bigint) {
    const state = await getCurveState(curve);
    const isNative = state.pairToken === zeroAddress;
    if (!isNative) await ensureAllowance(state.pairToken, curve, amount);
    return write(curve, hoodCurveAbi, "donate", [amount], isNative ? amount : undefined);
  }

  /// Permissionless: opens the pool for a curve that sold out.
  const finalize = (curve: Address) => write(curve, hoodCurveAbi, "finalize", []);

  /// Permissionless: pays a curve's booked protocol legs out to the treasury it was launched with.
  /// The curve books them rather than pushing them, so that a treasury which cannot take a transfer
  /// can never stop a trade.
  const claimProtocol = (curve: Address) => write(curve, hoodCurveAbi, "claimProtocol", []);
  const protocolClaimable = (curve: Address) =>
    publicClient.readContract({ address: curve, abi: hoodCurveAbi, functionName: "protocolClaimable" }) as Promise<bigint>;

  /// What a buy of `pairIn` would return on the curve right now, for the floor on a buyback.
  const quoteCurveBuy = (curve: Address, pairIn: bigint) =>
    publicClient.readContract({
      address: curve, abi: hoodCurveAbi, functionName: "quoteBuy", args: [pairIn],
    }) as Promise<readonly [bigint, bigint, bigint]>;

  /// Locks the house coin. There is only one lockable token on the pad, so this reads it off the
  /// vault rather than taking it as an argument: a caller cannot lock the wrong thing by accident.
  async function stake(amount: bigint, lockSeconds: number, beneficiary?: Address) {
    const token = await houseToken();
    if (token === zeroAddress) throw new Error("the house coin has not been named yet: nothing can be locked");
    await ensureAllowance(token, addresses.staking, amount);
    return beneficiary
      ? write(addresses.staking, hoodStakingAbi, "stakeFor", [beneficiary, amount, BigInt(lockSeconds)])
      : write(addresses.staking, hoodStakingAbi, "stake", [amount, BigInt(lockSeconds)]);
  }

  const claim = (id: bigint) => write(addresses.staking, hoodStakingAbi, "claim", [id]);
  const unstake = (id: bigint) => write(addresses.staking, hoodStakingAbi, "unstake", [id]);
  const demote = (id: bigint) => write(addresses.staking, hoodStakingAbi, "demote", [id]);

  /// Permissionless: pushes a token's booked fees through its model.
  const flush = (token: Address) => write(addresses.feeRouter, hoodFeeRouterAbi, "flush", [token]);
  const flushBuyback = (token: Address, minTokensOut: bigint) =>
    write(addresses.feeRouter, hoodFeeRouterAbi, "flushBuyback", [token, minTokensOut]);
  const collect = (token: Address) => write(addresses.graduator, uniswapV4GraduatorAbi, "collect", [token]);

  const transferCreatorFeeRecipient = (token: Address, to: Address) =>
    write(addresses.factory, hoodFactoryAbi, "transferCreatorFeeRecipient", [token, to]);

  // ------------------------------------------------------------------ omnichain

  function requireBridge(): Address {
    if (!addresses.bridgeFactory) throw new Error("no bridgeFactory address configured");
    return addresses.bridgeFactory;
  }

  async function adapterOf(token: Address): Promise<Address> {
    return publicClient.readContract({
      address: requireBridge(), abi: hoodBridgeFactoryAbi, functionName: "adapterOf", args: [token],
    }) as Promise<Address>;
  }

  /// Permissionless: deploys the lock box so a token can travel.
  const deployAdapter = (token: Address) => write(requireBridge(), hoodBridgeFactoryAbi, "deployAdapter", [token]);

  /// LayerZero V2 type-3 options carrying one executor lzReceive option.
  /// Layout: uint16 type(3) | uint8 worker(1=executor) | uint16 size | uint8 option(1=lzReceive) | uint128 gas
  function lzOptions(gas = 200_000): `0x${string}` {
    const gasHex = BigInt(gas).toString(16).padStart(32, "0");
    return `0x0003` + `01` + `0011` + `01` + gasHex as `0x${string}`;
  }

  async function bridgeQuote(token: Address, route: RouteName, amount: bigint, to?: Address) {
    const adapter = await adapterOf(token);
    if (adapter === zeroAddress) throw new Error("this token has no lock box yet: call deployAdapter first");
    const sendParam = {
      dstEid: routes[route].eid,
      to: `0x${(to ?? account().address).slice(2).padStart(64, "0")}` as `0x${string}`,
      amountLD: amount,
      minAmountLD: amount,
      extraOptions: lzOptions(),
      composeMsg: "0x" as `0x${string}`,
      oftCmd: "0x" as `0x${string}`,
    };
    const fee = (await publicClient.readContract({
      address: adapter, abi: hoodOFTAdapterAbi, functionName: "quoteSend", args: [sendParam, false],
    })) as { nativeFee: bigint; lzTokenFee: bigint };
    return { adapter, sendParam, fee };
  }

  async function bridgeSend(token: Address, route: RouteName, amount: bigint, to?: Address) {
    const { adapter, sendParam, fee } = await bridgeQuote(token, route, amount, to);
    await ensureAllowance(token, adapter, amount);
    return write(adapter, hoodOFTAdapterAbi, "send", [sendParam, fee, account().address], fee.nativeFee);
  }

  /// The routes this deployment can actually carry a token over, with their live state.
  async function supportedRoutes(token?: Address) {
    const adapter = token && addresses.bridgeFactory ? await adapterOf(token) : zeroAddress;
    return Promise.all(
      (Object.keys(routes) as RouteName[]).map(async (name) => {
        const r = routes[name];
        let peer: `0x${string}` = "0x";
        if (adapter !== zeroAddress) {
          peer = (await publicClient.readContract({
            address: adapter, abi: hoodOFTAdapterAbi, functionName: "peers", args: [r.eid],
          })) as `0x${string}`;
        }
        const open = peer !== "0x" && BigInt(peer || "0x0") !== 0n;
        return { ...r, route: name, open };
      }),
    );
  }

  return {
    addresses,
    // the viem clients are deliberately not re-exported here: their inferred types drag viem
    // internals into every consumer's declaration file. Keep your own reference to them.
    // reads
    configCount, getConfig, listConfigs, getLaunch, getCurveState, quoteBuy, quoteBuyExactOut, quoteSell,
    previewLaunchEconomics, isSymbolAvailable, creatorFees, tokenMeta, balanceOf, getStakePosition, weightFor, houseToken,
    // writes
    launch, launchCustom, launchResult, buy, buyExactOut, buyWithNativeRoute, buyWithNativeCalldata, sell, donate, finalize, claimProtocol, protocolClaimable, quoteCurveBuy,
    stake, claim, unstake, demote, flush, flushBuyback, collect, transferCreatorFeeRecipient, ensureAllowance,
    // omnichain
    adapterOf, deployAdapter, bridgeQuote, bridgeSend, supportedRoutes,
    layerZero,
    encodeBuyCall: (curve: Address, pairIn: bigint, minTokensOut: bigint, to: Address) =>
      encodeFunctionData({ abi: hoodCurveAbi, functionName: "buy", args: [pairIn, minTokensOut, to] }),
  };
}

export type HoodClient = ReturnType<typeof createHoodClient>;
