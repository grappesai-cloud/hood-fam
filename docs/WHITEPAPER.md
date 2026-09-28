# hood.fam

hood.fam is a token launchpad on Robinhood Chain, chain id 4663. Anyone can launch a token in one
transaction. The token trades from the first block. Every trade pays a fee of 1%. The contracts
split that fee by rules that are written in code and fixed at launch. Nobody can change the rules
of a live token afterwards. Not the creator, and not us.

This paper explains the two ways to launch, what a trade costs, and where every part of the fee
goes. Every number here is a number the contracts apply. The contracts are in `src/`, the points
rules the API applies are in `apps/api/src/points.ts`, and the practical guide is the docs page of
the app (`apps/web/app/docs/page.tsx`). This same paper is published at `/whitepaper`.

Version 4. Contracts deployed on Robinhood Chain on 29 September 2026. Launches printed on the
version 3 contracts before that day keep the rules they were launched with: those contracts are
still live, and nothing in version 4 reaches them.

## Contents

1. [What hood.fam is](#what-hoodfam-is)
2. [Two ways to launch](#two-ways-to-launch)
3. [What a trade costs](#what-a-trade-costs)
4. [The Bag](#the-bag)
5. [The token's pot](#the-tokens-pot)
6. [Payday](#payday)
7. [The Vault](#the-vault)
8. [The burn clock](#the-burn-clock)
9. [Graduation](#graduation)
10. [The opening tax](#the-opening-tax)
11. [The creator slash](#the-creator-slash)
12. [Boosts and the launch fee](#boosts-and-the-launch-fee)
13. [Referrals](#referrals)
14. [The season drop](#the-season-drop)
15. [On the chain and off the chain](#on-the-chain-and-off-the-chain)
16. [What is guaranteed and what is not](#what-is-guaranteed-and-what-is-not)
17. [Risks](#risks)
18. [Contract addresses](#contract-addresses)

## What hood.fam is

hood.fam is a place to launch a token and trade it. A launch is one transaction. The token trades
from the first block. Every trade pays a fee of 1%. The contracts split that fee by rules that are
written in code and fixed at launch.

Most of that fee goes to the creator of the token and back to the people who use the site. Traders
are paid every hour by Payday. People who lock the house coin are paid by the Vault. The holders of
each token are paid from the token's pot. When a token graduates, part of the graduation fee goes
to its creator and the rest to the burn clock, which buys the house coin and burns it. Our own
share is called the house. Each of these has a section below.

This paper says who pays, who gets paid, and when. It also says what runs on the chain and what our
off-chain service, the keeper, does. The keeper mostly calls functions that are open to anyone. Two
hourly payouts, Payday and the burn, are limited to the keeper and to the factory owner. If the
keeper stops, money does not go to the wrong place. It waits.

Two things are not live yet. The house coin has not been launched, so the Vault and the burn clock
wait for it. The Safe has not accepted ownership of the factory yet. Both are stated again in
[what is guaranteed and what is not](#what-is-guaranteed-and-what-is-not).

## Two ways to launch

A creator picks one of two shapes. They are different markets, not different tiers.

**The curve.** The factory creates a token with a fixed supply and opens a bonding curve for it. A
bonding curve is a contract that sells tokens at a price that rises as more are sold, and buys them
back along the same line. 80% of the supply is for sale on the curve. The other 20% is set aside to
seed a pool. When the curve sells out, it stops trading. Anyone can then call `finalize()`. The
token graduates: the money the curve raised and the 20% of supply go into a Uniswap v4 pool, and
that liquidity is locked forever.

**The direct pool.** The portal creates the token and puts the whole supply into a Uniswap v4 pool
in the launch transaction. There is no curve and no raise. A hook, a contract attached to the pool,
takes the fee and the creator's own tax on every swap.

Both shapes print a token with a fixed supply, no owner and no mint function. Both fix the creator's
terms at launch. Both open with the same [opening tax](#the-opening-tax). They differ in where the
price comes from. On the curve it comes from a formula until graduation. In a direct pool it comes
from the pool from block one.

## What a trade costs

Every trade pays 1% of its size, which is 100 basis points (bps). The trader pays it, in the asset
the token is priced in: ETH or USDG. The fee splits in two. 70 bps go to the creator's side. 30 bps
go to the Bag. The Bag is the contract that receives the protocol's share of every fee and splits it
by fixed rules. It has its own section.

- On a curve launch the two numbers come from the preset. Every preset today sends 70 bps to the
  creator and 30 bps to the Bag. The factory refuses a preset where the two add up to more than
  500 bps. The creator's 70 bps go to the fee router, which spends them along the four legs the
  creator fixed at launch: the house coin's lockers, a buyback of the token, deeper liquidity, and
  the creator's own wallet.
- On a direct launch, and on every graduated pool, the two numbers are hardcoded: 70 bps to the
  creator's side, 30 bps to the Bag.
- A graduated pool is a Uniswap v4 pool, and the pool charges its own fee of 0.3% on top (poolFee
  3000, tickSpacing 60). That fee accrues to the locked liquidity position. Anyone can call
  `collect` on the graduator. The token side is burned. The quote side goes to the creator's fee
  split.
- On a direct launch the creator also sets a tax of his own, from 1% to 10% per side (100 to 1,000
  bps). The trader pays it on top of the 1%. The tax and the creator's 70 bps go to the launch's
  splitter, which divides them between four legs the creator fixed at launch: the creator, a
  buyback, dividends to holders, and liquidity. The four legs add up to 100%.
- In the first three seconds of a launch, a buy also pays the [opening tax](#the-opening-tax). It is
  trading fee and splits the same way: 70 to the creator's side, 30 to the Bag. On a direct pool the
  creator's tax, the fee and the opening tax together can never take more than 99% (9,900 bps).

| Parameter | Value |
|---|---|
| Trade fee, every machine | 100 bps (1%) |
| Creator's share of the trade fee | 70 bps |
| The Bag's share of the trade fee | 30 bps |
| Cap on Bag plus creator, curve presets | 500 bps together |
| Graduated pool LP fee, on top | 0.3% (poolFee 3000, tickSpacing 60) |
| Creator tax, direct launches | 100 to 1,000 bps per side (1% to 10%) |
| Opening tax, every launch | 9,900, 618 and 19 bps of a buy in seconds 0, 1 and 2; then 0 |
| Creator tax plus fee plus opening tax, direct launches | at most 9,900 bps |
| Referral cut | at most 5,000 bps of the Bag's share, never the creator's |

## The Bag

The Bag (`HoodBag`) receives the protocol's share of every fee and splits it. Who gets paid depends
on where the money came from. The rules are constants in a library: nobody can edit them. The Bag
has no owner and no withdrawal function. The addresses it pays, the house, the Vault, Payday and the
burn clock, are set when it is deployed and cannot change.

**Trade fees.** The 30 bps the Bag receives from a trade split three ways: 3,333 bps to the Vault,
3,333 to Payday, and the rest, 3,334, to the house. Measured against the whole 1% a trade pays, that
is 10 bps to the Vault, 10 to Payday and 10 to the house. With the 70 bps that go to the creator,
the whole fee is accounted for. When the house coin itself trades, the Bag's whole share of that
trade goes to the Vault.

**Graduation fees.** When a curve graduates, a tenth of the raise is the graduation fee. It splits:
2,300 bps to the dev, and the rest, 7,700, to the burn clock. The dev is the launch's creator fee
recipient, read from the factory at the moment of graduation, so a creator who handed the fee stream
on has handed this on too. The dev's share is pushed with a gas cap. If the dev's address refuses
it, the Bag books it (`devClaimable`) and anyone can push it again later with `claimDev(dev,
asset)`. A launch with no dev address sends the whole fee to the burn clock.

**Boosts.** A boost purchase goes whole to Payday, into the hour the boost runs.

**Launch fees.** A launch fee goes whole to the house (`takeHouseFee`).

**The house coin's creator leg.** When the house coin is launched with the Bag as its creator fee
recipient, its creator leg enters the Bag through its own door (`takeHouseCoinLeg`): 5,000 bps to
the Vault, 5,000 to the house.

| Source | House | Vault | Payday | Burn clock | Dev |
|---|---:|---:|---:|---:|---:|
| Trade fee, of the Bag's 30 bps | 3,334 | 3,333 | 3,333 | 0 | 0 |
| Trade fee, measured on the whole 1% | 10 bps | 10 bps | 10 bps | 0 | 0 |
| Trade fee on the house coin's own trades | 0 | 10,000 | 0 | 0 | 0 |
| Graduation fee | 0 | 0 | 0 | 7,700 | 2,300 |
| Boosts | 0 | 0 | 10,000 | 0 | 0 |
| Launch fees | 10,000 | 0 | 0 | 0 | 0 |
| House coin creator leg | 5,000 | 5,000 | 0 | 0 | 0 |

Splits are in basis points of the row's source unless the cell says bps of the whole fee. 10,000
bps is 100%. A graduation with no dev address sends all 10,000 to the burn clock.

**While the house coin does not exist.** The Vault can only pay people who lock the house coin.
Until the coin exists, the Bag keeps the Vault's share on its own books (`heldForVault`). Anyone can
call `releaseHeld` later and move it to the Vault. A transfer to the burn clock that fails is kept
the same way (`heldForBurn`). A house payment the treasury refuses is booked in `houseClaimable` and
pushed later by anyone with `claimHouse`. Nothing is lost and nothing can be withdrawn by anyone.

## The token's pot

Every token has a pot. The pot is the contract that pays the token's holders. On a curve launch the
pot is a `HoodPot`. On a direct launch the revenue splitter plays the pot. Either way the pot works
the same. It keeps a per-share accumulator: every deposit is divided over the eligible supply, and
each holder's claim grows with the balance they hold. The token calls `syncBalances` on the pot on
every balance move, so the books are always current. A deposit that arrives while nobody is
eligible is credited at the next sync.

Some addresses never earn: the curve, the graduator, the pot itself, the first-buy locker, the
staking contract, the PoolManager and the hook. Everybody else who holds the token earns from the
pot.

What fills a pot:

- Payday's slice for the ten most recent launches.
- The dividends leg of the creator's allocations, on a direct launch that has one.
- The creator slash on a direct launch: every unclaimed creator fee, when the creator sells.
- Anyone else: `depositForHolders` is open, and the money goes to the holders whole.

How holders are paid: `claim(account)` is permissionless. Anyone can call it for any holder, and the
money always goes to that holder. `pushMany(accounts, floor)` is permissionless too. It pays every
listed holder whose claim is above the floor. The keeper calls it every 5 minutes with a floor of
0.0001 ETH (1e14 wei), and the keeper pays the gas. A holder whose claim is below the floor waits
until it grows past it, or claims it himself.

## Payday

Payday (`HoodPayday`) pays traders every hour. An epoch is one hour. After an hour closes, the
keeper, or the factory owner, calls `pay` for that hour, once per hour per asset. One payout covers
at most 500 wallets and 10 pots. Up to 10% (1,000 bps) of the hour's money goes to the pots of the
ten most recent launches, so the holders of the newest tokens get a bonus. The rest goes to wallets
in proportion to their points for that hour. Anything not paid carries into the next hour. Claims
under the dust floor of 1e13 wei are not paid. A wallet that refuses a payment is booked (`owed`) and
can be paid later by anyone with `claimOwed`.

The keeper chooses who is on the list. It cannot choose how much an hour pays in total: an hour
pays at most what it holds, and never twice.

What pays into Payday: 10 bps of every trade, a third of the Bag's 30, and every boost, into the
hour the boost runs.

Points are computed off the chain by our API, from the trades, launches, locks and referrals it
indexes. They are not a token and not a balance. They only decide how an hour's Payday, and a
season's drop, split between wallets.

| What you do | Points |
|---|---|
| Launch a token | 500, credited only after the token has done 1,000 USD of volume |
| Buy | 2 per dollar |
| Sell | 1 per dollar |
| Lock the house coin | 10 per dollar per 30 days locked, times the lock multiplier |
| Bounty | 1, for holding a token at the moment somebody paid its opening tax or its creator was slashed |
| Rank | multiplies the rows above by 1.5x to 5x, set by your 30-day volume |
| Referral | 10% of the trading points of the wallet you referred, on top of theirs, not multiplied |

| Rank | 30-day volume from (USD) | Multiplier |
|---|---:|---:|
| Wood | 0 | 1.5x |
| Bronze | 10,000 | 2x |
| Silver | 50,000 | 2.5x |
| Gold | 150,000 | 3x |
| Platinum | 500,000 | 4x |
| Degen | 1,000,000 | 5x |

## The Vault

The Vault (`HoodStaking`) pays people who lock the house coin. The house coin is the platform's own
token. It has not launched yet. When it does, the factory owner sets it in the Vault once, and after
that it cannot change. The Vault stakes only that coin. Until then the Vault holds nothing, and its
share of every fee waits in the Bag.

| Lock | Multiplier |
|---|---:|
| Flexible, no lock | 1x |
| 7 days | 1.25x |
| 30 days | 1.5x |
| 90 days | 2x |
| 180 days | 2.5x |

A lock longer than 365 days reverts. A lock between two tiers gets the multiplier of the tier it
reached, rounded down. The multiplier is the weight of the position when rewards are shared out.

What pays in:

- The Bag's Vault legs: 10 bps of every trade, the Bag's whole 30 bps of every trade of the house
  coin itself, and half of the house coin's creator leg.
- The stakers leg of the curve fee router, when a curve creator chose to send part of his share to
  the Vault.

Rewards arrive in up to 8 assets, native ETH, USDG and any quote asset a token trades in, through
`notifyReward`. A position is owed a list of assets, not one number.

`claim(id)` is permissionless and pushes every asset to the owner of the position, never to the
caller. Rewards that arrive while nothing is staked go to the first staker. A position can be
unstaked only after its unlock time. `demote(id)` is permissionless after unlock and resets the
position to 1x, so an expired lock does not keep its weight.

The first-buy locker (`HoodTokenLock`) is a separate contract. It holds a creator's own first buy
for 7, 30, 90 or 180 days. It earns nothing. It is a statement about the creator, not a yield.

## The burn clock

The burn clock (`HoodBurnClock`) buys the house coin and burns it. The factory owner names the
house coin and the pool it trades in once (`setHouseCoin`). The other currency of that pool becomes
the clock's spend asset, which on mainnet is ETH. Once an hour, called by the keeper or the factory
owner, the clock spends its balance of that asset on the house coin and burns what it bought. A burn
may move the pool's price by at most 296 ticks, which is about 3%. What does not fit waits for the
next hour. The coin is burned through `burn()` when it has one, or by sending it to `0x...dEaD`.

The clock spends only its spend asset. Any other asset funded to it, for example the burn share of a
graduation priced in USDG or in a tokenised share, accumulates and stays in the clock forever: the
clock has no owner and no withdrawal function. That money is out of circulation, but it never buys
and burns the house coin.

Until the factory owner sets the house coin, every burn reverts with `NoHouseCoin`. The money waits.

What pays into the burn: 77% of every graduation fee, and all of it when the launch has no dev
address.

## Graduation

A curve graduates when it sells out. The curve stops trading, and anyone can call `finalize()`. The
pool was already prepared at launch, so nobody can open it at a wrong price before graduation. At
graduation the price is pinned to the ratio the raise came out at. If the pool already has
liquidity from somebody else, the pin must land within a 5% band of the pool's price. The liquidity
is full range. The position NFT stays in the graduator, which has no transfer function and no
decrease-liquidity function. The lock is the absence of code, not a promise.

The graduation fee is the part of the raise that does not go into the pool. The factory requires at
least 8,000 bps of the raise to go to liquidity. Every preset today keeps 9,000 bps for the pool, so
the fee is a flat tenth of the raise. It goes to the Bag in the same call: 23% to the dev, 77% to the
burn clock.

After graduation the token trades on its pool, through the graduation hook. Every trade pays the 1%
fee (70 bps to the creator's fee split, 30 to the Bag) and the pool's own 0.3% fee, and nothing else.
The pool fee accrues to the locked position. Anyone can call `collect`: the token side is burned and
the quote side goes to the creator's fee split.

| Preset | Quote | Start cap | Graduation cap | Raise, about | To liquidity | Graduation fee | To the dev | To the burn clock |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| 0 | ETH | 1.1 ETH | 11.025 ETH | 4.85 ETH | 4.365 ETH | 0.485 ETH | 0.11155 ETH | 0.37345 ETH |
| 1 | ETH | 2 ETH | 40 ETH | 16.8 ETH | 15.12 ETH | 1.68 ETH | 0.3864 ETH | 1.2936 ETH |
| 2 | USDG | 5,500 USDG | 55,125 USDG | 24,250 USDG | 21,825 USDG | 2,425 USDG | 557.75 USDG | 1,867.25 USDG |

Every preset: supply 1,000,000,000; 80% on the curve; 20% reserved to seed the pool; 9,000 bps of
the raise to liquidity; trade fee 1%, of which 70 bps to the creator and 30 bps to the Bag. The
burn share of preset 2 is USDG, which the burn clock holds and never spends (see
[the burn clock](#the-burn-clock)).

## The opening tax

Every launch opens the same way, on both machines. It is not a setting, and no creator can change
it. A buy pays the opening tax on top of the trade fee, by how many seconds have passed since the
launch block:

| Seconds after the launch | Opening tax |
|---:|---:|
| 0, the launch's own second | 9,900 bps (99%) |
| 1 | 618 bps (6.18%) |
| 2 | 19 bps (0.19%) |
| 3 and later | 0 |

- Buys only. A seller never pays it.
- It is trading fee. It splits like the rest of the fee: 70 to the creator's side, 30 to the Bag.
- On a direct pool the creator's tax, the 1% fee and the opening tax together never take more than
  9,900 bps; the opening tax is cut to fit.
- Exempt for the whole window: the wallet that launched, the creator fee recipient, and up to 32
  more wallets the creator names at launch. The list is on the chain from the launch transaction on
  and cannot change.
- On the curve the exemption follows the wallet that receives the tokens. On a direct pool it
  follows the wallet that sent the transaction (`tx.origin`), because the pool's hook only sees the
  router; a wallet behind a smart-account relayer is seen as the relayer.
- Buys made inside the launch transaction itself, the creator's first buy and a team launch's
  legs, never pay it.

Who pays: the bots that buy in the first seconds. Who gets it: the creator's side and the Bag, as
fee. When: in the same trade.

## The creator slash

The creator slash exists on direct launches. When the creator, or whoever currently receives the
creator's fees, sells into the pool, every unclaimed creator fee moves to the holders' accumulator
in the same transaction. The holders get paid. The creator gets nothing from it. A creator who wants
to keep his fees does not sell into his own pool.

## Boosts and the launch fee

The launch fee is 0.002 ETH on both machines. The factory owner and the portal owner can raise it,
up to a cap of 0.01 ETH. The creator pays it in the launch transaction. It goes 100% to the house.

A boost is a paid slot on the board for one hour. Boosts (`HoodBoosts`) sell 4 slots per hour. The
default price is 0.005 ETH; the factory owner can set it, up to 0.05 ETH. A slot can be bought for
the current hour or the next one. One token can hold one slot per hour. The whole price goes through
the Bag to Payday, into the hour the boost runs: the traders who show up while the coin is boosted
are the ones paid for it.

## Referrals

There are two referral systems, one on the chain and one off it.

On the chain, the owner can set a referral cut per token in the referrals registry: a referrer
address and a share, at most 5,000 bps of the Bag's share of that token's fees on the curve or on
its direct pool. A graduated pool's fee pays no referral cut. The cut only ever comes from the
protocol's side. It never touches the creator's 70 bps or a holder's dividends.

Off the chain, a wallet that arrives through your referral link is tied to you. You earn 10% of that
wallet's trading points, on top of theirs, not out of theirs. Referral points are not multiplied by
rank.

## The season drop

The season drop (`HoodSeasonDrop`) is a share of what the protocol earned in a season, split by
points. Off the chain, the pool is 30% of the season's protocol take. On the chain it works like
this:

- A season is a Merkle tree: every wallet with points has a leaf with its amount.
- The owner opens a season and funds it in the same transaction. A season is never opened empty.
- A season stays open for at least 30 days.
- Claims are permissionless. Anyone can claim for anyone, and the money always goes to the listed
  account.
- After the deadline the owner can sweep what was not claimed back to the treasury.
- There is no rescue function. The owner cannot take funds out of an open season.

No token is promised. The drop pays in the assets the protocol earned. A quiet season pays a small
pool.

## On the chain and off the chain

The contracts hold the money and apply the rules. The keeper is our off-chain service. It calls the
contracts on a schedule and pays the gas. The API is our indexer: it reads the chain and computes
points.

| What | Where it runs | Who can do it |
|---|---|---|
| Fee splits, the Bag's rules, pots, the opening tax and its exemptions | On the chain | Nobody can change them |
| Pushing pot payouts to holders | On the chain; the keeper calls `pushMany` every 5 minutes with a 0.0001 ETH floor | Anyone |
| Payday for a closed hour | On the chain; the keeper calls `pay` every hour | The keeper or the factory owner |
| The hourly burn | On the chain; the keeper calls it every hour | The keeper or the factory owner |
| `finalize`, `collect`, `claim`, `claimDev`, `claimHouse`, `claimOwed`, `demote`, `releaseHeld` | On the chain | Anyone |
| Points, ranks, the leaderboard, referral points, dollar prices | Off the chain, in the API | Us. The API can be rebuilt from the chain, but it is not the chain. |
| A season's Merkle root | Built off the chain, written on the chain | The owner opens and funds it |

If the keeper stops, holders can claim from their pots themselves, and anyone can push for them.
Payday and the burn wait for the keeper or the owner; the money stays where it is until then.

## What is guaranteed and what is not

Guaranteed by the absence of code:

- The Bag has no owner and no withdrawal function. Its rules are constants. Its outlets are
  immutable.
- A token has a fixed supply, no owner and no mint function.
- A live token's fees, taxes, opening tax exemptions and allocations cannot be changed by anyone.
- Graduated liquidity is locked. The graduator has no transfer function and no decrease-liquidity
  function.
- The burn clock has no owner and no withdrawal function. What it holds leaves only as a burn.
- A pot pays its holders and nobody else. Claims are permissionless and always pay the holder.
- The season drop has no rescue function. Claims always pay the listed account.

Not guaranteed:

- Points are off the chain. The API computes them, and the keeper submits the list Payday pays. The
  contract only limits how much an hour can pay.
- The house coin is not launched. The Vault and the burn clock wait for it. The Vault's share waits
  in the Bag; the burn share waits in the clock.
- The Safe has not accepted ownership yet. The deployer wallet still owns the factory, the portal,
  the referrals registry and the bridge factory.
- The factory owner can change things for new launches only: presets, the launch fee (up to 0.01
  ETH), the pair allow list, the graduation handler, the boost price (up to 0.05 ETH), referral cuts
  (up to 5,000 bps of the Bag's share), the keeper address, and the house coin, once. The owner
  cannot touch a live token, the Bag, or locked liquidity.
- The keeper's timing. A push every 5 minutes and a payout every hour are what we run, not what the
  chain enforces.
- Nothing here promises a price, a yield or a return.

## Risks

- Most tokens go to zero. A launch is somebody else's token, not ours. Check the address before you
  buy.
- A creator's terms are fixed but they can be harsh: a tax of up to 10% per side on a direct pool.
  Every launch charges 99% on a buy in its first second. Read the token page first.
- Contracts can have bugs. This paper does not claim an independent audit.
- The keeper can be late. Payouts that depend on it wait until it, or the owner, calls.
- Points and the season pool are a score and a policy, not a balance owed to you.
- Robinhood Chain is a young chain with 100 ms blocks. The public RPC can lag or refuse a request,
  and the app can show stale numbers while it catches up. The chain is authoritative.
- The house coin does not exist yet. Nothing here promises it a date, a price or a yield.

## Contract addresses

Robinhood Chain, chain id 4663. Deployed on 29 September 2026; the first receipt is in block
75134585. Source is verified on the chain's Blockscout explorer.

| Contract | Address |
|---|---|
| Factory (HoodFactory) | `0x14226252c5C5526c76Ec1370246c77d108dBfb4B` |
| The Bag (HoodBag) | `0x471EE5dA3fD9B9C8B186B7e9DAD72270463e36d3` |
| Payday (HoodPayday) | `0xA76759C5818cAFa348071027Fc6cD903adA81195` |
| Burn clock (HoodBurnClock) | `0xA542876A28d9954e88922785bE70D79B18a8Fc4F` |
| Boosts (HoodBoosts) | `0xADE405A64379C5A2A00cE84A4af61bB0b0ec42D0` |
| Graduation hook | `0x4ff4F5175c9057E40413068bBE6F4c55D45000cC` |
| Portal (direct launches) | `0x8f9F4221b211549bE2F06a2bAFa05DE089182c77` |
| Block zero (HoodBlockZero) | `0xeD04C668C53de1EEa4cB5361014C90C731739c0E` |
| The Vault (HoodStaking) | `0xdC5af0613e5f2B5fBcFC2131dc93E6FF4cbB118D` |
| Fee router (HoodFeeRouter) | `0xd2c0c656d7395248eD7B4F08d64D247Fe0bb63aa` |
| Referrals (HoodReferrals) | `0x91F7766c60c621940ce8360999Debec8ddA9078b` |
| Graduator (UniswapV4Graduator) | `0x057180612d111E36075893a9dD816E028662069D` |
| Curve router (HoodCurveRouter) | `0xb88dB2C54f8087E521F06321429389B02ba152eD` |
| First-buy locker (HoodTokenLock) | `0xDb249D05570B60CF2C923938Ba5def9048AA65E5` |
| Bridge factory (HoodBridgeFactory) | `0xdB1Caff9854973959f38bB7096EE1b8Ed6f25902` |
| Direct deployer (HoodDirectDeployer) | `0xd49EF209d1C1c5AdDD8065A884a7037e3A4fA340` |
| Launch token implementation (HoodLaunchToken) | `0xc2E2d993A45b398981DBfa1064BEC78F74D48F7F` |
| Buyback module (HoodBuybackModule) | `0x4ea89c4c8bD249d9958586602Cde6ebc4EA2D94F` |
| Season drop (HoodSeasonDrop), deployed on its own and unchanged by version 4 | `0x44a085d3a3e79d132f7468cc7d53308c8cb715b0` |

The owner and the treasury are the Safe `0x1f22d71cab5ce344B711C4090fd0f8A0aa5bac2E`. The version
3 contracts stay live for the launches printed on them; their factory is
`0x2b9c1f6667e05b68a5d1ab697710afc97a1949b5` and their portal
`0xf3541ace9098775b812df2ff7acebaeecb5aef9e`.

External:

| Contract | Address |
|---|---|
| Uniswap v4 PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` |
| Uniswap v4 PositionManager | `0x58daec3116aae6D93017bAAea7749052E8a04fA7` |
| USDG (6 decimals) | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` |

Pending: the house coin is not set in the Vault or the burn clock. The Safe has not accepted
ownership; the deployer wallet still owns the factory, the portal, the referrals registry and the
bridge factory. The accept is one Safe batch, `npm run safe -- accept`.

This paper is not financial advice.
