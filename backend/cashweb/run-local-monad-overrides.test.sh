#!/usr/bin/env bash
# Tests the demo-launcher overrides of run-local-monad.sh (CASHWEBD_BIN, FRANK_RELAY_LISTEN,
# FRANK_RELAY_DB_PATH, FRANK_RELAY_EXTRA_TOML, FRANK_RUN_LOCAL_SKIP_DOTENV) with a stub daemon, so
# it needs no Cargo build. The real-parser check of the generated config stays in
# run-local-monad.test.sh.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
work="$(mktemp -d "${TMPDIR:-/tmp}/frank-run-local-overrides.XXXXXX")"
trap 'find "$work" -depth -delete' EXIT HUP INT TERM

# Isolated copy of the launcher, so a `.env` at the real repo root can never be read.
mkdir -p "$work/repo/backend/cashweb" "$work/out"
cp "$script_dir/run-local-monad.sh" "$script_dir/cashwebd.local.toml" "$work/repo/backend/cashweb/"
launcher="$work/repo/backend/cashweb/run-local-monad.sh"

cat >"$work/stub-cashwebd" <<'STUB'
#!/usr/bin/env bash
if [[ "$1" == "--check-config" ]]; then cat >"$STUB_OUT/check.toml"; exit 0; fi
cat >"$STUB_OUT/run.toml"
echo "rpc=$MONAD_TESTNET_HTTP_RPC_URL tag=$FRANK_NETWORK_TAG burn=${MONAD_STAMP_BURN_ADDRESS:-unset}" >"$STUB_OUT/env.txt"
STUB
chmod +x "$work/stub-cashwebd"

fail() { echo "FAIL: $*" >&2; exit 1; }
run() { STUB_OUT="$work/out" env -i PATH="$PATH" HOME="$work" STUB_OUT="$work/out" "$@" bash "$launcher" 2>"$work/err.txt"; }

# 1. Overrides land in the config the daemon receives.
printf '[[registry.curated_defaults]]\naddress = "0xabc"\nname = "Bot"\n' >"$work/extra.toml"
run MONAD_TESTNET_HTTP_RPC_URL=http://127.0.0.1:9 CASHWEBD_BIN="$work/stub-cashwebd" \
    FRANK_RELAY_LISTEN=127.0.0.1:19098 FRANK_RELAY_DB_PATH="$work/db" \
    FRANK_RELAY_EXTRA_TOML="$work/extra.toml"
grep -q '^host = "127.0.0.1:19098"$' "$work/out/run.toml" || fail "host override missing"
grep -q '^url = "http://127.0.0.1:19098"$' "$work/out/run.toml" || fail "url override missing"
grep -q '^\[registry.directory\]$' "$work/out/run.toml" || fail "directory section missing: the message and directory routes would not exist"
grep -q '^endpoint = "http://127.0.0.1:19098"$' "$work/out/run.toml" || fail "directory endpoint does not follow the listen address"
grep -q '^network = "monad-testnet"$' "$work/out/run.toml" || fail "directory network missing"
grep -q "^db_path = \"$work/db\"$" "$work/out/run.toml" || fail "db_path override missing"
grep -q '^\[\[registry.curated_defaults\]\]$' "$work/out/run.toml" || fail "extra toml not appended"
grep -q '^enabled = true$' "$work/out/run.toml" || fail "mailbox not enabled"
cmp -s "$work/out/run.toml" "$work/out/check.toml" || fail "checked config differs from the served one"
grep -q 'rpc=http://127.0.0.1:9 tag=MONT' "$work/out/env.txt" || fail "daemon env not passed"

# 1a. A relay this launcher starts asks no price or energy provider unless the run says so; the
# providers' own addresses are left as shipped (only the relay's own url lines are rewritten).
grep -A1 '^\[registry.oracle\]$' "$work/out/run.toml" | grep -q '^collect = false$' || fail "oracle collection is not off by default"
grep -q '^api_url = "https://api.kraken.com/0/public/Ticker"$' "$work/out/run.toml" || fail "an oracle provider address was rewritten"
rm -f "$work/out/"*
run MONAD_TESTNET_HTTP_RPC_URL=http://127.0.0.1:9 CASHWEBD_BIN="$work/stub-cashwebd" \
    FRANK_RELAY_ORACLE_COLLECT=true
grep -A1 '^\[registry.oracle\]$' "$work/out/run.toml" | grep -q '^collect = true$' || fail "FRANK_RELAY_ORACLE_COLLECT=true did not turn collection on"
[ "$(grep -c '^collect = ' "$work/out/run.toml")" = 1 ] || fail "collect written more than once"

# 1b. A second relay beside the first gets its own id, identity and public endpoint.
rm -f "$work/out/"*
run MONAD_TESTNET_HTTP_RPC_URL=http://127.0.0.1:9 CASHWEBD_BIN="$work/stub-cashwebd" \
    FRANK_RELAY_LISTEN=127.0.0.1:19099 FRANK_RELAY_PUBLIC_URL=https://relay-b.example.invalid \
    FRANK_RELAY_ID=ffeeddccbbaa99887766554433221100 \
    FRANK_RELAY_IDENTITY=02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5
grep -q '^endpoint = "https://relay-b.example.invalid"$' "$work/out/run.toml" || fail "public endpoint override missing"
grep -q '^relay_id = "ffeeddccbbaa99887766554433221100"$' "$work/out/run.toml" || fail "relay id override missing"
grep -q '^relay_identity = "02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5"$' "$work/out/run.toml" || fail "relay identity override missing"

# 2. Without overrides the checked-in host and db path are untouched.
rm -f "$work/out/"*
run MONAD_TESTNET_HTTP_RPC_URL=http://127.0.0.1:9 CASHWEBD_BIN="$work/stub-cashwebd"
grep -q '^host = "127.0.0.1:8098"$' "$work/out/run.toml" || fail "default host changed"
grep -q '^db_path = "data/registry.rocksdb"$' "$work/out/run.toml" || fail "default db_path changed"
grep -q curated_defaults "$work/out/run.toml" && fail "unexpected extra toml"

# A prebuilt launch never resolves a compiler (the resolver is not even copied).
run MONAD_TESTNET_HTTP_RPC_URL=http://127.0.0.1:9 CASHWEBD_BIN="$work/stub-cashwebd" \
    PROTOC="$work/no-such-compiler"

# 3. A repo-root .env is ignored when FRANK_RUN_LOCAL_SKIP_DOTENV=1 and honoured otherwise.
printf 'FRANK_NETWORK_TAG=MON1\nMONAD_TESTNET_CHAIN_ID=143\n' >"$work/repo/.env"
rm -f "$work/out/"*
run MONAD_TESTNET_HTTP_RPC_URL=http://127.0.0.1:9 CASHWEBD_BIN="$work/stub-cashwebd" \
    FRANK_RUN_LOCAL_SKIP_DOTENV=1
grep -q 'tag=MONT' "$work/out/env.txt" || fail ".env was read despite FRANK_RUN_LOCAL_SKIP_DOTENV=1"
rm -f "$work/out/"*
run MONAD_TESTNET_HTTP_RPC_URL=http://127.0.0.1:9 CASHWEBD_BIN="$work/stub-cashwebd"
grep -q 'tag=MON1' "$work/out/env.txt" || fail ".env not honoured by default"
rm "$work/repo/.env"

# 4. Bad override values are rejected with one clear message (exit 64), before anything starts.
for bad in "FRANK_RELAY_ORACLE_COLLECT=yes" "FRANK_RELAY_LISTEN=not-a-port" "FRANK_RELAY_DB_PATH=a\"b" "FRANK_RELAY_EXTRA_TOML=$work/missing.toml" "FRANK_RELAY_PUBLIC_URL=relay.example" "FRANK_RELAY_ID=xyz" "FRANK_RELAY_IDENTITY=04abcd"; do
    if run MONAD_TESTNET_HTTP_RPC_URL=http://127.0.0.1:9 CASHWEBD_BIN="$work/stub-cashwebd" "$bad"; then
        fail "$bad was accepted"
    fi
    grep -q '^run-local-monad: FRANK_RELAY_' "$work/err.txt" || fail "no clear message for $bad"
done

# 5. MONAD_STAMP_BURN_ADDRESS (#364): reaches the daemon and is reported; missing it is a loud
# warning (the topic routes answer HTTP 500 without it); a malformed value is rejected.
burn=0x000000000000000000000000000000000000dEaD
rm -f "$work/out/"*
run MONAD_TESTNET_HTTP_RPC_URL=http://127.0.0.1:9 CASHWEBD_BIN="$work/stub-cashwebd" \
    MONAD_STAMP_BURN_ADDRESS="$burn"
grep -q "burn=$burn" "$work/out/env.txt" || fail "burn address not passed to the daemon"
grep -q "MONAD_STAMP_BURN_ADDRESS: $burn" "$work/err.txt" || fail "burn address not reported"
grep -q WARNING "$work/err.txt" && fail "warned although the burn address is set"
rm -f "$work/out/"*
run MONAD_TESTNET_HTTP_RPC_URL=http://127.0.0.1:9 CASHWEBD_BIN="$work/stub-cashwebd"
grep -q 'burn=unset' "$work/out/env.txt" || fail "unexpected burn address"
grep -q 'WARNING: MONAD_STAMP_BURN_ADDRESS is not set' "$work/err.txt" || fail "no warning without a burn address"
if run MONAD_TESTNET_HTTP_RPC_URL=http://127.0.0.1:9 CASHWEBD_BIN="$work/stub-cashwebd" \
    MONAD_STAMP_BURN_ADDRESS=0xnothex; then
    fail "malformed burn address accepted"
fi
grep -q '^run-local-monad: MONAD_STAMP_BURN_ADDRESS must be' "$work/err.txt" || fail "no clear message for a bad burn address"

echo "run-local-monad overrides: ok"
