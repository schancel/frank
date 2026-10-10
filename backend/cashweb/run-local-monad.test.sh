#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd -- "$script_dir/../.." && pwd -P)"
# Exercise the same compiler resolution used by the production launcher.
PROTOC="$(bash "$script_dir/protoc-tool/resolve.sh" "$repo_root")"
export PROTOC
node --test "$script_dir/protoc-tool/resolve.test.cjs"
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
cp -R "$script_dir/protoc-tool" "$fixture_root/backend/cashweb/"
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
    # Record that the launcher itself ran the pre-flight check, and let a test make it fail.
    [[ -z "${FRANK_LAUNCHER_CHECK_LOG:-}" ]] || echo "check-config" >>"$FRANK_LAUNCHER_CHECK_LOG"
    [[ "${FRANK_FAKE_CHECK_FAIL:-}" != "1" ]] || exit 1
    grep -q '^\[registry\.monad_mailbox\]$' <<<"$config"
    grep -q '^enabled = true$' <<<"$config"
    # The complete generated document goes through the real production parser, with the same
    # environment the launcher hands the daemon.
    printf '%s\n' "$config" | "$FRANK_REAL_CASHWEBD" --check-config -
    exit 0
fi
if [[ "${1:-}" == "--check-db" ]]; then
    # The database check is the real relay's: it opens the registry database as a start does.
    [[ "${2:-}" == "-" ]]
    [[ -z "${FRANK_LAUNCHER_CHECK_LOG:-}" ]] || echo "check-db" >>"$FRANK_LAUNCHER_CHECK_LOG"
    exec "$FRANK_REAL_CASHWEBD" --check-db -
fi
printf '%s\n' "$@" >"$FRANK_LAUNCHER_ARGS"
printf 'rpc=%s\ntag=%s\n' "${MONAD_TESTNET_HTTP_RPC_URL:-}" "${FRANK_NETWORK_TAG:-}" \
    >"$FRANK_LAUNCHER_ARGS.env"
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
        FRANK_LAUNCHER_CHECK_LOG="$fixture_root/check.log" \
        "$launcher" 2>"$fixture_root/effective.err"
)

diff -u <(printf '%s\n' -) "$args_file"
# The launcher must run `--check-config` itself, before starting the daemon.
# ... and then the database check, in that order.
[[ "$(cat "$fixture_root/check.log")" == "$(printf 'check-config\ncheck-db')" ]] || exit 1
[[ "$(grep -c '^\[registry\.monad_mailbox\]$' "$config_file")" -eq 1 ]] || exit 1
[[ "$(grep -c '^enabled = true$' "$config_file")" -eq 4 ]] || exit 1
# The endpoint is secret-bearing: it reaches the daemon only through its environment, never the
# generated config, and the network tag defaults to Monad testnet's MONT.
[[ "$(grep -c '^rpc_url' "$config_file")" -eq 0 ]] || exit 1
! grep -Fq "$dummy_rpc_url" "$config_file" || exit 1
[[ "$(cat "$args_file.env")" == "$(printf 'rpc=%s\ntag=MONT' "$dummy_rpc_url")" ]] || exit 1
# The effective values are printed, but the secret path of the URL is not.
grep -Fq 'FRANK_NETWORK_TAG:      MONT' "$fixture_root/effective.err" || exit 1
grep -Fq 'min_value_wei:          1000000000000' "$fixture_root/effective.err" || exit 1
grep -Fq 'expected_chain_id:      10143' "$fixture_root/effective.err" || exit 1
grep -Fq 'origin https://rpc.invalid.example' "$fixture_root/effective.err" || exit 1
! grep -Fq 'test-only' "$fixture_root/effective.err" || exit 1
# Enabled mode requires an explicit minimum and chain ID; local defaults are Monad testnet's.
[[ "$(grep -Fxc 'min_value_wei = "1000000000000"' "$config_file")" -eq 1 ]] || exit 1
[[ "$(grep -Fxc 'expected_chain_id = 10143' "$config_file")" -eq 2 ]] || exit 1
# Guard against the harness silently weakening: an enabled mailbox without its minimum/chain ID
# is rejected by the real parser even with the RPC URL and tag supplied.
old_style="$(sed '/^min_value_wei/d;/^expected_chain_id/d' "$script_dir/cashwebd.local.toml")"
if printf '%s\n' "$old_style" |
    MONAD_TESTNET_HTTP_RPC_URL="$dummy_rpc_url" FRANK_NETWORK_TAG=MONT \
        "$FRANK_REAL_CASHWEBD" --check-config - 2>/dev/null; then
    echo "real parser unexpectedly accepted an enabled mailbox without minimum/chain ID" >&2
    exit 1
fi
# ... and the shipped config fails fast, naming the variable, when the RPC URL or tag is missing.
if env -u MONAD_TESTNET_HTTP_RPC_URL FRANK_NETWORK_TAG=MONT \
    "$FRANK_REAL_CASHWEBD" --check-config - <"$script_dir/cashwebd.local.toml" 2>"$fixture_root/norpc.err"; then
    echo "shipped config unexpectedly validated without the RPC URL" >&2
    exit 1
fi
grep -Fq 'MONAD_TESTNET_HTTP_RPC_URL' "$fixture_root/norpc.err" || exit 1
if env -u FRANK_NETWORK_TAG MONAD_TESTNET_HTTP_RPC_URL="$dummy_rpc_url" \
    "$FRANK_REAL_CASHWEBD" --check-config - <"$script_dir/cashwebd.local.toml" 2>"$fixture_root/notag.err"; then
    echo "shipped config unexpectedly validated without the network tag" >&2
    exit 1
fi
grep -Fq 'FRANK_NETWORK_TAG' "$fixture_root/notag.err" || exit 1
# The real parser accepts exactly what the launcher generated.
MONAD_TESTNET_HTTP_RPC_URL="$dummy_rpc_url" FRANK_NETWORK_TAG=MONT \
    "$FRANK_REAL_CASHWEBD" --check-config - <"$config_file"
[[ -z "$(find "$fixture_root/tmp" -type f -print -quit)" ]] || exit 1

# A failing pre-flight check must stop the launcher before the daemon is ever started.
rm -f -- "$args_file" "$config_file"
if MONAD_TESTNET_HTTP_RPC_URL="$dummy_rpc_url" FRANK_FAKE_CHECK_FAIL=1 \
    CARGO="$fixture_root/bin/fake-cargo" \
    FRANK_LAUNCHER_ARGS="$args_file" \
    FRANK_LAUNCHER_CONFIG="$config_file" \
    "$launcher" >/dev/null 2>&1; then
    echo "launcher ignored a failing --check-config" >&2
    exit 1
fi
[[ ! -e "$args_file" ]] || exit 1

for invalid_env in "CASHWEB_STAMP_MIN_BURN_VALUE_WEI=1e12" "MONAD_TESTNET_CHAIN_ID=0x279f" "FRANK_NETWORK_TAG=MO NT" "FRANK_NETWORK_TAG=MONX" "FRANK_NETWORK_TAG=mont"; do
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
    FRANK_NETWORK_TAG=MON1 \
    MONAD_TESTNET_HTTP_RPC_URL="$dummy_rpc_url" \
    CARGO="$fixture_root/bin/fake-cargo" \
    FRANK_LAUNCHER_ARGS="$args_file" \
    FRANK_LAUNCHER_CONFIG="$config_file" \
    "$launcher"
grep -Fxq 'min_value_wei = "340282366920938463463374607431768211455"' "$config_file"
grep -Fxq 'expected_chain_id = 143' "$config_file"
grep -Fxq 'id = "monad-mainnet"' "$config_file"
grep -Fxq 'checkpoint_block_hash = "0x0c47353304f22b1c15706367d739b850cda80b5c87bbc335014fef3d88deaac9"' "$config_file"

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
grep -Fq 'expected_chain_id = 10143' "$config_file" || exit 1
grep -Fxq 'tag=MONT' "$args_file.env" || exit 1
grep -Fxq 'rpc=https://monad-testnet.g.alchemy.com/v2/<your-alchemy-key>' "$args_file.env" || exit 1

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

# A relay database from an earlier development build: the real relay refuses it, and this
# launcher (development, demos and tests only) moves exactly the paths the refusal names aside,
# never deletes them, leaves everything else beside them alone, says so, and starts.
old_db_dir="$fixture_root/old-relay"
mkdir -p "$old_db_dir/registry.monad-dm-cbor-v1"
echo "old messages" >"$old_db_dir/registry.monad-dm-cbor-v1/data"
echo "session" >"$old_db_dir/registry.session-secret"
echo "not the relay's" >"$old_db_dir/account-root.hex"
# The relay itself, started directly, refuses and names the paths.
if printf 'x' | MONAD_TESTNET_HTTP_RPC_URL="$dummy_rpc_url" FRANK_NETWORK_TAG=MONT \
    "$FRANK_REAL_CASHWEBD" --check-db - <<<"$(sed "s#^db_path = .*#db_path = \"$old_db_dir/registry.rocksdb\"#" "$config_file")" \
    2>"$fixture_root/refusal.err"; then
    echo "the relay unexpectedly opened a database beside an earlier message store" >&2
    exit 1
fi
grep -Fq 'Development reset' "$fixture_root/refusal.err" || exit 1
grep -Fq "$old_db_dir/registry.monad-dm-cbor-v1" "$fixture_root/refusal.err" || exit 1
[[ -d "$old_db_dir/registry.monad-dm-cbor-v1" ]] || exit 1
rm -f -- "$args_file" "$config_file"
MONAD_TESTNET_HTTP_RPC_URL="$dummy_rpc_url" \
    CARGO="$fixture_root/bin/fake-cargo" \
    FRANK_RELAY_DB_PATH="$old_db_dir/registry.rocksdb" \
    FRANK_LAUNCHER_ARGS="$args_file" \
    FRANK_LAUNCHER_CONFIG="$config_file" \
    "$launcher" 2>"$fixture_root/moved.err"
grep -Fq 'MOVED ASIDE (not deleted)' "$fixture_root/moved.err" || exit 1
[[ ! -e "$old_db_dir/registry.monad-dm-cbor-v1" ]] || exit 1
moved_store="$(find "$old_db_dir" -maxdepth 1 -name 'registry.monad-dm-cbor-v1.old-format-*' -print)"
[[ -n "$moved_store" && "$(cat "$moved_store/data")" == "old messages" ]] || exit 1
# The daemon was started, on a database the real relay opens.
[[ -e "$args_file" ]] || exit 1
[[ -d "$old_db_dir/registry.rocksdb" ]] || exit 1
# Nothing but the relay's own database paths was touched.
[[ "$(cat "$old_db_dir/registry.session-secret")" == "session" ]] || exit 1
[[ "$(cat "$old_db_dir/account-root.hex")" == "not the relay's" ]] || exit 1
# A second start finds nothing to move.
MONAD_TESTNET_HTTP_RPC_URL="$dummy_rpc_url" \
    CARGO="$fixture_root/bin/fake-cargo" \
    FRANK_RELAY_DB_PATH="$old_db_dir/registry.rocksdb" \
    FRANK_LAUNCHER_ARGS="$args_file" \
    FRANK_LAUNCHER_CONFIG="$config_file" \
    "$launcher" 2>"$fixture_root/second.err"
! grep -Fq 'MOVED ASIDE' "$fixture_root/second.err" || exit 1
[[ "$(find "$old_db_dir" -maxdepth 1 -name '*.old-format-*' | wc -l | tr -d ' ')" -eq 1 ]] || exit 1
