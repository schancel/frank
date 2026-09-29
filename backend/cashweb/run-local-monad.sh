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

if ! awk '
    /^\[registry\.monad_mailbox\]$/ {
        sections += 1
        in_monad_mailbox = 1
        next
    }
    in_monad_mailbox && /^\[/ { in_monad_mailbox = 0 }
    in_monad_mailbox && /^enabled[[:space:]]*=[[:space:]]*false[[:space:]]*$/ {
        disabled += 1
    }
    END { exit !(sections == 1 && disabled == 1) }
' "$base_config"; then
    echo "run-local-monad: expected exactly one explicitly disabled Monad mailbox in $base_config" >&2
    exit 70
fi

# Process substitution feeds the generated configuration to the daemon through standard input.
# The private RPC URL therefore never gains a filesystem directory entry, even if this launcher
# or the server is killed without an opportunity to clean up. Redirecting the pipe onto fd 0 (as
# opposed to passing its `/dev/fd/*` path) preserves it through the Cargo-slot and Cargo exec chain.
cd -- "$script_dir"
exec "$repo_root/.agents/scripts/with-cargo-slot" \
    "$cargo_command" run -p cashwebd-exe -- - < <(MONAD_TESTNET_HTTP_RPC_URL="$rpc_url" awk '
    /^\[registry\.monad_mailbox\]$/ {
        in_monad_mailbox = 1
        print
        next
    }
    in_monad_mailbox && /^enabled[[:space:]]*=/ {
        print "enabled = true"
        print "rpc_url = \"" ENVIRON["MONAD_TESTNET_HTTP_RPC_URL"] "\""
        in_monad_mailbox = 0
        next
    }
    { print }
' "$base_config")
