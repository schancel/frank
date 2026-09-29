#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd -- "$script_dir/../.." && pwd -P)"
fixture_root="$(mktemp -d "${TMPDIR:-/tmp}/frank-run-local-monad-test.XXXXXX")"

cleanup() {
    find "$fixture_root" -depth -delete
}
trap cleanup EXIT HUP INT TERM

mkdir -p \
    "$fixture_root/.agents/scripts" \
    "$fixture_root/.cargo" \
    "$fixture_root/backend/cashweb" \
    "$fixture_root/bin" \
    "$fixture_root/tmp"
git init -q "$fixture_root"
cp "$script_dir/run-local-monad.sh" "$fixture_root/backend/cashweb/"
cp "$script_dir/cashwebd.local.toml" "$fixture_root/backend/cashweb/"
cp "$repo_root/.agents/scripts/with-cargo-slot" "$fixture_root/.agents/scripts/"

cat >"$fixture_root/bin/fake-cargo" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ "${1:-}" == "build" ]]
[[ -n "${CARGO_TARGET_DIR:-}" ]]
target_name="${CARGO_BUILD_TARGET:-}"
if [[ -z "$target_name" ]]; then
    repo_root="$(git rev-parse --show-toplevel)"
    if [[ -f "$repo_root/.cargo/config.toml" ]]; then
        target_name="$(sed -n 's/^[[:space:]]*target[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' \
            "$repo_root/.cargo/config.toml")"
    fi
fi
artifact_dir="$CARGO_TARGET_DIR"
if [[ -n "$target_name" ]]; then
    artifact_dir="$artifact_dir/$target_name"
fi
artifact="$artifact_dir/debug/cashwebd-exe"
mkdir -p "$artifact_dir/debug"
cat >"$artifact" <<'DAEMON'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "--check-config" ]]; then
    [[ "${2:-}" == "-" ]]
    config="$(cat)"
    grep -q '^\[registry\.monad_mailbox\]$' <<<"$config"
    grep -q '^enabled = true$' <<<"$config"
    grep -q '^rpc_url = "https\?://' <<<"$config"
    exit 0
fi
printf '%s\n' "$@" >"$FRANK_LAUNCHER_ARGS"
cat >"$FRANK_LAUNCHER_CONFIG"
if [[ "${FRANK_LAUNCHER_MODE:-}" == "block" ]]; then
    trap 'exit 143' TERM
    while :; do
        sleep 1
    done
fi
DAEMON
chmod +x "$artifact"
FRANK_FAKE_ARTIFACT="$artifact" perl -MJSON::PP=encode_json -e '
    print encode_json({
        reason => "compiler-artifact",
        target => {name => "cashwebd-exe", kind => ["bin"]},
        executable => $ENV{FRANK_FAKE_ARTIFACT},
    }), "\n";
'
EOF
chmod +x \
    "$fixture_root/.agents/scripts/with-cargo-slot" \
    "$fixture_root/backend/cashweb/run-local-monad.sh" \
    "$fixture_root/bin/fake-cargo"

launcher="$fixture_root/backend/cashweb/run-local-monad.sh"
args_file="$fixture_root/args"
config_file="$fixture_root/config"
dummy_rpc_url="https://rpc.invalid.example/v2/test-only"
export XDG_CACHE_HOME="$fixture_root/cache"

if env -u MONAD_TESTNET_HTTP_RPC_URL \
    CARGO="$fixture_root/bin/fake-cargo" \
    "$launcher" >"$fixture_root/missing.out" 2>"$fixture_root/missing.err"; then
    echo "missing RPC URL unexpectedly succeeded" >&2
    exit 1
else
    status=$?
    [[ "$status" -eq 64 ]]
fi

if MONAD_TESTNET_HTTP_RPC_URL="file:///not-an-rpc" \
    CARGO="$fixture_root/bin/fake-cargo" \
    "$launcher" >"$fixture_root/invalid.out" 2>"$fixture_root/invalid.err"; then
    echo "invalid RPC URL unexpectedly succeeded" >&2
    exit 1
else
    status=$?
    [[ "$status" -eq 64 ]]
fi

(
    cd /
    TMPDIR="$fixture_root/tmp" \
        MONAD_TESTNET_HTTP_RPC_URL="$dummy_rpc_url" \
        CARGO="$fixture_root/bin/fake-cargo" \
        FRANK_LAUNCHER_ARGS="$args_file" \
        FRANK_LAUNCHER_CONFIG="$config_file" \
        "$launcher"
)

diff -u <(printf '%s\n' -) "$args_file"
[[ "$(grep -c '^\[registry\.monad_mailbox\]$' "$config_file")" -eq 1 ]]
[[ "$(grep -c '^enabled = true$' "$config_file")" -eq 1 ]]
[[ "$(grep -Fxc "rpc_url = \"$dummy_rpc_url\"" "$config_file")" -eq 1 ]]
[[ -z "$(find "$fixture_root/tmp" -type f -print -quit)" ]]

configured_target="fixture-host-target"
rm -f -- "$args_file" "$config_file"
CARGO_BUILD_TARGET="$configured_target" \
    MONAD_TESTNET_HTTP_RPC_URL="$dummy_rpc_url" \
    CARGO="$fixture_root/bin/fake-cargo" \
    FRANK_LAUNCHER_ARGS="$args_file" \
    FRANK_LAUNCHER_CONFIG="$config_file" \
    "$launcher"
[[ -n "$(find "$fixture_root/cache/cargo-target" \
    -path "*/$configured_target/debug/cashwebd-exe" -type f -perm -u+x -print -quit)" ]]
[[ -s "$config_file" ]]

cat >"$fixture_root/.cargo/config.toml" <<EOF
[build]
target = "$configured_target"
EOF
rm -f -- "$args_file" "$config_file"
env -u CARGO_BUILD_TARGET \
    MONAD_TESTNET_HTTP_RPC_URL="$dummy_rpc_url" \
    CARGO="$fixture_root/bin/fake-cargo" \
    FRANK_LAUNCHER_ARGS="$args_file" \
    FRANK_LAUNCHER_CONFIG="$config_file" \
    "$launcher"
[[ -s "$config_file" ]]
rm -f -- "$fixture_root/.cargo/config.toml"

cp "$repo_root/.env.example" "$fixture_root/.env"
printf '\nCARGO=%q\nFRANK_LAUNCHER_ARGS=%q\nFRANK_LAUNCHER_CONFIG=%q\n' \
    "$fixture_root/bin/fake-cargo" "$args_file" "$config_file" >>"$fixture_root/.env"
env -u MONAD_TESTNET_HTTP_RPC_URL "$launcher"
grep -Fq 'rpc_url = "https://monad-testnet.g.alchemy.com/v2/<your-alchemy-key>"' "$config_file"

rm -f -- "$config_file"
TMPDIR="$fixture_root/tmp" \
    MONAD_TESTNET_HTTP_RPC_URL="$dummy_rpc_url" \
    CARGO="$fixture_root/bin/fake-cargo" \
    FRANK_LAUNCHER_ARGS="$args_file" \
    FRANK_LAUNCHER_CONFIG="$config_file" \
    FRANK_LAUNCHER_MODE=block \
    "$launcher" &
launcher_pid=$!
for _ in {1..100}; do
    [[ -s "$config_file" ]] && break
    sleep 0.01
done
[[ -s "$config_file" ]]
FRANK_CARGO_SLOT_TIMEOUT_SECONDS=1 \
    "$fixture_root/.agents/scripts/with-cargo-slot" true
kill -TERM "$launcher_pid"
if wait "$launcher_pid"; then
    echo "TERM unexpectedly produced a successful launcher exit" >&2
    exit 1
else
    status=$?
    [[ "$status" -eq 143 ]]
fi
[[ -z "$(find "$fixture_root/tmp" -type f -print -quit)" ]]

echo "run-local-monad tests passed"
