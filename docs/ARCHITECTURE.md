# How hood.fam works

Five moving parts. Three of them are on chain and cannot be changed after a launch; two of them run
on a server and can be replaced at any time without anybody's money noticing.

This describes the v4 contracts, deployed on Robinhood Chain on 29 September 2026. Launches printed
on the v3 contracts before that day keep running on them, under the rules they were launched with.

```
        creator                     trader                      agent
           │                          │                           │
           ▼                          ▼                           ▼
   ┌───────────────────────── apps/web (Next.js) ──────────────┐  packages/mcp
   │  board · token page · launch wizard · portfolio · points  │  (36 tools over the SDK)
   └───────────┬──────────────────────────────┬────────────────┘       │
               │ reads (lists, charts)        │ writes (wallet)        │
               ▼                              ▼                        ▼
       apps/api (Fastify)              ═════ chain 4663 ═════   packages/sdk (viem)
       indexer + REST + points                  │
               ▲                                │
               └──────────── logs ──────────────┘
                                                │
   HoodFactory ─ deploys ─► HoodToken + HoodCurve + HoodPot ─ graduates ─► UniswapV4Graduator ─► v4 pool
        │                          │                                              (HoodGraduationHook)
        │                          ├── 70 bps ──► HoodFeeRouter ──► split across four roads
        │                          │                                 ├─► HoodStaking (lock, 1x to 2.5x)
        │                          │                                 ├─► buy back and burn
        │                          │                                 ├─► deepen the liquidity
        │                          │                                 └─► pay the creator
        │                          └── 30 bps ──► HoodBag ──► Vault · Payday · house
        │                                           └── graduation fee ──► dev · HoodBurnClock
        └── registry, presets, copycat lock

   HoodBridgeFactory ─► HoodOFTAdapter (lock box) ─► LayerZero ─► other chains
```

## The chain half

**HoodFactory** prints a token and opens its curve in one transaction. It holds the presets
(append only, never edited), the registry, and the copycat lock. It can also spend the creator's
own money on the first buy inside the same transaction, so a launch cannot be sniped in the gap
between the token appearing and the creator buying. It also prints the launch's pot and writes
the list of wallets that pay no opening tax (`LaunchParams.exempt`, at most 32, plus the launcher
and the creator fee recipient).

**A creator can lock their own first buy.** `LaunchParams.firstBuyLock` is a duration in seconds
and must be one of `HoodTokenLock`'s lengths (7, 30, 90 or 180 days) or the launch reverts, so an
app and the contract can never disagree about what a lock is. When it is set, the tokens the first
buy bought never pass through the creator's wallet: the factory hands them to the locker in the
creator's name. They earn nothing there, and that is deliberate. Locking for money is the house
coin's job; this lock exists to say one thing, which is that the one parcel nobody else could have
bought yet cannot be sold into the people who buy next. Only the creator can take it out, and only
once the time has passed. A lock with no first buy behind it reverts rather than doing nothing.

**HoodDeployer** holds the bytecode of the token and the curve, and a child (`HoodPotDeployer`)
that holds the pot's, and nothing else. It exists because a factory that inlines `new Token()` and
`new Curve()` carries both creation codes in its own runtime code: ours came out 27,037 bytes
against a 24,576 limit, so it could not be deployed at all. The pot sits one hop further for the
same reason. Measured with `forge build --sizes`, and there is a test that keeps it measured.

**HoodToken** is fixed supply, has no owner and has no mint function. That is not an omission. A
bridge that can mint is a supply backdoor, so the token travels through a lock box instead.

**HoodCurve** is one launch's market. Price rises linearly with supply sold, from the start cap to
the graduation cap. Every parameter is an immutable set at launch: no owner, no pause, no setter,
and no path to the reserve other than selling back into the curve or graduating into the pool.
When the curve sells out it stops trading and anyone may call `finalize`, which hands the pool
supply and the raise to the graduation handler and pays the graduation fee into the Bag.
Graduation is deliberately a separate call: a pool deployment that reverts must never be able to
hold the last buy of a curve hostage. Of the 1% fee, the creator's 70 bps go to the fee router on
every trade, and the protocol's 30 bps are booked in the curve and pulled into the Bag by the
permissionless `claimProtocol`, so a Bag that cannot take a transfer never stops a trade.

**The opening tax.** Every curve opens on the one schedule every launch runs
(`SnipeSchedule`): 99% of a buy in the launch's own second, 6.18% in the next, 0.19% in the one
after, then nothing. Buys only. It is trading fee, split between the protocol and the creator the
way the fee is. The exemption is keyed on the wallet that receives the tokens, and every buy made
inside the launch transaction, by the factory or by the account that called it, is free: the
curve's constructor marks a transient storage slot that lives exactly as long as the launch
transaction.

**UniswapV4Graduator** opens the pool, keeps the position forever and hands its fees back to the
fee split. It has no owner, no transfer and no way to decrease liquidity. The lock is the absence
of code, not a promise. It also opens the pool inside the LAUNCH transaction, at the price the raise
is heading for, because anybody can open a v4 pool for any pair at any price and one stranger with
one transaction could otherwise brick or drain every launch on the platform. Opening it is not the
whole defence, because an open pool with no liquidity in it still has a price anybody can walk
anywhere for the cost of gas: at graduation the handler pins the price back to the ratio the raise
actually came out at, so the position is minted where the money says it belongs. Every pool it
opens names **HoodGraduationHook**, one hook for all of them, which takes the 1% fee on every swap
(70 bps to the fee router, 30 into the Bag) and nothing else.

**HoodFeeRouter** books the creator leg of every trading fee and spends it across the four
destinations the creator chose at launch. It has no owner and no withdrawal. Flushing is
permissionless.

**HoodStaking** is the Vault: one vault holding one coin, the pad's own, named once by the owner
through `setHouseToken` and never changeable. The `stakersBps` leg of every launch pays into it, and
so do the Bag's Vault legs, so holding the house coin is a claim on the whole board rather than on
a single token, and no launch can build a staking economy of its own. Lock length sets the weight,
from 1x flexible to 2.5x for half a year. `stakeFor` locks the coin in somebody else's name: they
earn from minute one and cannot sell before the lock ends. `claim` is permissionless and always pays
the position's owner, so a keeper can push everybody's rewards and, when the keeper dies, anybody
else can.

Because launches pair against different assets, the vault keeps an accumulator per asset and every
position carries a debt per asset, fixed when it opens so it can never reach back into what was
paid before it existed. The asset list is capped, and only a pair the owner allowed can reach it.

**HoodTokenLock** holds creators' first buys and team legs and nothing else: no owner, no rewards,
no rescue, no way to shorten a lock. It is a separate contract precisely because the vault stopped
accepting launched tokens.

**HoodBlockZero** is a periphery over the factory for a team launch: the token is printed and every
team wallet buys in the same transaction, before anyone else can trade, and each leg is written on
chain. The factory sees it as the caller, so its buys inside the launch transaction pay no opening
tax; it adds the real launcher to the exempt list when the fee recipient is somebody else.

**HoodBridgeFactory** deploys the one lock box per token and owns it, so routes are opened through
one contract with one owner instead of a loose key per token.

## The Bag

**HoodBag** receives the protocol's share of every fee, from both machines and from every
graduated pool, and splits it by constants nobody can edit. It has no owner and no withdrawal
function; its outlets (the house, which is the treasury Safe, the Vault, Payday and the burn clock)
are immutables.

| money in | where it goes |
|---|---|
| the Bag's 30 bps of a trade | 3,333 bps to the Vault, 3,333 to Payday, the rest to the house; all of it to the Vault when the house coin itself trades |
| the graduation fee, a tenth of the raise | 2,300 bps to the dev (the launch's creator fee recipient, read from the factory at `finalize`), the rest to the burn clock; all of it to the burn clock when there is no dev |
| a boost | all of it to Payday, for the hour the boost runs |
| a launch fee | all of it to the house |
| the house coin's creator leg | half to the Vault, half to the house |

Nothing here may stop a trade. The house and the dev are pushed with a gas cap, and a refused push
is booked (`houseClaimable`, `devClaimable`) for anyone to send again. The Vault's share waits in
the Bag (`heldForVault`) until the house coin exists, then anyone can release it.

**HoodPayday** is the hourly distributor. The Bag funds the current hour; once the hour has closed,
the keeper pays it to the hour's wallets by points and sends up to a tenth into the pots of the ten
newest launches. The keeper chooses who is paid, never how much in total.

**HoodBurnClock** takes the burn share of every graduation fee. Once the owner names the house
coin and its pool, the pool's other currency becomes the clock's spend asset (ETH on mainnet), and
once an hour the keeper spends it on the coin, moving the price at most 296 ticks, and burns what it
bought. Any other asset funded to it, the burn share of a USDG or tokenised-share graduation for
example, accumulates and stays: the clock has no owner and no withdrawal.

**HoodBoosts** sells four board slots an hour, 0.005 ETH each by default, and the whole price goes
through the Bag to that hour's Payday.

**HoodPot** is a curve launch's pot: a per-share accumulator that pays the token's holders in the
quote. The token reports every balance move to it; the machine's own addresses are excluded. It is
filled by Payday's launch slice and by anyone who deposits for the holders. A direct launch's
splitter plays the same part.

## Where the money goes

On every curve trade the curve splits the 1% fee in two: the protocol's 30 bps are booked for the
Bag, the creator's 70 bps go to the fee router. The router holds them until somebody flushes, and
the flush spends them across four legs the creator fixed at launch. They are bps and they add up to
10,000, so one launch can pay its stakers, buy itself back, deepen its pool and keep a slice, all
at once:

| leg | before graduation | after graduation |
|---|---|---|
| stakers | credited to the house coin's lockers, by weight | same |
| buyback | buys off the curve, burns | swaps out of the pool with a floor, burns |
| liquidity | added to the raise, so the pool opens deeper | donated to the pool through the PoolManager |
| creator | paid to the fee recipient | same |

Every leg is floored and the last leg with a share takes the remainder, so the four always add up to
exactly what was booked and nothing is left behind in the router. A split with a buyback leg is
flushed through `flushBuyback(token, minTokensOut)` rather than `flush`, because a permissionless
buy with no floor is a gift to whoever is watching; the floor applies to the buyback leg only and
the other three do what they always do. There is no leg for charging nothing: how big the creator
fee is belongs to the preset, so a launch that wants traders to pay the protocol and nobody else
picks a preset whose `creatorFeeBps` is zero, and then nothing is ever booked to split.

At graduation the pool gets `liquidityBps` of the raise (at least 80%, enforced when a preset is
created; 90% on every preset today) plus every donation; the remainder is the graduation fee, which
goes into the Bag in the same call. The position is locked forever, and its trading fees are
collected by anyone and routed straight back into the split above.

## The direct machine

The second way to launch, and the one Argus and the current Pons both use: there is no curve, no
reserve and no migration. The entire supply goes into a single Uniswap v4 position **above** the
opening price, and buys walk the price up through it. The liquidity is real from the first block,
it is already locked, and there is no moment where a contract holds the raise and has to be trusted
to hand it over.

```
HoodPortal ─ one transaction ─┬─► HoodLaunchToken (EIP-1167 clone, creator slash and dividend sync in _update)
                              ├─► HoodRevenueSplitter (the creator's tax and 70 bps, across four roads; the pot)
                              ├─► HoodLaunchHook (mined address, taxes both sides in the quote, 30 bps to the Bag)
                              ├─► v4 pool, initialized at tickStart, hook attached
                              ├─► the whole supply as one position [tickStart → tickBond]
                              └─► HoodLocker (holds the position, cannot let go)
```

**The tax.** Fixed per side at launch, between 1% and 10%, always taken in the quote asset so the
splitter downstream only ever handles one currency. On top of it the hook takes the 1% platform
fee: 70 bps ride with the creator's tax to the splitter, 30 bps go to the Bag. When the quote is the
specified side of the swap (an exact-input buy, an exact-output sell) it is taken in `beforeSwap`;
when the quote is the unspecified side (an exact-input sell, an exact-output buy) it is taken in
`afterSwap`. All four shapes pay, and the hook refuses to serve any pool but the one the portal
opened for it. The buyback module's own buys are the launch's money coming back and pay the
creator's tax only.

**The opening tax.** The same schedule as the curve: 99% of a buy in the launch's own second,
6.18% in the next, 0.19% in the one after, then nothing, split 70 to the creator's side and 30 to
the Bag. The hook caps the creator's tax, the fee and the opening tax together at 99%. A hook only
sees the router as its caller, so the exemption is keyed on `tx.origin`: the launcher, the creator
fee recipient and up to 32 wallets named in `DirectConfig.exempt`. The portal's own buys inside the
launch transaction pay none of it. A bot in the first second pays nearly all of its edge to the
people it is racing.

**The latch.** When the price first crosses `tickBond` the launch is bonded, and that never unsets.
It is a status, not an event that moves money, because there is nothing left to move.

**The four roads.** Every unit of the creator's tax and fee lands in the splitter, which splits it
between four destinations the creator fixed at launch: their own claimable balance, a buyback pot,
a dividend accumulator for holders, and the locked liquidity. There is no protocol cut here
(`PROTOCOL_BPS` is zero): the platform's share is the 30 bps the hook sends to the Bag. Nothing has
to call in to announce money: `sweep` looks at what the contract holds, subtracts what is already
spoken for, and splits the difference, so a swap tax, a fee harvest and a stranger's donation all
behave identically. The buyback road is spent by a shared module that may move the price by about
three percent per run, once per block, and carries the rest, which is what makes running it
permissionless. The liquidity road is pushed into the locked position by a donation, and that only
goes out while the locked position is the only liquidity in range, because v4 pays a donation to
whoever is standing there.

**Dividends** are pull based, on a per-share accumulator. The token tells the splitter when a
balance moves; the pool, the locker, the hook and the splitter itself hold no share. Claiming is
permissionless and always pays the holder. The splitter is also the launch's pot, so Payday's slice
for the newest launches lands in the same accumulator.

**The creator slash.** A transfer from the creator, or from whoever currently receives the
creator's fees, into the pool is a sell, and the token moves everything they had not claimed to the
holders before the transfer goes through. The call cannot revert the transfer.

**How the tax physically leaves.** A tax on the quote as a trade's *input* is owed before that
input has been settled, so it cannot be transferred out in the same breath: the hook mints it to
itself as an ERC-6909 claim and flushes it to the splitter and the Bag at the next swap, or when
anyone calls `flushClaims`. A tax on the quote as a trade's *output* is a slice of what the pool is
paying out, which exists, so it is taken directly. This was measured, not designed: the naive
`take` in `beforeSwap` works for ETH only because the PoolManager pools every pool's ETH, and
reverts the moment the quote is an ERC-20 no other pool happens to hold.

**The creator's first buy** happens inside the launch transaction when they ask for one, swapped
straight against the PoolManager so the hook sees the portal as the caller, and the portal is never
charged the opening tax. `createTeamLaunch` does the same for a declared list of team wallets, each
leg handed to its wallet or locked in its name.

**The hook's address is mined.** Uniswap v4 keeps a hook's permissions in the low fourteen bits of
its address, so the salt is searched for until the CREATE2 address lands on them: about sixteen
thousand hashes, a tenth of a second in a browser. The portal binds the salt to the creator before
CREATE2, so miners never collide with each other and a salt in the mempool is nobody else's.
`HoodDirectDeployer.hookInitCodeHash` and `hookAddressFor(poolManager, creator, salt)` are what a
miner needs, and the portal refuses a salt that does not land.

**Which machine to use.** The curve is familiar, needs no ticks, and is the right shape when the
point is a fair price discovery into a pool. The direct machine is the right shape when the point
is a market that trades from block one and pays its holders while they hold.

## The server half

**apps/api** is one process with two jobs and two switches (`INDEXER=0`, `API=0`).

The indexer walks the chain forward in chunks, one request at a time, halving the chunk whenever
the node refuses a range. That shape is not defensive programming for its own sake: 4663 makes
100ms blocks, rejects large `eth_getLogs` ranges, rate limits parallel bursts and has no JSON-RPC
batching, so the naive loop fails on all three counts. It starts at the deployment block and never
before it.

It keeps: launches, trades, balances (from Transfer, so holder counts are exact), stakes, fee
events, the Bag's tape, pots, Payday, boosts, every opening tax paid, and points. Volume is priced
in dollars through the Chainlink ETH/USD feed on 4663, with the last good answer cached and
`HOOD_ETH_USD` as a floor, because a feed that hiccups for a minute must not quietly price a day of
trading at zero.

**Points** follow the rules in `apps/api/src/points.ts`: 500 for printing a token, once it has done
1,000 dollars of volume, 2 per dollar bought, 1 per dollar sold, and 10 per dollar locked for every
30 days it stays locked times the lock multiplier, all multiplied by the trader's rank. Locking is
the one that pays for time rather than for an event, credited by `stake-accrual.ts` on the
indexer's loop and settled when a position closes, because paying at the moment of locking was
farmable: the flexible tier unlocks in the block it locks. Rank comes from rolling 30 day volume,
Wood 1.5x to Degen 5x, so it is re-earned rather than kept. Our own contracts trade too (the factory
buys for a creator, the router buys on a buyback) and they are excluded by address: a buy is
credited to whoever ends up holding the tokens, a sell to whoever gave them up.

**apps/web** is the app. Every list, chart and holder count comes from our own indexer; every quote
and every write goes straight to the chain from the user's wallet. The chart draws market cap, not
price per token, because a token priced at 0.0000000053 ETH is a chart of zeroes.

Selling on a pool goes through the UniversalRouter, and the router never pulls an ERC-20 itself:
it asks Permit2 to. So the first sell of a token is three signatures, once each: approve the token
to Permit2, tell Permit2 the router may spend it, then the swap. A graduated curve token trades its
pool through the same box, through the graduation hook, paying the 1% fee and nothing else. After
any receipt lands the page refetches everything at once rather than waiting for a poll, and polling
continues in background tabs.

**Support** lives in the same API process (`apps/api/src/support.ts`). The help button in the app
talks to an assistant that reads the public documents in this repository, plus five tools: look a
token up, look a wallet up, read a transaction (and replay a reverted one to decode the reason),
check how far the indexer is behind, and open a ticket. Everything but the ticket is read-only, the
model never holds a key, and the ticket path works with the assistant switched off, so support is
never down because a third party is. Tickets land in Postgres; `docs/SUPPORT.md` is the FAQ the
assistant answers from, and it is written to be read by people too.

**apps/keeper** runs four loops on one wallet: `tick` (opening a pool for a curve that sold out,
pulling the protocol's legs into the Bag, flushing booked fees, collecting what a locked position
earned, sweeping and buying back on direct launches), `push` (pushing every pot's payouts to its
holders), `payday` (paying the closed hour) and `burn` (the hourly burn). Most of it is
permissionless, and if the keeper dies anybody can do it from a wallet; it just would not be
instant. Payday, the burn and curve-fee buybacks need the wallet to be appointed by the factory
owner; without it they wait, and the owner can run them itself.

**packages/sdk** is the one place that knows the ABIs, the addresses and the call shapes. The app,
the MCP server and the keeper all sit on it, so they cannot drift apart. ABIs are generated from the
Foundry artifacts by `npm run abis`, so they cannot drift from the deployed bytecode either.

**packages/mcp** is the agent surface: 36 tools, including an encrypted local keystore (AES-256-GCM,
scrypt, file mode 600) and a browser signer for the case where no key should ever touch the agent.
`AGENT_MODE=1` lets an autonomous agent act without a human confirming each transaction; without it
every write needs `confirm: true`.

## Omnichain

LayerZero V2 is live on 4663, at `0x6F47...DD5B`, eid 30416. It is NOT at the canonical
`0x1a44...` address, which is the kind of thing that costs an afternoon if you assume.

A token leaves by being locked in its adapter here and minted by a `HoodOFTRemote` there, so the
total across all chains is always the supply printed at launch. Routes to Ethereum, Arbitrum, Base,
BNB, Optimism, Polygon and Scroll resolve their libraries in both directions: eid 30416 is
registered on the canonical endpoint on all seven, and all seven are registered here. What does not
work out of the box is the verification layer. The default ULN config, **here and on every
destination alike**, names a DVN stub whose `getFee` reverts with "Please set your OApp's DVNs
and/or Executor", so an OApp that only sets a peer cannot send in either direction. Every route
needs `configureRoute` on both ends as well as `setPeer`: `script/WireRemote.s.sol` does the 4663
end, `script/DeployRemote.s.sol` deploys and configures the far end, both read before they write,
and `test/ForkRemote.t.sol` proves each end prices a real quote on a fork of the real chains.

Money coming the other way (a buyer whose funds sit on Base) goes through Relay, which lists 4663
natively for ETH and USDG. With a Relay API key the app quotes it in place; without one it hands
the user a hosted Relay link, which is the honest fallback rather than a broken button.

## What is trusted, and what is not

| thing | who can change it |
|---|---|
| a live token's curve, fees, supply, fee split, opening tax exemptions | nobody, ever |
| the Bag's splits and outlets | nobody, ever; the Bag has no owner |
| a locked first buy | nobody; the locker releases it to the creator when the time is over |
| a direct launch's taxes, allocations, ticks, opening tax exemptions | nobody, ever |
| graduated liquidity | nobody; there is no withdrawal function |
| a launch's fee recipient | only the current recipient, in one step |
| presets, launch fee, pair allow list, graduation handler for NEW launches | the factory owner |
| boost price (up to 0.05 ETH), the keeper, the house coin (once) | the factory owner |
| which chains a token may travel to | the bridge factory owner |
| the indexer, the API, the app, the keeper | anybody with the server, and none of it can move money |
