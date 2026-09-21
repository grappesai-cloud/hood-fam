# Deploying hood.fam

In order. Nothing here is optional, and the order matters in two places, both marked.

## 0. Wallets

Four roles, four addresses, all generated for this project and used for nothing else:

| role | what it does | where the key lives |
|---|---|---|
| deployer | sends the deployment, then hands ownership over | a fresh key, used once |
| owner | presets, launch fee, pair list, routes | **a Safe** (section 0a) |
| treasury | receives the protocol fee and the graduation fee | **the same Safe** |
| keeper | finalizes, flushes, collects | a hot key on the server, holding gas and nothing else |

```bash
cast wallet new              # four times, or
node -e "import('viem/accounts').then(m=>console.log(m.generatePrivateKey()))"
```

The keeper key sits in an environment variable on the server. That is acceptable because the keeper
can only do things anybody could do anyway: it can waste its own gas and nothing else.

**Check each address has no code before using it.** On 4663 the well known test keys (anvil's
`0xac09...`, `0x59c6...`, `0x5de4...`, and the addresses they derive) all carry an EIP-7702
delegation to a sweeper that forwards every wei they are paid. An address that looks like an empty
wallet is a contract, and a launch fee "sent to the treasury" arrives and leaves in the same
transaction. This is not hypothetical: it is why the rehearsal derives its own keys and checks them.

```bash
cast code $TREASURY --rpc-url $HOOD_RPC   # must print 0x, for every one of the four
```

(The Safe is the exception: it is a contract by definition, and section 0a checks it differently.)

## 0a. The Safe that owns it

The owner and the treasury are one Safe, created before anything else is deployed. hood.fam ships no
multisig of its own: Safe v1.4.1 is already on 4663 at its canonical addresses, byte for byte the
code Safe runs on every other chain (the deploy script refuses to build on anything else), and
Safe{Wallet} supports the chain as `robinhood`.

```bash
export SAFE_OWNERS=0xA,0xB,0xC     # signers, each on its own device; not the deployer key
export SAFE_THRESHOLD=2            # under 2 is refused: a 1-of-N is one key with extra steps
forge script script/DeploySafe.s.sol --rpc-url robinhood --broadcast
```

The address is worked out before anything is sent, so a second run with the same owners, threshold
and salt finds the same Safe and sends nothing. Then deploy with `OWNER` and `TREASURY` both set to
it (section 1): on 4663 the deploy refuses an owner that is not a Safe of at least two signers.

**The treasury has to be the Safe from the first deploy.** A curve pins the treasury it was launched
with, so moving the treasury later reaches only launches made after the move. The direct machine
pulls to the portal's current treasury, so that half does follow a change.

**Accepting ownership.** The factory, the portal and the bridge factory are `Ownable2Step`: the
deploy hands them over and nothing moves until the Safe accepts. One batch does all three:

```bash
export HOOD_SAFE=0x...   # plus HOOD_FACTORY / HOOD_PORTAL / HOOD_BRIDGE_FACTORY / HOOD_SEASON_DROP
npm run safe -- accept
```

That writes a Transaction Builder file. In Safe{Wallet}: Apps, Transaction Builder, drop the file in,
and every signer sees each call decoded before signing. It needs no key on the deploying machine and
no API key anywhere. `npm run safe -- info` says who owns what and what is still waiting;
`npm run safe -- call factory "setLaunchFee(uint256)" 1000000000000000` builds any other owner call
the same way. With `SAFE_SIGNER_KEYS` (or `--keystore`) it can also sign and send, which is how the
rehearsal drives it; on mainnet the signers sign in Safe{Wallet}, on their own devices.

**The app from inside the Safe.** Safe{Wallet} opens hood.fam as a Safe App (Apps, add custom app,
paste the site's URL; the manifest is at `/manifest.json`). Connected that way the wallet is the Safe
itself: the admin page's switches, and every ordinary thing a team does, become Safe transactions
that the other signers approve. A self-hosted Safe{Wallet} is allowed in with
`NEXT_PUBLIC_SAFE_APP_ORIGINS` (its origin, exactly), which also opens the frame in the app's CSP.

## 1. Contracts

The rehearsal below is the dress rehearsal for everything in this section, and the same file checks
the wiring of a real deployment:

```bash
node scripts/e2e/lifecycle.mjs          # the whole system on a fork, 161 assertions, about 30s
node scripts/e2e/lifecycle.mjs --wiring-only   # the addresses in the environment, read only
npm run abis:check                      # the SDK's ABIs still match the contracts
```

It deploys with the scripts below, launches on both machines, trades, stakes, graduates, collects,
sweeps, buys back, runs the indexer and the read API against the fork, opens a season, builds a drop
and claims it, asserting after every step. `scripts/e2e/README.md` has the knobs. `abis:check` is
not a formality: a function added to a contract and never regenerated does not exist as far as the
SDK, the app and every harness are concerned, which is how `HoodCurve.claimProtocol` stayed
invisible for a round.

```bash
forge test --no-match-path 'test/Fork*.t.sol'                    # 86 tests
forge test --match-path 'test/Fork*.t.sol' --fork-url robinhood  # 27 against the real chain
forge build --sizes                                              # nothing over 24,576 bytes

export PRIVATE_KEY=0x...   # deployer
export OWNER=0x...         # where ownership lands
export TREASURY=0x...
forge script script/Deploy.s.sol --rpc-url robinhood --broadcast
```

It prints six lines. Keep them; everything else is configured from them.

```
factory     0x...
deployer    0x...   # the bytecode holder, not a wallet
staking     0x...
firstBuyLock 0x...  # where creators' locked first buys sit
feeRouter   0x...
graduator   0x...
bridge      0x...
start block N       # the indexer starts here and never before
```

**Order matters here:** `HoodDeployer.initialize` and `HoodDirectDeployer.initialize` may only be
called by the account that created them, once. A deployment that stops halfway is resumed with the
same deployer key, and no stranger can name themselves the factory in between two transactions.

Verify the source on the explorer (`robinhoodchain.blockscout.com`). Blockscout on this chain rate
limits and wants a user agent:

```bash
forge verify-contract <address> src/HoodFactory.sol:HoodFactory \
  --chain 4663 --verifier blockscout \
  --verifier-url https://robinhoodchain.blockscout.com/api
```

## 1a. The house coin

One coin is lockable on this pad, and until it exists nobody can be paid as a staker: the vault
refuses every stake and the factory refuses any launch whose split promises the stakers leg
anything. That is deliberate, and it fixes the order:

1. Launch the coin on the pad, like any other launch, with a split that does **not** pay stakers
   (at that moment there is nobody to pay). The wizard does this for you: with no coin named, the
   stakers slider is held at zero and says why.
2. Name it, once, from the owner:

```bash
cast send $HOOD_STAKING "setHouseToken(address)" $HOUSE_COIN \
  --rpc-url robinhood --private-key $PRIVATE_KEY
# or, when the owner is a Safe, as a batch file every signer can read before signing:
#   npm run safe -- call $HOOD_STAKING "setHouseToken(address)" $HOUSE_COIN
```

`setHouseToken` reverts on a second call, for anyone including the owner: a vault whose coin can be
swapped is a vault that can be emptied by decree. Check it took with
`cast call $HOOD_STAKING "houseToken()(address)"`, and `lifecycle.mjs --wiring-only` prints it on
every run.

From then on every launch can point its stakers leg at that room. The coin's own launch cannot,
and never will be able to, because its split was fixed before the room existed.

## 2. Presets and pairs

`script/Deploy.s.sol` seeds three presets and two pairs. Change them there before deploying, not
after: a preset is append only, and a live token can never be moved onto a different one.

- preset 0, the standard launch: a billion tokens, 80% on the curve, start cap 1 ETH, graduation cap
  10 ETH, which is a raise of about 4.4 ETH, 90% of it into the pool
- preset 1, the wide launch: start cap 2 ETH, graduation cap 40 ETH, 95% into the pool
- preset 2, priced in USDG so the chart does not move with ETH

The copycat lock threshold is set per pair (`setPair`) and is denominated in that pair, because
there is no oracle inside the trade path. 25 ETH of volume inside 24 hours locks a ticker and its
artwork for 48 hours.

## 2a. Pairs: what a launch can trade against

A launch is quoted in one asset, holds its raise in it, and pays its creator in it. The factory's
allow list decides which, and the app reads that list rather than carrying its own, so adding one
is two owner calls and no deploy:

```bash
PRIVATE_KEY=... HOOD_FACTORY=... forge script script/AddStockPairs.s.sol --rpc-url robinhood --broadcast
```

That script is also the checklist for adding another asset. Before allowing anything, establish:

- **it is an ERC-20 that will move.** Read `symbol()` and `decimals()` off the token, and simulate
  a transfer to a contract (`cast call <token> "transfer(address,uint256)" <a contract> 1 --from
  <a holder>`). A share that refuses to move to a contract can never sit in a curve.
- **it can be priced.** Add it to `PAIR_ASSETS` in `apps/api/src/price.ts` with the pool it trades
  against the dollar in, then run `npm run check:pairs`. A pair with no price is a pair whose
  trades earn nobody any points, silently.
- **it has a preset.** A preset's caps are in the pair's own units and are never edited, so each
  asset needs its own, sized to a sane opening valuation. The wizard hides presets whose caps make
  no sense for the chosen pair, which is also how a missing preset shows up: the pair is offered
  and nothing can be launched on it.

The ticker lock threshold is in that asset's units: pick roughly what a day of real volume looks
like, the way 25 ETH and 100,000 USDG were picked.

The direct machine keeps its own list, on the portal, because it is a different contract with a
different owner path:

```bash
PRIVATE_KEY=... HOOD_PORTAL=... forge script script/AllowDirectQuotes.s.sol --rpc-url robinhood --broadcast
```

Nothing else is needed for it: the portal has always pulled an ERC-20 quote, sorted the pool by
address and taxed whichever side the quote landed on. The app works out which side the token will
sort into with `predictDirectToken`, because the position and both ticks depend on it, and
`npm run check:ticks` holds that arithmetic to the numbers the fork test worked out by hand.

## 3. The server

One box, one compose file, own Postgres. Not a serverless platform: the indexer is a long-lived
process that has to hold a cursor, and the database is ours.

```bash
cp .env.example .env     # fill in the six addresses, the start block, the keys
docker compose up -d --build
```

That brings up four containers: `db`, `api` (indexer plus REST), `web`, `keeper`. All three
images build from a clean clone; the web image installs `python3 make g++` for wagmi's native
WebSocket helpers and keeps optional dependencies, because Tailwind's `lightningcss` and Next's
`swc` ship as optional platform binaries and the build fails without them. On Coolify, point
a Docker Compose resource at this repository and set the same variables in the UI; the build args
under `web` have to be set there too, because `NEXT_PUBLIC_*` is baked at build time and a missing
one leaves the app pointed at nothing.

**Never rsync over the server's `.env`.** The deploys here copy the tree to the box with rsync,
and the box's `.env` is the only copy of the addresses, the database password and the R2 keys: the
repository's own `.env` is a blank template. A sync with `--delete` and no exclusion replaced the
live file with the blank one, the images rebuilt with empty `NEXT_PUBLIC_*`, and every front said
the curve machine was not configured while the API crash-looped on an empty password. Always:

```bash
rsync -az --delete --exclude .env --exclude node_modules --exclude .git \
  --exclude 'apps/web/.next' --exclude 'packages/*/dist' ./ box:~/hood-fam/
```

If it happens anyway, the running containers are the backup: `docker inspect <container>` prints the
environment each one was started with, so a container that was not recreated still carries the
addresses (`keeper`), the database password (`backup`, as `PGPASSWORD`) and the object storage keys
(`offload`, as `RCLONE_CONFIG_STORE_*`). Recreate the web containers last, for that reason.

Health: `GET /health` returns the last indexed block and which optional integrations are wired
(`assistant`, `art`, `relay`, booleans only). If the block stops moving, the indexer is stuck, not
the chain.

**Rate limit.** The API limits every client to `RATE_LIMIT_PER_MINUTE` requests (default 300)
per IP, `/health` exempt, admin routes at 60. Behind Traefik or Coolify the client address arrives
in `X-Forwarded-For`, so `TRUST_PROXY=true` (the default in production); without a proxy set it to
`false` or everybody shares one bucket. The support desk keeps its own, tighter limit.

**Admin token.** `HOOD_ADMIN_TOKEN` (generate it: `openssl rand -hex 32`) is the bearer token for
`/admin/*` and the ticket queue, and the password of the `/admin` page in the app. `SUPPORT_ADMIN_TOKEN`
still works for a deployment that only set the older name. Leave both empty and nothing
administrative answers over HTTP. Owner actions on the contracts are not behind it; they are behind
the owner wallet, and the `/admin` page only offers them to the connected owner.

```bash
export T=$HOOD_ADMIN_TOKEN
curl -H "Authorization: Bearer $T" https://api.hood.fam/admin/me         # {"ok":true}
curl -H "Authorization: Bearer $T" https://api.hood.fam/admin/overview   # indexer lag, wiring, counts
```

The app has the same thing with a face on it at `/admin` (by URL; it is not in the nav). It asks for
the token once and keeps it in the tab, never in a cookie or on disk, so closing the tab signs out.
The left half is operations against the API (overview, the ticket queue, seasons); the right half is
the owner's switches on chain, and every button there is disabled unless the connected wallet is
that contract's current owner. Verified against a fork: the gate, the whitelist, a ticket moved to
answered with a note, and a season opened.

`/admin/overview` is the one screen worth checking after a deploy: `blocksBehind` (100 ms blocks, so
600 is a minute), which optional integrations are wired, every deployed address as the process sees
it, launches, graduations, open tickets and the current season. The same booleans are on the public
`/health`, so an uptime check can see that the assistant is wired without holding the token.

## 3a. Optional integrations

Three keys, none of which is required for the launchpad to work. `GET /health` and
`/admin/overview` report which are wired as booleans, so a deploy can be checked from outside
without ever echoing a key.

| Key | What it turns on | What happens without it |
|---|---|---|
| `ANTHROPIC_API_KEY` | the support assistant behind the help button (api) | `/support/status` says `enabled: false`, the widget goes straight to the ticket form, tickets still work |
| `OPENROUTER_API_KEY` | token art in the launch wizard (web) | `POST /api/image` answers 501 and the wizard keeps the artwork URL field |
| `RELAY_API_KEY` | in-app cross-chain buy quotes (web and sdk) | the bridge page links out to Relay's own page with the route prefilled |

None of them is a `NEXT_PUBLIC_*`: the art key is used in a route handler on the server, the
assistant's key never leaves the api container, and the Relay key is read by the SDK on the server
side. A key in a `NEXT_PUBLIC_*` variable would be baked into the browser bundle, which is why
there is no such variable to set.

## 3a1. The pages an operator has to fill in

`/terms` and `/privacy` are written and live, with four placeholders each that only the operator can
fill: `[OPERATOR LEGAL NAME]`, `[REGISTERED ADDRESS]`, `[CONTACT EMAIL]` (and `[PRIVACY CONTACT
EMAIL]`) and `[JURISDICTION]`. Both carry a `LAST_CHANGED` constant at the top of the file. Neither
is legal advice; they describe what this software actually does, which is the part a lawyer should
not have to reverse engineer. `docs/SECURITY.md` has one more: the security contact, which is still
"nothing is deployed yet".

`/analytics` is the public numbers page (launches, graduations, volume, trades, wallets, and the
season's take, pool and points). It reads the same indexer as everything else, so it needs no
configuration.

## 3a2. Token art storage

Artwork is a URL on chain, never the picture itself: a 40 KB image as a base64 string in calldata
costs more gas than the launch. The API takes the upload and hands back a URL.

Point it at a Cloudflare R2 bucket (any S3-compatible bucket works). Ours is `hood-fam-art`, public
at its `r2.dev` domain, with an account API token scoped to object read and write **on that bucket
only**. To make another one:

```bash
wrangler r2 bucket create hood-fam-art
wrangler r2 bucket dev-url enable hood-fam-art     # prints the public https://pub-....r2.dev base
```

The S3 access key pair is not something wrangler can mint: create it in the dashboard under R2,
Account API tokens, Object Read and Write, applied to that one bucket, and put the pair in
`R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`. The endpoint is
`https://<account id>.r2.cloudflarestorage.com`, the region is `auto`, and `R2_PUBLIC_BASE` is the
public domain from the command above. Public access matters: the URL goes on chain and has to
resolve for everybody, forever, which is also why a custom domain is worth doing before the first
real launch. The `.env` in this repository is the working copy and is gitignored; the keys live
nowhere else.

```bash
curl -F file=@art.png https://api.hood.fam/uploads/image
# {"url":"https://pub-xxx.r2.dev/tokens/<sha256>.png","key":"...","bytes":12345,"contentType":"image/png","deduped":false}
```

The key is the sha256 of the bytes, so the same image uploaded twice is one object and the second
call answers `deduped: true`. Type comes from the magic bytes, never from the filename. The cap is
`UPLOAD_MAX_BYTES` (4 MiB) and it is enforced while the bytes stream, not after. Objects are
immutable and cached for a year.

With storage unconfigured the route answers 501 with a plain sentence, the wizards fall back to the
artwork URL field, and `GET /health` reports `integrations.storage: false`. The AI art path then
refuses anything over 8 KB rather than letting a creator burn a fortune putting a picture on chain.

## 3b. Backups

Two more containers in the same compose file:

- `backup`: the plain `postgres:17` image running `scripts/backup/backup.sh`, which `pg_dump`s the
  database every `BACKUP_EVERY_SECONDS` (default six hours) into the `backups` volume in custom
  format and prunes dumps older than `BACKUP_KEEP_DAYS` (default 14). A failed dump logs and
  retries next round; it never stops the loop.
- `offload` (optional, `docker compose --profile offload up -d`): `rclone` syncing the volume to an
  S3-compatible bucket (`BACKUP_S3_*`; R2 works with `BACKUP_S3_PROVIDER=Cloudflare`). Uploading is
  separate from dumping on purpose, so a broken bucket never costs a local dump.

Manual dump and restore:

```bash
docker compose run --rm backup sh /scripts/backup.sh once
docker compose exec backup ls -la /backups

docker compose stop api keeper                           # the indexer must not write during a restore
docker compose run --rm backup sh /scripts/restore.sh /backups/hood-<stamp>.dump
docker compose start api keeper                          # resumes from the restored cursor
```

The indexer re-reads only the blocks between the dump and now. Nothing on chain depends on this
database; a lost database is a re-index from `HOOD_START_BLOCK`, a lost `support_tickets` table is
lost tickets, which is what the backups are for.

## 3c. Seasons

Points are stamped with the season that was current when they were earned. The 500 for printing a
token is paid the first time that token trades `LAUNCH_POINTS_MIN_USD` (1,000 dollars by default),
not when it is created, so an empty token earns nothing and the launch fee stops being the cheapest
entry on the board. Opening the next season
closes the previous one at the same instant, so no point falls into two seasons or into none. A
snapshot freezes a finished season's top 250, and from then on `GET /leaderboard?season=N` serves the
frozen rows (`frozen: true`, with `takenAt`) instead of recomputing, so late points cannot reshuffle
a board people have already been paid against.

From the app: `/admin`, seasons panel. From a shell with the token:

```bash
curl -H "Authorization: Bearer $T" https://api.hood.fam/admin/seasons
curl -X POST -H "Authorization: Bearer $T" -H 'content-type: application/json' \
  -d '{"name":"Season 2"}' https://api.hood.fam/admin/seasons
curl -X POST -H "Authorization: Bearer $T" https://api.hood.fam/admin/seasons/1/snapshot
```

From the box, with database access and no token (the same functions, so the two never disagree):

```bash
docker compose exec api node dist/seasons-cli.js list
docker compose exec api node dist/seasons-cli.js open "Season 2" [--starts ISO] [--ends ISO]
docker compose exec api node dist/seasons-cli.js close [id] [--ends ISO]
docker compose exec api node dist/seasons-cli.js snapshot [id]
```

Order at a season boundary: open the new season first (it closes the old one at that instant), then
snapshot the old one once the indexer has caught up to that timestamp. Snapshotting twice replaces
the earlier snapshot, so a snapshot taken too early is fixed by taking it again.

## 3d. The season drop

The claim side of `docs/AIRDROP.md`. One contract holds every season's drop; a season's root is
written once and can never be rewritten, and nobody can stop a claim before the deadline.

```bash
export PRIVATE_KEY=0x...   # deployer
export OWNER=0x...         # the multisig, which then calls acceptOwnership()
export TREASURY=0x...      # where an unclaimed remainder goes back to
forge script script/DeploySeasonDrop.s.sol --rpc-url robinhood --broadcast
```

Put the address in `HOOD_SEASON_DROP` (the api reads it, and the web image bakes it in as
`NEXT_PUBLIC_SEASON_DROP`, so the app has to be rebuilt after the first deploy) and accept the
ownership from the owner key.

At the end of a season, in this order:

```bash
# 1. the season is closed and settled (see 3c), and the indexer has caught up past its end
docker compose exec api node dist/seasons-cli.js snapshot 1

# 2. decide the pool from that season's take and the percentage announced before it started
curl -s https://api.hood.fam/airdrop/season/1 | jq '.pool'

# 3. build the tree over EVERY wallet that earned a point that season
docker compose exec api node dist/airdrop-cli.js build 1 --pool 12.5 --out /tmp/season-1.json
docker compose exec api node dist/airdrop-cli.js verify /tmp/season-1.json
# or the same thing through the admin API:
curl -X POST -H "Authorization: Bearer $T" -H 'content-type: application/json' \
  -d '{"pool":"12.5"}' https://api.hood.fam/admin/airdrop/1/build

# 4. write the root on chain and fund it in the same transaction
cast send $HOOD_SEASON_DROP "openDrop(uint256,bytes32,address,uint256,uint64)" \
  1 $ROOT 0x0000000000000000000000000000000000000000 $TOTAL_WEI $DEADLINE \
  --value $TOTAL_WEI --rpc-url robinhood --private-key <owner>
```

The total the CLI prints and the value you send have to match to the wei, and the contract checks
it. `--asset 0x...` builds a drop in an ERC-20 instead, in which case approve the contract for
`total` first and send no value. The deadline is at least 30 days out, enforced.

Then the page at `/airdrop` serves every wallet its proof and anyone can claim for anyone:
`claim(season, account, amount, proof)` always pays `account`, never the caller, so a keeper or a
friend can push a claim for somebody who never comes back. After the deadline, `sweep(season)`
returns what nobody claimed to the treasury, once.

Two things to get right, because neither can be undone: **announce the percentage before the
season**, not after the take is known, and **check the tree before you open the drop** (`verify`
re-reads the file, checks every proof against the root, and checks the amounts sum to the pool).

## 3e. The direct machine

`script/Deploy.s.sol` deploys it alongside the curve machine and prints four more addresses:

```
portal         0x...   # createLaunch lives here
directDeployer 0x...   # holds the hook, splitter and locker bytecode; the hook miner needs it
tokenImpl      0x...   # the EIP-1167 implementation every direct token clones
buyback        0x...   # permissionless swap-and-burn module, shared by every launch
```

It also wires them: the portal points at the registry, the registry accepts the portal, and USDG is
allowed as a quote asset beside the chain's own currency.

**The hook address has to be mined.** Uniswap v4 stores a hook's permissions in the low bits of its
address, so every launch mines a CREATE2 salt whose address ends in `0xCC`. The app does it in the
browser in about a tenth of a second (`mineHookSalt` in `@hood/sdk`). From a script:

```bash
cast call $HOOD_DIRECT_DEPLOYER "hookInitCodeHash(address)(bytes32)" \
  0x8366a39CC670B4001A1121B8F6A443A643e40951 --rpc-url robinhood
```

then mine against `keccak256(0xff ++ deployer ++ keccak256(abi.encode(creator, salt)) ++ initCodeHash)`
until the address ends in those bits: the portal binds every salt to the sender before CREATE2, so
mine for the wallet that will send the launch (`hookAddressFor(poolManager, creator, salt)` on the
deployer checks an answer). The portal rejects a salt that does not land, so a wrong one costs gas
and nothing else.

**Ownership moves in two steps.** The deploy script calls `transferOwnership(owner)` on the
factory, the bridge factory and the portal, which only names a pending owner on each; the owner has
to accept all three from its own key or Safe:

```bash
for c in $HOOD_FACTORY $HOOD_BRIDGE_FACTORY $HOOD_PORTAL; do
  cast send $c "acceptOwnership()" --rpc-url robinhood --private-key <owner>   # or from the Safe
  cast call $c "owner()(address)" --rpc-url robinhood                          # must print the owner
done
```

Until that call the deployer key is still the owner. Do it before the deployer key is discarded.

**The gate.** `setLaunchGate(enabled, whitelistOnly)` and `setWhitelisted(who, allowed)` touch new
launches only; `canLaunch(address)` is what the app reads before it mines a salt. Launches are open
by default. For a staged open: `setLaunchGate(true, true)` plus a whitelist, then `setLaunchGate(true, false)`.

**The protocol's tenth is pulled.** Nothing reaches the treasury until somebody calls
`claimProtocol()` on a splitter; the keeper does it whenever `protocolClaimable` is non-zero, and
anyone else can. It pays the portal's *current* `treasury()`, so rotating the treasury is one
`setTreasury` and needs no redeploy.

**Ticks.** A direct launch is described by two valuations, not two ticks. Against the chain's own
currency the token always sorts into currency1, so `tick = log(supply / valuation) / log(1.0001)`,
rounded to the spacing. The app does this conversion; `fdvToTick` in the web app is the reference.

**Quote assets other than the native one** work, but the tick direction depends on how the token
address sorts against the quote address, which is only known after the clone is deployed. The app
offers direct launches against the native currency for that reason. Launching against USDG from a
script is supported: compute the clone address first, sort, and pick the tick direction to match.

## 3f. A preview behind a proxy that is already there

The compose file above owns its box: it publishes 8080 and 4665 and nothing argues. On a box that
already runs a proxy with other sites behind it, add the overlay:

```bash
docker compose -f docker-compose.yml -f docker-compose.proxy.yml up -d db api web backup
```

It publishes nothing (a published port bypasses the host firewall, because Docker writes its own
iptables rules, which would leave the API answering in the clear beside the proxy meant to front
it), names the containers `hood-db`, `hood-api` and `hood-web`, joins the API and the app to the
proxy's network (`PROXY_NETWORK`, default `coolify`) and moves the keeper behind a profile, since a
box that only serves the site has no business holding a hot key.

The proxy needs two names: one for the site, one for the API. Not one name with the API under a
path: `/api/...` is the app's own route namespace (`/api/image` draws token artwork), and a router
that swallows the prefix takes the wizard with it. As a file-based Traefik router, dropped into the
proxy's dynamic directory:

```yaml
http:
  routers:
    hood-web:
      entryPoints: [https]
      rule: "Host(`hood.example.com`)"
      priority: 1000
      service: hood-web
      tls: { certResolver: letsencrypt }
    hood-api:
      entryPoints: [https]
      rule: "Host(`api.hood.example.com`)"
      priority: 1000
      service: hood-api
      tls: { certResolver: letsencrypt }
    hood-http:
      entryPoints: [http]
      rule: "(Host(`hood.example.com`) || Host(`api.hood.example.com`)) && !PathPrefix(`/.well-known/acme-challenge/`)"
      priority: 100
      service: noop@internal
      middlewares: [hood-https]
  middlewares:
    hood-https:
      redirectScheme: { scheme: https, permanent: true }
  services:
    hood-web:
      loadBalancer:
        servers: [{ url: "http://hood-web:4665" }]
    hood-api:
      loadBalancer:
        servers: [{ url: "http://hood-api:8080" }]
```

The challenge path is carved out of the redirect, or the certificate can never be issued. Set
`CORS_ORIGIN` to the site's origin, since the app now calls the API cross-origin. With more than one
face (section 3j) it is EVERY face's origin, comma separated: each one is served from its own name
and reads the same API from it, so a name missing here has a board that says the feed is down while
the API is perfectly healthy.

**A preview is not a second site.** Point `NEXT_PUBLIC_SITE_URL` at the host it actually answers on
and the app stops inviting crawlers: `robots.txt` disallows everything and every page carries
`noindex` unless the host is hood.fam (`apps/web/lib/site.ts`). An indexed preview is this product
under a name nobody should ever land on, competing with the real one.

**Before the contracts exist.** `INDEXER=0` runs the read API on its own, which is what a preview
wants when there is no factory to follow: no error every poll, `/health` still answers. With
`HOOD_FACTORY` and `HOOD_PORTAL` empty, both wizards say the machine is not configured on this
deployment rather than offering a button that writes to the zero address. Filling the addresses in
and rebuilding turns the preview into a deployment; the `NEXT_PUBLIC_*` values are baked at build
time, so it is a rebuild of the web image, not a restart.

## 3g. The demo world

A preview with an empty database answers nothing about how the product looks: a board with no
launches, a wallet page with no positions, a leaderboard with one row. The seeder writes the rows
the indexer would have written if the chain had carried three weeks of activity, so every screen and
every points rule runs on it unchanged.

```bash
docker exec hood-api node apps/api/dist/demo-cli.js seed --yes --wipe
docker exec hood-api node apps/api/dist/demo-cli.js wipe --yes      # and back to empty
```

Twelve launches across both machines, at every stage from an hour old to graduated, ninety wallets,
around seven hundred trades, locked positions, sweeps, dividends, three support tickets, and a
season that opens where the history opens. One seed string decides all of it, so the same demo is
the same demo: re-seeding does not churn the art bucket and yesterday's screenshot still matches.

The art is drawn, not fetched: deterministic identicons encoded as PNGs (`demo-art.ts`) and pushed
through the same upload path as a creator's own file, so the demo also exercises the bucket.

**What keeps it honest.** `--yes` is required, and the CLI refuses outright unless `INDEXER=0`,
because fabricated rows beside indexed ones are indistinguishable a week later. Build the app with
`NEXT_PUBLIC_DEMO=1` and every page carries a strip saying the data is invented and no button writes
anything; `NEXT_PUBLIC_DEMO_WALLET` puts a link to the seeded wallet in it. Both are build-time
values, so a real deployment cannot end up wearing the strip and a demo cannot end up without it.

What the demo cannot fake is anything read from the chain rather than from the database: the fee
waiting to be pushed, a connected wallet's own balance, a stake position's accrued reward. Those
read as zero, which is what they are.

## 3h. Watching it

Three things can be wrong at once and only one of them is visible from the browser: the site can be
up while the indexer is an hour behind and the database has not been backed up in a week. So there
are three checks, and the middle one is the interesting one.

**`GET /ready`** is the endpoint an uptime check should ask, not `/health`. It answers 503, with a
reason, when the database is unreachable, when the chain is, or when the indexer has fallen further
behind than `READY_MAX_BLOCKS_BEHIND` (default 6000 blocks, which at 100 ms a block is ten minutes).
A deployment that deliberately does not index (`INDEXER=0`, a preview) reports `indexer: off` and
stays green, because there is nothing for it to be behind on.

**The backup check is about the dump, not about the script.** A cron on the host looks for a dump
newer than eight hours in the backup volume and pushes to a heartbeat monitor only when it finds
one. A "the script ran" ping would have gone out just as happily with a zero byte file behind it.
The monitor's own interval is what raises the alarm: nothing pushed, nothing heard, alert.

**Offsite.** The compose file's `offload` profile syncs the dumps to S3-compatible storage with
rclone; on the preview that is a private R2 bucket with its own scoped token, separate from the art
bucket, which is public.

```bash
docker compose -f docker-compose.yml -f docker-compose.proxy.yml --profile offload up -d offload
```

Set `BACKUP_S3_ENDPOINT`, `BACKUP_S3_BUCKET`, `BACKUP_S3_ACCESS_KEY` and `BACKUP_S3_SECRET_KEY`
first. Verify by fetching one back and looking at it: a pg_dump starts with the bytes `PGDMP`, and a
backup nobody has ever restored is a hope rather than a backup.

**The blind spot.** The uptime checker on the preview runs on the same box as the thing it watches,
so it cannot report that the box is gone. Something outside has to ask too: on this setup a five
minute launchd job on a laptop, which is enough to notice, and healthchecks.io or any external
pinger would do the same job without a laptop being open.

## 3i. Announcements

The two moments worth telling people about are the two the board is built on: a token was printed,
and a token graduated into a locked pool. `apps/announcer` watches the read API for both and posts
them, oldest first.

```bash
docker compose -f docker-compose.yml -f docker-compose.proxy.yml --profile announcer up -d announcer
```

It holds no key, touches no database and reads nothing the public API does not serve, so the worst a
broken announcer can do is go quiet. With `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` it posts to
Telegram; with `ANNOUNCE_WEBHOOK` it posts `{"content": "..."}` to any endpoint that takes it, which
is Discord's shape and most others'. With neither, it runs and logs every post it would have made,
which is the mode to read before letting it talk.

Two guards that matter more than they look. Its first run starts from now and says nothing about the
past, because a fresh state file means it has no idea what was already announced. And nothing older
than `ANNOUNCE_MAX_AGE_MINUTES` (default three hours) is ever posted, so an announcer that was down
for a week wakes up quiet instead of posting a week of launches in one burst.

## 3j. The other faces

One launchpad, one indexer, one API, five front ends. A brand lives in `apps/web/brands/<id>`: its
own mark, chrome, front page, stylesheet and wording, over the same contracts and the same data.
Nothing underneath is duplicated, so a fix to a trade box or to the Safe handling reaches all five.

```bash
npm run brand -- ox        # writes brands/current.ts and app/brand.css, then build as usual
```

A deployment serves one brand per container, all reading `api.hood.grappes.dev`:

```bash
cd /root/hood-fam
docker compose -f docker-compose.yml -f docker-compose.proxy.yml -f docker-compose.brands.yml \
  build web-ox web-klimb web-pit web-bodega
docker compose -f docker-compose.yml -f docker-compose.proxy.yml -f docker-compose.brands.yml \
  up -d web-ox web-klimb web-pit web-bodega
```

Then the routes: copy `deploy/traefik-hood-brands.yaml` to
`/data/coolify/proxy/dynamic/hood-brands.yaml`. Traefik reads it without a restart.

**Each name needs its own DNS record first.** There is no wildcard on grappes.dev, and a host
without a record gets no certificate, so Traefik answers it with the default one and the browser
refuses. One A record per brand, at the box's address, before the first request.

`NEXT_PUBLIC_SITE_URL` differs per brand (it is what share cards and the Safe App manifest are built
against), which is why each service passes its own; everything else is the same build arg.

Two things that bite in this order, both measured the first time this was done for real:

- **`CORS_ORIGIN` must list every brand's origin.** Otherwise the new names load, render, and then
  say the feed is down, because the API refuses an origin it was never told about.
- **DNS only (grey cloud) for a new name**, so Traefik answers the ACME challenge itself and gets a
  certificate the way the existing names did. Proxying can be turned on afterwards.

## 4. Opening omnichain routes

Per token, per destination, and only for tokens worth the trouble. A route is two deployments and
four configurations, and it is not open until **both ends** are configured.

**What the defaults actually do.** Measured on forks of all seven destinations and of 4663: eid
30416 (this chain) is registered on the canonical endpoint everywhere, and every destination eid is
registered here, so the libraries resolve on both sides. But the default ULN config, on 4663 and on
every destination alike, names a DVN stub whose `getFee` reverts with "Please set your OApp's DVNs
and/or Executor". An OApp that only sets a peer cannot send, in either direction, and the error is
the same on both sides. The LayerZero Labs DVN on each chain does price the route (`0xd01ae690...`
on 4663, the per-chain addresses are in `destinationLayerZero` in the SDK's `chains.ts`), which is
what both scripts configure.

**Before you start.** A funded deployer on the destination chain (its own gas token) for one deploy
plus four configuration transactions; ETH on 4663 for the adapter and two transactions; and whoever
later sends tokens pays the LayerZero fee in the **source** chain's gas token (measured: about
1.26e-4 ETH from Base to 4663, 1.04e-4 ETH from 4663 to Base). Both ends must use the same
confirmations number, because `configureRoute` writes one config for send and receive; a receiver
expecting more confirmations than the sender attested to never verifies, and fails quietly. Both
scripts default to 15.

```bash
# 1. the destination chain, e.g. Base
export PRIVATE_KEY=0x...
export HOME_ADAPTER=$(cast call $HOOD_BRIDGE_FACTORY "predictAdapter(address)(address)" $TOKEN --rpc-url robinhood)
export TOKEN_NAME="Hood Fam" TOKEN_SYMBOL=FAM
export OWNER=0x...            # the multisig that ends up owning the remote
forge script script/DeployRemote.s.sol --rpc-url https://mainnet.base.org --broadcast
# prints REMOTE=0x...; re-run with REMOTE=0x... set to finish a half-done pass

# 2. back on 4663, with the bridge owner's key
export HOOD_BRIDGE_FACTORY=0x... TOKEN=0x... DST_EID=30184 REMOTE=0x...
forge script script/WireRemote.s.sol --rpc-url robinhood --broadcast

# 3. both ends must price before you tell anyone the route exists
cast call $HOME_ADAPTER "quoteSend((uint32,bytes32,uint256,uint256,bytes,bytes,bytes),bool)" ... --rpc-url robinhood
```

Both scripts read before they write, so running either twice changes nothing. `DeployRemote` hands
over the endpoint delegate first and the ownership second, because `transferOwnership` does not
carry the delegate. `OpenRoute.s.sol` is the older, write-only version of step 2 and is kept for a
route that is being opened by hand.

The bridge factory has no setter for enforced options, so a sender leaving 4663 always passes its
own `extraOptions`; the remote gets enforced options from the deploy script.

**Then send dust both ways and watch it land** on LayerZero Scan before announcing anything. A fork
proves the fee quotes and the packet leaving; it cannot prove the DVN signing or the executor
delivering on the far side.

## 5. The agent surface

```jsonc
// claude_desktop_config.json, or any MCP client
{
  "mcpServers": {
    "hood-fam": {
      "command": "node",
      "args": ["/srv/hood-fam/packages/mcp/dist/index.js"],
      "env": {
        "HOOD_FACTORY": "0x...", "HOOD_FEE_ROUTER": "0x...",
        "HOOD_STAKING": "0x...", "HOOD_GRADUATOR": "0x...",
        "HOOD_BRIDGE_FACTORY": "0x...", "HOOD_API": "https://api.hood.fam"
      }
    }
  }
}
```

Without `AGENT_MODE=1` every write needs `confirm: true` from the caller. With it, an agent acts on
its own, so give it a wallet that holds only what it is allowed to lose.

## 6. The support desk

The help button in the app is served by the API process. It needs one thing to answer and nothing
to take tickets:

```
ANTHROPIC_API_KEY=       # without it /support/status says enabled:false and the button opens tickets only
SUPPORT_ADMIN_TOKEN=     # bearer token for reading and updating the ticket queue; generate it, never reuse one
SUPPORT_MODEL=claude-opus-5
SUPPORT_EFFORT=medium    # low is cheaper and fine for FAQ traffic; raise it if answers get sloppy
SUPPORT_RATE_LIMIT=30    # messages per IP per ten minutes
```

The assistant reads `docs/SUPPORT.md`, `README.md`, `docs/ARCHITECTURE.md`, `docs/SECURITY.md` and
`FEATURES.md` once at boot, from `HOOD_DOCS_DIR` (the image copies them next to the code). Editing
the FAQ and restarting the API is how you change an answer. `RUNBOOK.md` is not read on purpose.

The ticket queue:

```bash
curl -H "Authorization: Bearer $SUPPORT_ADMIN_TOKEN" https://api.hood.fam/support/tickets?status=open
curl -X PATCH -H "Authorization: Bearer $SUPPORT_ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"status":"answered","note":"replied on telegram"}' https://api.hood.fam/support/tickets/12
```

Statuses are `open`, `answered`, `closed`. A ticket carries the contact the user gave, the wallet
they had connected, the page they were on and the last 24 messages of the chat, so the reply can
start from the receipt rather than from "what happened".

Cost is bounded three ways: the documents are one cached prefix, so a conversation pays for them
once; each message is capped at 4,000 characters and 24 turns; and each IP gets `SUPPORT_RATE_LIMIT`
messages per ten minutes. `usage` is logged per reply at info level.

## 7. When something breaks

**Testing on a fork.** The public 4663 RPC prunes historical state within about half an hour. An
anvil fork older than that starts failing reads that touch storage anvil never cached ("historical
state ... is not available"), and because the app batches reads through Multicall3, one such slot
blanks every number in the batch. Fork at the head, do the work, throw the fork away. It is the
fork's age, not the app.

**The indexer stopped.** `GET /health` is not advancing. Look at the logs: a refused log range
halves itself and retries, but a node that refuses even 32 blocks logs and skips. Restart with
`HOOD_START_BLOCK` set to the last good block and truncate nothing: every insert is idempotent on
`(tx, log_index)`.

**Points look wrong.** They are derived, never authoritative. Truncate `points` and `cursors`,
restart, and the indexer rebuilds them from the chain.

**A curve sold out and nothing opened the pool.** Anybody can call `finalize(curve)`, including from
the token page. The keeper does it within one tick.

**A graduated buyback will not flush.** It needs `flushBuyback(token, minTokensOut)`, because that
path swaps and a permissionless swap without a floor is a gift to sandwichers.

**A direct launch reverts on `createLaunch` with `BadHookSalt`.** The mined salt does not land on
the permission bits, which usually means the hook's bytecode changed and the miner is using a stale
initcode hash. Re-read it from the deployer.

**A direct launch's buckets are empty although trades are happening.** Two places money waits.
Buy-side tax sits in the hook as an ERC-6909 claim until the next swap or a `flushClaims()` call;
after that it sits in the splitter until `sweep()` divides it. The keeper does both every tick, and
anybody can.

**Nobody can trade a direct launch in its first block.** That is the window doing its job: the
launch block belongs to the creator. It ends by itself.

**A bridge quote reverts.** The route is not configured. Peer alone is not enough on 4663; see
step 4.

**The app shows zero market caps.** The indexer never filled `curve_supply`, which means the launch
was indexed before the RPC could answer. Re-index that range.
