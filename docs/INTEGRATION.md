# Integrating hood.fam

For screeners, bots, wallets and anyone else who wants to follow hood.fam launches from the chain
alone. Everything below can be done from logs plus a handful of `eth_call`s at the head; nothing
needs our API, although the API is there and documented at the end.

Two machines print tokens here. **The curve** sells into a reserve at a rising price and graduates
into a Uniswap v4 pool when it sells out. **The direct machine** puts the whole supply into one
v4 position from block one, with a hook that taxes both sides; it graduates when the price first
crosses a tick fixed at launch. The word for both is *graduated*. In the contracts the direct
machine's latch is still called `bonded`, and the field keeps that name in the ABI and the API;
it means the same thing.

## Network

| | |
|---|---|
| chain id | 4663 (Robinhood Chain, Arbitrum Orbit, settles on Ethereum) |
| RPC | `https://rpc.mainnet.chain.robinhood.com` |
| explorer | `https://robinhoodchain.blockscout.com` (Blockscout, verified source for every contract) |
| gas | ETH, 18 decimals |
| blocks | 100 ms. A day is about 864,000 blocks; start at the deployment block, never at genesis |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` |
| ETH/USD | Chainlink `latestAnswer()` at `0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9`, 8 decimals |

Four things about the public RPC that shape an indexer:

- **`eth_getLogs` ranges are refused above a few thousand blocks.** Walk forward in chunks; our
  indexer asks for 5,000 blocks and halves the chunk whenever a range is refused, then grows it
  back. Filter by `topics[0]` rather than by address, because a per-launch contract (curve, hook,
  splitter) is a new address every launch.
- **Parallel bursts are rate limited.** One request in flight at a time is the shape that works.
- **There is no JSON-RPC batching.** Several questions at once go through Multicall3.
- **Historical state is pruned after about thirty minutes.** An `eth_call` at an older block fails
  with "historical state is not available". Logs and receipts are kept. Read state at the head,
  and derive anything historical from events.

Uniswap v4 on 4663:

| | |
|---|---|
| PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` |
| PositionManager | `0x58daec3116aae6D93017bAAea7749052E8a04fA7` |
| StateView | `0xF3334192D15450CdD385c8B70e03f9A6bD9E673b` |
| Quoter | `0x8dC178EfB8111bB0973dd9d722EBefF267c98F94` |
| UniversalRouter | `0x8876789976dEcBfCbBbe364623C63652db8C0904` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |

The UniversalRouter is a Robinhood fork: every v4 swap struct carries an extra `uint256
minHopPriceX36` between `amountOutMinimum` and `hookData`. Encoding a swap the canonical way puts
the hook data offset where the router expects a price floor and reverts inside the callback with no
message. `apps/web/lib/direct.ts` has the working encoding.

Quote assets a launch can be priced in: ETH as `address(0)`, and USDG at
`0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (6 decimals).

## Contracts

Names are the variables in `.env.example`; addresses are printed by `script/Deploy.s.sol`. The
addresses below are the v4 deployment of 29 September 2026 (first receipt in block 75134585).
Launches printed on the v3 contracts before that day keep running on them, under the v3 rules; the
v3 factory is `0x2b9c1f6667e05b68a5d1ab697710afc97a1949b5` and the v3 portal
`0xf3541ace9098775b812df2ff7acebaeecb5aef9e`.

| variable | contract | address | what it is |
|---|---|---|---|
| `HOOD_FACTORY` | `HoodFactory` | `0x14226252c5C5526c76Ec1370246c77d108dBfb4B` | Prints curve tokens. The registry for both machines (`getLaunch`), the copycat lock, the presets |
| `HOOD_FEE_ROUTER` | `HoodFeeRouter` | `0xd2c0c656d7395248eD7B4F08d64D247Fe0bb63aa` | Books a curve token's creator fee leg and spends it across its split |
| `HOOD_STAKING` | `HoodStaking` | `0xdC5af0613e5f2B5fBcFC2131dc93E6FF4cbB118D` | The Vault: one vault, holding the one coin this pad lets you lock |
| `HOOD_GRADUATOR` | `UniswapV4Graduator` | `0x057180612d111E36075893a9dD816E028662069D` | Opens and holds a graduated curve token's pool; `positionOf(token)` returns the pool key |
| `HOOD_GRADUATION_HOOK` | `HoodGraduationHook` | `0x4ff4F5175c9057E40413068bBE6F4c55D45000cC` | The hook every graduated curve pool trades through: the 1% fee |
| `HOOD_CURVE_ROUTER` | `HoodCurveRouter` | `0xb88dB2C54f8087E521F06321429389B02ba152eD` | One-transaction buys of a curve token with ETH when it trades in another pair |
| `HOOD_BRIDGE_FACTORY` | `HoodBridgeFactory` | `0xdB1Caff9854973959f38bB7096EE1b8Ed6f25902` | LayerZero lock boxes |
| `HOOD_REFERRALS` | `HoodReferrals` | `0x91F7766c60c621940ce8360999Debec8ddA9078b` | The referral registry both machines read |
| `HOOD_PORTAL` | `HoodPortal` | `0x8f9F4221b211549bE2F06a2bAFa05DE089182c77` | Prints direct launches. `getLaunch`, `graduationStatus`, `allLaunches`, `launchCount` |
| `HOOD_DIRECT_DEPLOYER` | `HoodDirectDeployer` | `0xd49EF209d1C1c5AdDD8065A884a7037e3A4fA340` | Bytecode for the hook, splitter and locker; `hookInitCodeHash(poolManager)` for salt mining |
| `HOOD_TOKEN_IMPLEMENTATION` | `HoodLaunchToken` | `0xc2E2d993A45b398981DBfa1064BEC78F74D48F7F` | The EIP-1167 implementation every direct token clones |
| `HOOD_BUYBACK_MODULE` | `HoodBuybackModule` | `0x4ea89c4c8bD249d9958586602Cde6ebc4EA2D94F` | Shared, permissionless swap-and-burn for direct launches |
| `HOOD_BAG` | `HoodBag` | `0x471EE5dA3fD9B9C8B186B7e9DAD72270463e36d3` | The router every platform fee passes through |
| `HOOD_PAYDAY` | `HoodPayday` | `0xA76759C5818cAFa348071027Fc6cD903adA81195` | The hourly distributor |
| `HOOD_BURN_CLOCK` | `HoodBurnClock` | `0xA542876A28d9954e88922785bE70D79B18a8Fc4F` | Buys the house coin once an hour and burns it |
| `HOOD_BOOSTS` | `HoodBoosts` | `0xADE405A64379C5A2A00cE84A4af61bB0b0ec42D0` | Hourly board slots |
| `HOOD_BLOCK_ZERO` | `HoodBlockZero` | `0xeD04C668C53de1EEa4cB5361014C90C731739c0E` | Team launches on the curve |
| `HOOD_START_BLOCK` | | `75134360` | The block the deployment started from. Index from here |

The first-buy locker (`HoodTokenLock`) is `0xDb249D05570B60CF2C923938Ba5def9048AA65E5`, also
readable as `HoodFactory.firstBuyLocker()`.

Per launch, new addresses appear in the launch event:

| machine | contract | where its address is |
|---|---|---|
| curve | `HoodToken` | `Launched.token` |
| curve | `HoodCurve` | `Launched.curve` |
| curve | `HoodPot` | `PotDeployed.pot` (also `getLaunch(token).pot`) |
| direct | `HoodLaunchToken` (clone) | `DirectLaunched.token` |
| direct | `HoodLaunchHook` | `DirectLaunched.hook` (also the `hooks` field of the pool key) |
| direct | `HoodRevenueSplitter` | `DirectLaunched.splitter` |
| direct | `HoodLocker` | `DirectLaunched.locker` |

## Events

Full signatures, with `topic0 = keccak256(signature)`. Indexed parameters are in the topics; the
rest is in `data`.

### HoodFactory (one address)

| event | topic0 |
|---|---|
| `Launched(address indexed token, address indexed curve, address indexed creator, uint256 configId, address pairToken, (uint16,uint16,uint16,uint16) feeSplit)` | `0x4c7632ec99854291dae1ca6df777cec083a6d2a197fc2b63135ec74127127e8c` |
| `LaunchMetadata(address indexed token, string name, string symbol, string image, string description, string website, string twitter, string telegram)` | `0xb223410ec1e948b7f27777ac33d1dcfdce9982e5c988994594be06df0ad1b12a` |
| `FirstBuyLocked(address indexed token, address indexed creator, uint256 positionId, uint256 amount, uint64 unlockAt)` | `0xfcb4d5fb598c462d5c9f2d4671260d3eae55d06300b388541a2cd4d3c6540eed` |
| `PotDeployed(address indexed token, address indexed pot)` | `0x012bac93b4a194686793b205f27d9591947a9f7c47aa524ee81f39326795307c` |
| `LaunchExempt(address indexed token, address[] wallets)` | `0x1ff272d2cecda163fbb0ef7be43fefcf33710a3a9fe309ca3309f01d4606fa61` |

`Launched`, `LaunchMetadata`, `PotDeployed` and `LaunchExempt` fire in the launch transaction, in
that order. `LaunchExempt` lists every wallet that pays no opening tax on this launch: the launcher
first, then the creator fee recipient (the launcher again when none was named), then the wallets the
creator named, at most 32. `feeSplit` is
`(stakersBps, buybackBps, liquidityBps, creatorBps)`, summing to 10,000 and fixed forever: the
share of the creator fee leg that goes to whoever locked the house coin, to buying this token back and burning it,
to deepening its liquidity, and to the fee recipient. A launch whose preset charges no creator fee
never books anything to split, whatever the shares say.

`FirstBuyLocked` fires only when the creator locked their own first buy, in the same transaction,
after the four above. `positionId` is the position in the first-buy locker (`HoodTokenLock`), which
belongs to the creator from that second; `amount` and `unlockAt` are also on the registry row (`getLaunch(token).firstBuyLocked`,
`.firstBuyUnlockAt`, both zero when there was no lock), so an app needs no logs to show the lock.

### HoodCurve (one per curve launch)

| event | topic0 |
|---|---|
| `Bought(address indexed buyer, address indexed to, uint256 pairIn, uint256 tokensOut, uint256 fee)` | `0x7ce543d1780f3bdc3dac42da06c95da802653cd1b212b8d74ec3e3c33ad7095c` |
| `Sold(address indexed seller, address indexed to, uint256 tokensIn, uint256 pairOut, uint256 fee)` | `0x9be8a5ca22b7e6e81f04b5879f0248227bb770114291bd47dfaee4c3a82ad60e` |
| `SoldOut(uint256 reserve)` | `0x7e1f5a77187e90f1751221bbd46ae08322d11774a58ae99cdb7d8573f4140c90` |
| `Graduated(uint256 tokenAmount, uint256 pairAmount, uint256 graduationFee)` | `0x72a089bf72f8bdb633c01144c6cf486e8b100097b06bd326948141b7bd827d88` |
| `Sniped(address indexed buyer, address indexed to, uint256 tax)` | `0x4518e330949435ee94c9c680c689190ccabc1f1129c73985ffdf54c3378f7bbf` |
| `SnipeExempt(address[] wallets)` | `0xa3f0bb01aa276e62ef7cba2b4e0d31e3804bb4a274f62f865f2a52499492f4b4` |
| `ProtocolClaimed(address indexed to, uint256 amount)` | `0x358d22ca92cd63a2c615bbad2e89c55a1609f1c1989572b37c772522400d0403` |

`pairIn` is gross and `fee` is inside it on a buy; `pairOut` is net and `fee` is on top of it on a
sell. `Graduated` fires from `finalize()`, a separate permissionless call after `SoldOut`; the same
transaction carries the graduator's pool opening, the first Uniswap v4 liquidity, and the graduation fee
entering the Bag (a tenth of the raise on every preset: 23% to the creator fee recipient, the rest
to the burn clock).

**The opening tax.** A buy in the first three seconds after the launch pays 9,900, 618 or 19 bps
of what it hands in (seconds 0, 1 and 2; `src/libraries/SnipeSchedule.sol`), then nothing. Sells
never pay it. The tax is trading fee: it is inside `Bought.fee`, and `Sniped` in the same
transaction says how much of that fee it was, with `buyer` the caller and `to` the wallet that got
the tokens. The exemption is keyed on `to`: `currentSnipeTaxBps(recipient)` is the rate a buy for
that wallet pays right now, and `quoteBuyFor(pairIn, to)` and `quoteBuyExactOutFor(tokensOut, to)`
quote it; `quoteBuy` and `quoteBuyExactOut` quote for a wallet that is not exempt. `SnipeExempt`
fires once, from the curve's constructor, so it sits one log before the factory's `Launched`; it
carries the same list as `LaunchExempt`. Buys made inside the launch transaction (the creator's
first buy, a block zero team's legs) never pay it.

`ProtocolClaimed` is the protocol's booked legs leaving for the Bag, from the permissionless
`claimProtocol()`; a `ReferralPaid(address indexed to, uint256 amount)` before it is the referral
cut, when the token has one.

### HoodFeeRouter (one address)

| event | topic0 |
|---|---|
| `Accrued(address indexed token, uint256 amount)` | `0x603f16706d8facbdadddadc2f84737909caebc5d1f3adf53d69014f2d908611c` |
| `Flushed(address indexed token, uint256 amount, uint256 toStakers, uint256 toBuyback, uint256 toLiquidity, uint256 toCreator, uint256 tokensBurned)` | `0xaaf0a3567edf8558e26592324e582cbce9787413bfc05ba1ed3960a7477e3bd5` |

`Accrued` is a curve token's creator fee leg arriving, from a trade or from the graduated
position's fees. `Flushed` is that pot leaving along the token's split: the four legs add up to
`amount` exactly, and `tokensBurned` is what the buyback leg took off the supply. A token with a
buyback leg can only be flushed through `flushBuyback(token, minTokensOut)`.

### HoodPortal (one address)

| event | topic0 |
|---|---|
| `DirectLaunched(address indexed token, address indexed creator, address indexed quote, address hook, address splitter, address locker, uint256 positionId, uint256 initialBuy)` | `0x8ee110d867da58afc91d18a3e743c274b2f51df50327a74850832d5de2947a90` |
| `DirectMetadata(address indexed token, string name, string symbol, string logo, string description)` | `0xc813a55cc6560611c40a7b6759c7748e25b6025d00b2016e6ed5224a9a0a5b79` |
| `PoolOpened(address indexed token, bytes32 indexed poolId, uint24 fee, int24 tickSpacing, int24 tickStart, int24 tickBond, uint16 buyTaxBps, uint16 sellTaxBps)` | `0xbcbda1a474f67312225140140856803cc51829ef76ab42c67538ae1c6885aa59` |

All three fire in the launch transaction, in that order. Between `DirectLaunched` and `PoolOpened`
you have every number the launch fixed, without calling the hook; the opening tax is the same on
every launch and is not in them. The order of everything in a launch transaction, for an indexer
that keys on the token address:

1. `Transfer(0x0 -> portal, supply)` on the token: the mint
2. `SnipeExempt(address[] wallets)` on the hook: who pays no opening tax
3. the position mint, and `Transfer(portal -> 0x0, dust)` on the token: the few wei the position
   maths could not place
4. `DirectLaunched`, `DirectMetadata`, `PoolOpened`
5. if `initialBuy > 0`: the PoolManager `Swap`, and `Transfer(PoolManager -> creator)` on the token

Steps 1 to 3 come before the launch event, so an indexer that only starts watching a token at
`DirectLaunched` should take the supply off the receipt (mint minus dust) rather than off
`totalSupply()`, which on a catch-up already includes every later burn.

The v3 portal's `DirectLaunched` carried a `uint64 restrictionsEndBlock` before `initialBuy`, and
its `PoolOpened` four more fields (`snipeTaxBps`, `snipeDecaySeconds`, `maxHoldBps`, `maxBuyBps`);
both have different topic0s from the ones above and appear only on launches printed on v3.

### HoodLaunchHook (one per direct launch)

| event | topic0 |
|---|---|
| `Taxed(bool isBuy, uint256 fee, uint256 volume)` | `0x62beef5756b4812eef4b5e3c1971dd977d18a4fe76e285286c152c53cca2a89b` |
| `Bonded(uint64 at, int24 tick)` | `0x66e33a21e7758fab316003b367a89f22eb5a6c04743cbe6ca658f19328f1a0de` |
| `ClaimsFlushed(uint256 amount)` | `0x76eb627b869ad1da0909363612c43bad6b2e1bccfa37f800671e50621e044fdd` |
| `Sniped(address indexed payer, uint256 tax)` | `0xfb19e2b6ef1f7181393f9f1205e9bc4ee585825ba88df33f188bba70525a97db` |
| `SnipeExempt(address[] wallets)` | `0xa3f0bb01aa276e62ef7cba2b4e0d31e3804bb4a274f62f865f2a52499492f4b4` |

`Bonded` is graduation. It fires once, from the first swap that leaves the price across
`tickBond`, and never unsets. `Taxed.volume` is the trade's size in the quote asset, gross;
`fee` is everything taken out of it: the creator's tax, the 1% platform fee (70 bps to the
splitter with the tax, 30 bps to the Bag) and, in the opening seconds, the opening tax. `Sniped`
in the same transaction is the opening tax alone, with `payer` the `tx.origin` of the swap; the hook
keys the exemption on that same `tx.origin` (`currentSnipeTaxBps(origin)`), and `SnipeExempt`,
emitted once when the portal sets the hook up, is the list. `currentTaxBps(isBuy)` is the all-in
rate right now for a wallet that is not exempt, capped at 9,900 bps. The event sits before the PoolManager `Swap` when the tax was taken in
`beforeSwap` (the quote is the specified side: an exact-input buy, an exact-output sell) and after it
otherwise; match by transaction hash, not by adjacency. `ClaimsFlushed` is buy-side tax, held as an
ERC-6909 claim, reaching the splitter; it is not a trade.

### HoodRevenueSplitter (one per direct launch)

| event | topic0 |
|---|---|
| `Swept(uint256 total, uint256 protocol, uint256 creator, uint256 buyback, uint256 dividends, uint256 liquidity)` | `0x9910a1d859a1ae77ae6dd174442bba14d18c31973578963c0e52950c2f0bc424` |
| `DividendsClaimed(address indexed holder, uint256 amount)` | `0x16b8533c95f66ab8c192c98ddcf5031bcb3ee6f4022988bdadd57d3422da3073` |
| `CreatorClaimed(address indexed to, uint256 amount)` | `0xd3a47810d5b7bf060f5a846b2900e17ee7ebfc6e5f09c2c5fc978b967375e3c4` |
| `ProtocolClaimed(address indexed to, uint256 amount)` | `0x358d22ca92cd63a2c615bbad2e89c55a1609f1c1989572b37c772522400d0403` |
| `BuybackReleased(uint256 amount)` | `0x9465fefd1d99bb7a1e211b678fe7a4bb4c6efb47baedc20097215261b6c2879a` |
| `LiquidityPushed(uint256 amount)` | `0xc82d960c5f2b6f7e1671fb88060033a50b8668a6e4bfb27781f7aeafd224d1fc` |

`Swept` is the split of whatever arrived since the last sweep along the four allocations. Its
`protocol` field is always zero on v4 (`PROTOCOL_BPS` is 0: the platform's share goes to the Bag
from the hook), so a v4 splitter never books anything for `claimProtocol()` and never emits
`ProtocolClaimed`.
The splitter is also the launch's pot, and a creator who sells into the pool loses every unclaimed
creator fee to the holders in that transaction (`CreatorSlashed(address indexed creator, uint256
amount)`, `0xcd2ac04cde793fed8a6f39577375456e1a60f17d92a5bb372801b1b901716083`). `allocations()`
on the splitter returns `(creatorBps, buybackBps, dividendsBps, liquidityBps)`, summing to 10,000,
fixed at launch. A launch with `dividendsBps == 0` has no dividends leg; do not show a dividends
line for it.

### HoodBuybackModule (one address)

| event | topic0 |
|---|---|
| `BoughtBack(address indexed token, uint256 spent, uint256 burned)` | `0xa52290e9bbeea08e85a4902c066be363bfea47a8be21bba8d1e325b67df795c6` |

`spent` is what the swap consumed, not the pot: a run may move the price at most 296 ticks (about
three percent), and what did not fit is carried to the next run. `UniswapV4Graduator` emits the same
signature for a curve token's post-graduation buyback, so filter by emitter.

### HoodLocker (one per direct launch)

| event | topic0 |
|---|---|
| `FeesHarvested(uint256 quoteAmount, uint256 tokenBurned)` | `0xdbea52dddfd8e616bf8eb8aba23388332cfff06845e748b06f71d49924f62149` |
| `LiquidityDeepened(uint256 quoteAmount)` | `0x704817483355afc575d390de564dfeff9e3cb6e9ccbe4773cde3a8eb4ae16b1c` |

### HoodGraduationHook (one address)

| event | topic0 |
|---|---|
| `PoolRegistered(bytes32 indexed id, address indexed token, address indexed pot)` | `0xfafdbdd88ac30f0aa936e576be61816ea751908540523fa81b80c4a406ad7bec` |
| `Taxed(bytes32 indexed id, address indexed token, bool isBuy, uint256 fee, uint256 volume)` | `0x221372c79507ce168bb1c143b22f331b0f26e7239a6051c3c6e8159de71ce512` |
| `ClaimsFlushed(bytes32 indexed id, address indexed token, uint256 toCreator, uint256 toBag)` | `0xfc3c28ff96a6896af7ec2fa918d609a2aa6532cdaf8088fc4248e0a0fa46f637` |

Every graduated curve pool trades through this one hook. `Taxed` is the 1% platform fee on one
swap, and nothing else is taken: a graduated pool has no opening tax and no penalties. The fee is
held as an ERC-6909 claim per pool and flushed at the first swap after an hour or by anyone calling
`flushClaims(key)`; `ClaimsFlushed` is the split, 70 bps of every 100 to the fee router for the
creator's split and 30 into the Bag.

### HoodBag (one address)

| event | topic0 |
|---|---|
| `BagIn(uint8 indexed source, address indexed asset, uint256 amount, address indexed token)` | `0x767f7e59ee5ec1a57b133490d3df67e53d5e78aa4015e8eea4d445d9236fc24b` |
| `BagOut(uint8 indexed outlet, address indexed asset, uint256 amount, address indexed to)` | `0xe7c8eac83d699b9349a46e450392d11185129d6aea85382b48091d96fce7afe4` |
| `Held(uint8 indexed outlet, address indexed asset, uint256 amount)` | `0xd8dc13f328621ea4d11c86e931943bfa799d1bb86025022d4496445d3f80d8a9` |
| `DevDeferred(address indexed dev, address indexed asset, uint256 amount)` | `0xfd31925487e29b988dd4f4bfa62b7cbebd638d8abcee16942e889c292578ab82` |

`source` is 0 trade, 1 graduation, 2 boost, 3 house (launch fees), 4 house coin. `outlet` is 0
house, 1 Vault, 2 Payday, 3 burn clock, 4 dev. A trade's 30 bps leave as 3,333 bps to the Vault,
3,333 to Payday and the rest to the house; a graduation fee as 2,300 bps to the dev (the launch's
creator fee recipient) and the rest to the burn clock; a boost whole to Payday. `Held` is a Vault
share waiting for the house coin, or a burn share the clock did not take. `DevDeferred` is a dev
share the recipient refused; `claimDev(dev, asset)` pushes it again, and anyone may call it.

### PoolManager

| event | topic0 |
|---|---|
| `Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)` | `0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f` |

Every trade on a direct launch, and on a graduated curve token, is one of these with `id` equal to
the launch's pool id. `sender` is whoever called the PoolManager: the UniversalRouter, the portal
on a creator's first buy, the buyback module. The person is whoever the token moved for in the same
receipt: the `to` of the token's `Transfer` from the PoolManager on a buy, the `from` of the
`Transfer` to the PoolManager on a sell.

### ERC-20 Transfer

| event | topic0 |
|---|---|
| `Transfer(address indexed from, address indexed to, uint256 value)` | `0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef` |

Watch it on every launched token for two reasons: holder balances, and burns. A `Transfer` to
`address(0)` is supply gone for good (a buyback, the locker burning the token side of a harvest,
the portal's launch dust). Market cap is price times what is left, so subtract every burn, or read
`totalSupply()` at the head, which already has.

## The pool key and the pool id

A v4 pool has no contract. It is a key, and its id is the hash of the key:

```
currency0 = min(token, quote)      // as uint160; address(0) is ETH and always sorts first
currency1 = max(token, quote)
key       = (currency0, currency1, fee, tickSpacing, hooks)
poolId    = keccak256(abi.encode(currency0, currency1, fee, tickSpacing, hooks))
```

For a direct launch, `hooks` is `DirectLaunched.hook`, `fee` and `tickSpacing` are in
`PoolOpened`, and `PoolOpened.poolId` is the answer already hashed. `HoodLaunchHook.poolKey()` and
`HoodLocker.poolKey()` return the key as well. For a graduated curve token, `hooks` is the
graduation hook (`HOOD_GRADUATION_HOOK`), and `UniswapV4Graduator.positionOf(token)` returns the
key.

`tokenIsZero = token < quote` is the one bit that decides every sign and every flip below. Against
ETH the token is always currency1, so `tokenIsZero` is false and `tickBond < tickStart`: buying the
token pushes the tick down.

## Buy or sell, from a Swap

`amount0` and `amount1` are the swapper's deltas from the pool's point of view: negative is what
they paid in, positive is what they took out.

```
tokenDelta = tokenIsZero ? amount0 : amount1
quoteDelta = tokenIsZero ? amount1 : amount0
side       = quoteDelta < 0 ? "buy" : "sell"
tokens     = |tokenDelta|
quote      = |quoteDelta|
price      = quote * 1e18 / tokens        // quote wei per whole token (1e18 token wei)
```

The `Swap` is the pool's view of the trade, and the hook's tax sits outside it. On an exact-input
buy the quote in the event is already net of the tax (the hook took it before the swap), so the
trader paid `Taxed.volume`, which is more. On an exact-input sell the quote in the event is gross
(the hook took its slice from the output afterwards), so the trader received less. `Taxed` in the
same transaction has both the gross and the fee.

## Price from slot0

`StateView.getSlot0(poolId)` returns `(sqrtPriceX96, tick, protocolFee, lpFee)`.

```
raw           = (sqrtPriceX96 / 2^96)^2       // currency1 per currency0, wei per wei; also 1.0001^tick
quotePerToken = tokenIsZero ? raw : 1 / raw   // quote wei per token wei
price         = quotePerToken * 1e18          // quote wei per whole token, the unit our API uses
```

To display it, divide by `10^quoteDecimals` (18 for ETH, 6 for USDG). Market cap in quote units is
`price * totalSupply / 1e18 / 10^quoteDecimals`, with `totalSupply` net of burns.

The opening price of a direct launch is `PoolOpened.tickStart` through the same formula, and it is
the right cap to show before the first trade.

## Progress and graduation

**Direct machine.** `HoodPortal.graduationStatus(token)` returns
`(int24 currentTick, int24 bondTick, uint256 progressBps, bool bonded)`: 0 at the opening tick,
10,000 at the graduation tick, clamped, and pinned at 10,000 once the latch has closed. To compute
it from logs alone: `(tick - tickStart) / (tickBond - tickStart)` with `tick` from the latest
`Swap`, and 100% from the moment a `Bonded` event exists. The hook's `bonded()` view is the latch.

**Curve.** `HoodCurve.phase()` is 0 on the curve, 1 sold out, 2 graduated. Progress is
`sold() / curveSupply()`; `reserve()` is what the curve holds now and `raiseTarget()` what it will
hold when it sells out. `remaining()` is what is still for sale. Anyone may call `finalize()` on a
sold-out curve, and `Graduated` then fires.

**Both.** `HoodFactory.getLaunch(token)` is the registry for both machines and says which one a
token came from (`mode`). Our API folds all of it into one `status` field: `curve`, `sold_out` or
`graduated`.

## Gas on a hooked pool, and in the opening seconds

Pad gas estimates by 30% for any swap on a direct launch's pool. The estimate is made against the
state of one block and the transaction executes in another, and between the two the hook's
arithmetic moves: the opening tax changes with the clock, and buy-side tax held as claims is
flushed by whichever swap comes next. Wallets pad their estimates; a script has to pad its own.
`apps/web/components/DirectTradeBox.tsx` does `estimate * 13 / 10`.

A curve buy in the opening seconds needs the same padding: the estimate is made in one second of
the schedule and the buy may land in another. Measured on a testnet fork, one such buy used 316,511
gas against 304,365 estimated. `apps/web/components/TradeBox.tsx` pads curve trades by the same
`estimate * 13 / 10`.

## Custom errors

The four-byte selector is what a revert carries. One sentence each.

| selector | error | contract | when |
|---|---|---|---|
| `0x021c0d43` | `ExemptionListTooLong()` | factory, portal | More than 32 wallets named as exempt from the opening tax. |
| `0x26f7ccb9` | `PoolAlreadyOpen()` | portal | Somebody initialized this launch's pool first, from the public salt; launch again with another salt. |
| `0x52b60656` | `NoBag()` | factory, hook | The Bag is not named yet; no launch until it is. |
| `0x1af50573` | `PairMismatch()` | factory | The preset's caps are in another pair's units than the pair asked for. |
| `0x378a8f3b` | `BadHookSalt()` | portal | The mined salt does not land on the permission bits (`address & 0x3FFF` must be `0xCC`); re-read `hookInitCodeHash`. |
| `0x1752d335` | `BadTicks()` | portal | Spacing not positive, a tick not a multiple of it, `tickStart == tickBond`, or the position would be empty. |
| `0xd500448a` | `QuoteNotAllowed()` | portal | The quote asset is not on the allow list (ETH and USDG). |
| `0x917f1a53` | `BadFee()` | portal, factory | `msg.value` is below the launch fee, plus the first buy when it is in ETH. |
| `0xbc4f33a3` | `BadSplit()` | factory | The four legs of `feeSplit` do not add up to 10,000, all four are zero included. |
| `0x75013283` | `NoHouseToken()` | factory, staking | The stakers leg promises a share before the pad's own coin has been named, or a stake was attempted before it exists. Read `HoodStaking.houseToken()`: zero means neither is possible yet. |
| `0x38f21151` | `BadLock()` | factory | `firstBuyLock` is not one of the locker's lengths: 7, 30, 90 or 180 days, or zero for no lock. |
| `0x3beb2222` | `NoFirstBuy()` | factory | `firstBuyLock` was asked for with nothing to lock: no ETH above the launch fee, or `firstBuy` at zero. |
| `0xec4ebdaf` | `BadSupply()` | portal | Supply is zero. |
| `0x3a25fc0d` | `BadPoolFee()` | portal | The pool fee carries the dynamic-fee flag or exceeds 100%. |
| `0x3fcbf498` | `NotWired()` | portal | The buyback module or the Bag is not set yet; no launches until both are. |
| `0x07b3e48e` | `LaunchesPaused()` | portal | New launches are switched off; existing tokens trade as before. |
| `0x584a7938` | `NotWhitelisted()` | portal | Launches are whitelist-only right now and this sender is not on it. |
| `0x8698bf37` | `UnknownToken()` | portal | `graduationStatus` on a token the portal did not print. |
| `0x23c950d1` | `BadTax()` | hook | A side's tax outside 1% to 10% (100 to 1,000 bps). |
| `0xd3c913ea` | `WrongPool()` | hook | A swap on some other pool that names this hook; each hook serves the one pool the portal opened. |
| `0x7dd37f70` | `Slippage()` | buyback module, curve | Fewer tokens out than the minimum passed. |
| `0xf9820cc1` | `Nothing()` | buyback module, splitter | Nothing to buy back with, or a claim of zero. |
| `0xf6806bf8` | `UnknownLaunch()` | buyback module | Not a direct launch. |
| `0x900091d4` | `BadAllocations()` | splitter | The four allocations do not sum to 10,000. |
| `0x93687c0b` | `NotCreator()` | splitter | `claim` from anyone but the creator. |
| `0x0bc3bfc6` | `NotTrading()` | curve | The curve has sold out or graduated; trade the pool instead. |
| `0x4281117c` | `NotSoldOut()` | curve | `finalize` before the curve has sold out. |
| `0x87f36a18` | `NothingBought()` | curve | The amount rounds to zero tokens, or a sell of zero or of more than was sold. |
| `0x9f443164` | `TooExpensive()` | curve | An exact-output buy would cost more than `maxPairIn`. |
| `0xae50e1d8` | `ExceedsCurveSupply()` | curve | An exact-output buy asks for more than is left on the curve. |
| `0x11011294` | `InsufficientValue()` | curve | `msg.value` is below the quoted cost of an ETH-paired exact-output buy. |
| `0xd92e233d` | `ZeroAddress()` | curve, factory | `to` is `address(0)`. |
| `0x33eeccd9` | `ConfigDisabled()` | factory | The preset is switched off for new launches. |
| `0x6b5dedec` | `PairNotAllowed()` | factory | The pair asset is not on the allow list. |
| `0x89f17dee` | `BadEconomics()` | factory | The `econ` hash passed does not match `previewLaunchEconomics`; terms moved between preview and launch. |
| `0x4ad37645` | `TickerLockedError()` | factory | The ticker belongs to a token that did enough volume to lock it, for 48 hours. |
| `0x2fadff00` | `ImageLockedError()` | factory | Same, for the artwork. |
| `0x1124f78b` | `SymbolTooLong()` | factory | The ticker is over 32 bytes. |
| `0xeb694a3c` | `NothingToFlush()` | fee router | No creator fee booked for this token. |
| `0x7cfccd30` | `NeedsSwapFloor()` | fee router | The split has a buyback leg, so it needs `flushBuyback(token, minTokensOut)`, not `flush`. |
| `0x0ebf677f` | `NeedsFinalize()` | fee router | The curve sold out and its pool is not open yet. |
| `0xd66173a5` | `NotGraduated()` | graduator | The token has no pool yet. |
| `0xe6a0d45f` | `AlreadyGraduated()` | graduator | It already has one. |

## Things that bite

**`liquidityPool()` on a direct token returns the PoolManager.** Every v4 pool's tokens sit in the
PoolManager, so that is the address a buy comes from and the only address the token can name. It is
not a pair contract. The pool is the id above.

**The creator's first buy is one trade, reported twice.** `DirectLaunched.initialBuy` is the quote
the creator spent inside the launch transaction, and the PoolManager `Swap` in the same transaction
is that same buy. Count one of them. The same goes for `Bought` on a curve when the factory's
`launch` carried a first buy: `Launched` and the `Bought` that follows are one transaction and one
trade.

**Our own contracts trade.** The portal (first buy and team legs), the buyback module, the fee
router, the graduator and the burn clock all swap, and `HoodBlockZero` buys on the curve for a
team. They are trades, not traders; exclude their addresses from trader counts.

**The opening tax is keyed on different wallets on the two machines.** The curve exempts by the
wallet that receives the tokens (`Bought.to`), the direct hook by the wallet that sent the
transaction (`tx.origin`). On the curve a buy for an exempt wallet is exempt whoever sends it; on
a direct pool only who sends it counts. Read the list off `SnipeExempt` (or the factory's
`LaunchExempt` for a curve) rather than guessing it.

**The tax moves outside the swap.** The quote asset's movement is not a `Transfer` when the quote
is ETH, and even for USDG the hook's take goes to the splitter on its own schedule. Volume comes
from `Swap` or `Taxed`, not from token transfers.

**Two `PoolOpened` signatures exist.** The portal's (above) and the graduator's
`PoolOpened(address indexed token, address indexed pairToken, uint256 tokenId, uint160 sqrtPriceX96, uint128 liquidity)`.
Different topic0, different machine.

## REST API

Base URL: `NEXT_PUBLIC_API_URL` in `.env.example`, `https://api.hood.fam` in production. Everything
is derived from the chain by our indexer and can be rebuilt from it; nothing here is authoritative
over the contracts. Amounts are strings in wei; `price` is quote wei per whole token.

`GET /health`

```json
{ "ok": true, "indexedBlock": "18422190" }
```

`GET /tokens?sort=new|volume|progress|graduated&status=curve|sold_out|graduated|graduating&creator=0x…&q=fam&limit=30&offset=0`

`status=graduating` is at least halfway to graduation and not there yet, on either machine.

```json
{
  "tokens": [
    {
      "token": "0x…", "mode": "direct", "status": "curve", "bonded": false,
      "name": "Direct Fam", "symbol": "DFAM", "image": "ipfs://…", "description": "…",
      "creator": "0x…", "pair_token": "0x0000000000000000000000000000000000000000",
      "hook": "0x…", "splitter": "0x…", "locker": "0x…",
      "pool_id": "0x…", "pool_fee": 10000, "tick_spacing": 200,
      "tick_start": 184200, "tick_bond": 161200, "last_tick": 179400,
      "buy_tax_bps": 300, "sell_tax_bps": 300, "snipe_tax_bps": null, "snipe_decay_seconds": null,
      "max_hold_bps": null, "max_buy_bps": null, "restrictions_end_block": null,
      "alloc_creator_bps": 4000, "alloc_buyback_bps": 2000, "alloc_dividends_bps": 2000, "alloc_liquidity_bps": 2000,
      "pot": "0x…", "boosted": false,
      "total_supply": "999999999999999999998000", "burned": "1234000000000000000000",
      "price": "10240000000", "volume_24h": "3200000000000000000", "volume_total": "3200000000000000000",
      "trades_total": 3, "launched_at": "2026-09-17T10:12:04.000Z", "graduated_at": null,
      "curve": "0x0000000000000000000000000000000000000000", "phase": 0,
      "split_stakers_bps": 0, "split_buyback_bps": 0, "split_liquidity_bps": 0, "split_creator_bps": 0,
      "first_buy_locked": "0", "first_buy_unlock_at": null,
      "sold": "0", "reserve": "0", "curve_supply": "0"
    }
  ]
}
```

A curve token has `mode: "curve"`, its `curve` address, `phase` 0/1/2, `sold`, `reserve`,
`curve_supply`, and nulls for the direct fields. `pot` is the launch's pot: a `HoodPot` on a curve
launch, the splitter on a direct one.

`snipe_tax_bps`, `snipe_decay_seconds`, `max_hold_bps`, `max_buy_bps` and
`restrictions_end_block`, and the sell-side penalty columns next to them (`jeet_tax_bps`,
`jeet_window_seconds`, `whale_tax_bps`, `whale_tick_limit`, `king_bps`, `penalties_to_vault`,
`auction_blocks`), exist only for launches printed before v4, on the v3 contracts. On every v4
launch they are null: the opening tax is the same on every launch (`opening_tax_bps` on
`/tokens/:token`, below), and the caps, penalties, king of the hill and the auction are gone.

The four `split_*_bps` are the launch's `FeeSplit`, straight off `Launched`. On a curve token they
sum to 10,000 and are what to render as four percentages. On a direct token they are all zero,
which means the split does not apply rather than nothing is paid: that launch's tax is divided by
its own splitter, and `alloc_*_bps` is where it goes.

`first_buy_locked` is token wei of the creator's own first buy, held by the locker in the
launch transaction, and `first_buy_unlock_at` is when it opens. Zero and null mean the creator took
their first buy in hand, so a "dev locked" badge is `first_buy_locked > 0`.

`GET /tokens/:token`

The row above plus:

```json
{
  "holders": 41,
  "fees": {
    "accrued": "96000000000000000", "flushed": "64000000000000000",
    "to_stakers": "25600000000000000", "to_buyback": "19200000000000000",
    "to_liquidity": "12800000000000000", "to_creator": "6400000000000000",
    "burned": "48210000000000000000"
  },
  "staking": { "staked": "0", "positions": "0" },
  "pot": "0x…",
  "opening_tax_bps": [9900, 618, 19],
  "paid_to_holders": "5100000000000000",
  "pot_deposits": 4,
  "boosted": false
}
```

`opening_tax_bps` is the opening tax in bps of a buy at 0, 1 and 2 seconds after the launch, then
nothing; it is the same on every launch and both machines, and an exempt wallet pays none of it.
`paid_to_holders` and `pot_deposits` are what the launch's pot has taken in for its holders, in the
quote's wei. The v3 API also returned a `penalties` object here (the snipe, jeet, whale, king and
auction settings); v4 does not, and those settings only ever existed on v3 launches.

`accrued` is what came in (the router's bookings on a curve token, the splitter's sweeps on a
direct one) and `flushed` is what has left along the split. The four legs under it are pair wei and
add up to `flushed`; `burned` is token wei the buyback leg took off the supply, so it never belongs
in the same sum.

`GET /tokens/:token/trades?limit=50`

```json
{ "trades": [ { "side": "buy", "trader": "0x…", "recipient": "0x…", "pair_amount": "1000000000000000000",
  "token_amount": "97650000000000000000000", "fee": "0", "price": "10240000000",
  "ts": "2026-09-17T10:12:09.000Z", "tx": "0x…" } ] }
```

`GET /tokens/:token/candles?interval=5 minutes&limit=288` (intervals: `1 minute`, `5 minutes`,
`15 minutes`, `1 hour`, `4 hours`, `1 day`)

```json
{ "interval": "5 minutes", "candles": [ { "t": "2026-09-17T10:10:00.000Z", "open": "10240000000",
  "high": "10900000000", "low": "10240000000", "close": "10880000000",
  "volume": "3200000000000000000", "trades": "3" } ] }
```

`GET /tokens/:token/holders`: the top 100 by balance, `{ "holders": [ { "address", "balance" } ] }`.

`GET /stats`

```json
{ "launches": "12", "graduated": "3", "volume_total": "…", "volume_24h": "…", "trades": "410", "traders": "88" }
```

Also: `GET /portfolio/:address`, `GET /stakes/:owner`, `GET /points/:address`,
`GET /leaderboard?season=1&limit=100`, `GET /seasons`, and `GET /tokens/:token/penalties`: every
opening tax paid on one launch (`kind: "snipe"`, from `Sniped`) and every creator slash
(`kind: "slash"`), newest first, paged with `before=<id>`.

## The live stream

`GET /stream?tokens=0xabc,0xdef`

Server-sent events. Public, read only, no key, and outside the rate limit: it is one connection
held open for as long as the reader wants it. The `tokens` filter is optional and takes at most 100
addresses; without it every launch on the site comes down it. Each event carries one JSON object.

| event | data |
|---|---|
| `trade` | `{ token, side, trader, pairAmount, tokenAmount, price, tx, at }` |
| `launch` | `{ token, symbol, name, creator, mode, at }` |
| `graduated` | `{ token, at }` |
| `message` | a chat message, exactly as the routes below return it |
| `ping` | `{}`, every 25 seconds, so a proxy does not close an idle connection |

```
event: trade
data: {"token":"0x…","side":"buy","trader":"0x…","pairAmount":"1000000000000000000",
"tokenAmount":"97650000000000000000000","price":"10240000000","tx":"0x…","at":"2026-09-17T10:12:09.000Z"}
```

Amounts are decimal strings in base units, as everywhere else here. A launch is announced once its
name and ticker are in, which is the event after the one that created it.

Two caps, per instance: ten connections per address and two thousand in total. Over the address cap
the oldest of that address's connections is closed rather than the newest refused, so a reloaded
tab never locks a reader out of their own site; over the total the answer is 503. `EventSource`
reconnects on its own and the stream asks it to wait three seconds.

It is a feed, not a log: nothing is replayed, and a reader that was away refetches the list it
cares about. Inside, every event travels on a Postgres `LISTEN`/`NOTIFY` channel, so it reaches
every API instance whether or not that instance is the one following the chain.

## Token chat

One room per launch. Reading is public; posting takes a wallet that holds the token or has traded
it at least once, which is the whole of the spam rule. The message, wherever it appears:

```json
{ "id": 412, "token": "0x…", "author": "0x…", "body": "…", "at": "2026-09-20T10:31:02.184Z",
  "rank": "Bronze", "holdingBps": 250, "isCreator": false, "hidden": false }
```

`rank` is the author's rank on the leaderboard, `holdingBps` their share of the token's supply in
basis points at the moment of the read, `isCreator` whether they launched it. A hidden message
carries `"hidden": true` and `"body": null` for everyone except its own author, who still reads
their own words. There is no delete and no edit.

**Signing in**, two calls, once a week:

`POST /chat/nonce` `{ "address": "0x…" }` → `{ "nonce", "message", "expiresAt" }`

Sign `message` exactly as given (`personal_sign`, or viem's `signMessage`). A nonce is good for
five minutes and for one signature.

`POST /chat/session` `{ "address", "signature", "nonce" }` → `{ "token", "address", "expiresAt" }`

The session lasts seven days and goes on every other call as `Authorization: Bearer <token>`. It is
the only thing the other routes look at; a signature is never sent twice. A key is checked here with
no network at all; a Safe or any other contract wallet is checked through ERC-1271, which is one call
against the chain's current state, so those wallets can hold a room's floor like anybody else.

`GET /chat/:token?limit=50&before=<id>` → `{ "messages": [ … ] }`

Newest first, `limit` capped at 100, `before` pages backwards by id. Public, never cached; with a
session, the caller's own hidden messages come back with their body.

`POST /chat/:token` `{ "body": "…" }`, with the session, returns the message and puts it on
`/stream` in the same moment. Every refusal carries a code and a sentence saying why:

| status | error | when |
|---|---|---|
| 401 | `no_session` | no session, or one that has run out |
| 404 | `unknown_token` | nothing has launched at that address |
| 403 | `no_position` | the wallet neither holds the token nor has ever traded it |
| 403 | `system_wallet` | one of our own contracts |
| 400 | `body_missing`, `body_empty`, `body_too_long`, `body_control_characters` | 1 to 280 characters after trimming, one line, plain text |
| 429 | `too_fast`, `too_many` | one message every 5 seconds and 30 an hour, counted per wallet rather than per address |

`POST /chat/:token/hide/:id` → `{ "ok": true }`

The launch's creator with their session, or an operator with `HOOD_ADMIN_TOKEN`. `{ "hidden": false }`
in the body puts a message back, by the same two. A creator reaches only their own launches (403
`not_the_creator`), and hiding never takes a message away from the person who wrote it.

## Where the pools show up

DexScreener addresses a v4 pair by its pool id: `https://dexscreener.com/robinhood/<poolId>`, or
by token at `https://dexscreener.com/robinhood/<token>`. GeckoTerminal is
`https://www.geckoterminal.com/robinhood/pools/<poolId>`. Both need the bytes32 id, not an address,
because there is no pool contract to address.

## Reference token

Filled in after the first mainnet launch: one direct launch and one curve launch, with the token,
hook, splitter and pool id, so an integrator can replay every event above against something real.

## From TypeScript

`@hood/sdk` (`packages/sdk`) carries the generated ABIs, the chain definition, the addresses above
and clients for both machines: `createDirectClient(...).graduationStatus(token)`, `.getLaunch`,
`.taxes(hook)`, `.buckets(splitter)`, `.pendingDividends`, and `mineHookSalt` for a launch. The
`apps/api/src/indexer.ts` file is a complete, working reference for everything in this guide.

## Pairs

`GET /pairs` is what a launch may be quoted in, taken from the factory's allow list rather than
from a constant, so it changes the moment the owner changes it.

```json
{ "pairs": [
  { "address": "0x0000000000000000000000000000000000000000", "symbol": "ETH", "decimals": 18,
    "share": false, "allowed": true, "lockThreshold": "25000000000000000000", "usd": 2722.83 },
  { "address": "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", "symbol": "NVDA", "decimals": 18,
    "share": true, "allowed": true, "lockThreshold": "300000000000000000000", "usd": 224.64 }
] }
```

`share` marks a tokenised share rather than a currency. `usd` is one whole unit in dollars, read
off the pool that asset trades against USDG in, and `lockThreshold` is the 24 hour volume, in that
asset's own units, above which a launch locks its ticker and artwork for 48 hours.

Every launch row carries `pair_symbol` and `pair_decimals` for the same reason: a pair allowed
after your integration shipped still has to display with the right number of zeros. Fall back to
the pair address only when they are null.
