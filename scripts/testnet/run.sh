#!/usr/bin/env bash
# The whole v4 launchpad on the public testnet (Robinhood Chain 46630), step by step.
#
#   bash scripts/testnet/run.sh status          addresses and balances of the twelve test wallets
#   bash scripts/testnet/run.sh fund            the deployer hands each role its test ETH
#   bash scripts/testnet/run.sh safe            a 2-of-2 Safe of the two signer wallets (owner and treasury)
#   bash scripts/testnet/run.sh dollar          tUSDG, six decimals, 100,000 minted to every wallet
#   bash scripts/testnet/run.sh deploy          Deploy.s.sol with OWNER=TREASURY=the Safe, KEEPER=keeper
#   bash scripts/testnet/run.sh accept          the Safe accepts every contract, two signatures, executed
#   bash scripts/testnet/run.sh scenario [phase ...]   scripts/testnet/scenario.mjs
#   bash scripts/testnet/run.sh stack           local api + indexer + keeper + web against the testnet
#   bash scripts/testnet/run.sh stop            stops the local stack
#   bash scripts/testnet/run.sh all             fund, safe, dollar, deploy, accept, stack, scenario
#
# Keys live in .deploy/testnet/wallets.json (gitignored, mode 600) and are read inside this shell
# only; nothing here prints one. What the steps learn goes to .deploy/testnet/testnet.env.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
# TESTNET_RPC and TESTNET_DIR point the same steps at a local fork of 46630 for a dry run, with
# its own env file, so nothing it learns is mistaken for the real testnet deployment.
DIR=${TESTNET_DIR:-.deploy/testnet}
WALLETS=$ROOT/.deploy/testnet/wallets.json
ENVF=$DIR/testnet.env
LOGS=$DIR/logs
RPC=${TESTNET_RPC:-https://rpc.testnet.chain.robinhood.com}
mkdir -p "$LOGS"
[[ -f $WALLETS ]] || { echo "no $WALLETS"; exit 1; }
touch "$ENVF"

addr() { python3 -c "import json,sys; print(json.load(open('$WALLETS'))['$1']['address'])"; }
key() { python3 -c "import json,sys; print(json.load(open('$WALLETS'))['$1']['private_key'])"; }
setenv() { # setenv KEY VALUE: replace or append in testnet.env
  python3 - "$ENVF" "$1" "$2" <<'PY'
import sys
p,k,v=sys.argv[1:]
lines=[l for l in open(p).read().splitlines() if l and not l.startswith(k+"=")]
lines.append(f"{k}={v}")
open(p,"w").write("\n".join(lines)+"\n")
PY
}
loadenv() { set -a; source "$ENVF"; set +a; }
ROLES="deployer safe_signer_1 safe_signer_2 keeper creator fee_recipient team_1 team_2 team_3 sniper trader_1 trader_2"
export HOOD_CHAIN_ID=46630 RPC_URL=$RPC HOOD_RPC=$RPC

step=${1:-help}; shift || true
case $step in
  status)
    loadenv
    for r in $ROLES; do
      a=$(addr $r); eth=$(cast balance "$a" --rpc-url $RPC --ether)
      usd=""; [[ -n ${TESTNET_USDG:-} ]] && usd=" $(cast call "$TESTNET_USDG" 'balanceOf(address)(uint256)' "$a" --rpc-url $RPC | cut -d' ' -f1) tUSDG(6dp)"
      printf "%-14s %s %s ETH%s\n" "$r" "$a" "$eth" "$usd"
    done
    if [[ -n ${HOOD_SAFE:-} ]]; then echo "safe           $HOOD_SAFE"; fi
    if [[ -n ${HOOD_FACTORY:-} ]]; then echo "factory        $HOOD_FACTORY"; fi
    ;;

  fund)
    # What each role spends in the scenario, with room: launches cost 0.002 ETH in fees, trades a
    # few thousandths, gas on this chain is nothing. The deployer keeps the rest for the deploy.
    PK=$(key deployer)
    for pair in safe_signer_1:0.003 safe_signer_2:0.001 keeper:0.01 creator:0.04 fee_recipient:0.002 \
                team_1:0.008 team_2:0.003 team_3:0.003 sniper:0.01 trader_1:0.012 trader_2:0.01; do
      r=${pair%%:*}; eth=${pair#*:}
      a=$(addr $r); have=$(cast balance "$a" --rpc-url $RPC)
      want=$(cast to-wei "$eth")
      if python3 -c "import sys; sys.exit(0 if $have >= $want else 1)"; then echo "$r has enough"; continue; fi
      cast send --private-key "$PK" --rpc-url $RPC "$a" --value $(python3 -c "print($want - $have)") >/dev/null && echo "funded $r to $eth ETH"
    done
    ;;

  safe)
    out=$(PRIVATE_KEY=$(key deployer) SAFE_OWNERS="$(addr safe_signer_1),$(addr safe_signer_2)" SAFE_THRESHOLD=2 \
      forge script script/DeploySafe.s.sol --rpc-url "$RPC" --broadcast 2>&1 | tee "$LOGS/safe.log")
    safe=$(grep -oE "(created|exists) +0x[0-9a-fA-F]{40}" <<<"$out" | grep -oE "0x[0-9a-fA-F]{40}" | head -1)
    [[ -n $safe ]] || { tail -20 "$LOGS/safe.log"; exit 1; }
    setenv HOOD_SAFE "$safe"; echo "safe $safe (2 of 2)"
    ;;

  dollar)
    loadenv
    if [[ -n ${TESTNET_USDG:-} ]]; then echo "tUSDG already at $TESTNET_USDG"; exit 0; fi
    to=$(for r in $ROLES; do printf "%s," "$(addr $r)"; done); to=${to%,}
    out=$(PRIVATE_KEY=$(key deployer) MINT_TO="$to" MINT_EACH=100000000000 \
      forge script script/testnet/DeployTestDollar.s.sol --rpc-url "$RPC" --broadcast --slow 2>&1 | tee "$LOGS/dollar.log")
    usd=$(grep -oE "TESTNET_USDG=0x[0-9a-fA-F]{40}" <<<"$out" | head -1 | cut -d= -f2)
    [[ -n $usd ]] || { tail -20 "$LOGS/dollar.log"; exit 1; }
    setenv TESTNET_USDG "$usd"; setenv HOOD_USDG "$usd"; echo "tUSDG $usd, 100,000 minted to each of the twelve"
    ;;

  deploy)
    loadenv
    [[ -n ${HOOD_SAFE:-} && -n ${TESTNET_USDG:-} ]] || { echo "run safe and dollar first"; exit 1; }
    PRIVATE_KEY=$(key deployer) OWNER=$HOOD_SAFE TREASURY=$HOOD_SAFE KEEPER=$(addr keeper) TESTNET_USDG=$TESTNET_USDG \
      forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast --slow > "$LOGS/deploy.log" 2>&1 \
      || { grep -E "Error|revert" "$LOGS/deploy.log" | head; exit 1; }
    grep -E "^ *HOOD_[A-Z_]+=" "$LOGS/deploy.log" | sed 's/^ *//' | awk -F= '!seen[$1]++' | while IFS== read -r k v; do setenv "$k" "$v"; done
    grep -E "ONCHAIN EXECUTION|PENDING" "$LOGS/deploy.log" | head
    grep -E "^HOOD_" "$ENVF"
    ;;

  accept)
    loadenv
    ( cd "$DIR" && SAFE_SIGNER_KEYS="$(key safe_signer_1),$(key safe_signer_2)" EXECUTOR_KEY=$(key safe_signer_1) \
      node "$ROOT/scripts/safe.mjs" accept --sign --exec )
    for c in HOOD_FACTORY HOOD_PORTAL HOOD_BRIDGE_FACTORY HOOD_REFERRALS; do
      printf "%-20s owner %s\n" $c "$(cast call "${!c}" 'owner()(address)' --rpc-url $RPC)"
    done
    ;;

  scenario)
    loadenv
    WALLETS="$WALLETS" SCENARIO_STATE="$ROOT/$DIR/scenario.json" HOOD_API=${HOOD_API:-} node scripts/testnet/scenario.mjs "$@"
    ;;

  stack)
    loadenv
    DB=hood_testnet
    psql -h 127.0.0.1 -d postgres -tc "select 1 from pg_database where datname='$DB'" | grep -q 1 || psql -h 127.0.0.1 -d postgres -c "create database $DB" >/dev/null
    npm run build -w @hood/sdk >/dev/null && npm run build -w @hood/api >/dev/null && npm run build -w @hood/keeper >/dev/null
    API_PORT=8299; WEB_PORT=4675
    ( DATABASE_URL=postgres://127.0.0.1:5432/$DB PORT=$API_PORT INDEXER=1 API=1 NODE_ENV=development TRUST_PROXY=false \
      RATE_LIMIT_TRUST_LOCAL=1 HOOD_CONFIRMATIONS=2 HOOD_POLL_MS=1000 HOOD_ETH_USD=3000 \
      nohup node apps/api/dist/index.js > "$LOGS/api.log" 2>&1 & echo $! > $DIR/api.pid )
    sleep 3
    ( HOOD_API=http://127.0.0.1:$API_PORT KEEPER_PRIVATE_KEY=$(key keeper) \
      nohup node apps/keeper/dist/index.js > "$LOGS/keeper.log" 2>&1 & echo $! > $DIR/keeper.pid )
    # The web: NEXT_PUBLIC_* from the deployment. The team console opens to the wallets in
    # NEXT_PUBLIC_TEAM_WALLETS; set it in the environment before `stack` to your browser wallet.
    ( cd apps/web && NEXT_PUBLIC_CHAIN_ID=46630 NEXT_PUBLIC_USDG=$TESTNET_USDG NEXT_PUBLIC_API_URL=http://127.0.0.1:$API_PORT \
      NEXT_PUBLIC_SITE_URL=http://127.0.0.1:$WEB_PORT NEXT_PUBLIC_FACTORY=$HOOD_FACTORY NEXT_PUBLIC_FEE_ROUTER=$HOOD_FEE_ROUTER \
      NEXT_PUBLIC_STAKING=$HOOD_STAKING NEXT_PUBLIC_GRADUATOR=$HOOD_GRADUATOR NEXT_PUBLIC_BRIDGE_FACTORY=$HOOD_BRIDGE_FACTORY \
      NEXT_PUBLIC_PORTAL=$HOOD_PORTAL NEXT_PUBLIC_DIRECT_DEPLOYER=$HOOD_DIRECT_DEPLOYER NEXT_PUBLIC_BUYBACK_MODULE=$HOOD_BUYBACK_MODULE \
      NEXT_PUBLIC_CURVE_ROUTER=$HOOD_CURVE_ROUTER NEXT_PUBLIC_BAG=$HOOD_BAG NEXT_PUBLIC_PAYDAY=$HOOD_PAYDAY \
      NEXT_PUBLIC_BURN_CLOCK=$HOOD_BURN_CLOCK NEXT_PUBLIC_BOOSTS=$HOOD_BOOSTS NEXT_PUBLIC_GRADUATION_HOOK=$HOOD_GRADUATION_HOOK \
      NEXT_PUBLIC_BLOCK_ZERO=$HOOD_BLOCK_ZERO NEXT_PUBLIC_TEAM_WALLETS=${NEXT_PUBLIC_TEAM_WALLETS:-} \
      NEXT_DIST_DIR=.next-testnet nohup npx next dev -p $WEB_PORT > "$ROOT/$LOGS/web.log" 2>&1 & echo $! > "$ROOT/$DIR/web.pid" )
    setenv HOOD_API http://127.0.0.1:$API_PORT
    echo "api    http://127.0.0.1:$API_PORT   (log $LOGS/api.log)"
    echo "keeper                                (log $LOGS/keeper.log)"
    echo "web    http://127.0.0.1:$WEB_PORT   (log $LOGS/web.log; add Robinhood Chain Testnet, id 46630, to your wallet)"
    ;;

  stop)
    for p in api keeper web; do [[ -f $DIR/$p.pid ]] && { kill "$(cat $DIR/$p.pid)" 2>/dev/null || true; rm -f $DIR/$p.pid; echo "stopped $p"; }; done
    ;;

  all)
    for s in fund safe dollar deploy accept stack; do echo; echo "== $s"; bash "$0" $s; done
    sleep 20; echo; echo "== scenario"; bash "$0" scenario
    ;;

  *) sed -n '2,16p' "$0" ;;
esac
