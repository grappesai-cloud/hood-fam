# bags.fam

bags.fam is a token launchpad on Robinhood Chain, chain id 4663. Anyone can launch a token in one
transaction. The token trades from the first block. Every trade pays a fee of 1%. The contracts
split that fee by rules that are written in code and fixed at launch. Nobody can change the rules
of a live token afterwards. Not the creator, and not us.

This paper explains the two ways to launch, what a trade costs, and where every part of the fee
goes. Every number here is a number the contracts apply. The contracts are in `src/`, the points
rules the API applies are in `apps/api/src/points.ts`, and the practical guide is the docs page of
the app (`apps/web/app/docs/page.tsx`). This same paper is published at `/whitepaper`.

Version 3. Contracts deployed on Robinhood Chain on 25 September 2026.

## Contents

1. [What bags.fam is](#what-bagsfam-is)
2. [Two ways to launch](#two-ways-to-launch)
3. [What a trade costs](#what-a-trade-costs)
4. [The Bag](#the-bag)
5. [The token's pot](#the-tokens-pot)
6. [Payday](#payday)
7. [The Vault](#the-vault)
8. [The burn clock](#the-burn-clock)
9. [Graduation and Confetti](#graduation-and-confetti)
10. [Penalties and the creator's options](#penalties-and-the-creators-options)
11. [King of the hill](#king-of-the-hill)
12. [The sniper auction](#the-sniper-auction)
13. [The creator slash](#the-creator-slash)
14. [Boosts and the launch fee](#boosts-and-the-launch-fee)
15. [Referrals](#referrals)
16. [The season drop](#the-season-drop)
17. [On the chain and off the chain](#on-the-chain-and-off-the-chain)
18. [What is guaranteed and what is not](#what-is-guaranteed-and-what-is-not)
19. [Risks](#risks)
20. [Contract addresses](#contract-addresses)

## What bags.fam is

bags.fam is a place to launch a token and trade it. A launch is one transaction. The token trades
from the first block. Every trade pays a fee of 1%. The contracts split that fee by rules that are
written in code and fixed at launch.

Most of that fee goes back to the people who use the site. The holders of each token are paid from
the token's pot. Traders are paid every hour by Payday. People who lock the house coin are paid by
the Vault. The burn clock buys the house coin and burns it. Our own share is called the house. Each
of these has a section below.

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
takes the fee and the creator's optional tax on every swap. The creator can also switch on
penalties, a sniper auction and king of the hill. Each is explained below.

Both shapes print a token with a fixed supply, no owner and no mint function. Both fix the creator's
terms at launch. They differ in where the price comes from. On the curve it comes from a formula
until graduation. In a direct pool it comes from the pool from block one.

## What a trade costs

Every trade pays 1% of its size, which is 100 basis points (bps). The trader pays it, in the asset
the token is priced in: ETH or USDG. The fee splits in two. 30 bps go to the creator. 70 bps go to
the Bag. The Bag is the contract that receives the protocol's share of every fee and splits it by
fixed rules. It has its own section.

- On a curve launch the two numbers come from the preset. Every preset today sends 70 bps to the
  Bag and 30 bps to the creator. The factory refuses a preset where the two add up to more than
  500 bps.
- On a direct launch, and on every graduated pool, the two numbers are hardcoded: 30 bps to the
  creator, 70 bps to the Bag.
- A graduated pool is a Uniswap v4 pool, and the pool charges its own fee of 0.3% on top (poolFee
  3000, tickSpacing 60). That fee accrues to the locked liquidity position. Anyone can call
  `collect` on the graduator. The token side is burned. The quote side goes to the creator's fee
  split.
- On a direct launch the creator can add a tax of his own, from 1% to 10% per side (100 to 1,000
  bps). The trader pays it on top of the 1%. The creator fixed at launch how it splits between four
  legs: the creator, a buyback, dividends to holders, and liquidity. The four legs add up to 100%.
  The tax and the snipe surcharge together can never take more than 99% (9,900 bps).
- Penalties can apply on top of all of this, in the cases listed in the
  [penalties section](#penalties-and-the-creators-options).

| Parameter | Value |
|---|---|
| Trade fee, every machine | 100 bps (1%) |
| Creator's share of the trade fee | 30 bps |
| The Bag's share of the trade fee | 70 bps |
| Cap on Bag plus creator, curve presets | 500 bps together |
| Graduated pool LP fee, on top | 0.3% (poolFee 3000, tickSpacing 60) |
| Creator tax, direct launches | 100 to 1,000 bps per side (1% to 10%) |
| Creator tax plus snipe surcharge | at most 9,900 bps |
| Referral cut | at most 5,000 bps of the Bag's share, never the creator's |

## The Bag

The Bag (`HoodBag`) receives the protocol's share of every fee and splits it. Who gets paid depends
on where the money came from. There are four rules, and they are constants in a library: nobody can
edit them. The Bag has no owner and no withdrawal function. The addresses it pays, the house, the
Vault, Payday and the burn clock, are set when it is deployed and cannot change.

**Rule 1: trade fees.** The 70 bps the Bag receives from a trade split four ways: 4,286 bps to the
Vault, 1,429 to Payday, 1,429 to the burn clock, and the rest, 2,856, to the house. Measured against
the whole 1% a trade pays, that is 30 bps to the Vault, 10 to Payday, 10 to the burn, and 20 to the
house. With the 30 bps that go to the creator, the whole fee is accounted for.

**Rule 2: graduation fees.** When a curve graduates, the part of the raise that does not go into
the pool is the graduation fee. It splits: 5,000 bps to the house, 2,500 to Confetti, 2,500 to the
Vault. Confetti is the graduation bonus paid into the token's pot, so the people holding the token
at that moment receive it. If the token has no pot, the Confetti share goes to the Vault instead.

**Rule 3: penalties.** A penalty is a charge on a specific behaviour: sniping, dumping early, or
moving the price too far in one sell. 8,000 bps of every penalty go to the holders, through the
token's pot, or through the Vault if the creator chose "penalties to vault". 2,000 bps go to the
Bag. The Bag splits its 2,000 as 5,000 to the house, 2,500 to Payday and 2,500 to the burn. There
is no Vault leg on a penalty.

**Rule 4: launch fees and boosts.** A launch fee and a boost purchase go 100% to the house
(`takeHouseFee`).

**The house coin's own trades.** When the house coin trades, its trade leg into the Bag splits
5,000 bps to the Vault and 5,000 to the burn. Nothing of it goes to the house.

| Source | House | Vault | Payday | Burn | Confetti |
|---|---:|---:|---:|---:|---:|
| Trade fee, of the Bag's 70 bps | 2,856 | 4,286 | 1,429 | 1,429 | 0 |
| Trade fee, measured on the whole 1% | 20 bps | 30 bps | 10 bps | 10 bps | 0 |
| Graduation fee | 5,000 | 2,500 | 0 | 0 | 2,500 |
| Penalties, the Bag's 2,000 bps | 5,000 | 0 | 2,500 | 2,500 | 0 |
| Launch fees and boosts | 10,000 | 0 | 0 | 0 | 0 |
| House coin trade leg | 0 | 5,000 | 0 | 5,000 | 0 |

Splits are in basis points of the row's source unless the cell says bps of the whole fee. 10,000
bps is 100%. Confetti with no pot goes to the Vault.

**While the house coin does not exist.** The Vault can only pay people who lock the house coin, and
the burn clock can only burn it. Until the coin exists, the Bag keeps the Vault's share on its own
books (`heldForVault`). Anyone can call `releaseHeld` later and move it to the Vault. A burn that
fails is kept the same way (`heldForBurn`). Nothing is lost and nothing can be withdrawn by anyone.

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

- Confetti, a quarter of the graduation fee, at the moment the token graduates.
- Penalties: 8,000 bps of every one, unless the creator chose "penalties to vault". On a direct
  launch with king of the hill on, part of that share goes to the king pot instead.
- The dividends leg of the creator's tax, on a direct launch that has one.
- Half of the winning bid of the sniper auction, on a direct launch that ran one.
- Payday's slice for the ten most recent launches.
- The creator slash on a direct launch: every unclaimed creator fee, when the creator sells.

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
under the dust floor of 1e13 wei are not paid.

The keeper chooses who is on the list. It cannot choose how much an hour pays in total: an hour
pays at most what it holds, and never twice.

What pays into Payday: 10 bps of every trade (rule 1) and a quarter of the Bag's 2,000 bps of every
penalty (rule 3), which is 5% of every penalty.

Points are computed off the chain by our API, from the trades, launches, locks and referrals it
indexes. They are not a token and not a balance. They only decide how an hour's Payday, and a
season's drop, split between wallets.

| What you do | Points |
|---|---|
| Launch a token | 500, credited only after the token has done 1,000 USD of volume |
| Buy | 2 per dollar |
| Sell | 1 per dollar |
| Lock the house coin | 10 per dollar per 30 days locked, times the lock multiplier |
| Bounty | 1, for holding a token at the moment a bot paid a penalty on it |
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

- The Bag's Vault legs: 30 bps of every trade, a quarter of every graduation fee, and half of the
  house coin's own trade leg.
- The stakers leg of the curve fee router, when a curve creator chose to send part of his share to
  the Vault.
- Penalties on a token whose creator chose "penalties to vault".
- Confetti from a graduated launch that has no pot.

Rewards arrive in up to 8 assets, native ETH, USDG and any quote asset a token trades in, through
`notifyReward`. A position is owed a list of assets, not one number.

`claim(id)` is permissionless and pushes every asset to the owner of the position, never to the
caller. Rewards that arrive while nothing is staked go to the first staker. A position can be
unstaked only after its unlock time. `demote(id)` is permissionless after unlock and resets the
position to 1x, so an expired lock does not keep its weight.

The first-buy locker (`HoodTokenLock`) is a separate contract. It holds a creator's own first buy
for 7, 30, 90 or 180 days. It earns nothing. It is a statement about the creator, not a yield.

## The burn clock

The burn clock (`HoodBurnClock`) buys the house coin and burns it. There is one burn per asset per
hour, called by the keeper or the factory owner. A burn may move the pool's price by at most 296
ticks, which is about 3%. What does not fit waits for the next hour. The clock spends only the asset
the house coin's pool is quoted in. Any other asset it was funded with stays in the clock forever:
it has no owner and no withdrawal function. The coin is burned through `burn()` when it has one, or
by sending it to `0x...dEaD`.

Until the factory owner sets the house coin once (`setHouseCoin`), every burn reverts with
`NoHouseCoin`. The money waits.

What pays into the burn: 10 bps of every trade, a quarter of the Bag's 2,000 bps of every penalty,
and half of the house coin's own trade leg.

## Graduation and Confetti

A curve graduates when it sells out. The curve stops trading, and anyone can call `finalize()`. The
pool was already prepared at launch, so nobody can open it at a wrong price before graduation. At
graduation the price is pinned to the ratio the raise came out at. If the pool already has
liquidity from somebody else, the pin must land within a 5% band of the pool's price. The liquidity
is full range. The position NFT stays in the graduator, which has no transfer function and no
decrease-liquidity function. The lock is the absence of code, not a promise.

The graduation fee is the part of the raise that does not go into the pool. The factory requires at
least 8,000 bps of the raise to go to liquidity. On presets 0 and 2 it is 9,000 bps, so the fee is
10% of the raise. On preset 1 it is 9,500 bps, so the fee is 5%. The fee goes to the Bag and follows
rule 2: half to the house, a quarter to the Vault, a quarter to Confetti. Confetti is paid into the
token's pot at that moment, so everyone holding the token when it graduates gets a share.

After graduation the token trades on its pool. Every trade pays the 1% fee (30 bps to the creator,
70 to the Bag) and the pool's own 0.3% fee. The pool fee accrues to the locked position. Anyone can
call `collect`: the token side is burned and the quote side goes to the creator's fee split. If the
creator set a jeet tax or a whale tax at launch, they wake up now, applied by the graduation hook.

| Preset | Quote | Start cap | Graduation cap | Raise, about | To liquidity | Graduation fee |
|---|---|---:|---:|---:|---:|---:|
| 0 | ETH | 1 ETH | 10 ETH | 4.4 ETH | 9,000 bps | 10% of the raise |
| 1 | ETH | 2 ETH | 40 ETH | 16.8 ETH | 9,500 bps | 5% of the raise |
| 2 | USDG | 5,000 USDG | 50,000 USDG | 22,000 USDG | 9,000 bps | 10% of the raise |

Every preset: supply 1,000,000,000; 80% on the curve; 20% reserved to seed the pool; trade fee 1%,
of which 70 bps to the Bag and 30 bps to the creator.

## Penalties and the creator's options

A penalty is an extra charge on a specific behaviour. The creator sets each one at launch, and none
can change afterwards. Every penalty splits the same way: 8,000 bps to the holders, through the
token's pot or through the Vault if the creator chose "penalties to vault", and 2,000 bps to the
Bag, which splits its part half to the house, a quarter to Payday and a quarter to the burn.

| Name | Who pays | Who gets it | Limits |
|---|---|---|---|
| Snipe tax (direct only) | A buyer in the first seconds after launch | 8,000 bps holders, 2,000 bps the Bag | Starts at the creator's rate and decays quadratically to zero over up to 600 seconds. The app's default is 50% over 3 seconds. Tax plus snipe surcharge never above 9,900 bps. |
| Opening window caps (direct only) | Nobody. A buy over the cap reverts. | Nobody | Lasts up to 1,200 blocks, about 2 minutes at 100 ms blocks; default 30 blocks. Per-wallet hold cap and buy cap; the buy cap is at most 1.1x the hold cap. |
| Jeet tax | A seller who sells within the window after buying | 8,000 bps holders, 2,000 bps the Bag | At most 2,500 bps. The window is at most 1 hour after the buy. |
| Whale tax | A seller whose sell moves the price more than the creator's tick limit | 8,000 bps holders, 2,000 bps the Bag | At most 2,500 bps. The tick limit is at most 2,000 ticks. A graduated pool with penalties refuses exact-output sells. |
| King of the hill (direct only) | Comes out of the holders' share of every penalty | The king, when the timer runs out | Up to 5,000 bps of the holders' 8,000. Timer 60 seconds. |
| Penalties to vault | Same payers as above | The Vault instead of the token's pot | On or off, chosen at launch. |

A curve launch has no penalties while it is on the curve. The jeet tax and the whale tax the
creator chose apply after graduation, on the pool. The snipe tax, the opening window, king of the
hill, the sniper auction and the creator slash exist only on direct launches.

## King of the hill

King of the hill is an option on direct launches. When it is on, up to half (5,000 bps) of the
holders' share of every penalty goes into the king pot instead of the token's pot. A buy takes the
crown only if it is worth at least a hundredth of the pot. The crown holds for 60 seconds after the
last crowned buy. When the timer runs out, the king takes the pot. Anyone can settle it. Then the
pot starts filling again as penalties come in.

Who pays: the people who pay penalties. Who gets paid: the last wallet crowned. When: 60 seconds
after the last crown, once somebody settles.

## The sniper auction

The sniper auction is an option on direct launches. The creator's own launch block is his. The
auction sells the first slot after it to the highest bidder, instead of to the fastest bot. The
window runs for up to 300 blocks after the launch block. While it is open, nobody can buy from the
pool.

- Bids are in the launch's quote asset. For a native quote the minimum bid is the launch fee.
- Each bid must beat the last one by 5%.
- The bidder who was outbid is refunded on the spot. If the refund cannot be delivered, it is
  booked and can be taken with `claimRefund`.
- After the window closes, the winner alone may receive tokens from the pool for 20 blocks.
- Anyone can settle once the window has closed. Half of the winning bid goes to the token's pot for
  the holders. Half goes to the locker as liquidity.
- If nobody bids, the pool simply opens after the window.

## The creator slash

The creator slash exists on direct launches. When the creator, or whoever currently receives the
creator's fees, sells into the pool, every unclaimed creator fee moves to the holders' accumulator
in the same transaction. The holders get paid. The creator gets nothing from it. A creator who wants
to keep his fees does not sell into his own pool.

## Boosts and the launch fee

The launch fee is 0.002 ETH. The factory owner can raise it, up to a cap of 0.01 ETH. The creator
pays it in the launch transaction. It goes 100% to the house.

A boost is a paid slot on the board for one hour. Boosts (`HoodBoosts`) sell 4 slots per hour. The
default price is 0.005 ETH; the factory owner can set it, up to 0.05 ETH. A slot can be bought for
the current hour or the next one. One token can hold one slot per hour. All proceeds go to the
house.

## Referrals

There are two referral systems, one on the chain and one off it.

On the chain, the owner can set a referral cut per token in the referrals registry: a referrer
address and a share, at most 5,000 bps of the Bag's share of that token's fees. The cut only ever
comes from the protocol's side. It never touches the creator's 30 bps or a holder's dividends.

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
| Fee splits, the Bag's rules, pots, penalties, the auction, king of the hill | On the chain | Nobody can change them |
| Pushing pot payouts to holders | On the chain; the keeper calls `pushMany` every 5 minutes with a 0.0001 ETH floor | Anyone |
| Payday for a closed hour | On the chain; the keeper calls `pay` every hour | The keeper or the factory owner |
| The hourly burn | On the chain; the keeper calls it every hour | The keeper or the factory owner |
| `finalize`, `collect`, auction and king settle, `claim`, `demote`, `releaseHeld` | On the chain | Anyone |
| Points, ranks, the leaderboard, referral points, dollar prices | Off the chain, in the API | Us. The API can be rebuilt from the chain, but it is not the chain. |
| A season's Merkle root | Built off the chain, written on the chain | The owner opens and funds it |

If the keeper stops, holders can claim from their pots themselves, and anyone can push for them.
Payday and the burn wait for the keeper or the owner; the money stays where it is until then.

## What is guaranteed and what is not

Guaranteed by the absence of code:

- The Bag has no owner and no withdrawal function. Its four rules are constants. Its outlets are
  immutable.
- A token has a fixed supply, no owner and no mint function.
- A live token's fees, taxes, penalties and options cannot be changed by anyone.
- Graduated liquidity is locked. The graduator has no transfer function and no decrease-liquidity
  function.
- The burn clock has no owner and no withdrawal function.
- A pot pays its holders and nobody else. Claims are permissionless and always pay the holder.
- The season drop has no rescue function. Claims always pay the listed account.

Not guaranteed:

- Points are off the chain. The API computes them, and the keeper submits the list Payday pays. The
  contract only limits how much an hour can pay.
- The house coin is not launched. The Vault and the burn clock wait for it. Their shares wait in
  the Bag.
- The Safe has not accepted ownership yet. The deployer wallet still owns the factory, the portal,
  the referrals registry and the bridge factory.
- The factory owner can change things for new launches only: presets, the launch fee (up to 0.01
  ETH), the boost price (up to 0.05 ETH), referral cuts (up to 5,000 bps of the Bag's share), the
  keeper address, and the house coin, once. The owner cannot touch a live token, the Bag, or locked
  liquidity.
- The keeper's timing. A push every 5 minutes and a payout every hour are what we run, not what the
  chain enforces.
- Nothing here promises a price, a yield or a return.

## Risks

- Most tokens go to zero. A launch is somebody else's token, not ours. Check the address before you
  buy.
- A creator's terms are fixed but they can be harsh: a tax of up to 10% per side, penalties of up
  to 25%, and a snipe tax that starts high in the first seconds. Read the token page first.
- Contracts can have bugs. This paper does not claim an independent audit.
- The keeper can be late. Payouts that depend on it wait until it, or the owner, calls.
- Points and the season pool are a score and a policy, not a balance owed to you.
- Robinhood Chain is a young chain with 100 ms blocks. The public RPC can lag or refuse a request,
  and the app can show stale numbers while it catches up. The chain is authoritative.
- The house coin does not exist yet. Nothing here promises it a date, a price or a yield.

## Contract addresses

Robinhood Chain, chain id 4663. Deployed on 25 September 2026; the first receipt is in block
72198515. Source is verified on the chain's Blockscout explorer.

| Contract | Address |
|---|---|
| Factory (HoodFactory) | `0x2b9c1f6667e05b68a5d1ab697710afc97a1949b5` |
| The Bag (HoodBag) | `0xf4ed44190cbf3ea597d6fa03855d402df42bd628` |
| Payday (HoodPayday) | `0x2ea48bbb382bfbe42088dfd1fcdaf4a0b8cff643` |
| Burn clock (HoodBurnClock) | `0x5603461f0b0264571d03a07fb32d70d95e4b9b96` |
| Boosts (HoodBoosts) | `0x8ed549aa479221ece612ce26d0f5b5d724114efb` |
| Graduation hook | `0x06f9fe8109867a22dd98d063ed43ea19b3d880cc` |
| Portal (direct launches) | `0xf3541ace9098775b812df2ff7acebaeecb5aef9e` |
| Opening auction (the sniper auction) | `0x7e1c0ab8ec48d529ecf44931684520062da7b930` |
| The Vault (HoodStaking) | `0xb24f6ee86438df7ac5d28fe04c7b77e04e2b4415` |
| Fee router (HoodFeeRouter) | `0x9208de8d02bf8b1d9a7c8c24668fc89320d4a677` |
| Referrals (HoodReferrals) | `0x64c006bb7f86a1d11f0b84b84b1d823bd6ce3f9a` |
| Graduator (UniswapV4Graduator) | `0x35e7982fd3511296a649598361f8707d63534b55` |
| Curve router (HoodCurveRouter) | `0x901d9591fae99e10e4754a86bc3006f835347619` |
| First-buy locker (HoodTokenLock) | `0x194a2bc75bdd337a92278e3b11279b2d25b11d35` |
| Bridge factory (HoodBridgeFactory) | `0x2b90021cf4ad2306c9f21f4ba4914cc55329634e` |
| Direct deployer (HoodDirectDeployer) | `0xc8cdd635bd6c524d57e12918bee0c754555f6523` |
| Launch token implementation (HoodLaunchToken) | `0x69e83e0bfae1967f6267f65d1f9dee61df2da7e5` |
| Buyback module (HoodBuybackModule) | `0x1f2db6dc21d9c643d8406da1d2c3d7ef125cb047` |
| Season drop (HoodSeasonDrop) | `0x44a085d3a3e79d132f7468cc7d53308c8cb715b0` |

External:

| Contract | Address |
|---|---|
| Uniswap v4 PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` |
| Uniswap v4 PositionManager | `0x58daec3116aae6D93017bAAea7749052E8a04fA7` |
| USDG (6 decimals) | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` |

Pending: the house coin is not set in the Vault or the burn clock. The Safe has not accepted
ownership; the deployer wallet still owns the factory, the portal, the referrals registry and the
bridge factory.

This paper is not financial advice.
