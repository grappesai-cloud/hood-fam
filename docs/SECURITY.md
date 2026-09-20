# What can go wrong, and what cannot

Nothing here has been audited. This document is what an auditor would be handed on the first day:
the trust model, the things that are impossible by construction, and the things that are merely
unlikely.

## What nobody can do

| Claim | Why it holds |
|---|---|
| Nobody can mint more of a launched token | Neither token contract has a mint function after its constructor or initializer. Omnichain travel locks supply in an adapter rather than minting against a bridge role. |
| Nobody can take a curve's reserve | `HoodCurve` has no owner, no setter and no withdrawal. Funds leave only by selling back into the curve or by graduating into the pool. |
| Nobody can pull graduated liquidity | `UniswapV4Graduator` and `HoodLocker` hold their positions and contain no transfer, decrease or rescue function. |
| Nobody can redirect a fee split or a tax split | Both are written once at launch. There is no setter, on either machine. |
| Nobody can change a live launch's economics | Every parameter is an immutable or is written once in the launch transaction. Presets are append-only. |
| The protocol's own cut cannot grow | 30 bps on the curve side and a 1,000 bps constant in the splitter, both in the code rather than in storage. |

## What the owner can do

Add presets, disable a preset for new launches, change the launch fee, change the pair allow list,
change the graduation handler for future launches, wire the portal into the registry, open or close
omnichain routes, and gate NEW direct launches (pause them, or restrict them to a whitelist for a
staged open; `canLaunch(address)` says so before anyone mines a salt). Changing the treasury reaches
future protocol claims on every direct launch, because the tenth is pulled to the portal's current
treasury, and reaches nothing else. Ownership of the portal moves in two steps. None of that reaches
a token that already exists.

**The owner is a Safe.** Safe v1.4.1, canonical deployment, at least two signers; the deploy script
on 4663 refuses an owner that is not one, and refuses a Safe one key can drive alone. The treasury is
the same Safe. The deployer key is used once and then has no role, and is never a signer of the Safe.
What that buys: no single key can add a preset, move the treasury, gate launches or open a bridge
route, and losing one signer's laptop loses nothing. What it does not buy: the signers are still the
trust boundary, and a majority of them can do everything in the list above.

## Accepted risks, named

**No audit.** Nothing here should hold money that matters until it has had one.

**The keeper key is hot.** It lives in an environment variable on the server. It can only do things
that are permissionless anyway, so the worst it can do is waste its own gas.

**Buybacks are immediate, not time-averaged, and capped in impact.** `HoodBuybackModule.run` is
permissionless. One run may move the price by at most 296 ticks (about three percent); whatever
part of the pot does not fit under that limit is carried to the next run, and a token may only be
run **once per block**. That last part is not decoration: the cap bounds one swap and `carried`
makes a run resumable, so without it a caller could chain runs inside a single transaction, walk
the whole pot up the book three percent at a time and sandwich it end to end. The keeper passes a
`minTokensOut` from a quote; a stranger passing zero is bounded by the limit and by the block, so
the worst they can do is buy a little at a slightly worse price. The pot is still visible, and a
TWAP would bound the rest.

**A donation only goes out when the launch's own position is the only thing in range.** v4 credits
a donation to whatever liquidity is in range at that instant, and says so on `IPoolManager.donate`
itself. A bot can mint a one-spacing position on the current tick (a narrow range buys a lot of
liquidity for little capital, and on the current tick's own boundary it needs one asset, not two),
call the donation, take its share and burn the position again, all inside one transaction and with
borrowed money. Measured, not argued: a bot matching the launch position's liquidity took exactly
half of the pot and paid nothing for it. So `HoodLocker.deepen` and `UniswapV4Graduator.compound`
compare the pool's in-range liquidity with the locked position's and refuse unless they agree to
within a thousandth. `canDeepen(locker)` and `canCompound(token)` say so before the gas is spent.
A pot that cannot go out stays where it is until the range is the launch's again; nothing is lost
by waiting, and nothing is lost to a stranger by not waiting.

**Graduation prices the pool itself, rather than trusting the price it finds.** The pool is opened
inside the launch transaction so nobody can open it first, but it holds no liquidity until the
curve graduates, and a swap in an EMPTY v4 pool fills nothing: it walks the price to whatever limit
it is handed, for the cost of gas. Anybody could therefore choose the price a launch's whole raise
gets minted at, and with it how much of that raise ends up in the pool at all, since the mint takes
the smaller side and the rest leaves through the fee split. `graduate` now computes the price the
raise implies, resets the pool to it (free while the pool is empty), and only accepts a price it
could not reset if that price is within five percent of the right one. If somebody has put real
liquidity in at a price further out than that, graduation waits rather than minting into it: anyone
can trade the pool back, and a mispriced position pays whoever does.

**All four swap shapes pay the tax in the quote.** Exact-input buys and exact-output sells pay in
`beforeSwap` (the quote is the specified side); exact-input sells and exact-output buys pay in
`afterSwap` (the quote is the unspecified side, whichever way it flows). An earlier version returned
early on the exact-output buy, which let a bot swapping with `amountSpecified > 0` skip the tax and
the opening surcharge; the Argus review caught it and `test/DirectSwap.t.sol` pins all four shapes.

**An exact-input order with a binding price limit is taxed on what it offered.** When the quote is
the input, the tax has to be taken in `beforeSwap`, before the pool has said how much of the order
it can fill under the caller's `sqrtPriceLimitX96`; the unfilled part is taxed all the same. Router
swaps never set a binding limit, so traders are not affected. Our own buyback module always does,
so it sizes its input to what the limit admits (in-range liquidity, or the edge tick's liquidity on
a fresh launch) rather than offering the whole pot; the limit stays on the swap as the backstop.
Volume is reported from the pool's delta in `afterSwap`, so an unfilled order never counts towards
the ticker lock. Caught by `test/DirectSwap.t.sol`: before the fix a capped buyback paid an
effective 255% and re-paid it on every carried remainder.

**The hook answers only its own pool.** Anyone can initialize a second v4 pool that names an
existing hook. Both callbacks compare the pool id with the one the portal registered and revert
`WrongPool()` otherwise, so a stranger's pool cannot latch the bond, report volume into the ticker
lock or drop unrelated tokens into the splitter.

**The protocol's tenth is pulled, never pushed.** `sweep()` books it into `protocolClaimable`;
`claimProtocol()` pays the portal's current treasury (falling back to the one pinned at launch).
The earlier design pushed it from inside `sweep()`, and every payout path calls `sweep()`, so one
treasury that rejected a transfer (an EIP-7702 delegation, a Safe with a reverting fallback, a
blacklisted stablecoin address) would have frozen holders, creators and buybacks of every launch
sharing it. Nobody else's money depends on the treasury accepting funds; tested with a treasury
that reverts.

**Hook salts are bound to the creator.** The portal hashes `(msg.sender, hookSalt)` before CREATE2,
so two people mining from zero in the same second never land on the same address and a salt seen
in the mempool is useless to anyone else. A creator relaunching from the same salt collides only
with their own earlier hook, and the miner skips used addresses.

**The opening window's hold cap applies to plain transfers.** Only selling is unrestricted while
the window is open. Otherwise a bot buys the cap from ten wallets and consolidates in the eleventh.
The buy cap is pinned to at most 1.1x the hold cap at launch, as Pons does; a buy cap far above the
hold cap is a cap on nothing.

**The ticker lock uses a tumbling 24 hour window, not a rolling one.** A token that trades heavily
across a window boundary can take two windows to trip the lock.

**The lock threshold is denominated in the pair asset, not dollars.** There is no oracle inside the
trade path. The indexer prices volume in dollars for points; the lock does not.

**Dividend dust.** The per-share accumulator floors, so a few wei per distribution stay in the
splitter forever. They are never claimable and never lost to a user.

**The launch's own first buy and its own buybacks are exempt from the snipe surcharge.** Both pay
the base tax; neither pays the opening surcharge. Those are the only exemptions, keyed on the
portal's and the buyback module's addresses rather than on an allow list somebody could be added
to (Pons's per-launch exemption lists are what its bundler bots are built on). The first buy is NOT
exempt from the window's buy cap: the creator gets the launch block, not the open.

**A hooked pool's gas moves with the clock.** The opening surcharge decays with `block.timestamp`,
so a swap's gas at execution differs from the wallet's estimate a second earlier. With a raw
estimate the swap can run out of gas inside the dividend bookkeeping and revert; measured on a
fork. The app and the SDK send router swaps with a third more gas than the estimate. Wallets that
pad estimates themselves are unaffected; a script that sends the raw estimate is not.

**Buy-side tax is held as ERC-6909 claims between swaps.** Between a buy and the next swap (or a
`flushClaims` call) the tax exists as a claim balance on the hook rather than as tokens in the
splitter. It cannot be taken by anyone, and the next swap or any caller realizes it. A launch that
sees one buy and then silence holds its tax as a claim until somebody flushes; the keeper does.

**The deployers are wired by their creator only.** `HoodDeployer` and `HoodDirectDeployer` accept
`initialize` from the account that deployed them and nobody else, so there is no window between
two deployment transactions in which a stranger could name themselves the factory or the portal.

**Third parties.** LayerZero carries omnichain messages and Relay carries cross-chain buys. Both are
failure domains outside this repo. A route that is not wired simply does not work; neither can move
funds that are not already in their path.

## Static analysis

Slither 0.11.6, run over `src/` with dependencies, tests and scripts excluded, informational and
low findings dropped. Last run 18-09-2026 against the current tree: 59 results, no high or medium
finding that is not answered below. Every high and medium finding was read and is answered here, so the next
person does not have to re-derive the verdicts.

| Detector | Count | Verdict |
|---|---|---|
| `arbitrary-send-erc20` | 1 | False positive. `PairTransfer.pull` pulls from `msg.sender` at every call site; the "arbitrary" address is the caller. |
| `arbitrary-send-eth` | 1 | False positive. `HoodFeeRouter._flush` pays the registry's creator fee recipient or the treasury, never a caller-supplied address. |
| `reentrancy-eth` | 4 | Guarded. `graduate`, `_flush`, `unstake` and `demote` are `nonReentrant` and write state before the transfer. The four splitter movers dropped off this list once the protocol tenth stopped being pushed from inside `sweep()`. |
| `reentrancy-no-eth` | 3 | Harmless. `deployAdapter` could only be re-entered by LayerZero's endpoint, and a second CREATE2 with the same salt reverts anyway. `_afterSwap` can only be reached through the PoolManager's lock. `HoodBuybackModule.run` is `nonReentrant`. |
| `incorrect-equality` | 17 | Not exploitable. They are `== 0` on amounts this contract computed, or `block.number == launchBlock`, not balance comparisons somebody can move with a donation. |
| `uninitialized-local` | 4 | False positive. Structs filled field by field, a tuple assigned by a ternary, and `released` in `run`, which is zero unless the try branch sets it. |
| `unused-return` | 27 | Accepted. `initialize`, `unlock`, `settle`, `donate` and `getSlot0` return values we do not need; each of them reverts on failure rather than returning a code. |
| `divide-before-multiply` | 2 | Intentional, both. `(MAX_TICK / spacing) * spacing` floors a tick to its spacing. The buyback's gross-up divides by the pool fee and then by the buy tax, losing at most a wei a step, which is why it ends `+ 1`: the swap must ask for at least what it needs, never a wei less. |

Slither cannot build IR for `HoodPortal._mintPosition` under via-IR and says so; that function is
covered by the fork suite and by `test/DirectSwap.t.sol` instead.

With the informational filters off, three more classes show up and all three are answered by
looking at them: `too-many-digits` on hashes of `creationCode` and on the v4 dynamic fee flag,
`cache-array-length` on a loop over a fixed-size `Tier[5]` whose length is a compile time constant,
and seven events whose address parameters are not indexed. The last one is the only real choice:
those events are read by our own indexer, which filters by contract rather than by topic, and
changing a signature now would silently break every consumer pinned to the old one. An auditor may
still raise it; the answer is that it is a cost paid once, at a version boundary, not never.

Reproduce with `slither . --filter-paths "lib/|node_modules/|test/|script/" --exclude-dependencies
--exclude-informational --exclude-optimization --exclude-low`. CI runs it on every push and posts
the report without gating, so a new finding is visible rather than blocking.

## The 4663 trap that bites payouts

On this chain, an EOA can carry an EIP-7702 delegation, and a delegated account's code can accept a
native transfer while leaving the balance unchanged. Money sent to such an address is gone as far as
the recipient is concerned.

Every address this system pays out to should be a plain EOA with no delegation, or a contract that
is known to accept the asset: the protocol treasury, a creator's fee recipient, a token's project
wallet. Check with `cast code <address>` before pinning one; anything that returns bytes starting
`0xef0100` is delegated. The curve's fee router and the direct machine's splitter both push rather
than pull, which is what makes this worth checking rather than merely interesting.

## Reporting

Nothing is deployed yet. Once it is, security contact goes here, along with the addresses that are
in scope and the ones that are deliberately not.
