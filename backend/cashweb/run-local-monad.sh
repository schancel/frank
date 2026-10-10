#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd -- "$script_dir/../.." && pwd -P)"
base_config="$script_dir/cashwebd.local.toml"

# The demo launcher (packages/bot/demo) is the one reader of the user's `.env` and passes exactly
# the variables it needs, so it sets FRANK_RUN_LOCAL_SKIP_DOTENV=1: a `.env` value must not
# override what it passed.
if [[ -f "$repo_root/.env" && "${FRANK_RUN_LOCAL_SKIP_DOTENV:-}" != "1" ]]; then
    set -a
    # shellcheck disable=SC1091 -- the repository-local environment is intentionally runtime-only.
    source "$repo_root/.env"
    set +a
fi

rpc_url="${MONAD_TESTNET_HTTP_RPC_URL:-}"
# The mailbox is enabled in the checked-in config, which already carries the local-testnet minimum
# and chain ID (10143; mainnet is 143). This launcher only overrides those two keys when the
# environment asks for something else. The RPC URL and network tag are never in the config: the
# daemon reads MONAD_TESTNET_HTTP_RPC_URL and FRANK_NETWORK_TAG from its environment, and refuses
# to start without them (an unset tag would make the relay reject every direct message, and a tag other than MONT or
# MON1 has no Frank-CBOR network mapping).
min_value_wei="${CASHWEB_STAMP_MIN_BURN_VALUE_WEI:-1000000000000}"
expected_chain_id="${MONAD_TESTNET_CHAIN_ID:-10143}"
network_tag="${FRANK_NETWORK_TAG:-MONT}"
cargo_command="${CARGO:-cargo}"
chronik_url="${XEC_TESTNET_CHRONIK_URL:-https://chronik-testnet.fabien.cash}"
solana_rpc_url="${SOLANA_DEVNET_HTTP_RPC_URL:-https://api.devnet.solana.com}"
# Public testnet Electrum servers (see cashwebd.local.toml for the checkpoint each must return).
btc_electrum_url="${BTC_TESTNET_ELECTRUM_URL:-ssl://electrum.blockstream.info:60002 ssl://blackie.c3-soft.com:57006 wss://testnet.aranguren.org:51004}"
bch_electrum_url="${BCH_TESTNET_ELECTRUM_URL:-ssl://testnet.imaginary.cash:50002 ssl://tbch.loping.net:60002}"
if [[ -z "$rpc_url" ]]; then
    echo "run-local-monad: MONAD_TESTNET_HTTP_RPC_URL is required (set it in .env or the environment)" >&2
    exit 64
fi
case "$rpc_url" in
    http://* | https://*) ;;
    *)
        echo "run-local-monad: MONAD_TESTNET_HTTP_RPC_URL must be an http(s) URL" >&2
        exit 64
        ;;
esac
# The value is inserted into one TOML basic string. Reject bytes that could escape that string or
# make the generated config multi-line; the URL itself is never printed or placed in argv.
case "$rpc_url" in
    *[![:print:]]* | *'"'* | *'\'*)
        echo "run-local-monad: MONAD_TESTNET_HTTP_RPC_URL contains unsupported characters" >&2
        exit 64
        ;;
esac

case "$network_tag" in
    MONT)
        rpc_chain="monad-testnet"
        canonical_chain_id="10143"
        canonical_checkpoint_hash="0x298034669ee44327d2da9744b9b2782848e2f2a6959756b7b0471b09a404f5c9"
        ;;
    MON1)
        rpc_chain="monad-mainnet"
        canonical_chain_id="143"
        canonical_checkpoint_hash="0x0c47353304f22b1c15706367d739b850cda80b5c87bbc335014fef3d88deaac9"
        ;;
    *)
        echo "run-local-monad: FRANK_NETWORK_TAG must be MONT (Monad testnet) or MON1 (Monad mainnet); the relay maps only these to a Frank-CBOR network and refuses to start otherwise" >&2
        exit 64
        ;;
esac
if [[ "$expected_chain_id" != "$canonical_chain_id" ]]; then
    echo "run-local-monad: MONAD_TESTNET_CHAIN_ID must be $canonical_chain_id when FRANK_NETWORK_TAG=$network_tag" >&2
    exit 64
fi

# The topic (forum) routes read MONAD_STAMP_BURN_ADDRESS at request time and answer HTTP 500 without
# it, while direct messages keep working: a silent half-broken relay. Warn loudly at startup, and
# reject a malformed value outright.
burn_address="${MONAD_STAMP_BURN_ADDRESS:-}"
if [[ -n "$burn_address" && ! "$burn_address" =~ ^0x[0-9a-fA-F]{40}$ ]]; then
    echo "run-local-monad: MONAD_STAMP_BURN_ADDRESS must be 0x followed by 40 hex characters" >&2
    exit 64
fi

case "$min_value_wei" in
    '' | *[!0-9]*)
        echo "run-local-monad: CASHWEB_STAMP_MIN_BURN_VALUE_WEI must be a decimal integer" >&2
        exit 64
        ;;
esac
case "$expected_chain_id" in
    '' | *[!0-9]*)
        echo "run-local-monad: MONAD_TESTNET_CHAIN_ID must be a decimal integer" >&2
        exit 64
        ;;
esac

if ! awk '
    /^\[registry\.monad_mailbox\]$/ {
        sections += 1
        in_monad_mailbox = 1
        next
    }
    in_monad_mailbox && /^\[/ { in_monad_mailbox = 0 }
    in_monad_mailbox && /^enabled[[:space:]]*=[[:space:]]*true[[:space:]]*$/ { enabled += 1 }
    in_monad_mailbox && /^min_value_wei[[:space:]]*=/ { minimum += 1 }
    in_monad_mailbox && /^expected_chain_id[[:space:]]*=/ { chain += 1 }
    in_monad_mailbox && /^rpc_url[[:space:]]*=/ { rpc += 1 }
    END { exit !(sections == 1 && enabled == 1 && minimum == 1 && chain == 1 && rpc == 0) }
' "$base_config"; then
    echo "run-local-monad: expected exactly one enabled Monad mailbox (with min_value_wei, expected_chain_id and no rpc_url) in $base_config" >&2
    exit 70
fi

cd -- "$script_dir"
# Optional overrides used by the demo launcher; unset they change nothing.
#   CASHWEBD_BIN            use this prebuilt daemon instead of building with Cargo
#   FRANK_RELAY_LISTEN      host:port to listen on (also sets the advertised url and the directory
#                           endpoint), e.g. 127.0.0.1:18098
#   FRANK_RELAY_PUBLIC_URL  the origin clients reach this relay at when it is not the listen
#                           address (a tunnel or proxy); becomes the directory endpoint
#   FRANK_RELAY_ID          this relay's 16-byte id (32 hex) in the directory section
#   FRANK_RELAY_IDENTITY    this relay's compressed public key (66 hex) in the directory section;
#                           two relays run side by side need their own id and identity
#   FRANK_RELAY_DB_PATH     RocksDB directory (default data/registry.rocksdb under backend/cashweb)
#   FRANK_RELAY_EXTRA_TOML  file of extra TOML appended to the config (curated defaults)
if [[ -n "${FRANK_RELAY_LISTEN:-}" && ! "${FRANK_RELAY_LISTEN}" =~ ^[0-9.]+:[0-9]+$ ]]; then
    echo "run-local-monad: FRANK_RELAY_LISTEN must look like 127.0.0.1:8098" >&2
    exit 64
fi
case "${FRANK_RELAY_DB_PATH:-}" in
    *[![:print:]]* | *'"'* | *'\'*)
        echo "run-local-monad: FRANK_RELAY_DB_PATH contains unsupported characters" >&2
        exit 64
        ;;
esac
if [[ -n "${FRANK_RELAY_ID:-}" && ! "${FRANK_RELAY_ID}" =~ ^[0-9a-f]{32}$ ]]; then
    echo "run-local-monad: FRANK_RELAY_ID must be 32 lowercase hex characters" >&2
    exit 64
fi
if [[ -n "${FRANK_RELAY_IDENTITY:-}" && ! "${FRANK_RELAY_IDENTITY}" =~ ^0[23][0-9a-f]{64}$ ]]; then
    echo "run-local-monad: FRANK_RELAY_IDENTITY must be a compressed public key (66 lowercase hex characters)" >&2
    exit 64
fi
case "${FRANK_RELAY_PUBLIC_URL:-}" in
    '' | http://* | https://*) ;;
    *)
        echo "run-local-monad: FRANK_RELAY_PUBLIC_URL must be an http(s) URL" >&2
        exit 64
        ;;
esac
case "${FRANK_RELAY_PUBLIC_URL:-}" in
    *[![:print:]]* | *'"'* | *'\'* | */)
        echo "run-local-monad: FRANK_RELAY_PUBLIC_URL contains unsupported characters or a trailing slash" >&2
        exit 64
        ;;
esac
if [[ -n "${FRANK_RELAY_EXTRA_TOML:-}" && ! -f "${FRANK_RELAY_EXTRA_TOML}" ]]; then
    echo "run-local-monad: FRANK_RELAY_EXTRA_TOML is not a file: ${FRANK_RELAY_EXTRA_TOML}" >&2
    exit 64
fi

artifact_parser='
    my $record = decode_json($_);
    if (($record->{reason} // "") eq "compiler-message") {
        my $rendered = $record->{message}->{rendered};
        print STDERR $rendered if defined $rendered;
        next;
    }
    next unless ($record->{reason} // "") eq "compiler-artifact";
    next unless ($record->{target}->{name} // "") eq "cashwebd-exe";
    next unless grep { $_ eq "bin" } @{$record->{target}->{kind} // []};
    next unless defined $record->{executable};
    die "run-local-monad: Cargo reported multiple cashwebd-exe artifacts\n"
        if defined $artifact;
    $artifact = $record->{executable};
    END {
        die "run-local-monad: Cargo did not report a cashwebd-exe artifact\n"
            unless defined $artifact;
        print $artifact;
    }
'
if [[ -n "${CASHWEBD_BIN:-}" ]]; then
    cashwebd="$CASHWEBD_BIN"
else
protoc="$(bash "$script_dir/protoc-tool/resolve.sh" "$repo_root")"
cashwebd="$(PROTOC="$protoc" "$repo_root/.agents/scripts/with-cargo-slot" bash -c '
    set -euo pipefail
    "$1" build -p cashwebd-exe --bin cashwebd-exe \
        --message-format=json-render-diagnostics |
        perl -MJSON::PP=decode_json -ne "$2"
' run-local-monad-build "$cargo_command" "$artifact_parser")"
fi
if [[ ! -x "$cashwebd" ]]; then
    echo "run-local-monad: built daemon is not executable: $cashwebd" >&2
    exit 70
fi

runtime_config="$(LAUNCHER_MIN_VALUE_WEI="$min_value_wei" \
    LAUNCHER_EXPECTED_CHAIN_ID="$expected_chain_id" \
    LAUNCHER_RPC_CHAIN="$rpc_chain" \
    LAUNCHER_EVM_CHECKPOINT_HASH="$canonical_checkpoint_hash" awk '
    /^\[registry\.monad_mailbox\]$/ { in_monad_mailbox = 1 }
    in_monad_mailbox && /^\[/ && !/^\[registry\.monad_mailbox\]$/ { in_monad_mailbox = 0 }
    in_monad_mailbox && /^min_value_wei[[:space:]]*=/ {
        print "min_value_wei = \"" ENVIRON["LAUNCHER_MIN_VALUE_WEI"] "\""
        next
    }
    in_monad_mailbox && /^expected_chain_id[[:space:]]*=/ {
        print "expected_chain_id = " ENVIRON["LAUNCHER_EXPECTED_CHAIN_ID"]
        next
    }
    # The directory accepts entries for the same network the mailbox and the RPC proxy serve.
    /^\[registry\.directory\]$/ { in_directory = 1 }
    in_directory && /^\[/ && !/^\[registry\.directory\]$/ { in_directory = 0 }
    in_directory && /^network[[:space:]]*=/ {
        print "network = \"" ENVIRON["LAUNCHER_RPC_CHAIN"] "\""
        next
    }
    /^\[\[registry\.evm_rpc\.chains\]\]$/ { in_evm_chain = 1 }
    in_evm_chain && /^\[/ && !/^\[\[registry\.evm_rpc\.chains\]\]$/ { in_evm_chain = 0 }
    in_evm_chain && /^id[[:space:]]*=/ {
        print "id = \"" ENVIRON["LAUNCHER_RPC_CHAIN"] "\""
        next
    }
    in_evm_chain && /^expected_chain_id[[:space:]]*=/ {
        print "expected_chain_id = " ENVIRON["LAUNCHER_EXPECTED_CHAIN_ID"]
        next
    }
    in_evm_chain && /^checkpoint_block_hash[[:space:]]*=/ {
        print "checkpoint_block_hash = \"" ENVIRON["LAUNCHER_EVM_CHECKPOINT_HASH"] "\""
        next
    }
    { print }
' "$base_config")"

# The daemon (not the config file) reads these variables; export them explicitly so a value
# taken from a shell default (the tag, chronik, solana) reaches it as well as one sourced from `.env`.
export MONAD_TESTNET_HTTP_RPC_URL="$rpc_url"
export FRANK_NETWORK_TAG="$network_tag"
export XEC_TESTNET_CHRONIK_URL="$chronik_url"
export SOLANA_DEVNET_HTTP_RPC_URL="$solana_rpc_url"
export BTC_TESTNET_ELECTRUM_URL="$btc_electrum_url"
export BCH_TESTNET_ELECTRUM_URL="$bch_electrum_url"

# Effective, non-secret values for this run. The RPC URL is reported by scheme and host only: its
# path commonly embeds the provider API key.
rpc_origin="$(printf '%s' "$rpc_url" | sed -E 's#^([a-z]+://[^/?\#]*).*#\1#')"
chronik_origin="$(printf '%s' "$chronik_url" | sed -E 's#^([a-z]+://[^/?\#]*).*#\1#')"
solana_origin="$(printf '%s' "$solana_rpc_url" | sed -E 's#^([a-z]+://[^/?\#]*).*#\1#')"
{
    echo "run-local-monad: effective configuration"
    echo "  config file:            $base_config (mailbox enabled)"
    echo "  MONAD_TESTNET_HTTP_RPC_URL: set (origin $rpc_origin, path hidden)"
    echo "  FRANK_NETWORK_TAG:      $network_tag"
    echo "  min_value_wei:          $min_value_wei"
    echo "  expected_chain_id:      $expected_chain_id"
    echo "  rpc_chain:              $rpc_chain"
    echo "  XEC_TESTNET_CHRONIK_URL: set (origin $chronik_origin, path hidden)"
    echo "  SOLANA_DEVNET_HTTP_RPC_URL: set (origin $solana_origin, path hidden)"
    echo "  MONAD_STAMP_BURN_ADDRESS: ${burn_address:-NOT SET}"
    if [[ -z "$burn_address" ]]; then
        echo "run-local-monad: WARNING: MONAD_STAMP_BURN_ADDRESS is not set: every forum topic post and vote will fail with HTTP 500 (direct messages still work). Set it (see .env.example)." >&2
    fi
} >&2

if [[ -n "${FRANK_RELAY_LISTEN:-}" ]]; then
    runtime_config="$(printf '%s\n' "$runtime_config" | awk '
        /^host = / { print "host = \"" ENVIRON["FRANK_RELAY_LISTEN"] "\""; next }
        /^url = / { print "url = \"http://" ENVIRON["FRANK_RELAY_LISTEN"] "\""; next }
        /^endpoint = / { print "endpoint = \"http://" ENVIRON["FRANK_RELAY_LISTEN"] "\""; next }
        { print }
    ')"
fi
if [[ -n "${FRANK_RELAY_PUBLIC_URL:-}" ]]; then
    runtime_config="$(printf '%s\n' "$runtime_config" | awk '
        /^endpoint = / { print "endpoint = \"" ENVIRON["FRANK_RELAY_PUBLIC_URL"] "\""; next }
        { print }
    ')"
fi
if [[ -n "${FRANK_RELAY_ID:-}" ]]; then
    runtime_config="$(printf '%s\n' "$runtime_config" | awk '
        /^relay_id = / { print "relay_id = \"" ENVIRON["FRANK_RELAY_ID"] "\""; next }
        { print }
    ')"
fi
if [[ -n "${FRANK_RELAY_IDENTITY:-}" ]]; then
    runtime_config="$(printf '%s\n' "$runtime_config" | awk '
        /^relay_identity = / { print "relay_identity = \"" ENVIRON["FRANK_RELAY_IDENTITY"] "\""; next }
        { print }
    ')"
fi
if [[ -n "${FRANK_RELAY_DB_PATH:-}" ]]; then
    runtime_config="$(printf '%s\n' "$runtime_config" | awk '
        /^db_path = / { print "db_path = \"" ENVIRON["FRANK_RELAY_DB_PATH"] "\""; next }
        { print }
    ')"
fi
if [[ -n "${FRANK_RELAY_EXTRA_TOML:-}" ]]; then
    runtime_config="$runtime_config"$'\n'"$(cat -- "$FRANK_RELAY_EXTRA_TOML")"
fi

# Validate the exact generated text through the production parser before starting the daemon, with
# the same environment the daemon will see. The Cargo slot covers compilation only, so the
# long-lived relay cannot block builds in other worktrees.
printf '%s\n' "$runtime_config" | "$cashwebd" --check-config -

# This launcher is for development, demos and tests. A relay database written by an earlier
# development build (the relay has no reader for it and refuses to start, naming the paths) is
# MOVED ASIDE here, never deleted, and the relay starts on a fresh one: bots and test users
# publish their directory entries again when they start. Only the paths the refusal names are
# renamed (the registry database and its message stores: messages, profiles, topics and directory
# entries; no keys, no funds). The session secret and everything else beside them stay. A relay
# started directly, as in production, keeps refusing.
move_old_relay_database_aside() {
    local refusal="$1" db stem stamp moved=() path
    db="$(printf '%s\n' "$runtime_config" | sed -n 's/^db_path = "\(.*\)"$/\1/p' | head -n 1)"
    [[ -n "$db" ]] || return 1
    # Rust's Path::with_extension: the last extension of the file name is replaced.
    case "${db##*/}" in
        ?*.*) stem="${db%.*}" ;;
        *) stem="$db" ;;
    esac
    stamp="$(date -u +%Y%m%dT%H%M%SZ)"
    for path in "$db" "$stem.messages-v2" "$stem.monad-dm-cbor-v1"; do
        [[ -e "$path" ]] || continue
        # Only what the relay itself named.
        [[ "$refusal" == *"$path"* ]] || continue
        mv -- "$path" "$path.old-format-$stamp"
        moved+=("$path -> $path.old-format-$stamp")
    done
    [[ ${#moved[@]} -gt 0 ]] || return 1
    echo "run-local-monad: the relay database was written by an earlier development build that this relay cannot read; MOVED ASIDE (not deleted): ${moved[*]}. Starting on a fresh relay database; wallets, bots and keys are untouched." >&2
}
if ! db_check="$(printf '%s\n' "$runtime_config" | "$cashwebd" --check-db - 2>&1)"; then
    if [[ "$db_check" == *"Development reset"* ]] && move_old_relay_database_aside "$db_check"; then
        printf '%s\n' "$runtime_config" | "$cashwebd" --check-db -
    elif [[ "$db_check" == *"--check-db"* ]]; then
        # A prebuilt relay (CASHWEBD_BIN) from before the check existed: start it as before.
        echo "run-local-monad: this relay binary has no --check-db; an old-format database will be refused by the relay itself" >&2
    else
        printf '%s\n' "$db_check" >&2
        exit 1
    fi
fi
exec "$cashwebd" - < <(printf '%s\n' "$runtime_config")
