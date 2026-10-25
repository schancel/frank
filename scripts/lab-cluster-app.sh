#!/usr/bin/env bash
# The three-relay cluster lab (backend/labs/compose.cluster.yml) on solonet, for the app and the
# bots. Local and disposable: nothing here touches signet.mx, ~/.frank-bots, ~/.frank-demo or any
# production identity, and every key it makes is a solonet test key.
#
#   scripts/lab-cluster-app.sh up        # solonet (started if absent), then the cluster with a
#                                        # fresh chain checkpoint; prints the app, funding and bot
#                                        # commands
#   scripts/lab-cluster-app.sh refresh-checkpoint   # a fresh checkpoint, relays restarted
#   scripts/lab-cluster-app.sh bots      # the bots against the cluster, in the foreground
#   scripts/lab-cluster-app.sh fund <0x address> <MON>   # the solonet faucet pays an account
#   scripts/lab-cluster-app.sh sweep     # the bot funding wallet pays its balance back to the faucet
#   scripts/lab-cluster-app.sh down      # stop the cluster, keeping its volumes
#
# The relays verify solonet against a checkpoint block taken when they start (16 behind the
# head). solonet keeps only a few thousand blocks (under an hour), so a relay that restarts later
# cannot verify that block any more. `up` therefore always takes a fresh checkpoint and restarts
# the relays; if paid sends or chain reads start failing after a relay restarted, run `up` or
# `refresh-checkpoint` again.
#
# Overrides: FRANK_LAB_CLUSTER_PORT (proxy port, default 18180), COMPOSE_PROJECT_NAME (default
# frank-lab-app), FRANK_LAB_CLUSTER_SUBNET (default 10.89.180), FRANK_LAB_DIR (bot state and the
# bot funding key, default ~/.frank-lab-cluster/<project>), FRANK_LAB_BOT_FUNDING_MON (what the
# bot funding wallet is topped up to, default 1000), FRANK_BOTS (default: every bot),
# FAUCET_AMOUNT_WEI (what the faucet bot grants each account once, default 1 MON, the most the
# faucet bot allows; for more, use `fund`).
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
export COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME:-frank-lab-app}
export FRANK_LAB_CLUSTER_PORT=${FRANK_LAB_CLUSTER_PORT:-18180}
export FRANK_LAB_CLUSTER_SUBNET=${FRANK_LAB_CLUSTER_SUBNET:-10.89.180}
# solonet as the containers reach it (Docker Desktop and Colima map host.docker.internal; the
# Compose file maps it to the host gateway on Linux).
export FRANK_LAB_SOLONET_RPC_URL=${FRANK_LAB_SOLONET_RPC_URL:-http://host.docker.internal:48080}
LAB_DIR=${FRANK_LAB_DIR:-$HOME/.frank-lab-cluster/$COMPOSE_PROJECT_NAME}
ORIGIN=http://127.0.0.1:$FRANK_LAB_CLUSTER_PORT
SOLONET_HOST_RPC=http://127.0.0.1:48080
BURN=0x000000000000000000000000000000000000dEaD
MIN_STAMP_WEI=1000000000000
FAUCET_WEI=1000000000000000000
COMPOSE=(docker compose -f "$ROOT/backend/labs/compose.cluster.yml")
BOT_KEY_FILE=$LAB_DIR/bot-funding-key.json
RELAYS=(relay-a relay-b relay-c)

bot() { yarn --silent --cwd "$ROOT/packages/bot" "$@"; }

ensure_solonet() {
  local status
  status=$(bot regtest:monad-status 2>&1 || true)
  echo "$status"
  if ! grep -q 'is at block' <<<"$status"; then
    echo "solonet is not making blocks; starting it (a cold start takes 5 to 8 minutes)"
    bot regtest:monad-start
  fi
}

wait_cluster() {
  local deadline=$((SECONDS + 300))
  until curl --fail --silent --output /dev/null \
    -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' \
    "$ORIGIN/chain-rpc/monad-regtest/rpc"; do
    if ((SECONDS > deadline)); then
      echo "the cluster at $ORIGIN does not forward to solonet; see: ${COMPOSE[*]} logs" >&2
      exit 1
    fi
    sleep 2
  done
}

# lab-init renders the relay configuration with a checkpoint 16 blocks behind solonet's head;
# the relays read it only when they start, so they are restarted after it.
refresh_checkpoint() {
  "${COMPOSE[@]}" up --no-deps --force-recreate lab-init
  "${COMPOSE[@]}" logs --no-color lab-init | grep 'checkpoint block' | tail -1 || true
  "${COMPOSE[@]}" restart "${RELAYS[@]}"
  wait_cluster
}

# The bot funding wallet: a fresh solonet key kept in the lab directory (mode 0600), topped up
# from the faucet. Never a production or demo key.
ensure_bot_key() {
  mkdir -p "$LAB_DIR/bots"
  chmod 0700 "$LAB_DIR"
  if [ ! -s "$BOT_KEY_FILE" ]; then
    (umask 077 && node -e '
      const { Wallet } = require(require.resolve("ethers", { paths: [process.argv[1]] }))
      const w = Wallet.createRandom()
      process.stdout.write(JSON.stringify({ address: w.address, privateKey: w.privateKey }) + "\n")
    ' "$ROOT/packages/bot" >"$BOT_KEY_FILE")
  fi
}

bot_address() { node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).address)' "$BOT_KEY_FILE"; }
bot_private_key() { node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).privateKey)' "$BOT_KEY_FILE"; }

balance_mon() {
  curl --fail --silent -H 'content-type: application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getBalance\",\"params\":[\"$1\",\"latest\"]}" \
    "$SOLONET_HOST_RPC" | node -e 'let t="";process.stdin.on("data",c=>t+=c).on("end",()=>{const w=BigInt(JSON.parse(t).result);process.stdout.write(String(w/10n**18n))})'
}

print_commands() {
  cat <<EOF

The cluster: three relays behind $ORIGIN (project $COMPOSE_PROJECT_NAME), on solonet.

App (another terminal, from the repository root; once per checkout: yarn install and
yarn --cwd app prepare:packages). The dev server is http://localhost:8080:

  cd app && QCLI_MONAD_RELAY_BASE_URL=$ORIGIN QCLI_MONAD_RPC_CHAIN=monad-regtest \\
    QCLI_MONAD_STAMP_BURN_ADDRESS=$BURN QCLI_CASHWEB_STAMP_MIN_BURN_VALUE_WEI=$MIN_STAMP_WEI \\
    yarn dev:browser

  When you create each account, open "Advanced options" and set the relay server to
  $ORIGIN. Without it the app talks to the relays through the dev server's own origin
  (http://localhost:8080), and group writes fail: their payments must commit to the relays'
  public origin, $ORIGIN. Direct messages work either way.
  For a second account in the same browser, use another origin (http://127.0.0.1:8080) or
  another browser profile: accounts live in the origin's storage.

  QCLI_MONAD_REGTEST_HTLC_ADDRESS and QCLI_MONAD_REGTEST_STATE_CHANNEL_ADDRESS are not needed:
  only swaps and state-channel games use them, and this lab deploys no contracts.

Fund an app account (its address is under Wallet / Receive) from the solonet faucet:

  scripts/lab-cluster-app.sh fund 0x... 20

  Monad keeps a 10 MON reserve per account, so fund more than 10 MON. A paid send right after
  funding waits a few blocks until the deposit is spendable.

Bots (another terminal): scripts/lab-cluster-app.sh bots, which runs

  BOT_STATE_DIR=$LAB_DIR/bots MONAD_RELAY_BASE_URL=$ORIGIN MONAD_RPC_CHAIN=monad-regtest \\
    MONAD_RPC_URL=$SOLONET_HOST_RPC MONAD_STAMP_BURN_ADDRESS=$BURN \\
    CASHWEB_STAMP_MIN_BURN_VALUE_WEI=$MIN_STAMP_WEI QWEN_BOT_MODE=stub \\
    FAUCET_AMOUNT_WEI=\${FAUCET_AMOUNT_WEI:-$FAUCET_WEI} \${FRANK_BOTS:+FRANK_BOTS=\$FRANK_BOTS} \\
    E2E_DEMO_MAIN_WALLET_PRIVATE_KEY=<lab key> \\
    yarn --cwd packages/bot target:all

  with a funding key of its own in $BOT_KEY_FILE, topped up from the faucet.

If paid sends or chain reads fail after a while (a relay restarted after solonet pruned its
checkpoint block): scripts/lab-cluster-app.sh refresh-checkpoint.

Return the test funds: scripts/lab-cluster-app.sh sweep (the bot funding wallet), and send each
app account's balance to the faucet, 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266, from the app.
Stop: scripts/lab-cluster-app.sh down. Reset (deletes this lab's volumes only):
  ${COMPOSE[*]} down --volumes
EOF
}

case "${1:-up}" in
  up)
    ensure_solonet
    "${COMPOSE[@]}" up -d --build
    # `up` leaves running relays on the checkpoint they started with.
    refresh_checkpoint
    echo "Replica-local owners (expected: forum, hourly quotas, directory enrollment quotas):"
    "${COMPOSE[@]}" logs --no-color relay-a | grep 'Replica-local owner' | sed 's/^/  /' | tail -3 || true
    print_commands
    ;;
  refresh-checkpoint)
    refresh_checkpoint
    ;;
  bots)
    wait_cluster
    ensure_bot_key
    address=$(bot_address)
    target=${FRANK_LAB_BOT_FUNDING_MON:-1000}
    have=$(balance_mon "$address")
    if ((have < target)); then
      bot regtest:monad-fund "$address" "$((target - have))"
    fi
    echo "bot funding wallet $address holds about $(balance_mon "$address") MON; state in $LAB_DIR/bots"
    cd "$ROOT/packages/bot"
    BOT_STATE_DIR=$LAB_DIR/bots MONAD_RELAY_BASE_URL=$ORIGIN MONAD_RPC_CHAIN=monad-regtest \
      MONAD_RPC_URL=$SOLONET_HOST_RPC MONAD_STAMP_BURN_ADDRESS=$BURN \
      CASHWEB_STAMP_MIN_BURN_VALUE_WEI=$MIN_STAMP_WEI QWEN_BOT_MODE=stub \
      FAUCET_AMOUNT_WEI=${FAUCET_AMOUNT_WEI:-$FAUCET_WEI} \
      E2E_DEMO_MAIN_WALLET_PRIVATE_KEY=$(bot_private_key) \
      exec yarn target:all
    ;;
  fund)
    [ $# -eq 3 ] || { echo "usage: $0 fund <0x address> <MON>" >&2; exit 2; }
    bot regtest:monad-fund "$2" "$3"
    ;;
  sweep)
    [ -s "$BOT_KEY_FILE" ] || { echo "no bot funding key in $BOT_KEY_FILE"; exit 0; }
    bot_private_key | bot regtest:monad-sweep
    ;;
  down)
    "${COMPOSE[@]}" down
    ;;
  *)
    sed -n '2,25p' "$0"
    exit 2
    ;;
esac
