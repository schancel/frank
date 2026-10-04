# @frank/bot

Headless demo and qwen bot. It drives `@frank/wallet` against the relay. It
does not own chain codecs, encryption suites, or CashWeb CBOR layouts. Frames
belong to `@frank/codec` and `frank-cbor`. The live demo path still uses the
protobuf relay.

## One-command demo (`yarn demo`)

Typed accounts have a separate EVM receive address. See [simulated typed-wallet funding](demo/README.md)
for the explicit fake-chain-only operator command and client seam; zero-funds setup is valid.

Starts the whole demo stack, waits until it is ready, and stops everything on Ctrl-C:

```sh
yarn demo --fake-chain      # no keys, no funds, no network: a built-in fake Monad RPC
yarn demo                   # against Monad testnet, using your .env (below)
```

Run either from the repo root (or packages/bot). `yarn demo` runs `node --import tsx
packages/bot/demo/demo.ts` directly with the bot tsconfig selected, with no second `yarn`/`tsx`
process in between. Stop it with
Ctrl-C, `kill -INT <pid>` or `kill -TERM <pid>` using the launcher pid it prints (that is the
`node` process). Killing the top-level `yarn` process (`kill -INT <yarn pid>`: yarn exits without
forwarding SIGINT) also stops the stack: a launcher started by yarn notices that yarn is gone
within a second and shuts down like a closed terminal. If you script it, prefer
`TSX_TSCONFIG_PATH=packages/bot/tsconfig.json node --import tsx packages/bot/demo/demo.ts` and
signal that pid.

How the parent check works: when yarn started the launcher, the launcher polls its parent pid once
a second. Nothing changes while yarn is alive, so `nohup yarn demo &` keeps working (yarn stays the
parent). The launcher stops only when the yarn process that started it dies, and it then stops
only its own children. If an ancestor terminal is closed, the usual SIGHUP handling applies. A
launcher started directly with `node` does no parent polling.

**State dir modes**: a state dir belongs to one mode. The launcher writes a small non-secret marker
`<state dir>/demo-mode.json` (`{mode: "fake-chain" | "real", chainId, createdAt}`) once the
prerequisite checks have passed (a start that fails on a missing wallet or a busy port claims
nothing, so a first failed `yarn demo` does not poison the dir for `--fake-chain`) and refuses to start when the requested mode or chain id differs ("this state dir was created for
the fake chain; ... use a new FRANK_DEMO_STATE_DIR, or delete <state dir>"), because bot
identities, stamp-pool records and faucet records made against the fake chain mean nothing on a
real network. A state dir from before the marker that holds a fake-chain wallet is refused for a
real run too.

What it does, in order: starts the fake chain (with `--fake-chain`), creates any missing bot
identity (under one state directory, default `~/.frank-demo`), prints and applies the relay's
curated-default contact lines, starts the local relay through `backend/cashweb/run-local-monad.sh`
(the first run builds it with Cargo; or set `CASHWEBD_BIN` to a prebuilt `cashwebd-exe`), then the
blackjack dealer, raffle, picture shop, Qwen (offline **stub** mode unless `QWEN_API_KEY` is set)
and the testnet faucet with demo-friendly limits (no idle exit, 5-entrant raffle rounds, no reply
cap). It prints every bot address, the app URL and the exact command to start the app, then waits. Logs are in
`<state dir>/logs/`. Missing prerequisites (Node, `bash`, `cargo` or `CASHWEBD_BIN`, a busy port, an
absent RPC URL or wallet file) each print one line, never a stack trace.

Source builds also need a usable native `protoc` (libprotoc 3+ with proto3 support). The relay
launcher validates `PROTOC` when set; otherwise it searches PATH, then the installed `protoc`
npm package's native compiler. It skips npm's CLI wrapper, which can have a CRLF shebang.
If the npm native payload is absent (for example after an install without postinstall scripts),
install a native compiler or set `PROTOC='/path with spaces/protoc'`. An invalid override fails
before Cargo; the launcher never downloads tools or edits dependencies. A prebuilt `CASHWEBD_BIN`
needs no compiler. This temporary build resolver goes away with the remaining prost inputs
(#130/#132).

**The app** (started by you, in another terminal, from the repo root) must be given the relay, the
chain and the burn address. The launcher prints the exact command; with `--fake-chain` it is

```sh
cd app && QCLI_MONAD_RELAY_BASE_URL=http://127.0.0.1:8098 QCLI_MONAD_RPC_CHAIN=monad-testnet \
  QCLI_MONAD_STAMP_BURN_ADDRESS=0x000000000000000000000000000000000000dEaD QCLI_CASHWEB_STAMP_MIN_BURN_VALUE_WEI=1000000000000 \
  yarn dev:browser
```

(ports follow `FRANK_DEMO_RELAY_PORT` / `FRANK_DEMO_FAKE_RPC_PORT`) and the app is at
**http://localhost:8080**, the fixed dev-server port from `app/quasar.config.js`. The relay and the
fake chain send `Access-Control-Allow-Origin: *` and answer preflights. The browser reaches only
the relay's `/chain-rpc/monad-testnet/rpc` route; the upstream RPC address remains process-owned
relay configuration and is never embedded in the app.

**Burn address**: the relay's forum routes (topic posts and votes) return HTTP 500 without
`MONAD_STAMP_BURN_ADDRESS`. The launcher passes one value (default the well-known
`0x...dEaD` burn address, override with `MONAD_STAMP_BURN_ADDRESS`) to the relay, every bot and the
app command above, so the three always agree. `run-local-monad.sh` also warns loudly at start when
it is missing.

**Faucet amount**: with `--fake-chain` the faucet sends 1 MON per new profile (the faucet's hard
ceiling): the cheapest blackjack hand needs 0.07 MON (0.01 table minimum + 0.01 default stamp + the
app's 0.05 MON fee reserve), and a raffle entry (0.02) and a shop picture (0.05-0.1) come on top.
On a real network the default stays a small 0.05 MON, which is NOT enough for a hand: set
`FAUCET_AMOUNT_WEI` (up to 1 MON) if you want players to play, and the summary warns when it is too
low. `FAUCET_MAX_PER_DAY`, the one-funding-per-address rule and the testnet-only guards are unchanged.

**Restarting**: the fake chain is saved to `<state dir>/fake-chain/ledger.json` after every
transaction and reloaded on the next start, so balances, nonces and profiles survive a restart. The
fake-chain faucet's records live next to it (`<state dir>/fake-chain/faucet-state`), so the chain
and the faucet's memory can only reset together: delete `<state dir>/fake-chain` (or the whole
state dir) for a fresh chain. A ledger that cannot be parsed is refused, not replaced.

**Raffle rounds**: the demo uses 5 entrants per round (`RAFFLE_BOT_MAX_ENTRIES`; the bot's own
default is unchanged). Set it to a smaller number for a quicker round.

### Raffle draw and payout (#363)

A raffle entry reaches the raffle identity net of the gas of the sweep that moves it there, so the
identity alone is always a little short of the gross pot (`entry price x entrants`). What is enforced
before an entry is credited (`recoverAndSweepEntryPayment`): the entry's on-chain stamp payments to
the bot's derived addresses, re-derived and checked against the message, total at least the entry
price; and the amount actually swept into the identity, plus one sweep-gas tolerance per payment, is
at least the entry price. The entry may be paid in up to 6 on-chain payments; that cap is a griefing
bound (each payment loses one sweep gas and the hold threshold below scales with the payment count,
so many tiny payments would widen it), not a rule for honest users, whose wallets can legitimately
need several payments.

**Uncredited entries and refunds.** An entry that fails those checks (more than 6 payments, or less
swept than the price) is NOT credited to a round, but its payments are first swept into the raffle
identity, so the money is operator-controlled, never stranded at the derived addresses. The bot
records it (entrant, payment hashes, swept amount, reason, time) in a persisted `unclaimed` list, logs
`UNCLAIMED ...` at warn level, and tells the entrant by direct message that the entry was not counted,
with the payment count and hashes, and that the operator will refund it. To refund: stop the raffle
bot (it holds the state database), then in `packages/bot` with `MONAD_TESTNET_HTTP_RPC_URL`,
`RAFFLE_BOT_IDENTITY_JSON` and `RAFFLE_BOT_STATE_DIR` set, run `yarn raffle:refund --list` and then
`yarn raffle:refund <id>`. The refund pays the recorded swept amount back once: the signed bytes are
persisted before broadcast, a re-run re-broadcasts the same bytes and reconciles by hash, and a
refunded record is never paid again. It is refused while a raffle draw is unsettled (refunds and
payouts share the identity's nonce and balance, #218), and if the identity holds less than the
amount. Restart the bot afterwards. (A crash between the sweep and the record being written would
leave the money in the identity without a record; the log line and the on-chain sweeps still show it.)

The draw then
works in this order, each step durable (fsynced) before the next: record the draw (and open the next
round with a fresh commitment) in one atomic write; make sure the identity holds pot plus payout
gas, topping up only that shortfall from the stamp wallet; sign the payout once and persist the exact
bytes; broadcast (a restart re-broadcasts the same bytes, never a new payment) and confirm by hash;
only then send the draw message that reveals the seed. The launcher therefore does not need to
pre-fund the raffle identity, and a winner is never announced before the payout is confirmed.
(Entry-credit writes keep the ordinary, non-fsynced level writes; the entry's funds are already
swept and confirmed on-chain before it is credited.)

**Operator top-up limits.** The stamp wallet may top up the identity only while all hold: the gap is
no more than the plausible sweep-gas dust for the round's payments (1.3 x (payments x sweep gas +
payout gas), the payment count recorded per entrant at credit time, so multi-payment entries raise
the threshold, up to the cap of 6 each; the 30% margin covers fee drift between the sweeps and the draw, and entrants of earlier
rounds paid without a top-up (at most one round's payments, reset by any top-up) are carried into
the count; a larger gap means an entry paid less than
the price, so the round is held and logged with no operator money moved); the round's cumulative top-ups stay within `RAFFLE_BOT_MAX_TOPUP_WEI`
(per round, persisted); and the trailing 24 hours stay within `RAFFLE_BOT_MAX_TOPUP_PER_DAY_WEI`
(default 5x the per-round limit, persisted). A failed top-up attempt still counts against the limits.
The signed top-up bytes and hash are persisted before broadcast and checked by hash before any
further top-up, so a restart never tops up twice while the first one is unmined (a top-up the node
has never heard of for 30 minutes is abandoned).

**Held rounds.** If the pot cannot be funded (stamp wallet empty, a limit reached, or a suspected
under-paying entry) the bot does not exit and does not refund: it logs `HELD ... Winner NOT
announced or paid` once per change, keeps accepting entries for the next round, and pays the held
round automatically once the cause is fixed. Entrants of a held round see nothing until the payout is
confirmed (no draw message, no refund); operators must watch `raffle.log` for `HELD`. Refunds and
leaving a round are a separate design (#218) and are not implemented here. Payouts are strictly
sequential (oldest round first); a held or unconfirmed payout delays later payouts, never their
announcements.

**Announcements** are independent of payouts. A failing draw message never delays any payout: it is
retried per recipient with backoff (5 s doubling to 5 min), and recipients already told are recorded
so nothing is resent.

**Idle exit.** `RAFFLE_BOT_IDLE_TIMEOUT_MS` only ends the process when no draw is unsettled; a held
or unconfirmed round keeps it running, and settlement progress counts as activity.

**Stuck payout.** If a signed payout is still unconfirmed after 10 minutes the bot logs
`STUCK payout <tx hash>` at error level once a minute (typical causes: the fee cap fell below the
network base fee, or the identity lacks gas). Operator steps: fund the raffle identity address (shown
at startup) if it is short of gas, and watch the log; the same signed bytes keep being re-broadcast.
If the node does not know the transaction at all for 15 minutes (receipt missing and
`eth_getTransactionByHash` empty), the bot re-signs the SAME nonce, recipient and value with up to 2x
fees (at most 3 times), but never with a fee whose maximum cost exceeds the gas the identity actually
holds above the pot; if no valid bump is affordable it tops up the payout gas reserve from the
stamp wallet within the same per-round and per-day limits. One nonce can mine only once, so at most
one of the attempts is ever paid. Every attempt is reconciled by hash, and if the newest bytes are
rejected (for example insufficient funds) the earlier attempts' bytes are broadcast instead. A transaction the node still knows is never replaced
automatically: wait for it, or replace it by hand.

The launcher keeps the bot's default entry price and sets the round size from the
`RAFFLE_BOT_MAX_ENTRIES` row above (the demo runs 5 entrants); the bot's own default is also 5
(`raffle-settlement.ts`).

The launcher sets every bot's state directory explicitly, under `<state dir>/bots/<bot>/state`
(and identities under `<state dir>/bots/<bot>/identity.json`). Bots started on their own with
`yarn bot`, `yarn blackjack`, ... default to `~/.frank-bots/<bot>` (`$XDG_STATE_HOME/frank-bots/<bot>`
when set) instead of `/tmp`; see "Stamp pool seed".

Per-bot commands also exist: `yarn bot` (Qwen), `yarn blackjack`, `yarn raffle`, `yarn vendor`,
`yarn faucet`.

**Configuration** comes only from environment variables and a `.env` file that you provide
(`FRANK_DEMO_ENV_FILE`, default `<repo>/.env`, gitignored, `KEY=value` lines). The launcher reads
just the variables in the table below and passes each child only the ones it needs; the process
environment wins over the file. The wallet file (`E2E_DEMO_MAIN_WALLET_JSON`) is read by the bots,
never by the launcher, and RPC URLs and keys are never printed.

**Smoke test**: `yarn demo:smoke` starts the stack against the fake chain in a temporary state
directory with a dummy env file (never your real `.env`), plays a new user against each bot and
checks that the Qwen stub, picture shop, raffle and dealer answer, the faucet funds the new
profile, a forum topic can be posted through the relay (a real burn transaction plus the relay's
topic route: it fails if the relay answers non-2xx) and the fake chain and the relay answer a
cross-origin browser request (exit 0 only if all pass; logs are kept on failure). The forum check
compares the title and message read back with what was posted. CORS on the relay comes from its own
layer (`cashweb-registry` `http/server.rs`), which the smoke checks on the preflight and on real
PUT and GET responses of the topics route. Use `CASHWEBD_BIN=... yarn demo:smoke`
to skip the Cargo build.

The smoke also obtains an authenticated relay RPC capability for a separate synthetic registered
identity and reads its balance through `/chain-rpc/monad-testnet/rpc`. This protected-proxy
check stays enabled when typed preview wallets use the direct fake transport.

Typed preview wallets can opt into the built-in disposable fake service with
`QCLI_FRANK_FAKE_DEMO=true` and `QCLI_FRANK_DEMO_CONTROL_URL=http://127.0.0.1:<port>`
in the browser (`FRANK_FAKE_DEMO` and `FRANK_DEMO_CONTROL_URL` in Node). Both flags are
explicit; the chain, network ID and network tag must identify Monad testnet. The URL must be a
literal loopback HTTP origin with an explicit valid port and no path, credentials, query or
fragment. Before constructing either RPC client, the wallet checks the existing simulated
funding capability with a five-second timeout and redirects disabled. It retains only the URL,
does not fund or register the wallet, and never retries direct after a production authorization
failure. Use the explicit funding control with the wallet's EVM receive address; typed DM remains
unavailable pending #696. Discovery identifies this disposable test service, not a security
boundary against a hostile local machine. Use only synthetic accounts and simulated value.

This temporary demo transport is owned by the #696 integration coordinator for removal in
[#752](https://github.com/schancel/frank/issues/752), once typed accounts can publish authenticated
directory statements and obtain the normal relay capabilities. Default and real-chain wallets
continue to use the authenticated relay proxy.

#### Variables

| Variable                              | Applies to       | Default                                                                     | Meaning                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------- | ---------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FRANK_DEMO_ENV_FILE`                 | launcher         | <repo>/.env if it exists                                                    | Path of the .env file to read (KEY=value lines). The process environment wins over the file. Never committed; you provide it.                                                                                                                                                                                                                              |
| `FRANK_DEMO_STATE_DIR`                | launcher         | ~/.frank-demo                                                               | One directory holding every bot identity, bot state, the relay database, the fake-chain wallet and the logs. Reused across runs.                                                                                                                                                                                                                           |
| `FRANK_DEMO_FAKE_CHAIN`               | launcher         | 0                                                                           | Set to 1 (same as the --fake-chain flag) to run against a built-in fake Monad JSON-RPC: no keys, no funds, no network.                                                                                                                                                                                                                                     |
| `FRANK_DEMO_RELAY_PORT`               | relay            | 8098                                                                        | Port the local relay listens on (127.0.0.1).                                                                                                                                                                                                                                                                                                               |
| `FRANK_DEMO_FAKE_RPC_PORT`            | chain            | 8545                                                                        | Port of the fake-chain RPC (only with FRANK_DEMO_FAKE_CHAIN=1).                                                                                                                                                                                                                                                                                            |
| `CASHWEBD_BIN`                        | relay            | built with Cargo                                                            | Path of a prebuilt cashwebd-exe; skips the Cargo build in run-local-monad.sh.                                                                                                                                                                                                                                                                              |
| `PROTOC`                              | relay build      | auto-detected                                                               | Native protoc executable path (libprotoc 3+); an invalid override fails before Cargo. Otherwise tries PATH, then the installed npm native compiler. Ignored with CASHWEBD_BIN.                                                                                                                                                                             |
| `CARGO`                               | relay build      | cargo                                                                       | Toolchain variables (also CARGO_HOME, CARGO_TARGET_DIR, RUSTUP_HOME, RUSTUP_TOOLCHAIN) are passed to the relay build only when set. Ignored with CASHWEBD_BIN.                                                                                                                                                                                             |
| `CARGO_HOME`                          | relay build      | unset                                                                       | See CARGO.                                                                                                                                                                                                                                                                                                                                                 |
| `CARGO_TARGET_DIR`                    | relay build      | unset                                                                       | See CARGO. Point it at a scratch directory to keep the build out of the repo tree.                                                                                                                                                                                                                                                                         |
| `RUSTUP_HOME`                         | relay build      | unset                                                                       | See CARGO.                                                                                                                                                                                                                                                                                                                                                 |
| `RUSTUP_TOOLCHAIN`                    | relay build      | unset                                                                       | See CARGO.                                                                                                                                                                                                                                                                                                                                                 |
| `MONAD_TESTNET_HTTP_RPC_URL`          | chain            | required unless fake chain                                                  | Monad TESTNET JSON-RPC URL (chain id 10143). May embed an API key. Secret: never printed.                                                                                                                                                                                                                                                                  |
| `MONAD_TESTNET_WS_RPC_URL`            | chain            | optional on a real chain; unset with fake chain                             | Monad TESTNET WebSocket JSON-RPC URL used by the relay proxy. May embed an API key. Secret: never printed.                                                                                                                                                                                                                                                 |
| `FRANK_NETWORK_TAG`                   | chain            | MONT                                                                        | Network tag the relay and bots stamp messages with (MONT = Monad testnet).                                                                                                                                                                                                                                                                                 |
| `MONAD_STAMP_BURN_ADDRESS`            | relay, bots, app | 0x000000000000000000000000000000000000dEaD                                  | Burn address of stamps and topic votes (0x + 40 hex). Passed to the relay (without it every forum post and vote fails with HTTP 500), to the bots, and printed in the app command as QCLI_MONAD_STAMP_BURN_ADDRESS: all three must agree. The default is the well-known 0x...dEaD burn address.                                                            |
| `CASHWEB_STAMP_MIN_BURN_VALUE_WEI`    | relay            | 1000000000000                                                               | Minimum wei a message stamp must pay (0.000001 MON).                                                                                                                                                                                                                                                                                                       |
| `FRANK_DM_DEFAULT_STAMP_VALUE_WEI`    | bots             | 10000000000000000                                                           | Default stamp value bots pay per message (0.01 MON).                                                                                                                                                                                                                                                                                                       |
| `E2E_DEMO_MAIN_WALLET_JSON`           | wallet           | required unless fake chain                                                  | Not allowed with --fake-chain (a throwaway wallet is generated). Path of a JSON file {"address","privateKey"} of a funded TESTNET wallet that pays for bot stamps and payouts. Read by the bots, never by the launcher. chmod 600. Secret: never printed.                                                                                                  |
| `FRANK_DEMO_FAUCET_WALLET_JSON`       | wallet           | required on a real network unless FRANK_DEMO_NO_FAUCET=1                    | Path of a SEPARATE funded testnet wallet file for the faucet (it must differ from E2E_DEMO_MAIN_WALLET_JSON: two processes sending from one wallet reuse nonces, and the faucet should not hold the stamp wallet). Not allowed with --fake-chain. Secret: never printed.                                                                                   |
| `FRANK_DEMO_NO_FAUCET`                | faucet           | 0                                                                           | Set to 1 to run without the faucet on a real network.                                                                                                                                                                                                                                                                                                      |
| `QWEN_API_KEY`                        | qwen             | unset = stub mode                                                           | Set to run the Qwen bot against a real model (needs QWEN_OPENAI_COMPATIBLE_ENDPOINT). Unset: the bot runs in offline STUB mode and its replies say so. Secret: never printed.                                                                                                                                                                              |
| `QWEN_OPENAI_COMPATIBLE_ENDPOINT`     | qwen             | required with QWEN_API_KEY                                                  | OpenAI-compatible base URL of the model provider.                                                                                                                                                                                                                                                                                                          |
| `QWEN_MODEL`                          | qwen             | qwen3.8-max                                                                 | Model name for live mode.                                                                                                                                                                                                                                                                                                                                  |
| `QWEN_BOT_MODE`                       | qwen             | live if QWEN_API_KEY, else stub                                             | Force "stub" or "live". "live" without a key is an error, never a silent stub.                                                                                                                                                                                                                                                                             |
| `RAFFLE_BOT_ENTRY_PRICE_WEI`          | raffle           | 20000000000000000                                                           | Raffle entry price (0.02 MON).                                                                                                                                                                                                                                                                                                                             |
| `RAFFLE_BOT_MAX_TOPUP_WEI`            | raffle           | 50000000000000000                                                           | Most the stamp wallet may top up the raffle identity per round to cover swept-entry gas and payout gas; beyond it the draw is held and logged (0.05 MON).                                                                                                                                                                                                  |
| `RAFFLE_BOT_MAX_TOPUP_PER_DAY_WEI`    | raffle           | 250000000000000000                                                          | Most the stamp wallet may top up the raffle identity per trailing 24 hours (0.25 MON).                                                                                                                                                                                                                                                                     |
| `RAFFLE_BOT_MAX_ENTRIES`              | raffle           | 5                                                                           | Entrants per round. The demo default is 5 (the bot's own default is unchanged); use a smaller number for a quick round.                                                                                                                                                                                                                                    |
| `BLACKJACK_BOT_MIN_WAGER_WEI`         | blackjack        | bot default (0.01 MON)                                                      | Table minimum.                                                                                                                                                                                                                                                                                                                                             |
| `BLACKJACK_BOT_MAX_WAGER_WEI`         | blackjack        | bot default (1 MON)                                                         | Table maximum.                                                                                                                                                                                                                                                                                                                                             |
| `BLACKJACK_BOT_MAX_GREETINGS`         | blackjack        | 5                                                                           | Welcome messages the dealer sends per run (each costs the dealer a stamp); 0 = never greet.                                                                                                                                                                                                                                                                |
| `BLACKJACK_BOT_MAX_GREETINGS_PER_DAY` | blackjack        | 20                                                                          | Welcome messages per UTC day, kept across restarts.                                                                                                                                                                                                                                                                                                        |
| `VENDOR_BOT_CATALOG_DIR`              | picture shop     | bundled demo-catalog/                                                       | Directory with manifest.json and image files the shop sells.                                                                                                                                                                                                                                                                                               |
| `FAUCET_AMOUNT_WEI`                   | faucet           | 50000000000000000 (0.05 MON); 1000000000000000000 (1 MON) with --fake-chain | MON sent to each new profile. The 0.05 MON real-network default is small on purpose and is NOT enough for a blackjack hand (0.07 MON minimum: 0.01 bet + 0.01 stamp + 0.05 fee reserve); raise it (ceiling 1 MON) if you want players to be able to play. With --fake-chain the default is 1 MON. FAUCET_MAX_PER_DAY and the per-address rule still apply. |
| `FAUCET_MAX_PER_DAY`                  | faucet           | 20                                                                          | New addresses funded per rolling 24 hours.                                                                                                                                                                                                                                                                                                                 |
| `FAUCET_MIN_RESERVE_WEI`              | faucet           | 100000000000000000                                                          | The faucet wallet keeps at least this balance.                                                                                                                                                                                                                                                                                                             |
| `FRANK_BOT_PEER_DENYLIST`             | bots             | empty                                                                       | Comma-separated addresses no bot engages.                                                                                                                                                                                                                                                                                                                  |
| `FRANK_BOT_MAX_REPLIES_PER_PEER`      | bots             | 20                                                                          | Per-peer reply budget per window.                                                                                                                                                                                                                                                                                                                          |

Stopping: Ctrl-C, SIGTERM, SIGHUP, a crash and the relay dying all stop every child process
group; a second Ctrl-C during the 8 s grace period kills them immediately. One launcher runs per
state dir: `<state dir>/demo.lock` (created exclusively, holding the launcher's pid and start
time) makes a second launcher refuse to start; a lock left by a dead launcher, or by a pid that
has since been reused, is recognised by the start time and replaced. If a lock cannot be judged,
the message says which file to delete.

A `kill -9` of the launcher (or a power loss) cannot be handled, and the launcher NEVER kills a
process because a file says so. It keeps `<state dir>/demo.pid` (0600; pid, process group, start
time and command line of each child) purely as information. After a hard kill the next `yarn demo`
deletes that record, does not stop anything, and, if a port is still busy, prints what the record
listed with the commands to inspect it: `ps -p <pid> -o pid,pgid,lstart,command`, and, only if
that really is a leftover of the demo, `kill -TERM -- -<pgid>`.

The faucet wallet must be a different wallet from the stamp wallet: the launcher compares the
`address` in the two wallet files (a copy or a symlink of the same file is refused).

A child that dies after startup is not restarted: a banner names it and its log, and the
summary is marked UNHEALTHY. If the relay dies the launcher stops everything and exits non-zero.

The blackjack smoke checks (#395): the dealer answers a bare `deal` with its tagged error; a new
profile receives the dealer's `welcome` (limits equal to the dealer's own config, greeted exactly
once); and a scripted first bet resolves end to end (a real wager transfer from the new profile, the
`bet` message, the dealer's `deal`, a `stand`, and a `reveal` whose fairness check passes). The
browser bet control itself is not exercised here (see the PR for the browser run).

The fake chain binds 127.0.0.1 only (a test asserts it), so nothing off this machine can reach it. It is a ledger, not a chain: it accepts any well-formed transaction and mines it
instantly, so it demonstrates flows, not consensus. Never point anything of value at it.

---

> **Update (2026-09-27, autonomous overnight session):** the bot and its scripts were ported off
> `lotus-identity.ts`/`FrankIdentity` onto `monad-identity.ts`/`MonadIdentity` -- the real Frank UI's
> `ActiveChain`/`MonadChain` stack (tickets #41-#45) only ever resolves a contact via
> `fetchMonadProfile`, which never finds a Lotus-registered identity, so the bot was previously
> invisible to (and couldn't message) any real wallet created through the app. The "Live proof"
> section below is left exactly as it was written -- an accurate historical record of that original,
> Lotus-identity run -- but is no longer how the bot actually authenticates itself; see each script's
> own updated header comment (compile command, imports) for the current shape, and the "fix(app):
> wire up identity registration; port Qwen bot to Monad-native identity" commit for the full
> before/after, including a real wire-format interop bug (bare-string vs. `MessageItem[]` JSON) only
> found by actually running the bot against a real `ActiveChain` wallet.

# Ticket #9: a Qwen 3.8 Max agent with its own on-chain Frank identity

This is the runbook for issue #9 (stretch): a headless client that bridges
real conversation turns between a human/script and **Qwen 3.8 Max** (Alibaba Cloud), speaking only
over **Frank**, a burn-to-speak messaging protocol on **Monad testnet**.

Everything described here is real and was run live against Monad testnet and Alibaba Cloud's Qwen
API while implementing this ticket — see "Live proof from this ticket's own run" below for the
actual transcript, transaction hashes, and independent on-chain verification.

## What this is, and why it's "agentic"

Most "AI agent" demos give a model a tool to call and call it a day. This is a different, more
literal claim: **the agent owns a cryptographic identity and pays its own way to communicate.**

- The bot generates its own secp256k1 keypair and derives its own Frank address
  (`lotus-identity.ts`) — nobody hands it credentials; it mints its own.
- It registers that identity on a live `cashweb-registry` relay via a real, signed `PUT /metadata/:addr` — the same identity-registration primitive a human Frank user would use.
- To reply to anyone, it must **burn real MON** (Monad's native token) in a stamp transaction it
  builds and signs itself, from a funded sub-account it manages itself (`qwen-bot-common.ts`,
  building on tickets #13/#14/#18/#34). No message goes out without a real, on-chain cost paid by
  the agent's own key.
- It reads every incoming message by trial-decrypting a real end-to-end-encrypted envelope
  (`monad-message-envelope.ts`) using ECDH between its own identity key and the sender's — a key
  it resolves by looking the sender up in the _same_ trust-anchored identity registry, not by
  trusting a self-asserted value in the message itself.

That's the "Trust, Identity & AI" angle: this isn't a wrapper around an API key sitting in an env
var. It's an agent whose right to speak is enforced by the same economic/cryptographic primitive
every other Frank user is bound by, and whose identity is independently verifiable by anyone who
can query the registry — a genuinely novel trust substrate for an autonomous agent, not just a
chatbot with blockchain flavor text sprinkled on top.

## Architecture

```
 human/script                         cashweb-registry relay                    bot
 (qwen-bot-send-demo.livecheck.ts)    (real HTTP server, real Monad RPC)   (qwen-bot.livecheck.ts)
 ─────────────────────────────        ──────────────────────────────      ─────────────────────
 1. register identity  ───PUT /metadata/:addr────────────────────────────────▶ (same, on startup)
 2. encrypt msg (ECDH), burn MON,
    PUT /message/monad  ──────────────────────────────────────────────────▶
                                        broadcasts+confirms+verifies burn tx
                                        on real Monad testnet, stores msg
 3. signed mailbox read (challenge +   ◀───────────────────────────────    4. same, as the bot's
    GET /message/monad/inbox/:me)                                                own recipient,
                                                                                  find msg addressed
                                                                                  to itself, decrypt
                                                                               5. ask Qwen 3.8 Max
                                                                                  (real streaming
                                                                                  HTTPS call)
                                                                               6. encrypt reply,
                                                                                  burn MON, PUT
    decrypt reply,             ◀───────────────────────────────────────────     /message/monad
    print Qwen's real answer
```

Library code (reusable, no side effects at import time):

- `lotus-identity.ts` — Frank/Lotus identity: keypair, address derivation (a from-scratch
  reimplementation of `bitcoinsuite_core::LotusAddress`, verified against its own Rust test
  vectors), signing, `PUT`/`GET /metadata/:addr`.
- `monad-message-envelope.ts` — the E2E encryption + recipient-addressing convention (see "The
  recipient-filtering gap" below), reusing `../relay/crypto.ts`'s existing ECDH+AES code.
- `monad-message-feed.ts` / `monad-mailbox-client.ts` — the authenticated recipient mailbox
  client (`POST /message/monad/auth/:me` challenge, identity-key signature, then
  `GET /message/monad/inbox/:me` with cursor paging). It replaced ticket #37's unauthenticated
  `GET /message/monad?since=<t>`, which PR #197 removed.
- `qwen-client.ts` — Qwen 3.8 Max streaming chat client (SSE, hand-parsed; the endpoint rejects
  non-streaming requests — see "Qwen API notes" below).
- `qwen-bot-common.ts` — shared identity/funding/sub-account-pool setup for both scripts below,
  including a nonce-race retry wrapper (see "Problems found and fixed" below).

Runnable entry points (`.livecheck.ts`, this app's existing convention for scripts that hit the
real network — excluded from `jest`'s `testMatch`, meant to be run manually):

- `qwen-bot.livecheck.ts` — the agent itself.
- `qwen-bot-send-demo.livecheck.ts` — the "human/script" side, for driving a live demo
  conversation (supports multiple sequential turns via `QWEN_BOT_MESSAGES`).

## How the recipient-filtering gap was solved for this demo

> **Historical (pre-PR #197).** The relay now serves each recipient only its own inbox behind a
> signed challenge, so bots read `fetchMonadMessagesSince({ ...mailboxAuthFor(identity, relayBaseUrl),
sinceMs })` and no longer download the global feed. The envelope's `to` check below is retained as
> defence in depth.

Ticket #37's `GET /message/monad?since=<t>` returns **every** stored message — there's no
recipient field on `MonadStampedMessage`/`StoredMonadMessage` for the relay to filter on (see that
route's own module doc in `backend/cashweb/cashweb-registry/src/http/monad_message.rs` for the
full reasoning). Fixing that for real means adding a wire-format field (`recipient_address_hint`,
sketched in that file's doc comment) — a deliberate proto change left for review, not made
unilaterally by this stretch ticket, since #16/#19/#27/#30/#37 all build on that proto.

Instead, messages use the version-2 envelope documented in `monad-message-envelope.ts`: ECDH plus
HKDF-SHA256 derives an AES-256-GCM key, and the version, Frank network tag, sender, and recipient
are authenticated as associated data. `from`/`to` remain relay-visible routing hints, while the
ciphertext and GCM tag provide confidentiality and tamper detection without adding a public sender
signature; either conversation participant can still construct an indistinguishable transcript.
Pollers compare EVM identities case-independently and persist canonical lower-case identity keys,
so checksum spelling is never a second bot user or raffle entrant. Readers always resolve the
sender's public key through the trust-anchored profile registry rather than accepting one from the
envelope. Version 1 AES-CBC envelopes remain parse/decrypt-only compatibility for records already
stored (including historical upper-case address spellings); no builder or new relay admission path
emits or accepts v1.

## Qwen API notes (confirmed live)

- `POST {QWEN_OPENAI_COMPATIBLE_ENDPOINT}/chat/completions`, model `qwen3.8-max`.
- **Must** pass `"stream": true` and `"enable_thinking": true` — a plain non-streaming request is
  rejected. `qwen-client.ts` hand-parses the resulting SSE stream (`choices[0].delta.content` for
  the reply text, `.delta.reasoning_content` for the model's visible reasoning, logged separately
  for this write-up but never sent back over Frank as part of the reply).

## Problems found and fixed while wiring this up

Both are genuine bugs/gaps found only by actually running the full pipeline live, fixed minimally
and documented at the fix site (same standard ticket #8 held itself to):

1. **`bitcore-lib-xpi`'s `PrivateKey.fromBuffer` silently drops key compression.**
   `PrivateKey._transformBNBuffer` (the path `fromBuffer` takes for a raw 32-byte key) hardcodes
   `compressed: false`, while the constructor's plain-hex-_string_ path defaults to `compressed: true`. A freshly-generated identity (`new PrivateKey()`, no args) got a 33-byte compressed
   pubkey; the _same_ identity reloaded via `fromBuffer` on a later run got a 65-byte uncompressed
   one — and the live registry's `PUT /metadata/:addr` rejects that with `400 invalid-pub-key-len` (`PubKeyHash` requires exactly 33 bytes). Confirmed live: the bot's first
   run worked, its second run (reloading the same persisted identity) failed with exactly this
   error until fixed. Fix: `FrankIdentity.fromPrivateKeyHex` (`lotus-identity.ts`) passes the hex
   _string_ to `PrivateKey`'s constructor instead of calling `fromBuffer`, sidestepping the buggy
   path entirely. Not a fix to `bitcore-lib-xpi` itself (a vendored third-party library) — worked
   around in this ticket's own new code only.
2. **The shared funded testnet wallet is in concurrent use by other activity in this
   environment.** Its balance and `eth_getTransactionCount` kept moving between this ticket's own
   transactions, and `fanOutFundSubAccounts` (#14) has no retry logic for a nonce fetched via
   `eth_getTransactionCount(addr, "pending")` going stale by submit time — confirmed live,
   repeatedly, as `"nonce has already been used"` / `NONCE_EXPIRED` errors. `fanOutFundSubAccounts`
   itself is untouched (its own doc comment already calls this "out of scope" for that ticket); this
   ticket's own `fundPoolWithRetry` (`qwen-bot-common.ts`) instead calls it directly with its
   `onFunded` hook, retrying only whichever sub-accounts didn't already get a real funding tx
   broadcast on a nonce-race failure, up to 6 attempts with linear backoff.

Also worth surfacing plainly: this ticket's instructions described the shared wallet
(`frank-worktrees/spike-demo/spike/data/chain-wallet.json`) as down to ~0.0177 MON by the time this
ticket started (per ticket #8's own balance having been spent down in the interim). That figure
turned out to describe a _different_ address — a one-time, already-`spent`, never-swept sub-account
from ticket #8's own ephemeral pool (`0x7494372aF686Db5ABC346fB4Cc49B5b17Fe8bEE8`, single-use by
design per ticket #34), not the main wallet itself. The actual main wallet
(`0xf7a977F50E825D9f9ea403a03Fca9828FEa65E9c`) had ~9.94 MON when this ticket's demo ran — plenty
for the multi-turn conversation below. This ticket's code (`qwen-bot-common.ts`'s dynamic,
fee-data-driven `gasReserve`) was written before this was discovered, under the (mistaken, at the
time) assumption of a near-empty wallet — left as-is since a frugal, no-guessing gas reserve is
strictly better than a padded one regardless of how much balance is actually available.

## Live proof from this ticket's own run

Two real conversation turns, run live against Monad testnet and Alibaba Cloud's Qwen API while
implementing this ticket (not mocked, not replayed):

- Bot's Frank identity: `lotusR16PSJKa9pYYkfkZVFYeWA6obDmzmXZx8CsRmZZjX9`
- Sender's Frank identity: `lotusR16PSJKNGo5sNqXoVjyaQKHDfdK3U6STRd2AydW9bt`

**Turn 1**

> Sender: "Hi! I'm a script talking to you over Frank on Monad testnet, as a demo. Please tell me: what model are you, who built you, and in one
> sentence why is a burn-to-speak protocol like Frank a good fit for an AI agent's identity?"

- Sender's stamped message burn tx: `0xd7a281fd2ffc0f4c7d10ad7933f6d5b9a45bfefad1e509f5f2ab622c2592877c`

> Qwen (via the bot): "I'm Qwen, a large language model built by Alibaba Group's Tongyi Lab. A
> burn-to-speak protocol like Frank fits AI agents because each message carries a small real cost
> and on-chain provenance, which helps deter spam and ties the agent's output to a verifiable
> identity."

- Bot's reply burn tx: `0xbf6ade241ff8eef009a274d1413532fa98915e4e78cee79b6cebe3b2dccfdd91`

**Turn 2** (a real follow-up, with the bot's Qwen conversation history carrying context from turn 1)

> Sender: "Follow-up: you said Tongyi Lab built you. Roughly how many parameters does qwen3.8-max
> have, and is your burn-to-speak reply itself proof that you paid real gas to talk to me?"

- Sender's stamped message burn tx: `0xb21bd361e0475e4a3d5db1a7d43aacb245c9e1484bf6bb4193a3cc1089cb19ba`

> Qwen (via the bot): "Alibaba hasn't published a reliable public parameter count for
> `qwen3.8-max`, so I shouldn't guess a number. My reply text alone isn't proof of payment; the
> proof is the associated Frank/Monad transaction, burn event, and receipt. If you have the tx
> hash, you can verify the MON burn and delivery on-chain."

- Bot's reply burn tx: `0xced7e73cc1c6415ab432a2e8fc4148adeac27736981c54267ff30c0b909aa7d2`

**Independent on-chain verification** (a separate `eth_getTransactionReceipt` call against
Alchemy's Monad testnet RPC, for all four burns above): every one landed with `status: 0x1`
(success) and `to: 0x000000000000000000000000000000000000dead` (the canonical Stamp burn address)
— real, mined, successful transactions, not simulated.

Note on turn 2's answer: this is Qwen correctly declining to fabricate a parameter count and
correctly reasoning about what "proof of payment" actually means here (the on-chain burn, not the
text) — exactly the kind of grounded, identity-aware response the demo is meant to show.

## Usage (from `packages/bot/`)

**Update (ticket #53, package split):** this used to require hand-listing every transitively
needed file to a raw `tsc` invocation (no `ts-node` in the repo) because the bot lived inside
`app/src/cashweb/wallet/` with no package boundary of its own. It's now `@frank/bot`, a real yarn
workspace package depending on `@frank/wallet`/`@frank/cashweb` -- runs directly via `tsx`, no
manual compile step:

```sh
cd packages/bot
yarn install   # from the repo root, or once via the root workspace
```

Start a local relay exactly as in ticket #8's runbook
(`backend/cashweb/cashweb-registry/examples/README.md`, step 1), then:

```sh
set -a; source ../../.env; set +a   # needs QWEN_API_KEY, QWEN_OPENAI_COMPATIBLE_ENDPOINT too
export E2E_DEMO_RELAY_URL=http://127.0.0.1:8098
export E2E_DEMO_MAIN_WALLET_JSON=/absolute/path/to/chain-wallet.json
yarn bot   # keeps running; set QWEN_BOT_MAX_REPLIES=<n> to exit after n replies
```

### Reply mode: live or stub (`QWEN_BOT_MODE`)

- `QWEN_BOT_MODE=live` (default): real Qwen replies. `QWEN_API_KEY` and
  `QWEN_OPENAI_COMPATIBLE_ENDPOINT` are required; if one is missing the bot exits at startup.
  It never falls back to the stub by itself. Failure logs omit provider bodies, even with
  `QWEN_BOT_DEBUG` set; check configuration and durable state locally.
- `QWEN_BOT_MODE=stub`: no API key, no network call to any model. Replies are deterministic and
  every one starts with `[STUB -- no model, offline canned reply]`, the startup banner and the
  logs identify `Reply mode: stub`. Use it for offline demos, smoke tests and CI.
- `QWEN_BOT_MAX_REPLIES` (default unset = keep running; `1` = exit after one reply) and
  `QWEN_BOT_IDLE_TIMEOUT_MS` (default: never when unlimited, 10 minutes when a reply cap is set;
  `0` = never).

```sh
QWEN_BOT_MODE=stub yarn bot   # still needs the relay/RPC/wallet env, but no Qwen key
```

The bot persists its mailbox/profile cursors, greeted and processed identities, and per-user Qwen
conversation history under `QWEN_BOT_STATE_DIR` (default `~/.frank-bots/qwen`, or under
`$XDG_STATE_HOME`). Its HD sender seed, single-use account pools, and exact payment journals live separately under
`QWEN_BOT_WALLET_STATE_DIR` (default `~/.frank-bots/qwen-wallet`, or under
`$XDG_STATE_HOME`). On restart it reconciles that
wallet authority before funding or signing anything new, then resumes the persisted mailbox
scan. On a new root, `QWEN_BOT_MESSAGE_SINCE_MS=<unix milliseconds>` sets the replay origin;
otherwise the pre-funding startup time is used. The origin is saved once. Changing the variable
on restart does not rebind an existing scan.

The `inbox-scan:v1` record binds the scan to the canonical bot identity, relay URL and network.
An existing legacy `__since__`, response, processed marker or conversation cannot prove that
earlier inputs were retained: first adoption replays the relay's retained inbox from origin **0**,
preserving all old processed/response rows. A response may have committed before the first
`__since__` checkpoint, so a missing timestamp alone does not make the store new.
This is an additive namespace; it does not rewrite or delete old state. A changed context or
malformed record stops ingress without erasing data. Use the original context to resume.

Each authenticated mailbox page and its exact opaque continuation are committed in one synced
Level batch before any imported turn reaches Qwen or a reply payment. Pending `inbox:v1:<hash>`
rows contain ciphertext, timestamp, network and local admission order, with account/relay context
owned by the immutable scan record. A completed sweep starts another sweep from the fixed origin,
so late equal-timestamp inputs are discovered. Saved stale/foreign-epoch tokens are cleared durably
and retried without a token at most once per poll; a no-token rejection remains an error.

Named local limits are 100 messages / 4 MiB + 16 KiB per page (the existing relay ceiling),
two page requests per poll, and 1,000 pending
inputs / 16 MiB pending ciphertext. A full page that exceeds local capacity leaves the checkpoint
unchanged and pauses admission; no pending row is evicted. Missing keys, policy/budget deferrals,
unsupported envelopes and unavailable decryption remain pending. An authenticated, deterministic
rejection retains only a fixed disposition and hash. Model ownership atomically removes the inbox
ciphertext as it creates `model-started`. Terminal identities deliberately grow with replayable
history; total storage is not constant and there is no tombstone garbage collector.

Qwen responses have a separate input-keyed record (`response:v1:<inbound payload hash>`) in
`QWEN_BOT_STATE_DIR/qwen-bot-state`. The bot fsyncs the generated response and proposed history
before sending, then fsyncs a `send-started` boundary before entering the ordinary send builder.
Only a confirmed send commits the response receipt, conversation and processed marker together.
Confirmed response rows keep only bounded input/context/receipt metadata; cumulative history
lives once in the conversation record. Pending responses retain their proposed history until commit.
Existing processed markers remain terminal. The database contains private conversation text;
keep it local and do not paste its contents into diagnostic logs or tickets.

| Durable response phase | Restart behavior |
| --- | --- |
| `model-started` | Held: the provider may have completed, but no result was durably accepted. No automatic model retry. |
| `response-ready` | Reuses the saved response/history without a model call, subject to peer policy and matching bot/funding/network/relay/stamp context. A transient policy lookup failure or exhausted budget is reconsidered on later polls. |
| `send-started` | Held: delivery or payment may have happened. No rebuilt envelope, new signature, or automatic resend. |
| `confirmed` | Terminal: duplicates do not generate or send again. |

A held diagnostic includes the inbound hash and a fixed reason. Stop the bot and preserve both
state roots before investigating that record alongside the wallet journals. There is deliberately
no automatic release/reset command: exact outbound-envelope and wallet attempt reconciliation
exists only for canonical replies (below); the legacy send keeps these holds. Later admitted turns from the held peer remain durably pending in order;
other peers proceed. This does not complete #168 or promise
exactly-once provider execution in the model-call/persistence crash window.

#### Canonical replies: one sealed envelope and one wallet attempt (#703)

With `QWEN_BOT_CANONICAL_ROOTS_JSON` set, a `response-ready` turn never enters the ordinary send
builder and never becomes `send-started`. Instead it owns one coupling record
(`coupling:v1:<inbound payload hash>`) beside its response row:

| Coupling phase | What is durable | Restart behavior |
| --- | --- | --- |
| `envelope-ready` | The sealed reply bytes, the wallet's public prepared binding and bounded public identity, fsynced before the first wallet call. | The wallet is asked for a record with exactly those bytes. If it has one, the link is repaired; otherwise the first payment intent is prepared for the same bytes. The reply is never sealed again. |
| `intent-linked` | The wallet's attempt reference. | Signs the stored unsigned transactions only, then re-sends the one promoted request. A `202` from the relay or an unknown outcome is held and retried with the same bytes. |
| `terminal` | The wallet's delivered or dead evidence, copied in the Qwen final batch. Delivered commits receipt, conversation and processed marker in that same batch. | The wallet's evidence is cleaned up and acknowledged; a crash in between repeats only those two steps. |
| `settled` | Bounded identity and evidence only; the sealed bytes are dropped once the wallet's acknowledgement frontier has passed the attempt. | Terminal. |

The record holds ciphertext, never the reply text, history or model reasoning. On startup the CLI
opens this state first, then the canonical wallet (which signs, funds and sends nothing on open),
then correlates every retained wallet record with a saved turn before any replay. A wallet record
no turn owns, a linked attempt the wallet no longer has, a changed account or stamp policy, or a
dead outcome leaves the turn held with a fixed reason; none of them builds a second envelope or
payment. A dead outcome is acknowledged to the wallet after it is recorded here, so it does not
block later turns for other peers; the dead turn and its peer stay held. Legacy `model-started`
and `send-started` rows keep the meanings in the table above and are never coupled after the fact.
At most 64 unsettled envelopes are retained; beyond that new replies wait.

Safe rollback: stop the bot and back up both state roots and its identity. Do not run older bot
code against these roots while any pending inbox or nonterminal response row exists: old code
ignores those rows and could skip input or repeat a paid send. Preserve the rows and keep the bot stopped until a compatible
version or reviewed reconciliation is available. Never delete the state root to clear a held turn.

Credential-free regression fixtures run the real CLI in stub mode with local Level state,
the public authenticated mailbox client, and local relay/model/payment fixtures. CLI child tests
use SIGKILL immediately after synced page, model-ownership and confirmation commits without
Close/flush. Fault tests cover uncertain batch completion, stale imports, concurrent drains,
capacity, context rejection and privacy. These fixtures do not prove live relay or chain finality.

```sh
yarn workspace @frank/bot test --runInBand qwen-inbound-workflow qwen-bot-loop qwen-bot.livecheck qwen-response-workflow
```

In a separate shell, once the bot prints its address (or is already running from a prior run —
its identity persists at `QWEN_BOT_IDENTITY_JSON`, default `/tmp/qwen-bot-identity.json`):

```sh
set -a; source ../../.env; set +a
export E2E_DEMO_RELAY_URL=http://127.0.0.1:8098
export E2E_DEMO_MAIN_WALLET_JSON=/absolute/path/to/chain-wallet.json
export QWEN_BOT_MESSAGES='["Hi, who are you?","Follow-up: prove you paid to reply."]'
yarn send-demo
```

`yarn ui-verify` (`monad-ui-verify.livecheck.ts`) exercises the same flow through the real app's
own `ActiveChain` seam (`@frank/wallet/chain`) instead of the bot's own hand-rolled calls -- see
that file's own header comment for its specific env vars.

## Canonical mode (#703/#778)

Setting `QWEN_BOT_CANONICAL_ROOTS_JSON` runs the bot with a typed account only: no legacy
identity, profile registration, greeting or legacy stamp wallet. It reads its canonical inbox from
its installed home relay, opens messages with its own role keys under admitted directory evidence,
and answers each turn through one sealed envelope and one durable wallet attempt (see "Canonical
replies" above). It answers only the `ui` subject in the operator-approved bundle.

Files the operator provides (all paths absolute or relative to `packages/bot`):

- **Roots** (`QWEN_BOT_CANONICAL_ROOTS_JSON`, mode `0600`, secret, never created by the bot):
  `{"registry":"frank-domain-roots-v1","roots":{"evm-wallet":"<64 hex>","identity-authentication":"<64 hex>","messaging-encryption":"<64 hex>"}}`
- **Bootstrap policy** (`QWEN_BOT_CANONICAL_POLICY_JSON`, public): the `bootstrap-policy.json`
  written by `app/scripts/directory-operator.mts policy`.
- **Approved bundle** (`QWEN_BOT_CANONICAL_BUNDLE_JSON`, public): the `approved-bundle.json`
  written by `app/scripts/directory-operator.mts approve`.

**1. Write the bot's public export** (signs one public statement; opens the typed wallet, which
funds and sends nothing; prints the stamp account to fund):

```sh
cd packages/bot
QWEN_BOT_MODE=stub \
QWEN_BOT_CANONICAL_ROOTS_JSON=/abs/bot-roots.json \
QWEN_BOT_CANONICAL_POLICY_JSON=/abs/bootstrap-policy.json \
QWEN_BOT_CANONICAL_HOME=relay-a \
QWEN_BOT_CANONICAL_EXPORT_JSON=/abs/bot-export.json \
QWEN_BOT_STATE_DIR=/abs/bot-state QWEN_BOT_WALLET_STATE_DIR=/abs/bot-wallet \
npx tsx qwen-bot.livecheck.ts
```

`QWEN_BOT_CANONICAL_HOME` must be the same relay the UI account is homed on (there is no relay
forwarding yet). The export must be made inside the policy's validity window (at most one hour).

**2. Operator approves** the UI export and the bot export and installs the result:

```sh
# from the repository root
npx tsx --tsconfig packages/bot/tsconfig.json app/scripts/directory-operator.mts approve \
  /abs/bootstrap-policy.json /abs/ui-export.json /abs/bot-export.json /abs/out /abs/relay-state new
```

Installing into the bot means pointing `QWEN_BOT_CANONICAL_BUNDLE_JSON` at
`/abs/out/approved-bundle.json` and starting it; the relays install the generated
`relay-*.directory.toml`. The bot refuses to start if the bundle or policy fails the strict parser,
belongs to another policy, or does not carry exactly the evidence its own wallet produces.

**3. Fund** the "canonical stamp account" printed in step 1 with native MON. The wallet funds
its single-use stamp accounts from that account, through the relay's RPC proxy.

**4. Run** (local Ollama model shown; use `QWEN_BOT_MODE=stub` for the deterministic model):

```sh
cd packages/bot
QWEN_BOT_MODE=live QWEN_API_KEY=local-ollama-placeholder \
QWEN_OPENAI_COMPATIBLE_ENDPOINT=http://127.0.0.1:11434/v1 QWEN_MODEL=qwen2.5:7b \
QWEN_BOT_CANONICAL_ROOTS_JSON=/abs/bot-roots.json \
QWEN_BOT_CANONICAL_POLICY_JSON=/abs/bootstrap-policy.json \
QWEN_BOT_CANONICAL_BUNDLE_JSON=/abs/out/approved-bundle.json \
QWEN_BOT_CANONICAL_STATUS_PORT=8455 \
QWEN_BOT_STATE_DIR=/abs/bot-state QWEN_BOT_WALLET_STATE_DIR=/abs/bot-wallet \
QWEN_BOT_STAMP_VALUE_WEI=10000000000000000 \
NODE_EXTRA_CA_CERTS=/abs/local-ca.pem \
npx tsx qwen-bot.livecheck.ts
```

- The relay is the bot subject's installed home endpoint from the bundle (an `https://` origin).
  `E2E_DEMO_RELAY_URL`, if set, must have the same origin or the bot refuses to start.
  `NODE_EXTRA_CA_CERTS` is only needed when that origin uses a local CA.
- `QWEN_BOT_CANONICAL_STATUS_PORT` serves `GET /directory-installation/<bundle identity>` as plain
  HTTP on `QWEN_BOT_CANONICAL_STATUS_HOST` (default `127.0.0.1`). Put a TLS front for the bot
  origin named in the policy before it; the app's readiness check reads it there. Any other path
  or manifest is 404.
- On every start the bot publishes its own attestation to
  `<home>/directory/v1/<network>/<P>/head`. It never publishes or enrolls anyone else: the UI
  account becomes usable only after it has published its own evidence to that relay.
- Chain RPC goes only through `<home>/chain-rpc/<MONAD_RPC_CHAIN>/rpc` (`MONAD_RPC_CHAIN`
  defaults to `monad-testnet`).
- `QWEN_BOT_MAX_REPLIES`, `QWEN_BOT_IDLE_TIMEOUT_MS`, `QWEN_BOT_POLL_INTERVAL_MS`,
  `QWEN_BOT_MESSAGE_SINCE_MS` and the per-peer reply budget (`FRANK_BOT_MAX_REPLIES_PER_PEER`,
  `FRANK_BOT_REPLY_WINDOW_MS`) apply as in legacy mode. The legacy bot-marker profile lookup and
  peer denylist are not consulted: a canonical peer is whoever the operator installed.
- Use a fresh `QWEN_BOT_STATE_DIR`: a root that already holds a legacy inbox context is refused.
- Durable roots: `QWEN_BOT_STATE_DIR` (turns, inbox, couplings, and `canonical-directory/` with
  the directory stores and their checkpoint files) and `QWEN_BOT_WALLET_STATE_DIR/canonical-*`
  (typed wallet pool and journals). Back up and restore them together.

## Auto-greet / auto-fund new signups (ticket #77)

Alongside its Qwen-reply behavior, `qwen-bot.livecheck.ts` also polls the live
`GET /metadata/monad?since=<t>` route (ticket #75, via `fetchMonadProfilesSince`,
`@frank/wallet/monad-identity`) for newly-registered Monad profiles. For each one seen after the
bot's own startup (never itself), it sends a real greeting DM (the same stamped-message path used
for Qwen replies, factored into `qwen-bot-common.ts`'s `sendDirectMessageText`) and funds the new
address with a small amount of real testnet MON, sent directly via `MonadAccountTxSigner.
buildAndSignTransfer` on the main funded wallet -- see `qwen-bot.livecheck.ts`'s own header comment
(point 5) for why that primitive was used instead of `fanOutFundSubAccounts`
(`@frank/wallet/monad-account-pool.ts`), which this ticket's own text originally suggested but
which is actually scoped to funding the bot's _own_ derived sub-account pool, not arbitrary
third-party addresses.

Configuration (env vars, all optional):

- `QWEN_BOT_MAX_GREETINGS` -- max new registrations to greet+fund per run (default `5`). Also
  limits real greeting stamp payments and funding transfers. Sender inventory is prepared lazily
  for each send instead of pre-funding a large nonce-contending batch.
- `QWEN_BOT_GREETING_MESSAGE` -- the greeting DM's text (default: a short welcome message).
- `QWEN_BOT_FUND_VALUE_WEI` -- wei sent to each newly-greeted address (default
  `50000000000000000`, i.e. 0.05 MON, enough for the preferred two-payment testnet flow under the
  current fee assumptions).
- `QWEN_BOT_STATE_DIR` -- durable polling, dedupe, and Qwen conversation state.
- `QWEN_BOT_WALLET_STATE_DIR` -- durable bot sender seed, account pools, and payment journals.

The sender demo uses the equivalent `QWEN_SENDER_WALLET_STATE_DIR` (default
`~/.frank-bots/qwen-sender-wallet`, or under `$XDG_STATE_HOME`). Keep the bot and sender roots
distinct: opening one root in two processes fails closed rather than allowing two signers to race
the same accounts and nonces.

## Bot loop guard (#311)

Bots that answer any inbound message (vendor catalog, raffle round status, Qwen chat) would
otherwise reply to each other forever, each reply paying a stamp. Every bot now registers a
self-declared `bot` profile entry (`registerAndLog`, an ordinary open-ended `Entry` kind: no
proto/backend change) and shares `bot-loop-guard.ts`:

- never greet/fund, chat with, or send catalog/status to another bot: a peer is a bot if its
  profile carries the marker or its address is in `FRANK_BOT_PEER_DENYLIST` (comma-separated;
  for bots registered before the marker existed or third-party bots). A failed profile lookup
  fails closed.
- hard per-peer reply budget per sliding window: `FRANK_BOT_MAX_REPLIES_PER_PEER` (default 20,
  `0` = never reply) per `FRANK_BOT_REPLY_WINDOW_MS` (default 1 hour). Applies to Qwen replies
  and the vendor/raffle unsolicited replies; paid fulfilment and game moves are never dropped.
- Qwen only treats `text` items as prompts; structured items are ignored, never quoted to the model.

Limits: the marker is self-asserted; the budget is in memory (a restart resets it) and per
address (a sybil gets the budget per address, each still paying a stamp). Blackjack answers only
`blackjack-move` items; it also opens the chat with each new registration (below), skipping itself,
the denylist and bot-marked profiles through the same guard.

### Blackjack welcome greeting (#395)

The dealer watches the new-registration feed like the Qwen greeter and sends each new profile ONE
message: a `blackjack-move` item with the additive action `welcome` (min/max wager in wei taken from
`BLACKJACK_BOT_MIN_WAGER_WEI` / `BLACKJACK_BOT_MAX_WAGER_WEI`, a fee hint, a rules summary) followed
by a plain-text line. The app renders an inline bet control in that bubble (there is no compose-bar
button). Each greeting costs the dealer a stamp, so: the once-per-address record is durable and
written before the send (`blackjack-greeting-state` in `BLACKJACK_BOT_STATE_DIR`, a restart never
re-greets), `BLACKJACK_BOT_MAX_GREETINGS` caps a run (default 5, 0 = off),
`BLACKJACK_BOT_MAX_GREETINGS_PER_DAY` caps a UTC day (default 20), and both count a failed send. A
registration held back by a cap or by short dealer funds is greeted later unless it is older than
`BLACKJACK_BOT_GREETING_MAX_AGE_MS` (default 24 h). When the dealer balance cannot cover its open
hands plus one greeting (stamp plus a 0.05 MON fee reserve) the greeting is skipped and logged; the
bot never crashes on it. `BLACKJACK_BOT_PROFILE_SINCE_MS` overrides where a first run starts
watching (default: now, so an old registry is not greeted). The cursor is persisted.

## Standalone testnet faucet (#316)

`yarn faucet` (`faucet-bot.livecheck.ts`, logic in `faucet-core.ts`) funds each newly registered
profile once with testnet MON. It needs no LLM key, no stamp pool and no identity: only
`MONAD_TESTNET_HTTP_RPC_URL`, `FRANK_NETWORK_TAG=MONT` and `E2E_DEMO_MAIN_WALLET_JSON`
(`{address, privateKey}` of a wallet holding testnet MON only). See the file header for every knob
(`FAUCET_AMOUNT_WEI` default 0.05 MON, hard ceiling 1 MON; `FAUCET_MAX_PER_RUN` 10;
`FAUCET_MAX_PER_DAY` 20 (max 1000); `FAUCET_MIN_RESERVE_WEI` 0.1 MON (minimum 0.01 MON);
`FAUCET_POLL_INTERVAL_MS` 4000 (min 1000); `FAUCET_STATE_DIR` default `~/.frank-faucet`, warns if under a
tmp dir). Invalid values fail startup with the variable name; nothing becomes NaN.

- once per address, durable: the exact signed transaction is persisted before broadcast; any
  record (signed/submitted/confirmed) blocks re-funding, across restarts and address casing. A
  crash mid-broadcast replays the same bytes on restart; it never re-signs.
- skips itself, `FRANK_BOT_PEER_DENYLIST`, self-declared bots (#311) and addresses that already
  hold at least the amount. Stops (without consuming the profile, so it is retried) at the per-run
  cap, the rolling 24h cap, or when the wallet would fall under the reserve.
- testnet only: refuses to start unless `FRANK_NETWORK_TAG=MONT` and the RPC reports chain id 10143.
- Do not also let Qwen fund: set `QWEN_BOT_FUND_VALUE_WEI=0` on the Qwen bot (it still greets).

- one wallet, one faucet: use a wallet dedicated to it. Do not share it with the Qwen bot's funding
  (`QWEN_BOT_FUND_VALUE_WEI=0`) or run a second faucet on a different state dir: concurrent senders
  reuse nonces and one kills the other's transfer. The faucet itself will not sign a new transfer
  while an earlier one is unsettled, and handles profiles one at a time.
- the wallet JSON holds a private key: `chmod 600` it (the faucet warns if group/others can read it).
- a profile that keeps failing (e.g. malformed address) is skipped and recorded after 3
  consecutive failures while the RPC is healthy, so it cannot block everyone behind it; an RPC
  outage never counts against a profile.

Stuck transfers. If the node rejects the exact-bytes replay (`already known`, `nonce too low`) the
faucet looks the receipt up by hash: mined settles the record, otherwise it waits and logs once.
If a record stays stuck (further funding is paused while any transfer is unsettled):

    yarn faucet --list-stuck          # signed / failed / skipped records with tx hashes
    yarn faucet --clear <address>     # DANGEROUS: lets the address be paid again

`--clear` is guarded because the record is the only thing preventing a second payment. It never
clears `submitted`/`confirmed` records; if `MONAD_TESTNET_HTTP_RPC_URL` is set it asks the node and
refuses any tx that is mined or in the mempool (or if the node cannot be asked). A `signed` record
may already have been broadcast (a timeout after the node accepted the tx looks identical), so it
additionally needs `--force --confirm-tx <txHash>` typed exactly, and prints a loud warning. A
`failed` record with a tx hash needs the same when no node lookup is available (a `failed` set
because the node did not know the tx may still land later). These
admin commands run before any other env validation and need only `FAUCET_STATE_DIR`.

A `submitted` transfer whose confirmation was never seen is re-checked by hash (5 min after its
(re)broadcast, at most every 5 min): a receipt settles it; a tx the node no longer knows is marked `failed` so it
shows in `--list-stuck`. It is never re-funded automatically.

Profiles with a malformed address (not `0x` + 40 hex, e.g. `abc`, `foo.eth`) are skipped up front,
without any RPC call, so they never stall the cursor. Skipping a profile after repeated failures ignores transient errors (timeouts, 5xx, rate limits):
malformed-address errors count 3 times; unclassified errors need 10 failures spread over 10 minutes.

Abuse limits (demo level): registration is free, so a sybil can mint addresses and collect the
amount per address until the daily cap (loss bounded to `maxPerDay * amount`, wallet floor kept by
the reserve). No captcha, no proof of humanity, no per-IP limit. The app's Receive page shows the
user's address and explains the faucet when the balance is a real zero.

## Bot profiles and curated defaults (#317)

Every bot registers a public profile on startup (`bot-directory.ts`): name (`Blackjack Dealer`,
`Raffle`, `Picture Shop`, `Qwen`), bio, a small generated identicon avatar (no third-party
artwork) and the `bot` marker. Registration is idempotent: it fetches the relay's copy first and
only PUTs when a field differs (a re-PUT would bump the registration timestamp and look like a new
signup to the greeter/faucet), so a bot registered before this change upgrades once.

To make the bots appear in a new user's Contacts, list them in the relay's curated defaults
(`GET /metadata/monad/curated-defaults`, the mechanism the app already reads):

    cd packages/bot
    yarn -s curated-defaults          # prints [[registry.curated_defaults]] TOML, address + name only
    # append the output to the relay config (see backend/docker/cashwebd.toml), restart the relay

Addresses come from each bot's own identity file (`*_BOT_IDENTITY_JSON`, same paths the bots use),
so they are per machine/network and nothing is hard-coded. The script is read-only: it never
creates an identity file, and if any are missing it prints every missing path and exits 1 (start
those bots once, or pass `--create-missing` to create them explicitly; the launcher, #312, should). The app shows the curated name immediately, then refreshes name/bio/avatar from the profile;
a registered profile whose display name is empty, whitespace or only invisible characters is
labelled with a short address, never "Loading...". No chat is opened automatically, and a default
the user deleted is not added back on later launches.

## Non-goals (per the ticket)

Production hardening, multi-user bot support, prompt/persona design polish, and a full
recipient-addressing fix to the wire format (ticket #37's noted follow-up).

## Stamp pool seed (#313)

Every stamp payment a bot sends comes from a single-use sub-account derived from an HD seed. The
seed used to be regenerated on each start, stranding whatever was left on those accounts. Now each
bot keeps it in its own state directory (`QWEN_BOT_STATE_DIR`, `BLACKJACK_BOT_STATE_DIR`,
`RAFFLE_BOT_STATE_DIR`, `VENDOR_BOT_STATE_DIR`). The default is per-user and persistent:
`~/.frank-bots/<bot>` (`$XDG_STATE_HOME/frank-bots/<bot>` when set). It used to be
`/tmp/<bot>-bot-state`; nothing is moved for you, so if that old directory exists and the new one
does not, the bot prints a notice naming both paths (move it, or point the variable at it). A state
directory under the system temp dir gets a warning at startup (a tmp cleaner would delete the seed).
The directory and the seed file must be owned by the bot's user and not writable by group/others,
or the bot refuses to start (another local user could otherwise plant a seed they know). The
directory's `stamp-pool-meta.json` marker records that pool records exist: a seed whose
`sub-account-pool/` or `change-pool/` directory has gone missing (or a marker that cannot be read)
is refused instead of restarting at index 0, which would reuse spent sub-accounts. If you accept
address reuse (or restored the seed without its records), delete `stamp-pool-meta.json` to
override. A relative `XDG_STATE_HOME` is ignored, and a state directory that cannot be resolved to
an absolute path (unset `HOME`, relative `*_BOT_STATE_DIR`) is a startup error.

- `stamp-pool-seed.json` -- the BIP-39 mnemonic, created on first start with mode `0600` (directory
  `0700`), loaded on every later start. It is never logged. It is a wallet secret: **never commit
  it**, and back it up if the bot holds real funds. A missing file means a new seed is created; an
  unreadable or invalid file is a startup error (the bot will not silently start a new pool and
  strand the old one).
- `sub-account-pool/`, `change-pool/` -- the pool's records (index, address, status; no keys), so a
  restart continues after the last spent sub-account instead of reusing one.

Recovering leftover funds: import the mnemonic into any BIP-44 wallet; sub-accounts are
`m/44'/60'/0'/0/<i>` and change accounts `m/44'/60'/0'/1/<i>`. Bots created before this change
simply gain a seed file on their next start; their identity and other state are untouched.

## Picture shop catalog (`vendor-bot.livecheck.ts`, #315)

The vendor bot sells pictures from a directory, not from code. `VENDOR_BOT_CATALOG_DIR` (default:
the bundled `demo-catalog/`, three generated original pictures with thumbnails) must contain:

```
manifest.json   {"items": [{"itemId": "sunrise", "description": "...", "priceWei": "50000000000000000",
                            "image": "sunrise.png", "thumbnail": "sunrise-thumb.png"}]}
sunrise.png     png / jpg / gif / webp, paths relative to the directory
```

`thumbnail` is optional (shown next to the entry in the app's catalog; max 64 KiB). The catalog is
validated once at startup and a bad one is a one-line error naming the item: unknown/duplicate ids,
bad prices, files outside the directory, non-image bytes, and any image (or the whole catalog
message) that would not fit the relay's 2 MiB request cap. To change the bundled art, edit and run
`yarn tsx scripts/generate-demo-pictures.ts`; to sell your own, point the variable at your directory.
