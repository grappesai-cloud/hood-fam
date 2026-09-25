# OX / hood.fam self-audit — 22 September 2026

This is an internal review of the working tree after `cdb8dfe`, **not an independent security
audit or a claim that the contracts are safe for material deposits**. The production addresses,
operator identity, and security contact are not established by this document. No public-chain
deployment was performed during this review.

## Scope and evidence

- Manually reviewed the money-moving paths in `HoodFactory`, `HoodCurveRouter`, `HoodFeeRouter`,
  `HoodStaking`, `UniswapV4Graduator`, the direct splitter and the API's custom-quote route.
- Ran Slither 0.11.6 on `src/`: 180 raw findings (9 high, 61 medium, 74 low, 33 informational,
  3 optimization). The high findings concern arbitrary-recipient transfers and external-call
  ordering; each was checked against launch registration, access control, `nonReentrant`, and
  accounting. Slither still cannot generate IR for `HoodPortal._mintPosition` under via-IR.
  A static-analysis warning being explained is not proof that the path is safe.
- Local Foundry suite and all `test/Fork*.t.sol` tests passed on a Robinhood Chain fork. `forge
  build --sizes` and SDK/API/keeper/web production builds passed. `npm run abis:check`,
  `check:curve`, `check:fetch`, `check:ticks`, `check:safe`, and `check:pairs` passed.
- The local production web build was opened in Chrome on desktop and mobile for home, launch and
  bridge: all five page loads returned 200/304, with no page errors, horizontal overflow or
  title/control overlap. This is a smoke test, not a full wallet usability study.
- The isolated Anvil + PostgreSQL lifecycle rehearsal passed **176/176** assertions, including
  launch, buy/sell, graduation, direct pool, tax, staking, fee collection, indexer balances and
  volume, points, season root, funded claim, and appointed-keeper wiring. Its database was
  `hood_audit_20260922_b`; it sent no public-chain transactions.
- `npm audit --omit=dev` still reports **2 high and 25 moderate** transitive dependency alerts.
  The full development dependency tree reports 3 critical, 11 high, 25 moderate and 14 low.

## Findings fixed in this working tree

| Severity | Finding | Change and regression |
|---|---|---|
| High, economic | Anyone could call `flushBuyback` with a dust `minTokensOut`, sandwiching the visible curve-fee pot. | Only the factory owner's Safe or its appointed keeper can choose the floor; zero is refused. Unit tests cover unauthorized calls, rotation, and execution. The keeper startup and deployment wiring verify the appointment. |
| Medium, liveness | A creator fee recipient that rejected ETH could revert the entire flush, blocking the staker and liquidity legs as well. | Bounded-gas payment attempt; failed creator share remains separately accounted and claimable by that recipient to an accepting address. Tests cover refusal, other-leg completion, accounting and claim. |
| Medium, accounting | An ERC-20 creator first buy that the curve did not fully absorb could leave its change in the factory. | Refund only the amount above the factory's pre-trade balance; reject fee-on-transfer input. Regression tests cover partial fills and taxed transfers. |
| Dependency | A transitive Axios 0.21.4 carried high-severity advisories. | Root override resolves Axios 1.20.0; the production audit no longer lists Axios. |

## Residual risks and release gates

1. **No independent review.** A self-audit, static analysis and fork tests cannot rule out a
   contract exploit. Do not market this as audited. If an open beta proceeds without external
   review, keep value-at-risk small and make that limitation explicit to users.
2. **Keeper trust.** A compromised appointed keeper can deliberately submit a bad floor and
   extract value from an accrued buyback pot. The Safe can rotate or disable it, and no keeper
   can alter a token's fee split or pull the curve reserve. Monitoring and an incident runbook
   are required before accepting real fees. The direct pool buyback has its separate per-run
   impact and once-per-block limits; it is not made lossless by them.
3. **Arbitrary ERC-20 quotes are not a safety guarantee.** Decimals and received-balance checks
   reject common bad tokens, but mutable taxes, rebases, blacklist behavior, false metadata and
   malicious callbacks can still break trading or strand value. The creator and buyer UI must
   continue to display the quote contract and warn of this risk. A local one-hop ETH route is
   available only for pairs with an ETH pool; arbitrary multi-hop routing still needs the
   configured route provider or a separately tested local implementation.
4. **Dependency alerts remain.** Production `postcss` and `ws` are the two high alerts; the
   transitive WalletConnect/MetaMask tree accounts for the moderate alerts. The critical
   `elliptic`/ethers alerts are in the development tree, not the `--omit=dev` runtime tree.
   Automatic `npm audit fix --force` proposes breaking Next/wagmi upgrades, so it was not run
   blindly. Upgrade and re-run browser/wallet regression tests before a public money launch.
5. **Operational and legal prerequisites are not supplied.** `/terms` and `/privacy` still
   contain operator name, address, jurisdiction and contact placeholders; the security contact
   and verified deployment-address list are absent. The actual Safe signers, keeper wallet,
   house token, liquidity/seed funds and launch parameters require operator decisions/signatures.
   The preview API returned zero indexed launches at review time, which is not proof that an old
   factory has no on-chain launches. Reconcile chain state before changing the indexer's factory.
6. **No live transaction smoke test of this revision.** Rehearsal addresses are local-fork
   addresses. Deploy to the intended chain only after the Safe controls the new contracts;
   verify source, read back every module and keeper, then use small real transactions for each
   asset path before opening the launch gate.

Reproduce the on-chain rehearsal with a **new, otherwise unused** `E2E_DB` name. The lifecycle
script drops and recreates that named database; never point it at an existing production DB.
Use `docs/RUNBOOK.md` for the ordered deployment and Safe hand-off.
