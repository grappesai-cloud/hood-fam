import { defineChain } from "viem";

/// Robinhood Chain. Arbitrum Orbit, settles on Ethereum, 100ms blocks, ETH for gas.
export const robinhood = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: {
    default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" },
  },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

/// Uniswap v4 and friends, as deployed on 4663. The UniversalRouter here is a Robinhood FORK with
/// an extra `minHopPriceX36` field in every swap struct; do not swap it for the canonical one.
export const uniswapV4 = {
  poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
  positionManager: "0x58daec3116aae6D93017bAAea7749052E8a04fA7",
  universalRouter: "0x8876789976dEcBfCbBbe364623C63652db8C0904",
  stateView: "0xF3334192D15450CdD385c8B70e03f9A6bD9E673b",
  quoter: "0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94",
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
} as const;

/// LayerZero V2 on 4663. NOTE: the endpoint is NOT at the canonical 0x1a44... address here.
export const layerZero = {
  endpoint: "0x6F475642a6e85809B1c36Fa62763669b1b48DD5B",
  eid: 30416,
  sendUln302: "0xC39161c743D0307EB9BCc9FEF03eeb9Dc4802de7",
  receiveUln302: "0xE1844c5D63a9543023008D332Bd3d2e6f1FE1043",
  executor: "0x4208D6E27538189bB48E603D6123A94b8Abe0A0b",
  dvns: {
    layerZeroLabs: "0xd01ae6905d48315f7bE10C7330aeCF8360Ef5b12",
    nethermind: "0x0Ffe02DF012299A370D5dd69298A5826EAcaFdF8",
    horizen: "0x1258a278519C7f4bD997a9C3bFD4aA802a028d89",
  },
} as const;

/// Routes that are open from 4663, verified on chain (the endpoint returns a default send library
/// for each of these). A route still needs its peer and its DVN config before it can carry a token.
export const routes = {
  ethereum: { eid: 30101, chainId: 1, name: "Ethereum" },
  arbitrum: { eid: 30110, chainId: 42161, name: "Arbitrum" },
  base: { eid: 30184, chainId: 8453, name: "Base" },
  bnb: { eid: 30102, chainId: 56, name: "BNB Chain" },
  optimism: { eid: 30111, chainId: 10, name: "Optimism" },
  polygon: { eid: 30109, chainId: 137, name: "Polygon" },
  scroll: { eid: 30214, chainId: 534352, name: "Scroll" },
} as const;

export type RouteName = keyof typeof routes;

/// The DVN the 4663 endpoint carries as its DEFAULT for every destination. It is a stub: asking it
/// for a price reverts with "Please set your OApp's DVNs and/or Executor". This is the whole reason
/// `HoodBridgeFactory.configureRoute` exists, and why a peer on its own is not a route.
export const homeDefaultDvnStub = "0x6788f52439ACA6BFF597d3eeC2DC9a44B8FEE842" as const;

/// What LayerZero has on each destination chain FOR eid 30416, read off each chain on 2026-09-17.
/// Every one of the seven is registered: `isSupportedEid(30416)` is true and both libraries resolve.
///
/// `defaultDvn` is the one the chain would use if a token set nothing, and on every chain it is the
/// same kind of stub as `homeDefaultDvnStub`: `getFee(30416, ...)` reverts. `lzLabsDvn` is the one
/// that answers with a price, so it is the one a remote has to name in its own config.
///
/// `defaultConfirmations` is that chain's default for eid 30416, kept here as a reference point, NOT
/// as the number to use: `HoodBridgeFactory.configureRoute` writes one config for both directions,
/// so a route has a single confirmations number and both ends must use it (a receiving side that
/// asks for more than the sender attested with never verifies the packet).
export const destinationLayerZero = {
  ethereum: {
    endpoint: "0x1a44076050125825900e736c501f859c50fE728c",
    sendUln302: "0xbB2Ea70C9E858123480642Cf96acbcCE1372dCe1",
    receiveUln302: "0xc02Ab410f0734EFa3F14628780e6e695156024C2",
    executor: "0x173272739Bd7Aa6e4e214714048a9fE699453059",
    defaultDvn: "0x747C741496a507E4B404b50463e691A8d692f6Ac",
    lzLabsDvn: "0x589dEDbD617e0CBcB916A9223F4d1300c294236b",
    defaultConfirmations: 15,
  },
  arbitrum: {
    endpoint: "0x1a44076050125825900e736c501f859c50fE728c",
    sendUln302: "0x975bcD720be66659e3EB3C0e4F1866a3020E493A",
    receiveUln302: "0x7B9E184e07a6EE1aC23eAe0fe8D6Be2f663f05e6",
    executor: "0x31CAe3B7fB82d847621859fb1585353c5720660D",
    defaultDvn: "0x758C419533ad64Ce9D3413BC8d3A97B026098EC1",
    lzLabsDvn: "0x2f55C492897526677C5B68fb199ea31E2c126416",
    defaultConfirmations: 20,
  },
  base: {
    endpoint: "0x1a44076050125825900e736c501f859c50fE728c",
    sendUln302: "0xB5320B0B3a13cC860893E2Bd79FCd7e13484Dda2",
    receiveUln302: "0xc70AB6f32772f59fBfc23889Caf4Ba3376C84bAf",
    executor: "0x2CCA08ae69E0C44b18a57Ab2A87644234dAebaE4",
    defaultDvn: "0x6498b0632f3834D7647367334838111c8C889703",
    lzLabsDvn: "0x9e059a54699a285714207b43B055483E78FAac25",
    defaultConfirmations: 10,
  },
  bnb: {
    endpoint: "0x1a44076050125825900e736c501f859c50fE728c",
    sendUln302: "0x9F8C645f2D0b2159767Bd6E0839DE4BE49e823DE",
    receiveUln302: "0xB217266c3A98C8B2709Ee26836C98cf12f6cCEC1",
    executor: "0x3ebD570ed38B1b3b4BC886999fcF507e9D584859",
    defaultDvn: "0xe9b5E4f9395a60799F4F608Ba3ABebDfC0ee6D9C",
    lzLabsDvn: "0xfD6865c841c2d64565562fCc7e05e619A30615f0",
    defaultConfirmations: 20,
  },
  optimism: {
    endpoint: "0x1a44076050125825900e736c501f859c50fE728c",
    sendUln302: "0x1322871e4ab09Bc7f5717189434f97bBD9546e95",
    receiveUln302: "0x3c4962Ff6258dcfCafD23a814237B7d6Eb712063",
    executor: "0x2D2ea0697bdbede3F01553D2Ae4B8d0c486B666e",
    defaultDvn: "0xEbc3065003e67CaaC747836dA272d9E5271A37e1",
    lzLabsDvn: "0x6A02D83e8d433304bba74EF1c427913958187142",
    defaultConfirmations: 20,
  },
  polygon: {
    endpoint: "0x1a44076050125825900e736c501f859c50fE728c",
    sendUln302: "0x6c26c61a97006888ea9E4FA36584c7df57Cd9dA3",
    receiveUln302: "0x1322871e4ab09Bc7f5717189434f97bBD9546e95",
    executor: "0xCd3F213AD101472e1713C72B1697E727C803885b",
    defaultDvn: "0x43CFcc293CdF99F7D021F21FfD443f174AB0e843",
    lzLabsDvn: "0x23DE2FE932d9043291f870324B74F820e11dc81A",
    defaultConfirmations: 120,
  },
  scroll: {
    endpoint: "0x1a44076050125825900e736c501f859c50fE728c",
    sendUln302: "0x9BbEb2B2184B9313Cf5ed4a4DDFEa2ef62a2a03B",
    receiveUln302: "0x8363302080e711E0CAb978C081b9e69308d49808",
    executor: "0x581b26F362AD383f7B51eF8A165Efa13DDe398a4",
    defaultDvn: "0xDB238D5196328b5623612C235062427F2F6792c0",
    lzLabsDvn: "0xbe0d08a85EeBFCC6eDA0A843521f7CBB1180D2e2",
    defaultConfirmations: 20,
  },
} as const satisfies Record<RouteName, {
  endpoint: string;
  sendUln302: string;
  receiveUln302: string;
  executor: string;
  defaultDvn: string;
  lzLabsDvn: string;
  defaultConfirmations: number;
}>;

/// Pair assets a launch can be priced in.
export const pairs = {
  eth: { address: "0x0000000000000000000000000000000000000000", symbol: "ETH", decimals: 18 },
  usdg: { address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", symbol: "USDG", decimals: 6 },
} as const;

/// Filled in by the deployment. Override per environment through `createHoodClient`.
export interface HoodAddresses {
  factory: `0x${string}`;
  feeRouter: `0x${string}`;
  staking: `0x${string}`;
  graduator: `0x${string}`;
  bridgeFactory?: `0x${string}`;
}

export function addressesFromEnv(env: Record<string, string | undefined> = process.env): HoodAddresses {
  const need = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`missing ${k}`);
    return v as `0x${string}`;
  };
  return {
    factory: need("HOOD_FACTORY"),
    feeRouter: need("HOOD_FEE_ROUTER"),
    staking: need("HOOD_STAKING"),
    graduator: need("HOOD_GRADUATOR"),
    bridgeFactory: env.HOOD_BRIDGE_FACTORY as `0x${string}` | undefined,
  };
}

/// What a launch can trade against on 4663, and therefore what its creator is paid in.
///
/// The chain's own currency, the dollar, and the tokenised shares that have real liquidity here.
/// Kept in the SDK because three different programs need the same answer to "how many decimals is
/// this pair, and what is it called": the app, the indexer and the MCP server. The factory's allow
/// list is the authority on which of them may be used; this is only the names and the scales.
export interface PairAsset {
  address: `0x${string}`;
  symbol: string;
  decimals: number;
  /// A share of a company rather than a currency. The app says so, because a creator choosing to
  /// be paid in NVDA is choosing something with a market that closes.
  share?: true;
}

export const PAIR_ASSETS: PairAsset[] = [
  { address: "0x0000000000000000000000000000000000000000", symbol: "ETH", decimals: 18 },
  { address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", symbol: "USDG", decimals: 6 },
  { address: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", symbol: "NVDA", decimals: 18, share: true },
  { address: "0x1b0E319c6A659F002271B69dB8A7df2F911c153E", symbol: "GME", decimals: 18, share: true },
  { address: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C", symbol: "SPY", decimals: 18, share: true },
  { address: "0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa", symbol: "SPCX", decimals: 18, share: true },
  { address: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9", symbol: "AAPL", decimals: 18, share: true },
  { address: "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35", symbol: "META", decimals: 18, share: true },
  { address: "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3", symbol: "GOOGL", decimals: 18, share: true },
  { address: "0xc72b96e0E48ecd4DC75E1e45396e26300BC39681", symbol: "INTC", decimals: 18, share: true },
];

const byAddress = new Map(PAIR_ASSETS.map((p) => [p.address.toLowerCase(), p]));

export function pairAsset(address?: string): PairAsset | undefined {
  return address ? byAddress.get(address.toLowerCase()) : undefined;
}
