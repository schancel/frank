#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd -- "$script_dir/../.." && pwd -P)"
fixture_root="$(mktemp -d "${TMPDIR:-/tmp}/frank-run-local-monad-test.XXXXXX")"

cleanup() {
    find "$fixture_root" -depth -delete
}
trap cleanup EXIT HUP INT TERM

# The launcher's generated configuration is validated against the REAL production parser
# (`cashwebd-exe --check-config -`), not a grep-based stand-in, so a config the daemon would
# reject (for example an enabled mailbox missing a required key) fails this test.
build_real_cashwebd() {
    local parser='
        my $record = decode_json($_);
        next unless ($record->{reason} // "") eq "compiler-artifact";
        next unless ($record->{target}->{name} // "") eq "cashwebd-exe";
        next unless grep { $_ eq "bin" } @{$record->{target}->{kind} // []};
        next unless defined $record->{executable};
        $artifact = $record->{executable};
        END { print $artifact if defined $artifact; }
    '
    local -a wrapper=()
    if [[ -z "${CARGO_TARGET_DIR:-}" ]]; then
        wrapper=("$repo_root/.agents/scripts/with-cargo-slot")
    fi
    (
        cd -- "$script_dir"
        ${wrapper[@]+"${wrapper[@]}"} "${CARGO:-cargo}" build -p cashwebd-exe --bin cashwebd-exe \
            --message-format=json-render-diagnostics |
            perl -MJSON::PP=decode_json -ne "$parser"
    )
}
built_cashwebd="$(build_real_cashwebd)"
if [[ ! -x "$built_cashwebd" ]]; then
    echo "could not build the real cashwebd-exe for full-config validation" >&2
    exit 1
fi
# The fixture below must select its own isolated target directory through the cargo slot wrapper;
# a caller-provided target directory would let the fake cargo overwrite a real build.
unset CARGO_TARGET_DIR

mkdir -p \
    "$fixture_root/.agents/scripts" \
    "$fixture_root/.cargo" \
    "$fixture_root/backend/cashweb" \
    "$fixture_root/bin" \
    "$fixture_root/tmp"
git init -q "$fixture_root"
# Copy the real daemon out of Cargo's target directory: the fake-cargo below writes its stand-in
# artifact into the (possibly shared) target directory and must never overwrite the real binary.
FRANK_REAL_CASHWEBD="$fixture_root/bin/real-cashwebd"
cp "$built_cashwebd" "$FRANK_REAL_CASHWEBD"
export FRANK_REAL_CASHWEBD
cp "$script_dir/run-local-monad.sh" "$fixture_root/backend/cashweb/"
cp "$script_dir/cashwebd.local.toml" "$fixture_root/backend/cashweb/"
cp "$repo_root/.agents/scripts/with-cargo-slot" "$fixture_root/.agents/scripts/"

cat >"$fixture_root/bin/fake-cargo" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ "${1:-}" == "build" ]] || exit 1
[[ -n "${CARGO_TARGET_DIR:-}" ]] || exit 1
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
    # The complete generated document goes through the real production parser.
    printf '%s\n' "$config" | "$FRANK_REAL_CASHWEBD" --check-config -
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
[[ "$(grep -c '^\[registry\.monad_mailbox\]$' "$config_file")" -eq 1 ]] || exit 1
[[ "$(grep -c '^enabled = true$' "$config_file")" -eq 1 ]] || exit 1
[[ "$(grep -Fxc "rpc_url = \"$dummy_rpc_url\"" "$config_file")" -eq 1 ]] || exit 1
# Enabled mode requires an explicit minimum and chain ID; local defaults are Monad testnet's.
[[ "$(grep -Fxc 'min_value_wei = "1000000000000"' "$config_file")" -eq 1 ]] || exit 1
[[ "$(grep -Fxc 'expected_chain_id = 10143' "$config_file")" -eq 1 ]] || exit 1
# Guard against the harness silently weakening: the old launcher output (enabled + rpc_url only)
# is rejected by the real parser.
old_style="$(sed 's|^enabled = false$|enabled = true\nrpc_url = "https://rpc.invalid.example"|' \
    "$script_dir/cashwebd.local.toml")"
if printf '%s\n' "$old_style" | "$FRANK_REAL_CASHWEBD" --check-config - 2>/dev/null; then
    echo "real parser unexpectedly accepted an enabled mailbox without minimum/chain ID" >&2
    exit 1
fi
# The real parser accepts exactly what the launcher generated.
"$FRANK_REAL_CASHWEBD" --check-config - <"$config_file"
[[ -z "$(find "$fixture_root/tmp" -type f -print -quit)" ]] || exit 1

for invalid_env in "CASHWEB_STAMP_MIN_BURN_VALUE_WEI=1e12" "MONAD_TESTNET_CHAIN_ID=0x279f"; do
    if env "$invalid_env" MONAD_TESTNET_HTTP_RPC_URL="$dummy_rpc_url" \
        CARGO="$fixture_root/bin/fake-cargo" \
        "$launcher" >"$fixture_root/invalid-env.out" 2>"$fixture_root/invalid-env.err"; then
        echo "$invalid_env unexpectedly succeeded" >&2
        exit 1
    else
        status=$?
        [[ "$status" -eq 64 ]]
    fi
done

rm -f -- "$args_file" "$config_file"
CASHWEB_STAMP_MIN_BURN_VALUE_WEI=340282366920938463463374607431768211455 \
    MONAD_TESTNET_CHAIN_ID=143 \
    MONAD_TESTNET_HTTP_RPC_URL="$dummy_rpc_url" \
    CARGO="$fixture_root/bin/fake-cargo" \
    FRANK_LAUNCHER_ARGS="$args_file" \
    FRANK_LAUNCHER_CONFIG="$config_file" \
    "$launcher"
grep -Fxq 'min_value_wei = "340282366920938463463374607431768211455"' "$config_file"
grep -Fxq 'expected_chain_id = 143' "$config_file"

configured_target="fixture-host-target"
rm -f -- "$args_file" "$config_file"
CARGO_BUILD_TARGET="$configured_target" \
    MONAD_TESTNET_HTTP_RPC_URL="$dummy_rpc_url" \
    CARGO="$fixture_root/bin/fake-cargo" \
    FRANK_LAUNCHER_ARGS="$args_file" \
    FRANK_LAUNCHER_CONFIG="$config_file" \
    "$launcher"
[[ -n "$(find "$fixture_root/cache/cargo-target" \
    -path "*/$configured_target/debug/cashwebd-exe" -type f -perm -u+x -print -quit)" ]] || exit 1
[[ -s "$config_file" ]] || exit 1

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
[[ -s "$config_file" ]] || exit 1
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
[[ -s "$config_file" ]] || exit 1
(
    cd "$fixture_root"
    FRANK_CARGO_SLOT_TIMEOUT_SECONDS=1 \
        "$fixture_root/.agents/scripts/with-cargo-slot" true
)
kill -TERM "$launcher_pid"
if wait "$launcher_pid"; then
    echo "TERM unexpectedly produced a successful launcher exit" >&2
    exit 1
else
    status=$?
    [[ "$status" -eq 143 ]]
fi
[[ -z "$(find "$fixture_root/tmp" -type f -print -quit)" ]] || exit 1

echo "run-local-monad tests passed"
