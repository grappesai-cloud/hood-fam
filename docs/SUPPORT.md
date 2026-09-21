# Support

How support works on hood.fam, and the answers to the questions that come up. The assistant in the
app reads this file, so a wrong sentence here becomes a wrong answer there. Keep it exact.

## How support works

There is an assistant in the app (the help button, bottom right). It reads the public documents in
this repository, and it can look up a token, a wallet or a transaction on the chain and in our own
indexer, so it answers from the receipt rather than from memory. It cannot move money, sign, or
change anything on chain, and it never asks for a private key.

When it cannot resolve something, or you ask for a person, it opens a ticket with a contact you
give it (email, Telegram or X). A person replies to that contact. The ticket form also works on its
own when the assistant is offline.

There is no other support channel that can act on your account. Anyone in a group chat claiming to
be hood.fam support and asking you to connect a wallet, sign a message, or share a seed phrase is
not us.

## Two machines

Every token on hood.fam was launched on one of two machines, chosen by its creator:

- **Curve.** Buyers trade against a bonding curve until the raise fills, then the raise and the
  reserved supply go into a Uniswap v4 pool and the position is locked forever. Phases: on the
  curve, sold out (waiting for graduation), graduated.
- **Direct.** The whole supply is in a Uniswap v4 pool from the first block, above the opening
  price. There is no curve and no event that moves liquidity; the token counts as graduated once its
  price first crosses the graduation tick (the contracts call this "bonded"), which changes what the
  board shows and nothing else. Trades on direct tokens pay the creator's buy and sell tax through a
  hook on the pool.

The token page says which machine a token is on. Most "why is X different from Y" questions come
down to this.

## Buying and selling

**My buy on a direct token failed right after launch.** The first block of a direct launch is the
creator's only. After that, for a number of blocks the creator chose, one wallet can hold at most
5% of the supply and one buy can be at most 5.5% of the supply. Buys that break either cap revert.
The token page shows whether the opening window is still on. Wait a few seconds or buy less.

**My buy failed with a slippage error.** Direct tokens carry a snipe surcharge that starts high and
decays over the creator's chosen window, on top of the normal tax. Right after launch the effective
tax can be far above the headline number, so an amount-out floor set from the headline tax fails.
The trade box reads the live tax from the hook; if you set slippage yourself, allow for the current
surcharge shown on the page.

**The transaction ran out of gas.** Swaps through a hooked pool need more gas than a wallet's
estimate, because the tax decays block by block and the estimate is taken a few blocks before the
trade lands. The app pads the estimate by 30%. If you sent the transaction from another interface,
add gas.

**Selling a direct token asks for two approvals.** Sells go through the Universal Router, which
pulls tokens through Permit2. The first approval lets Permit2 spend the token, the second lets the
router use Permit2. Both are once per token. A sell that reverts with an allowance error is missing
one of them.

**The buy went through but the token does not show on the board.** The board is fed by our
indexer, which follows the chain a few blocks behind. Blocks are 100 milliseconds apart, so "a
minute behind" is 600 blocks. Refresh; if it is still missing after a few minutes, share the
transaction hash.

**I bought and the price on the chart is nothing like what I paid.** Curve prices are quoted per
token in the pair asset with 18 decimals, and early curve prices are very small numbers. The chart
shows market cap for that reason. Compare market caps, not raw prices.

**Can I buy from another chain?** Yes, through the bridge page. A cross-chain buy quotes a route
and lands the token in the same wallet on Robinhood Chain. If in-app quotes are unavailable, the
page links to the bridge provider directly.

## Points, quests, referrals and your crowd

**How do I earn points?** Print a token (500, once it has traded a thousand dollars), buy (2 per
dollar), sell (1 per dollar), lock the house coin (10 per dollar per 30 days, times the lock), bring
somebody (a tenth of what they earn trading), and finish a quest (what the card says). Everything
bought with dollars is multiplied by your rank; a referral share and a quest are not.

**What are quests?** Nine things worth doing, at `/quests`. Progress is read off the chain by our
indexer, so nothing is claimed by asking: a quest turns claimable when the thing actually happened.
Claim pays every finished quest at once, once per wallet per season.

**How does a referral work?** Your link is `/?ref=<your address>` and your code is your own address,
so anybody can check on chain who they are about to be tied to. When a wallet that arrived through it
signs in and ties itself, you earn a tenth of what it earns by trading, on top of its points rather
than out of them. It counts only trades made after the tie, a wallet can be tied once and never
re-pointed, and two wallets cannot bring each other.

**What is Following?** A list of wallets whose public trades you want to see in one feed, plus the
launches you are watching. Nothing there can trade for you: "copy this trade" opens that launch with
the trade box ready, and you still sign it yourself.

**Can I be told when a launch moves?** Turn alerts on from `/following`. They are browser
notifications drawn from the same live stream the board reads, for the launches on your watchlist
only. Nothing is pushed from our side and nothing is stored: close the tab and they stop.

**What is the profit board?** `Top traders → Profit` ranks wallets by what they made trading on this
pad: banked profit plus what is still open, marked at the last traded price. It is built from a cost
basis we keep per wallet and launch, from trades on this pad alone — tokens that arrived by plain
transfer have no price we know, so they enter at zero cost and read as pure profit when sold. It is
all-time, because realised profit does not belong to a window.

**Signing in.** One signature, no account, good for a week. It proves the wallet is yours; it moves
nothing and costs nothing, and the same signature covers chat, follows, the watchlist, quests and
referrals.

## Fees, taxes and where the money goes

**Curve tokens.** Every trade pays 1%: 30 bps to the treasury as the protocol fee, 70 bps to the fee
router as the launch's own share. What happens to the creator fee is the fee split, chosen at launch and never
editable. It is four shares that add up to the whole, so a token can do several of these at once:

- Staking rewards: paid to people who locked the **house coin**, the one coin this pad's vault
  accepts, weighted by amount and lock length. It is not the launched token: every launch that pays
  a stakers leg pays into that same room, and until the house coin exists a launch cannot choose
  this leg at all.
- Buyback and burn: buys the token back and burns it.
- Liquidity: deepens the pool (added to the raise before graduation, donated to the pool after).
- Creator keeps: paid to the creator's fee recipient.

A token whose preset charges no creator fee has no creator fee at all; only the protocol's 30 bps
is paid.

Fees sit in the router until somebody flushes them. Flushing is permissionless, our keeper does it
regularly, and anyone can call it.

**Direct tokens.** Trades pay the creator's buy tax and sell tax (1% to 10% per side, chosen at
launch, plus the decaying snipe surcharge early on). Every shape of trade pays it, including
exact-output orders. 10% of every tax goes to the protocol. The other 90% is split by the creator's
allocation across four destinations: the creator's wallet, dividends to holders, a buyback that
burns, and liquidity. Allocations are set at launch and cannot be changed.

**The buyback spent only part of the pot.** One buyback run may move the price by about three
percent; whatever does not fit under that limit is carried to the next run. That is what keeps a
run safe for anyone to trigger. The token page shows the carried amount when there is one.

**Where are my dividends?** Dividends on direct tokens are pull-based: they accrue to your balance
and you claim them from the token page (a "claim" button appears when there is something to claim).
They do not expire. If you sold everything, claim what accrued while you held; nothing new accrues
after.

**Where are my creator fees?** For a curve token on the "creator keeps" model: in the fee router
until a flush, then in the fee recipient wallet. For a direct token: the creator's share of the
tax is held by the token's revenue splitter and released to the creator wallet on each distribution.
Check the token page's fees panel; if the splitter shows an unaccounted balance, a sweep is due and
anyone can trigger it.

**Can the creator change the tax or the allocations later?** No. Both are immutable after launch.
The creator fee recipient of a curve token can be transferred to another address by the current
recipient; nothing else is editable.

**Can the team or the creator pull the liquidity?** No. Curve liquidity is minted into a position
with no withdrawal function. Direct liquidity sits in a locker that can harvest fees and deepen the
position but cannot remove it. There is no admin key that reaches into an existing token.

## Launching

**What does it cost to launch?** A fixed launch fee in ETH, shown on the launch page, plus gas.
Optionally the creator buys first, inside the same transaction, so nobody can front-run the launch.

**Why was my ticker rejected?** A token that did enough volume inside 24 hours locks its ticker and
its artwork for 48 hours. The check is case-insensitive. Pick another ticker or wait.

**Why is the token image not showing?** Images are referenced by URL or IPFS hash and served
through a public gateway. A brand new IPFS upload can take a few minutes to propagate. If the URL
is a private link, it will not render for anyone else.

**I launched and the page 404s.** The launch is on chain the moment the transaction confirms; the
board needs the indexer to reach that block. The page retries by itself. Give it a minute.

**The launch form says the hook address is taken.** Direct launches mine a hook address in the
browser, and the address is tied to your wallet, so only one of your own earlier launches can be in
the way. The form skips used addresses on its own; if it still fails, refresh and try again.

## Locking

There is one coin to lock here: the pad's own. Locking it pays you a share of the stakers leg of
every launch that sends one, not of one token. No other token can be locked, by anyone, anywhere.
Locks: none (1x), 7 days (1.25x), 30 days (1.5x), 90 days (2x), 180 days (2.5x). Rewards come from
the creator fee of the launches that pay, arrive in whatever those launches trade against, and are
claimable at any time. You cannot withdraw before the lock ends. Somebody can lock in your name (a
"sent stake"); you earn from the first minute and cannot sell before it unlocks.

A creator's locked first buy is a different thing: it sits in the locker, earns nothing, and comes
back to the creator when the time is up. It is there to prove they are not selling into you.

When a lock expires the position keeps earning at 1x; anyone can demote it, which is expected.

## The season drop

At the end of a season the protocol distributes a pool to that season's points holders, pro rata.
The pool is a share of what the protocol actually earned that season (a tenth of the direct
machine's tax, 30 bps of curve trades), announced before the season starts. No token is promised,
no date is promised, and a season that earns little pays little.

`/airdrop` shows the pool so far, the points in the season, and a calculator: put in what you would
trade, print and lock, and it shows what that is worth as a range, because every trade is scored at
the rank you held when it landed. When a season has been split, the same page shows your claim.

**Why is my number a range?** Rank comes from rolling 30 day volume. The low end scores everything
at the rank you hold today, the high end at the rank the activity would reach. Reality is between.

**Why did my share fall?** Somebody else earned points. Your share is your points over everybody's,
so it moves when the season grows. The pool usually grew too, since both follow volume.

**When can I claim?** When the season is closed, snapshotted and split. The page says which of those
has happened. A claim is permissionless: anyone can send yours, and it always pays your wallet.

**Nothing to claim?** Either that season has not been split yet or your wallet earned no points in
it. Both say so on the page.

## Points and ranks

Points are awarded per season for trading volume, launches and staking. A launch earns its 500 the
first time the token trades 1,000 dollars, not when it is created, so printing an empty token earns
nothing. Ranks go from Wood to Degen and are recomputed from rolling 30 day volume. Trades made by our own contracts (buybacks,
harvests, the launch's first buy) never score, and neither do trades where the recipient is one of
our contracts. Points update when the indexer sees the trade, so they lag the chain by the same
few blocks the board does.

## Bridge and omnichain

Tokens can be made omnichain through LayerZero. Bridging locks the token on Robinhood Chain and
mints a mirror on the destination. A route must be configured for the destination first; if the
bridge page lists no destination for a token, the route is not open yet. A bridge that has not
arrived after ten minutes is usually waiting on the destination chain's verifiers; share the source
transaction hash in a ticket.

## Wallets and safety

**Which wallet works?** Any injected browser wallet on Robinhood Chain (chain id 4663). The app
adds the network when you connect.

**Payouts to my address never arrive.** On this chain an address can carry an EIP-7702 delegation.
Some delegated accounts accept a native transfer and leave the balance unchanged, so money sent to
them is lost. If your address shows code starting with 0xef0100 on the explorer, remove the
delegation or use a plain address for fee recipients and creator wallets.

**I think I was scammed.** hood.fam never messages you first, never asks you to sign anything
outside the app, and never needs your seed phrase. If you signed something unexpected, revoke
approvals and move funds to a fresh wallet. Report the token and the address in a ticket; we can
flag it on the board but cannot reverse a transaction.

## What support cannot do

Reverse or refund a transaction, change a token's parameters, unlock a stake early, delist a token
from the chain, or tell you whether to buy or sell anything. Nothing here is financial advice.
