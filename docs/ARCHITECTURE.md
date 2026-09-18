# How hood.fam works

Five moving parts. Three of them are on chain and cannot be changed after a launch; two of them run
on a server and can be replaced at any time without anybody's money noticing.

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
   HoodFactory ─ deploys ─► HoodToken + HoodCurve ─ graduates ─► UniswapV4Graduator ─► v4 pool
        │                          │                                     │
        │                          └── fees ──► HoodFeeRouter ──► one of five models
        │                                                │
        └── registry, presets, copycat lock              ├─► HoodStaking (lock, 1x to 2.5x)
                                                         ├─► buy back and burn
   HoodBridgeFactory ─► HoodOFTAdapter (lock box) ─► LayerZero ─► other chains
                                                         ├─► deepen the liquidity
                                                         └─► pay the creator
```

## The chain half

**HoodFactory** prints a token and opens its curve in one transaction. It holds the presets
(append only, never edited), the registry, and the copycat lock. It can also spend the creator's
own money on the first buy inside the same transaction, so a launch cannot be sniped in the gap
between the token appearing and the creator buying.

**HoodDeployer** holds the bytecode of the token and of the curve and nothing else. It exists
because a factory that inlines `new Token()` and `new Curve()` carries both creation codes in its
own runtime code: ours came out 27,037 bytes against a 24,576 limit, so it could not be deployed at
all. Measured with `forge build --sizes`, and there is a test that keeps it measured.

**HoodToken** is fixed supply, has no owner and has no mint function. That is not an omission. A
bridge that can mint is a supply backdoor, so the token travels through a lock box instead.

**HoodCurve** is one launch's market. Price rises linearly with supply sold, from the start cap to
the graduation cap. Every parameter is an immutable set at launch: no owner, no pause, no setter,
and no path to the reserve other than selling back into the curve or graduating into the pool.
When the curve sells out it stops trading and anyone may call `finalize`, which hands the pool
supply and the raise to the graduation handler. Graduation is deliberately a separate call: a pool
deployment that reverts must never be able to hold the last buy of a curve hostage.

**UniswapV4Graduator** opens the pool, keeps the position forever and hands its fees back to the
fee model. It has no owner, no transfer and no way to decrease liquidity. The lock is the absence
of code, not a promise. It also opens the pool inside the LAUNCH transaction, at the price the raise
is heading for, because anybody can open a v4 pool for any pair at any price and one stranger with
one transaction could otherwise brick or drain every launch on the platform. Opening it is not the
whole defence, because an open pool with no liquidity in it still has a price anybody can walk
anywhere for the cost of gas: at graduation the handler pins the price back to the ratio the raise
actually came out at, so the position is minted where the money says it belongs.

**HoodFeeRouter** books the creator leg of every trading fee and spends it along the model the
creator chose. It has no owner and no withdrawal. Flushing is permissionless.

**HoodStaking** is one vault for every launch. Lock length sets the weight, from 1x flexible to
2.5x for half a year. `stakeFor` locks tokens in somebody else's name: they earn from minute one
and cannot sell before the lock ends. `claim` is permissionless and always pays the position's
owner, so a keeper can push everybody's rewards and, when the keeper dies, anybody else can.

**HoodBridgeFactory** deploys the one lock box per token and owns it, so routes are opened through
one contract with one owner instead of a loose key per token.

## Where the money goes

On every trade the curve splits the fee in two: the protocol leg goes to the treasury, the creator
leg goes to the fee router. The router holds it until somebody flushes, and the flush does whatever
the creator picked at launch:

| model | before graduation | after graduation |
|---|---|---|
| staking | credited to lockers, by weight | same |
| buyback | buys off the curve, burns | swaps out of the pool with a floor, burns |
| liquidity | added to the raise, so the pool opens deeper | donated to the pool through the PoolManager |
| creator | paid to the fee recipient | same |
| zero | nothing is ever booked | same |

At graduation the pool gets `liquidityBps` of the raise (at least 80%, enforced when a preset is
created) plus every donation; the remainder is the protocol's graduation fee. The position is locked
forever, and its trading fees are collected by anyone and routed straight back into the model above.

## The direct machine

The second way to launch, and the one Argus and the current Pons both use: there is no curve, no
reserve and no migration. The entire supply goes into a single Uniswap v4 position **above** the
opening price, and buys walk the price up through it. The liquidity is real from the first block,
it is already locked, and there is no moment where a contract holds the raise and has to be trusted
to hand it over.

```
HoodPortal ─ one transaction ─┬─► HoodLaunchToken (EIP-1167 clone, opening window in _update)
                              ├─► HoodRevenueSplitter (10% protocol, 90% across four roads)
                              ├─► HoodLaunchHook (mined address, taxes both sides in the quote)
                              ├─► v4 pool, initialized at tickStart, hook attached
                              ├─► the whole supply as one position [tickStart → tickBond]
                              └─► HoodLocker (holds the position, cannot let go)
```

**The tax.** Fixed per side at launch, between 1% and 10%, always taken in the quote asset so the
splitter downstream only ever handles one currency. When the quote is the specified side of the
swap (an exact-input buy, an exact-output sell) it is taken in `beforeSwap`; when the quote is the
unspecified side (an exact-input sell, an exact-output buy) it is taken in `afterSwap`. All four
shapes pay, and the hook refuses to serve any pool but the one the portal opened for it.

**The opening surcharge.** An extra rate at the open, decaying quadratically to nothing over a few
seconds, capped so launch tax plus surcharge never exceeds 99%. A bot in the first block pays most
of its edge to the people it is racing. The launch's own transaction is exempt.

**The opening window**, from Pons: the launch block belongs to the creator, and for a configurable
number of blocks after it no wallet may end up holding more than `maxHoldBps` of supply or buy more
than `maxBuyBps` of it out of the pool. The hold cap applies to plain transfers too, or a bot would
buy from ten wallets and consolidate; selling is never restricted, every limit expires by itself,
and setting the window to zero blocks disables all of it including the launch block rule. It lives
in the token's `_update`, which is the only place that sees every movement.

**The latch.** When the price first crosses `tickBond` the launch is bonded, and that never unsets.
It is a status, not an event that moves money, because there is nothing left to move.

**The four roads.** Every unit of tax lands in the splitter, which books a tenth for the protocol
(hard coded, not a setter; pulled by `claimProtocol`, never pushed, so no treasury can freeze a
holder) and splits the rest between four destinations the creator fixed at launch: their own
claimable balance, a buyback pot, a dividend accumulator for holders, and the locked liquidity.
Nothing has to call in to announce money: `sweep` looks at what the contract holds, subtracts what
is already spoken for, and splits the difference, so a swap tax, a fee harvest and a stranger's
donation all behave identically. The buyback road is spent by a shared module that may move the
price by about three percent per run, once per block, and carries the rest, which is what makes
running it permissionless. The liquidity road is pushed into the locked position by a donation, and
that only goes out while the locked position is the only liquidity in range, because v4 pays a
donation to whoever is standing there.

**Dividends** are pull based, on a per-share accumulator. The token tells the splitter when a
balance moves; the pool, the locker, the hook and the splitter itself hold no share. Claiming is
permissionless and always pays the holder.

**How the tax physically leaves.** A tax on the quote as a trade's *input* is owed before that
input has been settled, so it cannot be transferred out in the same breath: the hook mints it to
itself as an ERC-6909 claim and flushes it to the splitter at the next swap, or when anyone calls
`flushClaims`. A tax on the quote as a trade's *output* is a slice of what the pool is paying out,
which exists, so it is taken directly. This was measured, not designed: the naive `take` in
`beforeSwap` works for ETH only because the PoolManager pools every pool's ETH, and reverts the
moment the quote is an ERC-20 no other pool happens to hold.

**The creator's first buy** happens inside the launch transaction when they ask for one, swapped
straight against the PoolManager so the hook sees the portal (exempt from the surcharge) and the
token sees the creator (whom the launch block belongs to). The window's buy cap applies to it all
the same: first dibs, not the whole open. A first buy the cap cannot allow reverts the launch.

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
events, and points. Volume is priced in dollars through the Chainlink ETH/USD feed on 4663, with
the last good answer cached and `HOOD_ETH_USD` as a floor, because a feed that hiccups for a minute
must not quietly price a day of trading at zero.

**Points** follow the rules in `apps/api/src/points.ts`: 500 for printing a token, 2 per dollar
bought, 1 per dollar sold, and 10 per dollar locked for every 30 days it stays locked times the lock
multiplier, all multiplied by the trader's rank. Locking is the one that pays for time rather than
for an event, credited by `stake-accrual.ts` on the indexer's loop and settled when a position
closes, because paying at the moment of locking was farmable: the flexible tier unlocks in the block
it locks. Rank comes from rolling 30 day volume, Wood 1.5x to Degen 5x, so it is re-earned
rather than kept. Our own contracts trade too (the factory buys for a creator, the router buys on a
buyback) and they are excluded by address: a buy is credited to whoever ends up holding the tokens,
a sell to whoever gave them up.

**apps/web** is the app. Every list, chart and holder count comes from our own indexer; every quote
and every write goes straight to the chain from the user's wallet. The chart draws market cap, not
price per token, because a token priced at 0.0000000053 ETH is a chart of zeroes.

Selling on a pool goes through the UniversalRouter, and the router never pulls an ERC-20 itself:
it asks Permit2 to. So the first sell of a token is three signatures, once each: approve the token
to Permit2, tell Permit2 the router may spend it, then the swap. A graduated curve token trades its
pool through the same box, with no hook and no tax. After any receipt lands the page refetches
everything at once rather than waiting for a poll, and polling continues in background tabs.

**Support** lives in the same API process (`apps/api/src/support.ts`). The help button in the app
talks to an assistant that reads the public documents in this repository, plus five tools: look a
token up, look a wallet up, read a transaction (and replay a reverted one to decode the reason),
check how far the indexer is behind, and open a ticket. Everything but the ticket is read-only, the
model never holds a key, and the ticket path works with the assistant switched off, so support is
never down because a third party is. Tickets land in Postgres; `docs/SUPPORT.md` is the FAQ the
assistant answers from, and it is written to be read by people too.

**apps/keeper** does only what is permissionless anyway: opening a pool for a curve that sold out,
pushing booked fees, collecting what a locked position earned. If it dies, anybody can do its work
from a wallet. It just would not be instant.

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
| a live token's curve, fees, supply, fee model | nobody, ever |
| a direct launch's taxes, allocations, ticks, window | nobody, ever |
| graduated liquidity | nobody; there is no withdrawal function |
| a launch's fee recipient | only the current recipient, in one step |
| presets, launch fee, pair allow list, graduation handler for NEW launches | the factory owner |
| which chains a token may travel to | the bridge factory owner |
| the indexer, the API, the app, the keeper | anybody with the server, and none of it can move money |
