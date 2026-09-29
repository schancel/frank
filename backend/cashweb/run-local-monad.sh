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

umask 077
runtime_config="$(mktemp "${TMPDIR:-/tmp}/frank-cashwebd-monad.XXXXXX")"
chmod 0600 "$runtime_config"
cleanup() {
    rm -f -- "$runtime_config"
}
trap cleanup EXIT HUP INT TERM

MONAD_TESTNET_HTTP_RPC_URL="$rpc_url" awk '
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
' "$base_config" >"$runtime_config"

if ! MONAD_TESTNET_HTTP_RPC_URL="$rpc_url" awk '
    $0 == "enabled = true" { enabled += 1 }
    $0 == "rpc_url = \"" ENVIRON["MONAD_TESTNET_HTTP_RPC_URL"] "\"" { rpc += 1 }
    END { exit !(enabled == 1 && rpc == 1) }
' "$runtime_config"; then
    echo "run-local-monad: could not enable exactly one Monad mailbox in the runtime config" >&2
    exit 70
fi

cd -- "$script_dir"
"$repo_root/.agents/scripts/with-cargo-slot" \
    "$cargo_command" run -p cashwebd-exe -- "$runtime_config"
