# hood.fam

A launchpad on Robinhood Chain (4663). The name comes from the chain, and from the one story
everybody already knows about a man called Hood: what the house takes, the fam gets back. That is
not a slogan here, it is where the code puts the money. The protocol keeps 30 bps of trading volume
and the graduation fee. The other 70 bps goes wherever the creator pointed it at launch, and four of
the five places it can go are the holders.

Everything in this repo is English only. Verified source is public on the explorer forever.

## Two machines

**The curve.** A creator picks a preset, a pair asset and a fee model, and gets a token with a
bonding curve. The curve sells four fifths of the supply at a linearly rising price. When it sells
out, anyone can finalize: the pool supply and the raise go into a Uniswap v4 position that this
system cannot withdraw, cannot transfer and cannot unwind. The only thing anybody can ever do with
that position is collect the fees it earns, and those go straight back into the token's fee model.

**Straight to the pool.** No curve, no reserve, no migration. The entire supply goes into one
Uniswap v4 position above the opening price and buys walk the price up through it, with a hook on
the pool taxing both sides in the quote asset. The tax splits four ways: the creator, a buyback, the
holders, and the liquidity itself. When the price crosses the bonding tick the launch is bonded, and
that is a status rather than a migration, because the liquidity was real and locked the whole time.

Both machines share one registry, one ticker lock, one staking vault, one points system and one app.

## The five fee models

Chosen at launch, written into the registry once, never editable afterwards.

| Model | What the creator leg does |
|---|---|
| `StakingRewards` | Pays the people who locked the token, weighted by size and by lock length. |
| `BuybackBurn` | Buys the token back (off the curve, or out of the pool after graduation) and burns it. |
| `LiquidityCompound` | Deepens the liquidity: added to the raise before graduation, donated to the pool after. |
| `CreatorKeep` | Pays the creator fee recipient. Transferable in one step, by the current recipient only. |
| `ZeroFee` | There is no creator leg. Traders pay the protocol's 30 bps and nothing else. |

Flushing is permissionless. Anyone can push a token's fees through its model at any time; if our
keeper stops, the machine keeps running.

## What is in this repository

```
src/                 the contracts: factory, token, curve, fee router, staking, graduator, bridge
packages/sdk/        one TypeScript client over all of it, ABIs generated from the artifacts
packages/mcp/        36 MCP tools: launch, quote, trade, stake, claim, bridge, keystore, signer, art, support
apps/api/            the indexer, the REST API, points and ranks, the support desk (Fastify + Postgres)
apps/web/            the app: board, token page, launch wizard, portfolio, points, bridge
apps/keeper/         pushes the permissionless jobs so they happen in seconds, not eventually
docs/                how it works, and how it deploys
```

`docs/SUPPORT.md` is the FAQ: what the help button answers from, and what a person answers
when it cannot. `docs/AIRDROP.md` is the season drop: where the pool comes from, how points split
it, and what is deliberately not promised. `docs/INTEGRATION.md` is for indexers, bots and screeners: events, topics, pool
keys, errors. `docs/ARCHITECTURE.md` is the whole system in one page. `docs/RUNBOOK.md` is the deployment, in
order, including the places where order matters. `docs/SECURITY.md` is the trust model: what nobody
can do, what the owner can, and the risks that are accepted rather than solved.

## The contracts

| Contract | What it is |
|---|---|
| `HoodFactory` | Prints tokens, holds the presets and the registry, runs the copycat lock. |
| `HoodToken` | Fixed supply, no owner, no mint function. Burnable. ERC-2612 permit. |
| `HoodCurve` | One launch's market. Every parameter is immutable, set at launch. No owner, no pause. |
| `HoodFeeRouter` | Books the creator leg and spends it along the model. No owner, no withdrawal. |
| `HoodStaking` | Locks tokens, pays the fee stream by weight. One vault serves every launch. |
| `UniswapV4Graduator` | Opens the pool, keeps the position forever, hands its fees back to the model. |
| `HoodDeployer` | Holds the token and curve bytecode, so the factory fits in an account. |
| `HoodBridgeFactory` | Deploys the one lock box per token and owns it, so routes have one owner. |
| `HoodOFTAdapter` / `HoodOFTRemote` | The lock box here, the mirror there. |
| `CurveMath` | The curve arithmetic, in one exact division. |

## The curve

`price(s) = p0 + (p1 - p0) * s / supply`, where `p0` and `p1` come from the start cap and the
graduation cap divided by the token count. Cost is the area under it:

```
cost(s -> s + d) = d * [ 2 * p0 * supply + (p1 - p0) * (2s + d) ] / (2 * supply * 1e18)
```

One division, so the result is the exact floor or ceiling of the true integral. This is deliberate:
with two roundings in sequence, splitting a trade into a thousand pieces came out a wei cheaper than
doing it at once, and a wei that leaks per call is a machine somebody will run. There are fuzz tests
that hold the line in both directions.

Buys round up, sells round down. The reserve can therefore only drift above the integral, and every
holder can sell back at the curve price at any time until it graduates.

## Anti-copycat

A token that does more than the configured volume inside 24 hours locks its ticker and its artwork
for 48 hours. A new launch cannot reuse either, and the ticker check is case-insensitive, so `bonk`
does not get you around a lock on `BONK`. A quiet token never locks anything.

## Staking

| Lock | Weight |
|---|---|
| none | 1x |
| 7 days | 1.25x |
| 30 days | 1.5x |
| 90 days | 2x |
| 180 days | 2.5x |

`stakeFor` is the send-a-stake: you can put tokens in somebody else's name, locked. They earn the
fee stream from minute one and cannot sell before the lock ends. That is how a launch pays a caller
or a partner without handing them an exit.

`claim` is permissionless and always pays the position's owner, so a keeper can push everybody's
rewards and, if the keeper dies, anybody else can. When a lock runs out, anyone can `demote` the
position back to 1x, so an expired lock stops taking a long-lock share of the pot.

## What the owner can and cannot do

Can: add presets (append only, never edited), disable a preset for new launches, change the launch
fee, the treasury, the pair allow list and the graduation handler that NEW launches get.

Cannot: touch a token that already exists. Its curve holds every parameter as an immutable, its fee
model is written once, its graduation handler is pinned at launch, and neither the curve nor the fee
router has a withdrawal function. The liquidity lock after graduation is the absence of code, not a
promise.

## Omnichain

LayerZero V2 is live on 4663 at `0x6F47...DD5B`, eid 30416, which is **not** the canonical
`0x1a44...` address. A token leaves by being locked in its adapter here and minted on the far side,
so the total across all chains is always the supply printed at launch. Routes to Ethereum, Arbitrum,
Base, BNB, Optimism, Polygon and Scroll are live from this chain, and each one needs its peer AND
its verifier config before it can carry anything: the endpoint's defaults here carry no DVNs at all.

Money coming the other way goes through Relay, which lists 4663 natively.

## Verified against the real chain

`test/ForkV4.t.sol` runs against a fork of 4663 with the real Uniswap v4 deployment: the pool opens
and is initialized, the locked position holds the liquidity, a swap goes through the UniversalRouter
(the Robinhood fork of it, with the extra `minHopPriceX36` field), the pool fee comes back and lands
in the fee model, and a donation reaches the pool.

Three things that had to be measured rather than assumed, all now encoded:

- The PositionManager rejects `DONATE` with `UnsupportedAction`. Compounding goes through the
  PoolManager's own unlock callback instead.
- The full-range liquidity maths deliberately asks for slightly less than the curve raised. The
  sliver left over is not stranded: the token side is burned, the pair side goes into the fee model.
- Anybody can open a v4 pool for any pair, at any price, for the cost of one transaction. If the
  pool were only opened at graduation, a stranger could open it first at an absurd price and every
  launch on the platform could be bricked or drained that way. So the pool is opened inside the
  launch transaction, priced at the raise the curve is heading for, before the token address has
  been seen by anyone. Graduation then mints into the price the pool actually holds, never one it
  assumes.

```bash
forge test --no-match-path 'test/Fork*.t.sol'                     # 86 local tests
forge test --match-path 'test/Fork*.t.sol' --fork-url robinhood   # 27 against the live chain
npm run abis && npm run build                                     # sdk, mcp, api
docker compose up -d --build                                      # db, indexer+api, web, keeper
```

Deployment, wallets and route wiring are in `docs/RUNBOOK.md`.

## Deliberately not like Printr

- **No mint role on the token.** A bridge that can mint is a supply backdoor. Omnichain expansion
  goes through a LayerZero OFT lock-box adapter deployed beside the token: the supply is locked
  here, the remote OFT mints against it, and nothing in the token has to change.
- **Graduation is its own call.** A pool deployment that reverts must never be able to hold the last
  buy of a curve hostage. The curve stops trading when it sells out; anyone can finalize, in the
  same block if they want.
- **The fee model cannot be switched after launch.** The buyer of the first minute and the buyer of
  the last hour are buying the same deal.

## Coverage

`FEATURES.md` maps every line of the Printr feature set to a status: what is built and tested here,
what exists on-chain but has no layer on top of it yet, and what does not exist at all.

## Verified beyond the tests

The whole stack has been run against a fork of 4663 from a real browser: both machines launched
through the app, bought, sold through Permit2 and the router, staked, dividends claimed, and every
one of those transactions checked on chain afterwards. The MCP server drove the same chain through
its own tools, the keeper ran against it, and the three Docker images build from a clean clone.
Slither's findings are triaged in `docs/SECURITY.md`.

## Not built

- **Solana.** Out on purpose: this launches on Robinhood Chain.
- **An external audit.** The self-audit found and fixed real bugs, which is the argument for one.
- **The far side of a bridge route.** `HoodOFTRemote` compiles and is deployed per destination
  chain by hand; there is no script that fans it out across seven chains yet.
- **In-app cross-chain quotes** need a Relay API key. Without one the app links out to Relay's own
  page, which works but is one more click.
