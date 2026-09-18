# The season drop

The house takes a tenth. Most of it goes back to the fam at the end of every season, split by
points. This page is the whole policy: what the pool is, how it is earned, how it is paid, and what
is deliberately not promised. The calculator at `/airdrop` runs the same numbers live.

## The pool is revenue, not a promise

A season's pool is a share of what the protocol actually earned during that season:

| Source | What the protocol takes |
|---|---|
| Direct machine | a tenth of every buy and sell tax, on every launch |
| Curve machine | 30 bps of every trade |
| Graduation | the part of the raise that does not go into the pool, per preset |

That money is already in the treasury before a single point is paid out. The pool is a percentage
of it (`SEASON_POOL_BPS`, 30% by default), decided and announced before a season starts and fixed
for that season. This is the part that makes the whole thing feasible rather than aspirational: a
season can never distribute more than the protocol earned, there is nothing to raise, nothing to
mint, and a quiet season simply pays a small pool.

No token is promised. Nothing here says a hood.fam token exists or will. If one ever does, it rides
the same rails: a root, a proof, a claim.

## Points decide the split

Points are earned by using the place, and the rules are the ones the indexer actually applies
(`apps/api/src/points.ts`, and they are the same rules the leaderboard has always used):

| What you do | Points |
|---|---|
| Print a token | 500, once it has traded 1,000 dollars |
| Buy | 2 per dollar |
| Sell | 1 per dollar |
| Lock | 10 per dollar per 30 days it stays locked, times the lock (1x none, 1.25x 7 days, 1.5x 30 days, 2x 90 days, 2.5x 180 days) |

**Trading against yourself does not score.** A trade by the wallet a launch's fee comes back to (the
creator, or whoever the creator pointed the fee at) earns no points and does not count towards the
1,000 dollars that unlocks the 500 for printing. It is still a trade and it still moves the price;
it simply does not pay. Without that rule the cheapest points on the board are a creator trading
their own token: on the direct machine up to 90% of the tax they pay comes straight back to them, so
wash volume costs little more than the pool fee and the protocol's tenth.

That closes the obvious hole, not the whole question. Points are paid per dollar of volume and the
pool is divided pro rata, so a wallet that is willing to pay the real cost of trading can still buy
a larger share of a fixed pool than it contributed to earning. Two ways to settle it before a season
runs with money in it: price points on the fee actually paid rather than on volume, which makes the
farm cost exactly what it earns, or cap what any one wallet can take out of a season. Both are
decisions rather than bugs, and neither has been made.

Locking is the one that pays for time rather than for an act, and it is credited as it is earned:
about once an hour, one row per position per day, stopping the moment the position is closed. It has
to work that way. Paid once at the moment of locking, the flexible tier unlocks in the same block it
locks, so a wallet could lock, be paid, unlock and lock again for the price of gas, at roughly five
hundred times the rate of somebody buying the same amount. A lock that is opened and closed in a
block is now worth a block. An expired lock drops to 1x from the instant it expires, whether or not
anybody called the permissionless `demote`.

Everything is multiplied by your rank, and rank comes from rolling 30 day volume, so it is re-earned
rather than kept:

| Rank | 30 day volume | Multiplier |
|---|---|---|
| Wood | from 0 | 1.5x |
| Bronze | from 10,000 | 2x |
| Silver | from 50,000 | 2.5x |
| Gold | from 150,000 | 3x |
| Platinum | from 500,000 | 4x |
| Degen | from 1,000,000 | 5x |

Your share of the pool is your points divided by every point earned that season. Nothing else enters
it: not how early you were, not how much you hold, not who you know.

## Why splitting across wallets does not pay

Points per dollar are flat, but the rank multiplier is not. One wallet doing a million dollars of
volume is Degen and multiplies everything by 5. The same million split across ten wallets is ten
Silver wallets multiplying by 2.5: same volume, same fees paid, half the points. Split it a hundred
ways and they are Bronze at 2x, which is 60% fewer. Sybil is not policed here because it is not
profitable here, and that is a better defence than a rule somebody has to enforce.

Wash trading is worse. A round trip on a direct launch pays the tax twice, call it 10% of the volume
at the usual 5% a side, and the protocol keeps a tenth of that: 1% of the volume. Even if that
trader were the only wallet in the season and took the entire pool, they would get back 30% of that
1%, which is 0.3% of what they just paid 10% for. On the curve machine the numbers are smaller and
the sign is the same. Farming points by trading with yourself is a way of donating to everybody
else, which is the only version of this that is safe to leave unguarded.

Printing is worse still. The 500 lands only when the token has actually traded a thousand dollars,
so a hundred empty tokens earn nothing at all, and each one cost a launch fee to print.

## What it actually returns

There is one number worth understanding, and it falls out of the arithmetic rather than out of a
slogan. Points are proportional to volume, so your share of the season's points is roughly your
share of the season's volume. The protocol's take is also proportional to volume. Divide one by the
other and the marketing line and the maths agree:

> On average, a trader gets back the season's pool percentage of what the house took from them.

At the default 30%, a trader who paid the protocol 1,000 dollars in fees over the season gets back
about 300. Not 300 of what they traded, 300 of what the house kept. Everything above that average
comes from the two ways of earning points without paying a fee: locking, which pays 10 a dollar for
every 30 days it stays locked, times the lock multiplier, and printing, which pays 500.

A season, end to end, with round numbers:

```
season volume                       20,000,000     across both machines
the protocol's take (about 1%)         200,000     a tenth of the direct tax, 30 bps of the curve
pool at 30%                             60,000     announced before the season, fixed for it
points in the season (about)        75,000,000     volume times rank, averaged over everybody
```

A trader who buys 50,000 and sells 50,000 ends the season at Silver on rolling volume, so 2.5x:

```
buys    50,000 x 2  = 100,000
sells   50,000 x 1  =  50,000
                      -------
                      150,000 x 2.5 = 375,000 points
```

375,000 of 75,000,000 is 0.5% of the pool: 300 dollars. They paid the protocol 1,000 over the same
period, so they got 30% of it back, which is the pool percentage, which is the point.

Rank is the one place where a single number would lie. Every trade is scored at the rank the wallet
held when it landed, so a season that starts at Wood and ends at Silver is scored partly at each.
The calculator says so out loud: it shows the same activity at the rank you hold today and at the
rank the activity would reach, and the answer sits between them, closer to the top end the earlier
in the season you trade.

Lock 20,000 for 180 days on top of that and the staking line adds 20,000 x 10 x 2.5 x 2.5 = 1,250,000
points, more than triple the trading line, for a fee of nothing. That is the shape this is meant to
have: it pays for staying, not for churning.

If the season instead ends with 200 million points, the same trader holds 0.19% rather than 0.5%.
That is not the pool shrinking, it is the season growing, and a bigger season has a bigger take
behind it. The calculator adds your points to the denominator before it divides, so it never quotes
you a share of a season you have not joined yet.

## How it is paid

1. The season closes (opening the next one closes it at the same instant).
2. The indexer catches up to that timestamp, then the season is snapshotted, which freezes the
   public leaderboard for it and marks the season settled.
3. The treasury decides the pool from the season's take and the announced percentage.
4. `airdrop-cli build <season> --pool <amount>` allocates the pool pro rata over **every wallet that
   earned a point that season**, not just the leaderboard, builds a merkle tree, and stores the root
   with every wallet's proof. Rounding goes to the largest holder, so the tree sums to the pool to
   the wei.
5. `HoodSeasonDrop.openDrop` writes that root on chain and funds it in the same transaction. A
   season's root can be written once and never changed.
6. Anybody claims, for anybody: `claim(season, account, amount, proof)` always pays `account`, never
   the caller, so a bot can push claims for people who never come back and nobody can redirect one.
7. What nobody claims goes back to the treasury after the deadline, which is at least 30 days out.

The claim contract cannot be drained by its owner, cannot have a root rewritten, and cannot stop a
claim before the deadline. Those are the only three properties that matter, and they are enforced by
the absence of code rather than by a promise.

## What this is not

- Not a promise. No token, no date, no amount, no guarantee that a season pays at all.
- Not fixed. The percentage of the take is set per season, before it starts, and can differ between
  seasons.
- Not yours alone. Your share falls when other people earn points, which is exactly what the pool
  growing looks like from the inside.
- Not a rank you keep. Rolling 30 day volume decides the multiplier; stop trading and it falls.
- Not advice. Trading tokens is risky and most launches go to zero.

## For whoever runs it

The deploy and season mechanics are in `docs/RUNBOOK.md`. Two things worth deciding before the first
announcement rather than after:

- **Say the percentage before the season, not after.** The whole credibility of this rests on the
  pool being a rule instead of a decision taken once the numbers are in.
- **Revenue sharing is regulated differently from a giveaway in most places.** A pool funded from
  protocol income and paid to people for using the product is not the same legal object as a token
  distribution, and it is worth an hour with a lawyer in the jurisdiction the entity sits in before
  the first announcement.
