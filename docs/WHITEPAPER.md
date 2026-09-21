# hood.fam

A token launchpad on chain 4663. You print a market in one transaction, it trades from the first
block, and the fees it earns are split by rules that are fixed at launch and cannot be changed
afterwards by anyone, including us. A tenth of what the protocol earns goes back to the people who
used it, every season, split by points.

This paper is the whole design: the two ways to launch, where every unit of money goes, how points
and seasons work, what is guaranteed by the absence of a function rather than by a promise, and what
is deliberately not promised at all. Every number here is one the code applies. The contracts are in
`src/`, the rules the server reads are in `apps/api/src/`, and the deeper walk-throughs are in
`docs/ARCHITECTURE.md`, `docs/AIRDROP.md` and `docs/RUNBOOK.md`.

## The chain

hood.fam runs on 4663, which makes 100ms blocks. Uniswap v4, LayerZero V2 and Chainlink feeds are
live there. A launch is a single transaction; a trade is a single transaction from the user's own
wallet. Nothing sits between a trader and the chain except their signature.

## Two ways to launch

There is a curve machine and a direct machine. They are different market shapes, not different
tiers, and a creator picks the one that fits.

### The curve machine

`HoodFactory` prints a fixed-supply token and opens its bonding curve in one transaction. Price
rises linearly with supply sold, from a start cap to a graduation cap. Every parameter is immutable
at launch: no owner, no pause, no setter, and no path to the reserve other than selling back into
the curve or graduating.

The factory can spend the creator's own money on the first buy inside the same transaction, so a
launch cannot be sniped in the gap between the token appearing and the creator buying. When the
curve sells out it stops trading and anyone may call `finalize`, which hands the pool supply and the
raise to the graduation handler.

Graduation opens a real Uniswap v4 pool, priced at the ratio the raise actually came out at, and
locks the position forever. At least 80% of the raise goes into that pool (enforced when a preset is
created); the remainder is the protocol's graduation fee. The locked position has no owner, no
transfer and no way to decrease liquidity. The lock is the absence of code, not a pledge.

The curve is the right shape when the point is fair price discovery into a pool.

### The direct machine

`HoodPortal` launches with no curve, no reserve and no migration. The entire supply goes into a
single Uniswap v4 position above the opening price, and buys walk the price up through it. The
liquidity is real and already locked from the first block. There is no moment where a contract holds
the raise and has to be trusted to hand it over.

Three defences ship in the launch itself:

- **The tax.** Fixed per side at launch, between 1% and 10%, always taken in the quote asset. All
  four swap shapes pay it, and the hook refuses to serve any pool but the one it was launched for.
- **The opening surcharge.** An extra rate at the open, decaying to nothing over a few seconds,
  capped so tax plus surcharge never exceeds 99%. A bot in the first block pays most of its edge to
  the people it is racing. The launch's own transaction is exempt.
- **The opening window.** For a configurable number of blocks, no wallet may end up holding more
  than a set share of supply or buy more than a set share out of the pool. The hold cap applies to
  plain transfers too, so a bot cannot buy from ten wallets and consolidate. Selling is never
  restricted, and every limit expires by itself.

The direct machine is the right shape when the point is a market that trades from block one and pays
its holders while they hold.

## Where the money goes

### The curve: four roads

On every curve trade the fee splits in two. The protocol leg (30 bps) goes to the treasury. The
creator leg goes to `HoodFeeRouter`, which holds it until anyone flushes it and then spends it
across four destinations the creator fixed at launch. They are bps and they add up to 10,000, so a
launch pays the house coin's lockers, buys itself back, deepens its pool and keeps a slice in whatever
proportion it chose:

| Leg | Before graduation | After graduation |
|---|---|---|
| Stakers | credited to lockers, by weight | same |
| Buyback | buys off the curve, burns | swaps out of the pool with a floor, burns |
| Liquidity | added to the raise, so the pool opens deeper | donated into the locked pool |
| Creator | paid to the fee recipient | same |

Every leg is floored and the last leg with a share takes the remainder, so the four always add up to
exactly what was booked. A launch that wants no creator fee at all picks a preset that charges none,
which is where the size of the fee belongs; the split only says where it goes.

The router has no owner and no withdrawal. Flushing is permissionless.

### The direct machine: four roads

Every unit of tax lands in a splitter. A tenth is booked for the protocol (hard coded, pulled by
`claimProtocol`, never pushed, so no treasury can freeze a holder). The rest is split across four
destinations the creator fixed at launch:

- **The creator's own claimable balance.**
- **A buyback pot,** spent by a shared module that may move the price by about 3% per run, once per
  block, which is what makes running it permissionless.
- **A dividend accumulator** paid to holders pro rata, pull based, permissionless to claim. The
  pool, the locker and the hook hold no share.
- **The locked liquidity,** pushed into the position by a donation.

Nothing has to call in to announce money. A `sweep` looks at what the contract holds, subtracts what
is already spoken for, and splits the difference, so a swap tax, a fee harvest and a stranger's
donation all behave identically.

## Locking the house coin

There is one coin to lock on this pad: the pad's own. One vault holds it, the owner names it once
and can never change it, and the stakers leg of every launch pays into that one room. A holder is
therefore paid by the whole board rather than by whichever token they happened to lock, and no
launch can promise a staking economy of its own.

Lock length sets the weight, from 1x flexible to 2.5x for half a year. `stakeFor` locks the coin in
someone else's name: they earn from the first minute and cannot sell before the lock ends. `claim`
is permissionless and always pays the position's owner, so a keeper can push everyone's rewards
and, if the keeper dies, anyone else can. Rewards arrive in whatever the paying launch traded
against, so what a position is owed is a list of assets rather than a single number.

A creator's locked first buy is not in this vault. It sits in a separate contract that pays nothing
and releases nothing early: it is a statement about the creator, not a yield.

## Points

Points are earned by using the place. The rules are the ones the indexer applies:

| Action | Points |
|---|---|
| Print a token | 500, once it has traded 1,000 dollars |
| Buy | 2 per dollar |
| Sell | 1 per dollar |
| Lock | 10 per dollar per 30 days locked, times the lock weight (1x none, 1.25x at 7 days, 1.5x at 30, 2x at 90, 2.5x at 180) |

Everything is multiplied by rank, and rank is re-earned from rolling 30 day volume, not kept:

| Rank | 30 day volume from | Multiplier |
|---|---|---|
| Wood | 0 | 1.5x |
| Bronze | 10,000 | 2x |
| Silver | 50,000 | 2.5x |
| Gold | 150,000 | 3x |
| Platinum | 500,000 | 4x |
| Degen | 1,000,000 | 5x |

Locking pays for time rather than for an act, so it is credited as it accrues, about once an hour,
and stops the moment a position closes. Paid once at the moment of locking it would be farmable: the
flexible tier unlocks in the block it locks.

**Trading against yourself does not score.** A trade by the wallet a launch's fee returns to earns
no points and does not count toward the 1,000 dollars that unlocks the print bonus. Without that
rule the cheapest points on the board would be a creator wash-trading their own token, since on the
direct machine up to 90% of the tax they pay comes straight back to them.

## Seasons and the revenue-share airdrop

The house takes a tenth. Most of it goes back to the fam at the end of every season, split by
points.

A season's pool is a share of what the protocol actually earned during that season: a tenth of every
direct-machine tax, 30 bps of every curve trade, and the part of each raise that does not enter the
pool at graduation. That money is in the treasury before a single point is paid. The pool is a fixed
percentage of it (30% by default), decided and announced before the season starts.

This is what makes it feasible rather than aspirational. A season can never distribute more than the
protocol earned. There is nothing to raise and nothing to mint, and a quiet season simply pays a
small pool. At settlement a merkle root is written on chain and funded in the same transaction, and
each wallet that earned points claims its share with a proof. A keeper can push a claim on a
wallet's behalf; the claim always pays the wallet.

**No token is promised.** Nothing here says a hood.fam token exists or will. If one ever does, it
rides the same rails: a root, a proof, a claim.

## What is guaranteed, and what is not

The guarantees are structural. They hold because the function that would break them does not exist.

| Thing | Who can change it |
|---|---|
| A live token's curve, fees, supply, fee split | nobody, ever |
| A direct launch's taxes, allocations, ticks, window | nobody, ever |
| Graduated liquidity | nobody; there is no withdrawal function |
| A launch's fee recipient | only the current recipient, in one step |
| Presets, launch fee, pair allow list, graduation handler for NEW launches | the factory owner |
| Which chains a token may travel to | the bridge factory owner |
| The indexer, API, app, keeper | anyone with the server, and none of it can move money |

The token has fixed supply, no owner and no mint function. A bridge that can mint is a supply
backdoor, so a token that travels does so by being locked in an adapter on 4663 and minted on the
far chain, and the total across all chains is always the supply printed at launch. Presets are
append only and never edited.

## Omnichain

LayerZero V2 is live on 4663 (endpoint id 30416). A token leaves by being locked in its adapter here
and minted by a remote contract there. Routes to Ethereum, Arbitrum, Base, BNB, Optimism, Polygon
and Scroll resolve in both directions; each route is configured and proven against a fork of the
real chains before it is announced. Money coming the other way, from a buyer whose funds sit on
another chain, is quoted through Relay, which lists 4663 natively.

## Security

The protocol ships with an in-house audit and penetration-test package (`docs/AUDIT.md`,
`docs/PENTEST.md`, `docs/SECURITY.md`) and a test suite that includes invariant fuzzing of the curve
(reserve solvency, supply conservation, token conservation) and of the season drop (a season never
pays out more than it was funded). A full end-to-end rehearsal (`scripts/e2e/lifecycle.mjs`) drives
the entire system on a local fork of 4663, from an empty chain to a claimed airdrop, asserting after
every step. An external audit is a decision that has not yet been made, and this paper does not claim
one.

## What this paper does not promise

- No hood.fam token, now or on a schedule.
- No fixed season pool beyond the one announced before each season; a quiet season pays little.
- No yield, no return, nothing that behaves like a security. Points buy a pro-rata share of revenue
  the protocol already earned, and nothing else.

This is not financial advice.
