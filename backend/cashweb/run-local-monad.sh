#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd -- "$script_dir/../.." && pwd -P)"
base_config="$script_dir/cashwebd.local.toml"

if [[ -f "$repo_root/.env" ]]; then
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
# to start without them (an unset tag would make the relay reject every direct message).
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
    '' | *[![:alnum:]]*)
        echo "run-local-monad: FRANK_NETWORK_TAG must be alphanumeric (MONT = Monad testnet, MON1 = mainnet)" >&2
        exit 64
        ;;
esac

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
cashwebd="$("$repo_root/.agents/scripts/with-cargo-slot" bash -c '
    set -euo pipefail
    "$1" build -p cashwebd-exe --bin cashwebd-exe \
        --message-format=json-render-diagnostics |
        perl -MJSON::PP=decode_json -ne "$2"
' run-local-monad-build "$cargo_command" "$artifact_parser")"
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
} >&2

# Validate the exact generated text through the production parser before starting the daemon, with
# the same environment the daemon will see. The Cargo slot covers compilation only, so the
# long-lived relay cannot block builds in other worktrees.
printf '%s\n' "$runtime_config" | "$cashwebd" --check-config -
exec "$cashwebd" - < <(printf '%s\n' "$runtime_config")
