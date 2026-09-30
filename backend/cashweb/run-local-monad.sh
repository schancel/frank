#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd -- "$script_dir/../.." && pwd -P)"
base_config="$script_dir/cashwebd.local.toml"

# The demo launcher (packages/bot/demo) is the one reader of the user's `.env` and passes exactly
# the variables it needs, so it sets FRANK_RUN_LOCAL_SKIP_DOTENV=1: a `.env` value must not
# override what it passed (for example the fake-chain RPC URL).
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
    MONT | MON1) ;;
    *)
        echo "run-local-monad: FRANK_NETWORK_TAG must be MONT (Monad testnet) or MON1 (Monad mainnet); the relay maps only these to a Frank-CBOR network and refuses to start otherwise" >&2
        exit 64
        ;;
esac

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
#   FRANK_RELAY_LISTEN      host:port to listen on (also sets the advertised url), e.g. 127.0.0.1:18098
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
cashwebd="$("$repo_root/.agents/scripts/with-cargo-slot" bash -c '
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
    LAUNCHER_EXPECTED_CHAIN_ID="$expected_chain_id" awk '
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
    { print }
' "$base_config")"

# The daemon (not the config file) reads these two variables; export them explicitly so a value
# taken from a shell default (the tag) reaches it as well as one sourced from `.env`.
export MONAD_TESTNET_HTTP_RPC_URL="$rpc_url"
export FRANK_NETWORK_TAG="$network_tag"

# Effective, non-secret values for this run. The RPC URL is reported by scheme and host only: its
# path commonly embeds the provider API key.
rpc_origin="$(printf '%s' "$rpc_url" | sed -E 's#^([a-z]+://[^/?\#]*).*#\1#')"
{
    echo "run-local-monad: effective configuration"
    echo "  config file:            $base_config (mailbox enabled)"
    echo "  MONAD_TESTNET_HTTP_RPC_URL: set (origin $rpc_origin, path hidden)"
    echo "  FRANK_NETWORK_TAG:      $network_tag"
    echo "  min_value_wei:          $min_value_wei"
    echo "  expected_chain_id:      $expected_chain_id"
    echo "  MONAD_STAMP_BURN_ADDRESS: ${burn_address:-NOT SET}"
    if [[ -z "$burn_address" ]]; then
        echo "run-local-monad: WARNING: MONAD_STAMP_BURN_ADDRESS is not set: every forum topic post and vote will fail with HTTP 500 (direct messages still work). Set it (see .env.example)." >&2
    fi
} >&2

if [[ -n "${FRANK_RELAY_LISTEN:-}" ]]; then
    runtime_config="$(printf '%s\n' "$runtime_config" | awk '
        /^host = / { print "host = \"" ENVIRON["FRANK_RELAY_LISTEN"] "\""; next }
        /^url = / { print "url = \"http://" ENVIRON["FRANK_RELAY_LISTEN"] "\""; next }
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
exec "$cashwebd" - < <(printf '%s\n' "$runtime_config")
