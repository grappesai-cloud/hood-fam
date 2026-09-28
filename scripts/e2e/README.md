# End to end harnesses

Scripts that drive the real thing rather than a mock: a local anvil fork of chain 4663, the
contracts deployed by `script/`, the SDK the app uses, and the API container's own build.

## The deployment rehearsal

`lifecycle.mjs` is the whole system in one run, from an empty fork to a claimed airdrop. It is the
pre-audit proof that the pieces fit together, and the dry run for the real deploy.

```bash
npm run build                      # the sdk and the api, once
node scripts/e2e/lifecycle.mjs     # about 30 seconds, 159 assertions
```

It needs `anvil` and `forge` on the path, and a Postgres it may create a database in. It starts its
own anvil on 8555, its own api on 8199 and its own database `hood_rehearsal`, so it never argues
with a stack that is already up. Nothing else on the machine is touched.

What it does, asserting after every step:

1. forks 4663 **at head** (never at a pinned block: this chain prunes state, and a fork of an old
   block answers "historical state is not available" on every call)
2. deploys with `script/Deploy.s.sol` and `script/DeploySeasonDrop.s.sol`, then accepts ownership
   on the three Ownable2Step contracts, the way section 3e of the runbook says to
3. checks the wiring: every owner, every treasury, the address each contract holds for the others,
   the three presets and two pairs from section 2, and the econ hash pin, recomputed here from what
   the chain says rather than read and trusted
4. brings up the indexer and the read API against the fork
5. the curve machine: a launch with a creator first buy, six trades from four wallets, a stake, the
   fee router flush into the staking model, a claim, graduation into the locked Uniswap v4 position,
   a swap on the real pool and a permissionless `collect` back into the fee split
6. the direct machine: a portal launch with a mined hook salt, the opening window refusing a whale,
   a buy inside the snipe surcharge, the surcharge decaying to nothing, buys and a sell through the
   hook, `flushClaims`, a sweep with the four way split, `claimProtocol`, and one buyback run
7. the seven day lock running out and the stake coming back
8. the API's own numbers against the chain: trade count, volume in wei, every holder balance against
   `balanceOf`, the direct launch's four contracts, and points against the leaderboard
9. a season opened and snapshotted, a merkle tree built and funded through `HoodSeasonDrop`, and a
   claim pushed by a keeper for a wallet that earned points

It prints a checklist of every assertion with pass or fail, and exits non-zero on the first failure.

### Against a real deployment

The wiring half runs on its own, against addresses in the environment, which is what you want right
after a real deploy:

```bash
HOOD_RPC=https://rpc.mainnet.chain.robinhood.com \
HOOD_FACTORY=0x... HOOD_FEE_ROUTER=0x... HOOD_STAKING=0x... HOOD_GRADUATOR=0x... \
HOOD_BRIDGE_FACTORY=0x... HOOD_PORTAL=0x... HOOD_DIRECT_DEPLOYER=0x... \
HOOD_TOKEN_IMPLEMENTATION=0x... HOOD_BUYBACK_MODULE=0x... HOOD_SEASON_DROP=0x... \
OWNER=0x... TREASURY=0x... \
node scripts/e2e/lifecycle.mjs --wiring-only
```

It is read only, takes under a second, and fails loudly if a pending owner was never accepted, a
module points somewhere unexpected, a preset does not match the one that was announced, or the econ
hash no longer pins what the presets say.

### Knobs

| variable | default | what it is |
|---|---|---|
| `HOOD_RPC` | the public 4663 RPC | what anvil forks, and what `--wiring-only` reads |
| `E2E_ANVIL_PORT` | 8555 | an anvil already listening there is reused instead of started |
| `E2E_API_PORT` | 8199 | where the api under test listens |
| `E2E_PG` | `postgres://hood:hood@127.0.0.1:55444/postgres` | the server the run's database is created on |
| `E2E_DB` | `hood_rehearsal` | dropped and recreated on every run |
| `E2E_KEEP` | unset | `1` leaves anvil and the api up afterwards, for poking at |
| `E2E_RUN_DIR` | the system temp directory | where the anvil and api logs land |

### Three things about 4663 that this script exists to remember

- **The well known test keys are not empty wallets here.** anvil's own accounts (`0xf39F...`,
  `0x7099...`, `0x3C44...`) carry an EIP-7702 delegation on 4663 to a contract that forwards every
  wei paid to them. A launch fee "sent to the treasury" vanishes on arrival. The rehearsal derives
  its own eight wallets, checks each one has no code, and funds them with `anvil_setBalance`.
- **Deadlines come off the chain's clock.** anvil's timestamps run ahead of the wall clock as soon
  as blocks are mined faster than one a second, and the router refuses a deadline it has already
  passed. The seven day jump for the stake lock is therefore done after the last swap in the run.
- **The public RPC rate limits the fork itself.** anvil reads state before it will serve genesis, so
  back to back runs can die on a 429 before a single assertion. The start is retried three times,
  and anvil is asked for one account rather than ten so there is less to fetch.

## The wizard, in a browser

`wizard-ui.mjs` is the other half of the proof: not the system from the outside, but the part a
person touches. It leaves the rehearsal's fork and API standing, builds the app against the
addresses that rehearsal deployed, opens it in Chrome with `provider-shim.js` standing in for a
wallet, fills the launch form in and presses the button.

```bash
node scripts/e2e/wizard-ui.mjs        # about three minutes, 18 assertions, screenshots at each step
```

A token is printed on the fork by the form, the app follows it to its page, a buy goes through the
curve, the indexer reads the trade back off the chain and the board shows the launch. The wallet it
signs with is a fresh address anvil impersonates, never one of anvil's own keys, for the 7702 reason
below.

## The rest

| script | what it drives |
|---|---|
| `run.mjs` | three curve launches, traded and one graduated, through the SDK |
| `swap.mjs` | the 4663 UniversalRouter's swap encoding, imported by the others |
| `grad-swap.mjs` | one swap on a graduated pool, for when an estimate is failing |
| `quote-check.mjs` | the quoter against what a swap actually returns |
| `airdrop.mjs` | the season drop against a running API, proofs verified locally |
| `admin.mjs` | the admin surface, seasons end to end, rate limit headers |
| `chat.mjs` | token chat: the login handshake, who may post, hiding, and a post arriving on `/stream` |
| `support.mjs` | the support desk and its ticket queue |
| `uploads.mjs` | token art upload, dedup and the 501 with no bucket |
| `mcp-chain.mjs` | the MCP server's chain tools |
| `provider-shim.js` | an EIP-1193 provider for driving the web app from a browser with no wallet; `window.__HOOD_SHIM = { rpc, account }` moves it to another fork or another wallet |
| `wizard-ui.mjs` | the launch wizard and the trade box, in Chrome, against the rehearsal's fork |
