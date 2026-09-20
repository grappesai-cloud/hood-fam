# The audit pack

What an auditor gets on day one, so the first week is spent reading code rather than asking what
this is. The trust model and the accepted risks live in [SECURITY.md](SECURITY.md); this is scope,
logistics and where to look hardest.

## What is in scope

Everything under `src/`: 4,596 lines of Solidity, eighteen deployable contracts, no proxies, no
upgradeability, no pausing except a gate on NEW direct launches.

| Contract | Lines | Deployed size | What it is |
|---|---|---|---|
| `direct/HoodPortal.sol` | 558 | 16,635 | the direct machine's door: one transaction that deploys a token, mines nothing, opens a v4 pool and locks the position |
| `graduation/UniswapV4Graduator.sol` | 443 | 13,423 | curve graduation into a locked v4 position, permissionless fee collection, compounding |
| `HoodFactory.sol` | 507 | 14,413 | the registry and the launch transaction for the curve machine; presets, pairs, econ hash, the creator's locked first buy |
| `direct/HoodLaunchHook.sol` | 334 | 7,425 | the v4 hook that taxes both sides of a swap, including the opening surcharge and the hold limits |
| `HoodCurve.sol` | 323 | 8,769 | the bonding curve: exact-in and exact-out buys, sells, fees, graduation |
| `direct/HoodRevenueSplitter.sol` | 256 | 5,448 | the four-way split of the tax, the protocol tenth, dividends |
| `HoodStaking.sol` | 267 | 5,938 | one vault for every launch, lock multipliers, permissionless claim and demote |
| `HoodSeasonDrop.sol` | 221 | 4,445 | merkle claim per season, funded in the same call that publishes the root |
| `direct/HoodBuybackModule.sol` | 200 | 6,094 | permissionless buyback, capped in price impact, resumable |
| `HoodFeeRouter.sol` | 215 | 5,970 | the four-way split of the creator fee leg, permissionless flush, no owner and no withdrawal |
| `direct/HoodLocker.sol` | 158 | 4,518 | holds the direct machine's position for good; harvest and deepen only |
| `omnichain/HoodBridgeFactory.sol` | 141 | 14,486 | LayerZero OFT adapter per token, per route |
| `direct/HoodLaunchToken.sol` | 141 | 8,825 | the clone the direct machine stamps |
| `direct/HoodDirectDeployer.sol` | 88 | 20,628 | deploys a hook at a mined address bound to its creator |
| `libraries/CurveMath.sol` | 71 | library | the curve's arithmetic |
| `libraries/PairTransfer.sol` | 61 | library | native and ERC-20 payment paths, fee-on-transfer refused |
| `HoodDeployer.sol`, `HoodToken.sol`, `HoodTypes.sol` | 187 | | the curve machine's token and shared types |

**Out of scope, and why it still matters.** `apps/` and `packages/` are off chain: the indexer, the
read API, the app, the SDK. Nothing there can move money. One seam is worth an auditor's attention
anyway: the season drop's merkle tree is built off chain from the indexer's points
(`apps/api/src/merkle.ts`) and published on chain by the owner. The contract cannot know whether the
tree is fair; it only enforces that the root is written once, that the pot covers it, and that a
leaf pays its own address. The treasury funds the drop, so the failure mode is the treasury paying
the wrong list, not a stranger draining the contract.

## Build

```
solc 0.8.26, via_ir, optimizer 400 runs, evm_version cancun
```

Dependencies are vendored or pinned: OpenZeppelin 5 in `lib/openzeppelin-contracts`, Uniswap
v4-core and v4-periphery and LayerZero v2 from `node_modules` (`package-lock.json` pins them).
`forge build --sizes` is clean: the largest runtime is 20,628 bytes, against the 24,576 limit.

Two toolchain notes to save time:
- **`forge coverage` does not run on this codebase.** Without `via_ir` the factory's metadata event
  is stack-too-deep; with `--ir-minimum` the Yul pipeline fails instead. Both are the known solc
  limitation rather than anything about the tests. What exists is the inventory below.
- The local direct-launch suite deploys v4-core's `PoolManager` from Uniswap's own artifact, because
  it does not compile under this project's optimizer settings. `fs_permissions` in `foundry.toml`
  is what allows that read.

## What to run

```bash
forge test --no-match-path 'test/Fork*.t.sol'                    # 128 local tests
forge test --match-path 'test/Fork*.t.sol' --fork-url robinhood  # 37 against the real chain
node scripts/e2e/lifecycle.mjs                                   # 161 assertions end to end, ~30s
npm run abis:check                                               # the SDK's ABIs match the contracts
```

The rehearsal is the one to run first. It deploys the whole system on a fork of 4663 with the
repo's own scripts and takes it from nothing to a claimed airdrop, asserting the wiring, both
machines, the indexer's numbers against the chain, and the drop. It is also how a fix should be
re-verified.

| Suite | Tests | What it covers |
|---|---|---|
| `SeasonDrop.t.sol` | 20 | the merkle claim, funding, windows, sweeping |
| `DirectSwap.t.sol` | 17 | the hook's taxes on real swaps, both directions, exact-in and exact-out |
| `Factory.t.sol` | 22 | launches, presets, pairs, the econ hash, the copycat lock, the locked first buy |
| `Curve.t.sol` + `CurveMath.t.sol` | 21 | curve arithmetic, both buy paths, sells, sold-out, finalize |
| `FeeSplit.t.sol` | 19 | the four legs, how a split rounds, flushes, what each leg does with a fee |
| `DirectSplitter.t.sol` | 11 | the four-way split, the protocol tenth, dividends, claims |
| `DirectToken.t.sol` + `DirectHook.t.sol` | 17 | the clone, the hold and buy limits, the surcharge decay |
| `Staking.t.sol` | 9 | locks, weights, claims, demotion |
| `Bridge.t.sol` | 4 | the OFT adapter per token |
| `ForkDirect`, `ForkV4`, `ForkLZ`, `ForkRemote` | 37 | the same against live 4663 contracts |

## Where I would look hardest

Ranked by what would hurt most if it were wrong, not by how likely I think it is.

1. **The hook's swap accounting.** `HoodLaunchHook.beforeSwap`/`afterSwap` return deltas and mint
   ERC-6909 claims for the input-side tax. Exact-output buys were taxed on the offered amount rather
   than the consumed one until it was fixed in-house; the class of bug is live.
2. **The mined hook address.** `HoodDirectDeployer` deploys to an address whose low bits carry the
   v4 permission flags (`0xCC`), from a salt bound to the creator. Both the binding and the flag
   check matter: a hook at the wrong address silently loses a callback.
3. **Graduation.** `UniswapV4Graduator` prices the pool itself rather than trusting what it finds,
   opens it inside the launch transaction, and locks the position with no way out. The donation and
   compounding guards (in-range liquidity must be the launch's own) are the defence against a
   one-block liquidity bot; they are measured, not argued, in SECURITY.md.
4. **Curve rounding.** `CurveMath` plus `_feeOnGross`/`_feeOnNet`/`_splitFee` in `HoodCurve`: every
   rounding decision is deliberate and the fee is split out of one rounded total so the legs cannot
   exceed it. Worth an independent pass.
5. **The splitter's accounting.** `unaccounted()` is the difference between what arrived and what is
   booked, and everything downstream is a slice of it. The protocol tenth is pulled, not pushed, so
   a treasury that reverts cannot freeze a launch: that decision is load-bearing.
6. **The buyback's impact cap.** One run may move at most 296 ticks, a token may be run once per
   block, and the remainder carries. Without either half, the pot can be walked up the book.
7. **Payment paths.** `PairTransfer` handles native and ERC-20, refuses fee-on-transfer pairs, and
   `pushAndCall` hands control to another contract mid-transaction. Reentrancy is guarded, but this
   is where to check the guard is on the right function.
8. **Ownership transitions.** Ownable2Step everywhere it matters, deployer used once. The rehearsal
   asserts the pending-owner dance, but the failure mode (an accepted owner that is not the intended
   multisig) is not something code can catch.

## What has already been found and fixed in-house

Not a substitute for an audit, but it says where the soft ground was. Each is in git-less history
only, so the current code is what to read: exact-output buys going untaxed; the hook serving pools
it was not deployed for; a pushed protocol tenth able to freeze payouts; hook salts not bound to
their creator; the buyback unbounded in impact; tax charged on the offered rather than the consumed
amount. Off chain, two economic holes: launch points paid for tokens nobody traded, and lock points
paid at the moment of locking, which the flexible tier made farmable in a single block.

## Handing it over

- **The reference to quote is the tag `audit-2026-09-18`.** The repository was initialised on
  18-09-2026 with the whole tree as one commit; there is no remote, so the tag is handed over as an
  archive or by pointing an auditor at the machine. `git rev-parse audit-2026-09-18^{}` prints the commit hash
  a report should name (the tag is annotated, so without the `^{}` you get the tag object instead), and `git log --oneline` from there is the history that follows it.
- Deployment is `script/Deploy.s.sol` and `script/DeploySeasonDrop.s.sol`, driven by section 1 of
  [RUNBOOK.md](RUNBOOK.md). Nothing is deployed on 4663 today.
- The four privileged addresses do not exist yet either. When they do, each must have no code on
  4663 before it is used: the well known test keys there carry EIP-7702 delegations to a sweeper.
- Ask for: a severity scale, a re-audit of the fixes rather than a letter on the first report, and a
  run of `scripts/e2e/lifecycle.mjs` against the fixed tree as part of sign-off.
