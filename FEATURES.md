# Coverage against Pons, Argus and Printr

Three launchpads, one platform. Pons contributed the opening window, the locked position with fees
claimable at any time, the on-chain socials and the launch fee (that is Pons V1, the single-sided
Uniswap V3 launch, now closed; Pons V2, the active one since 2026, is a bonding curve that graduates
into a v4 pool behind one shared hook with a 99% exponentially decaying snipe tax and stock-token
quote assets, which is the shape our curve machine covers). Argus contributed the whole idea of
skipping the curve: supply as liquidity above the opening price, a tax hook on the pool, a decaying
snipe surcharge, a revenue split across four destinations and holder dividends. Printr contributed
the curve machine, the fee models we turned into one split, time-weighted locking of the house coin, the ticker lock,
the omnichain leg
and the agent surface.

## What came from where

| From Pons | Status | Where it lives |
|---|---|---|
| Launch and pool in one transaction | in | `HoodPortal.createLaunch` |
| Creator's initial buy inside the launch transaction, `initialBuyAmount` in the event | in | `HoodPortal._initialBuy`, swapped straight against the PoolManager; the window's cap applies to it |
| Launch block belongs to the creator | in | `HoodLaunchToken._update` |
| Per-wallet hold and buy caps after it, expiring on their own | in | same, 5% and 5.5% by default |
| Selling never restricted; the hold cap applies to plain transfers during the window | in | same; the buy cap is pinned to at most 1.1x the hold cap, as Pons's factory does |
| Liquidity locked automatically at creation | in | `HoodLocker`, no withdrawal function exists |
| Creator fees accrue in the position, claimable any time | in | `harvestFees` into the splitter, `claim` for the creator |
| On-chain `logo()`, `description()`, `socials()`, `liquidityPool()` | in | `HoodLaunchToken` |
| 0.0005 ETH launch fee, 1% pool tier, 1e9 supply | in | portal defaults |
| Graduation status readable on chain | in | `HoodPortal.graduationStatus(token)`: current tick, bond tick, progress in bps, bonded |
| Protocol fees into TWAP buybacks | part | buybacks are permissionless and immediate, not time-averaged |

| From Argus | Status | Where it lives |
|---|---|---|
| No virtual curve: supply as one position above the opening price | in | `HoodPortal._mintPosition` |
| Buys walk the price up through it | in | proven on a fork of 4663 |
| Monotonic bonded latch | in | `HoodLaunchHook._latch` |
| Fixed buy/sell tax, 1-10% per side, immutable | in | `HoodLaunchHook`; input-side tax held as ERC-6909 claims until settled, output-side taken directly |
| Opening snipe tax decaying over seconds, 99% combined cap | in | quadratic decay; the launch's own buy and its own buybacks are the only exemptions, no per-launch lists |
| Revenue split 10% protocol / 90% creator | in | `HoodRevenueSplitter`, the tenth is a constant |
| Four creator destinations, allocations fixed at launch | in | creator, buyback, dividends, liquidity |
| Separate creator-fee recipient | in | The launching wallet signs the terms, while `creatorFeeRecipient` can point the creator leg at a different wallet from block one. |
| Pull-based per-share holder dividends | in | accumulator with the pool and system addresses excluded |
| Non-custodial locker with permissionless harvest | in | `HoodLocker` |
| Buyback as an external permissionless module | in | `HoodBuybackModule`, swaps straight against the PoolManager, at most ~3% price impact per run, the rest carried |
| EIP-1167 token clone, no admin, no transfer tax | in | `HoodLaunchToken` |
| Everything deployed in one atomic call | in | token, splitter, hook, pool, position, locker |

## Coverage against the Printr feature set

`in` = built, tested, and exercised end to end. `part` = works, with a named limit.
`out` = not built, with the reason.

## 1. Omnichain launching (LayerZero OFT)

| Feature | Status | Note |
|---|---|---|
| Launch on Robinhood Chain | in | 4663 is home. Solana is out by decision, not by omission. |
| Native OFT bridging, no wrapped tokens | in | Lock box here, mint there. `HoodOFTAdapter` + `HoodOFTRemote`, verified against the real LayerZero endpoint on 4663 (eid 30416, and not at the canonical address). |
| Routes | in | Ethereum, Arbitrum, Base, BNB, Optimism, Polygon, Scroll. Measured on forks of all seven: the eids resolve both ways, and the default DVN on every chain (this one included) is a stub that cannot price, so each route needs its peer and its own DVN config on BOTH ends. |
| One adapter per token | in | Enforced by the registry: two lock boxes would each believe they hold the canonical supply. |
| Deploying the far side | in | `script/DeployRemote.s.sol` deploys and configures the remote on the destination chain, `script/WireRemote.s.sol` wires the 4663 end; both read before they write, so a half-done route is finished by running them again. Nothing is deployed on any destination yet. |
| Independent curve per chain | out | The curve lives on 4663 and the token travels. One market, not seven. |

## 2. One-click cross-chain swap and bridge

| Feature | Status | Note |
|---|---|---|
| Buy from another chain | part | Relay lists 4663 natively. With `RELAY_API_KEY` the SDK quotes it in place; without one, the app hands over a hosted Relay link rather than a broken button. |
| Bridge from the portfolio | in | The bridge page sends a launched token out over any open route, and quotes the messaging fee first. |
| Stablecoin pairings | in | Any ERC-20 on the allow list, six decimals included, traded and graduated in tests. |

## 3. Fees, split four ways

Not a model a launch picks one of: four shares in bps that add up to 10,000 and are spent pro rata
on every flush, so a launch can do several of these at once.

| Feature | Status | Note |
|---|---|---|
| Proof-of-belief locking | in | The `stakersBps` leg, paid to whoever locked the house coin. One vault, one coin, fed by every launch. |
| Buyback and burn | in | The `buybackBps` leg. Off the curve before graduation, out of the real pool after, with a floor. |
| LP compounding | in | The `liquidityBps` leg. Into the raise before graduation, donated through the PoolManager after. |
| Creator keep | in | The `creatorBps` leg. Transferable in one step by the current recipient only. |
| Zero fee | in | Not a leg: a preset whose `creatorFeeBps` is zero, so nothing is ever booked to split. |
| Claiming, pushing, keeper | in | Non-buyback fee flushes are permissionless; only the Safe-appointed keeper or Safe may choose a buyback slippage floor. `apps/keeper` handles the routine jobs. |

## 4. Staking and KOL protection

| Feature | Status | Note |
|---|---|---|
| Time-weighted multipliers 1x to 2.5x | in | none / 7d / 30d / 90d / 180d. |
| Send a Stake | in | `stakeFor`, and it is in the app behind one disclosure. |
| Creator's first buy, locked | in | `LaunchParams.firstBuyLock`, one of the locker's lengths; the tokens go to `HoodTokenLock` in the creator's name instead of to their wallet, and earn nothing. |
| Positions and claims | in | In the app, in the SDK, in the MCP server, and claimable by anybody on the owner's behalf. |

## 5. Bonding curve flexibility

| Feature | Status | Note |
|---|---|---|
| Custom start and graduation caps | in | Per preset, append only. |
| Custom liquidity ratio | in | Two knobs, with a floor of 80% into the pool. |
| Graduation into a real pool | in | Uniswap v4, locked position, fees collectible by anyone into the split. Fork-tested against live 4663. |

## 6. Anti-copycat

| Feature | Status | Note |
|---|---|---|
| 48h ticker and image lock | in | Case-insensitive, releases itself. |
| Threshold in dollars | part | Measured in the pair asset, per pair, because no oracle sits in the trade path. The indexer prices volume in dollars; the lock does not. |

## 7. Agent layer

| Feature | Status | Note |
|---|---|---|
| MCP server | in | 36 tools: create, quote, launch, buy, sell, finalize, fees, stake, claim, bridge, cross-chain buy, wallets, treasury, gas, art, support. |
| TypeScript SDK | in | `packages/sdk`, viem and zod, ABIs generated from the Foundry artifacts so they cannot drift. |
| Local encrypted keystore | in | AES-256-GCM, scrypt, file mode 600, wrong password rejected. Unlocking returns a signer, never the secret. |
| Web signer | in | A local page where a human signs in their own wallet, for when no key should touch the agent. |
| Treasury and gas management | in | Set treasury, fund a wallet, drain a wallet minus gas. |
| AI token art | in | OpenRouter image model, in the MCP server and in the launch wizard. The key stays server side. |
| Headless agent mode | in | `AGENT_MODE=1`; without it every write needs `confirm: true`. |

## 8. Points and community

| Feature | Status | Note |
|---|---|---|
| Launch and graduation announcements | in | `apps/announcer`: reads the public API, posts to Telegram or any webhook, logs instead when neither is configured. Holds no key. |
| Points for printing, trading, staking | in | 500 per launch (paid once the token has traded 1,000 dollars, so an empty token earns nothing), 2 per dollar bought, 1 per dollar sold, 10 per dollar locked for every 30 days it stays locked, times the lock multiplier, credited as it accrues rather than at the moment of locking. |
| Rank multipliers | in | Wood 1.5x to Degen 5x, from rolling 30 day volume, so a rank is re-earned. |
| Seasons and leaderboard | in | Season table, leaderboard endpoint, leaderboard page, admin routes and a CLI to open, close and snapshot. |
| Snapshots | in | `seasons-cli snapshot`, and a snapshotted season's public board is frozen from then on. |
| A pool at the end of a season | in | `HoodSeasonDrop`: merkle claim, a root written once, permissionless claims that always pay the holder, unclaimed funds swept back only after 30 days. The pool is a share of the protocol's own take, so it can never promise more than it earned. |
| Telling people what they would get | in | `/airdrop`: the live pool, the season's points, and a calculator that scores the same activity at the rank you hold today and at the rank it would reach, because every trade is scored when it lands. |

## 9. The rest

| Feature | Status | Note |
|---|---|---|
| Web app | in | Board with category chips, live FOMO feed, top-trader windows, graduation race, dev-lock badges, token page with chart, holder map and holder-gated chat, launch wizard for both machines, portfolio, points and bridge. Write paths (connect, buy, sell with Permit2, stake, claim, launch) driven end to end against a fork from a real browser. |
| Indexer and API | in | Fastify and Postgres, built for a chain with 100ms blocks that refuses large log ranges. |
| Solana | out | Deliberate: we launch on Robinhood Chain. |
| Audit | out | Nothing here has had one. |
| Partner and bot white-label APIs | out | The SDK is the surface a bot would integrate; no partner program exists. |

## 10. The multisig

| Feature | Status | Note |
|---|---|---|
| Owner and treasury on a Safe | in | Safe v1.4.1, the canonical 4663 deployment, checked by code hash before anything builds on it. `script/DeploySafe.s.sol` creates it (refusing a 1-of-N, and a deployer who is also a signer), `Deploy.s.sol` refuses an owner on 4663 that is not a Safe of two or more. |
| Taking ownership | in | One batch for the factory, the portal, the bridge factory and the drop: `npm run safe -- accept` writes a Transaction Builder file whose checksum Safe{Wallet} accepts without a warning. |
| Owner calls from a terminal | in | `npm run safe -- call factory "setLaunchFee(uint256)" …`, as a file to sign in Safe{Wallet}, or signed and sent locally for a rehearsal. |
| The app as a Safe App | in | Safe{Wallet} opens hood.fam in a frame and the wallet is the Safe. `/manifest.json`, `frame-ancestors` for app.safe.global only, and a self-hosted Safe allowed in by env. |
| A Safe as a user | in | Launch, trade, stake, claim, collect fees. Approval and action go as one Safe transaction, the app waits for the signers rather than for a hash that will never be mined, and the bridge makes a Safe name its destination instead of assuming it owns its own address on another chain. |
| Proving it | in | 12 Solidity tests against the real Safe bytecode, 34 assertions end to end on a local 4663 (`scripts/e2e/safe.mjs`), and 14 in a real browser inside a stand-in Safe{Wallet} (`scripts/e2e/safe-ui.mjs`). |

## In this repo and not in any of the three

- The two machines share one registry, so a ticker lock, the staking vault, the points, the bridge
  and the app treat a curve launch and a direct launch as the same platform.
- The economics of a curve launch are pinned by a hash the creator reads first, so the terms cannot
  move between the quote and the signature.
- A curve launch's pool is opened inside the launch transaction. Anybody can open a v4 pool at any
  price, and one stranger could otherwise brick or drain every launch on the platform.
- Curve graduation is a separate permissionless call, so a failing pool deployment cannot hold a
  trade hostage.
- No token in either machine has a mint function, so no bridge can ever print supply.

## In this repo and not in that report

- The creator's first buy happens inside the launch transaction, so a launch cannot be sniped.
- The economics of a launch are pinned by a hash the creator reads first.
- The pool is opened inside the launch transaction, because anybody can open a v4 pool at any price
  and one stranger could otherwise brick or drain every launch on the platform.
- Graduation is a separate permissionless call, so a failing pool deployment cannot hold a trade.
- The token has no mint function at all, so no bridge can ever print supply.
- The fee split cannot be switched after launch.

## The social pad (21-09-2026)

| Feature | State | Where |
|---|---|---|
| One-click buy with ETH on any pair with an ETH pool | in | `HoodCurveRouter` + `localNativeRoute` in `apps/api/src/uniswap-route.ts`; Uniswap's routing service is used instead when `UNISWAP_API_KEY` is set |
| Creator-chosen trade fee, 0.30% to 5% | in | the wizard's fee slider; a moved fee launches through `launchCustom`, the factory caps the total at 500 bps |
| Referrals, a tenth of a referred wallet's trade points | in | `referrals` table, `payReferrer` in `points.ts`, `/refer` |
| Quests, nine per season, claimed once per wallet | in | `apps/api/src/quests.ts`, `/quests` |
| Races: a named window over the same points | in | `races` table, `/races/current`, opened by the admin token |
| Follow a trader, feed of their trades | in | `follows` table, `/feed`, `/following` |
| Profit board with a real cost basis | in | `trade_positions`, `apps/api/src/pnl.ts`, `/top-traders?sort=pnl` |
| Watchlist and browser alerts | in | `watchlist` table, `/following`, drawn off the existing stream |
| Category filters on the shared board | in | `category=new|stocks|culture|direct|locked`, front page tabs |
