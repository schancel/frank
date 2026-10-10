# @frank/bot

Headless demo and qwen bot. It drives `@frank/wallet` against the relay. It
does not own chain codecs, encryption suites, or CashWeb CBOR layouts. Frames
belong to `@frank/codec` and `frank-cbor`. The live demo path still uses the
protobuf relay.

## One-command demo (`yarn demo`)

Starts the whole demo stack on **Monad testnet**, waits until it is ready, and stops everything on
Ctrl-C. There is one mode: a real chain. Nothing in this repository simulates a chain.

```sh
yarn demo                   # Monad testnet, using your .env (below)
```

Run it from the repo root (or packages/bot). `yarn demo` runs `node --import tsx
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

What it does, in order: creates any missing bot identity (under one state directory, default
`~/.frank-demo`), checks on chain that the funding wallet can fund the bots (if it cannot, it says
how much is missing and starts nothing), starts the local relay through
`backend/cashweb/run-local-monad.sh` (the first run builds it with Cargo; or set `CASHWEBD_BIN` to
a prebuilt `cashwebd-exe`), then **one bot process** (`targets/all-bots.ts`) that runs every bot on
one bot host: blackjack dealer, raffle, picture shop, Qwen (the live model; the offline stub only
with `QWEN_BOT_MODE=stub`), faucet, lobby, RPS and dice. It prints every bot
address, the app URL and the exact command to start the app, then waits. Logs are in
`<state dir>/logs/` (`relay.log`, `bots.log`; each bot's lines start with `[<bot>]`). Missing
prerequisites (Node, `bash`, `cargo` or `CASHWEBD_BIN`, a busy port, an absent RPC URL or wallet
file) each print one line, never a stack trace.

**One funding wallet, one process.** `E2E_DEMO_MAIN_WALLET_JSON` is the only wallet. The single bot
host is its only user, so there is one nonce counter: the host funds each bot's two accounts (its
identity address and the account it pays stamps from) one after the other while registering it, and
the faucet pays new profiles from the same wallet. Each bot still has its own key and state under
`<state dir>/bot-host/bots/<bot>/`. After the bots are up the launcher reads every bot account's
balance from the chain: a bot that failed to start (the Qwen bot without its model settings, for
example), or holds less than 0.1 MON in either account,
is printed as an error naming the bot (`DEMO BOT ERRORS`, repeated in the summary), and the other
bots keep running. `all N bots funded and registered` is printed only when every one is.

**What a start costs, and the limit on it.** The bot host refills a bot's transfer account to
0.5 MON when it holds less than 0.3 and its stamp account to 0.5 MON when it holds less than 0.1
(the faucet has no transfer account to fund), so a first start on a new state directory draws close
to 1 MON per bot from the funding wallet; later starts on the same state directory draw only what
the bots have spent. Before anything starts the launcher works the draw out from chain balances
(transfers plus gas) and **refuses a start that would draw more than 1 MON**
(`FRANK_DEMO_MAX_START_DRAW_WEI`), saying exactly how much and from which address. Pass
`--allow-draw` (or raise the variable) to permit it. It also refuses when the wallet cannot cover
the draw plus the 0.1 MON reserve the host keeps in it. A bot's key, and so whatever its accounts
hold, lives in the state directory: do not start on a new one, or delete one, as a quick fix. When
a start funds bot accounts it says how much it places in the state directory; `yarn demo:sweep
<state dir> --send` returns a finished demo state's funds to the funding wallet (see below).

Source builds also need a usable native `protoc` (libprotoc 3+ with proto3 support). The relay
launcher validates `PROTOC` when set; otherwise it searches PATH, then the installed `protoc`
npm package's native compiler. It skips npm's CLI wrapper, which can have a CRLF shebang.
If the npm native payload is absent (for example after an install without postinstall scripts),
install a native compiler or set `PROTOC='/path with spaces/protoc'`. An invalid override fails
before Cargo; the launcher never downloads tools or edits dependencies. A prebuilt `CASHWEBD_BIN`
needs no compiler. This temporary build resolver goes away with the remaining prost inputs
(#130/#132).

**The app** (started by you, in another terminal, from the repo root) must be given the relay, the
chain and the burn address. The launcher prints the exact command:

```sh
cd app && QCLI_MONAD_RELAY_BASE_URL=http://127.0.0.1:8098 QCLI_MONAD_RPC_CHAIN=monad-testnet \
  QCLI_MONAD_STAMP_BURN_ADDRESS=0x000000000000000000000000000000000000dEaD QCLI_CASHWEB_STAMP_MIN_BURN_VALUE_WEI=1000000000000 \
  yarn dev:browser
```

(the port follows `FRANK_DEMO_RELAY_PORT`) and the app is at
**http://localhost:8080**, the fixed dev-server port from `app/quasar.config.js`. The relay sends
`Access-Control-Allow-Origin: *` and answers preflights. The browser reaches only
the relay's `/chain-rpc/monad-testnet/rpc` route; the upstream RPC address remains process-owned
relay configuration and is never embedded in the app.

**Burn address**: the relay's forum routes (topic posts and votes) return HTTP 500 without
`MONAD_STAMP_BURN_ADDRESS`. The launcher passes one value (default the well-known
`0x...dEaD` burn address, override with `MONAD_STAMP_BURN_ADDRESS`) to the relay, every bot and the
app command above, so the three always agree. `run-local-monad.sh` also warns loudly at start when
it is missing.

**Faucet amount**: the default is a small 0.05 MON per new profile (real testnet funds), which is
NOT enough for a blackjack hand (0.07 MON: 0.01 table minimum + 0.01 default stamp + the app's 0.05
MON fee reserve): set `FAUCET_AMOUNT_WEI` (up to 1 MON) if you want players to play, and the
summary warns when it is too low. Each profile is granted once; the testnet-only guards are unchanged.

**Raffle rounds**: the demo uses 5 entrants per round (`RAFFLE_BOT_MAX_ENTRIES`; the bot's own
default is unchanged). Set it to a smaller number for a quicker round.

### How the game and shop bots take and pay money

One rule for dice, rock-paper-scissors, raffle and the picture shop (`src/bots/money.ts`):

- **What a message paid is what is on chain.** A stake, an entry price or a purchase price is the
  value paid with the message that asks for it. The bot looks up every transfer the wallet reported
  with that message and counts it only if it is mined, succeeded and is the transfer described; a
  transfer pays for one message only. An amount typed in chat is never money. A message that paid
  too little gets a refusal and what it did pay back.
- **A payout is the value of the bot's own message.** The result, pot or refund is written down in
  the bot's state before it is sent and is sent, one at a time, until it has gone. Each has one
  message ID for good and the wallet never makes a second attempt for an ID, so a retry or a restart
  does not pay twice. What could not be sent is tried again every 10 seconds and at start.

- **Sent means delivered.** An owed message counts as sent only when the wallet says it was
  delivered. One the wallet is still delivering stays owed. One the relay ended is kept as FAILED,
  logged at error level with the bot, recipient and amount, and never announced.
- **A paid message is written down first.** Before its payment is even looked up, a message that
  came with money is recorded; the record goes only with the write that settles it. One left over
  (a crash or an error while handling it) is refunded at the next start or within seconds.
- **Paying too much.** Anything paid above a stated stake, the entry price or the item price comes
  back with the bot's answer. Dice and rock-paper-scissors refuse (and refund) a bet the bank
  cannot cover.
- **Operator tool.** With the bot stopped: `yarn tsx outbox-admin.livecheck.ts <host state dir>
  <bot id> list` shows what is owed, pending and failed; `... retry <id> --i-checked-the-chain`
  sends a failed message again as a new one.

**Raffle.** An entry is a confirmed payment of the entry price; the entry "transaction" in the draw
is that payment's hash. When the round fills the winner is fixed and owed the pot (`entry price x
entrants`); the other entrants are told, and the next round opens, only once the winner's message
has gone out. Until then the round stays `drawing` and further entries are refused and refunded.

The launcher keeps the bot's default entry price and sets the round size from the
`RAFFLE_BOT_MAX_ENTRIES` row above (the demo runs 5 entrants); the bot's own default is also 5.

The launcher sets every bot's state directory explicitly, under `<state dir>/bots/<bot>/state`
(and identities under `<state dir>/bots/<bot>/identity.json`). Bots started on their own with
`yarn bot`, `yarn blackjack`, ... default to `~/.frank-bots/<bot>` (`$XDG_STATE_HOME/frank-bots/<bot>`
when set) instead of `/tmp`; see "Stamp pool seed".

Per-bot commands also exist: `yarn bot` (Qwen), `yarn blackjack`, `yarn raffle`, `yarn vendor`,
`yarn faucet`.

**Configuration** comes only from environment variables and a `.env` file that you provide
(`FRANK_DEMO_ENV_FILE`, default `<repo>/.env`, gitignored, `KEY=value` lines). The launcher reads
just the variables in the table below and passes each child only the ones it needs; the process
environment wins over the file. A relative wallet-file path written in the env file
(`E2E_DEMO_MAIN_WALLET_JSON`, `FRANK_TEST_WALLET_JSON`) is relative to that file, so the repo's
`.env` works from any directory or worktree; one given in the environment is relative to where
the command was typed. The launcher reads only the address of the wallet file
(`E2E_DEMO_MAIN_WALLET_JSON`); its key is read by the bot process. RPC URLs and keys are never
printed.

**Checks against the real stack** (each is one command from the repo root, exits non-zero on any
failure, and spends real testnet funds from `FRANK_TEST_WALLET_JSON`, a second funded testnet
wallet; nothing but the bot host may send from `E2E_DEMO_MAIN_WALLET_JSON` while a demo runs):

- `yarn test:two-wallets`: starts the real relay binary, opens two wallets (kept and reused
  between runs in `~/.frank-real-stack`; each is given 0.012 MON only when it has run dry), sends
  a stamped message each way and checks every reported stamp payment on chain (mined, right
  destination and amount). `FRANK_REAL_STACK_RELAY_URL` uses a relay that is already running.
- `yarn demo:smoke`: starts exactly what `yarn demo` starts (same `.env`, state directory and
  draw limit; stop a running demo first), then one persistent test user with a real wallet
  messages Qwen, the picture shop, the raffle, the dealer, dice and rock-paper-scissors and each
  reply is checked for its content; the faucet's payment to that profile is read from the chain;
  the relay's proxied chain RPC and its CORS headers are checked. Before its prompts the user is
  topped up to 0.012 MON per prompt (0.072 MON for the six), which a run mostly spends: the wallet
  pays each message from a single-use account funded with a fee reserve of just under 0.01 MON. The three game bots must each answer with a free message that opens a game: the
  dealer's `blackjack-hand` challenge (game ID, dealer role, seed commitment, and a text naming
  the table's bet limits), the dice `table` (roll ID and the commitment to its secret, the secret
  itself absent) and the rock-paper-scissors `start` (match ID and the commitment to the bot's
  move, the move absent), each with the table limit named in its text. No bet is placed:
  `real-games.livecheck.ts` plays for money.
- `node app/test/autonomous-fullstack-e2e.mjs`: the browser run, against a running `yarn demo`
  (see the header of that file). Its account lives in a persistent Chrome profile,
  `~/.frank-e2e-browser/autonomous-fullstack-e2e` (`E2E_PROFILE_DIR`): created on the first run,
  reused afterwards, funded (0.2 MON, `E2E_FUND_MON`) only when it holds less than 0.1 MON. Its
  native-send scenario pays the test wallet, and at the end what the account holds above 0.15 MON
  (`E2E_FLOAT_MON`) is sent back to the test wallet through the app's send page; anything not sent
  stays in the account for the next run. The last line names the account and its balance.
  `app/test/swap-browser.livecheck.mjs` keeps its account the same way in
  `~/.frank-e2e-browser/swap-browser`. Never delete these profiles: the account's keys are only
  there.

Every one of these refuses to fund anything without `FRANK_TEST_WALLET_JSON`, and one funding
transfer is at most 0.5 MON (`FRANK_TEST_MAX_FUND_WEI`).

The harness these use is `packages/bot/demo/real-stack.ts` (`startRealStack`, `openWallet`, `fund`,
`sweep`, `stop`): real relay, real chain, real wallets, for any other test that needs them. A
script that funds a wallet calls `stack.sweep()` in a `finally`, before `stop()`:
`test:two-wallets` and `real-games.livecheck.ts` do, pass or fail, and print one line for every
account the sweep left money in and why (dust under twice the transfer fee, a failed or reverted
transfer). The smoke's test user is deliberately persistent and is not swept.

**Where the test money is, and getting it back.** Every demo start, harness run and livecheck
puts testnet MON in accounts whose keys exist only in a state directory. Two commands read those
directories with the wallet's own derivation (main account, identity, single-use sender accounts
whatever their state, change accounts) and the chain:

- `yarn --cwd packages/bot funds:report [dir ...]`: per directory, the wallets found, what each
  account holds, what is worth moving, what is dust and what has no key left. With no directory
  it looks at `~/.frank-*` and the `frank-*` directories of the temp directory. Read-only.
- `yarn --cwd packages/bot funds:sweep <dir ...>`: a dry run of sending it back;
  `--send` does it. One transfer per account, one at a time, each waited for, to the address of
  the funding wallet (`E2E_DEMO_MAIN_WALLET_JSON`; only its address is read); every transfer is
  appended to a log file (`--log <file>`, otherwise a file in the temp directory that the last
  line names). An account under twice the transfer fee (21,000 gas at the node's gas price,
  about 0.0021 MON) is left as dust. It refuses a directory a running process has open, and a
  demo state directory unless asked through `yarn demo:sweep`. It never writes to a state
  directory (pool records are read from a temporary copy) and never prints a key.
- `yarn demo:sweep <demo state dir> [--send]` (repo root): the same for a demo's bots, for a
  demo state that is finished with. A stop does NOT sweep: the bots are meant to stay funded
  between runs. When a start funds bot accounts the launcher prints how much it places in the
  state directory and this command.

State kept under a temp directory is gone after a reboot, and its money with it: keep state
directories under the home directory. Until the unmerged `wallet-parallel-send` branch lands (a
send then funds nothing ahead), every message is paid from a single-use sender account that is
funded with a fee reserve, and the part the fee did not use (about 0.002 to 0.005 MON) stays in
the spent account; `funds:sweep` collects those that are above cost, the rest is dust.

**Checks on a local regtest network** (no funds, no `.env`, nothing outside this machine; the
first run downloads the eCash node into the git-ignored `.regtest-cache/` and checks its SHA-256):

- `yarn --cwd packages/bot regtest:check`: starts a Bitcoin ABC node with Chronik in regtest mode
  and the real relay binary pointed at it as `xec-regtest`, then checks the faucet, the block
  driver, the relay's Chronik proxy and that everything stops and frees its ports.
- `yarn --cwd packages/bot regtest:ecash-send`: on the same stack, two eCash wallets opened
  through the relay pay each other and each payment is read back from the node; then the wallet
  package's funded send check (`packages/wallet/utxo-funded-send.livecheck.ts`) runs on
  `xec-regtest`, funded from the node's faucet.

The harness is `packages/bot/demo/regtest/regtest-stack.ts`: `startRegtestStack()` returns
`relayUrl`, `chains['xec-regtest']` (`checkpoint`, `fund`, `mine`, `stop`) and `stop`. Blocks
arrive every 3 seconds on their own and at once from `mine()`. `ecash-send.livecheck.ts` exports
both send checks (`ecashWalletsPayEachOther(stack)`, `walletFundedSendCheck(stack)`) for scripts
that start their own stack. How a regtest network proves its identity is in
`docs/protocol/chains/README.md`.

#### Variables

| Variable                           | Applies to       | Default                                            | Meaning                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------- | ---------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FRANK_DEMO_ENV_FILE`              | launcher         | <repo>/.env if it exists                           | Path of the .env file to read (KEY=value lines). The process environment wins over the file. Never committed; you provide it.                                                                                                                                                                                                                                     |
| `FRANK_DEMO_STATE_DIR`             | launcher         | ~/.frank-demo                                      | One directory holding every bot identity, bot state, the relay database and the logs. Reused across runs.                                                                                                                                                                                                                                                         |
| `FRANK_DEMO_RELAY_PORT`            | relay            | 8098                                               | Port the local relay listens on (127.0.0.1).                                                                                                                                                                                                                                                                                                                      |
| `FRANK_DEMO_RELAY_DB_PATH`         | relay            | <state dir>/relay/registry.rocksdb                 | Where the relay keeps its database. Set it to start the relay on a fresh database without touching the one in the state directory (a relay refuses a database written by an earlier build).                                                                                                                                                                       |
| `FRANK_DEMO_NGROK`                 | launcher         | 0                                                  | Set to 1 (same as the --ngrok flag) to automatically expose the demo stack via local ngrok tunnels.                                                                                                                                                                                                                                                               |
| `FRANK_DEMO_NGROK_BIN`             | launcher         | ngrok                                              | Executable name or path for the ngrok CLI.                                                                                                                                                                                                                                                                                                                        |
| `FRANK_DEMO_NGROK_CONFIG`          | launcher         | unset                                              | Path to an existing ngrok configuration file to merge with the demo tunnels.                                                                                                                                                                                                                                                                                      |
| `FRANK_DEMO_NGROK_RELAY_DOMAIN`    | launcher         | unset                                              | Domain or hostname for the ngrok relay tunnel (e.g. relay-subdomain.ngrok-free.app).                                                                                                                                                                                                                                                                              |
| `FRANK_DEMO_NGROK_APP_DOMAIN`      | launcher         | unset                                              | Domain or hostname for the ngrok app tunnel (e.g. app-subdomain.ngrok-free.app).                                                                                                                                                                                                                                                                                  |
| `FRANK_DEMO_PUBLIC_RELAY_URL`      | relay, app       | unset = http://127.0.0.1:<port>                    | Public base URL of the relay. If unset and FRANK_DEMO_NGROK=1, auto-discovered from ngrok. When set, the app connects to this URL instead of loopback.                                                                                                                                                                                                            |
| `FRANK_DEMO_PUBLIC_APP_URL`        | app              | unset = http://localhost:<port>                    | Public URL of the frontend app. If unset and FRANK_DEMO_NGROK=1, auto-discovered from ngrok.                                                                                                                                                                                                                                                                      |
| `NGROK_AUTHTOKEN`                  | launcher         | unset                                              | ngrok authtoken; only needed if not already configured in your local ngrok configuration. Secret: never printed.                                                                                                                                                                                                                                                  |
| `CASHWEBD_BIN`                     | relay            | built with Cargo                                   | Path of a prebuilt cashwebd-exe; skips the Cargo build in run-local-monad.sh.                                                                                                                                                                                                                                                                                     |
| `PROTOC`                           | relay build      | auto-detected                                      | Native protoc executable path (libprotoc 3+); an invalid override fails before Cargo. Otherwise tries PATH, then the installed npm native compiler. Ignored with CASHWEBD_BIN.                                                                                                                                                                                    |
| `CARGO`                            | relay build      | cargo                                              | Toolchain variables (also CARGO_HOME, CARGO_TARGET_DIR, RUSTUP_HOME, RUSTUP_TOOLCHAIN) are passed to the relay build only when set. Ignored with CASHWEBD_BIN.                                                                                                                                                                                                    |
| `CARGO_HOME`                       | relay build      | unset                                              | See CARGO.                                                                                                                                                                                                                                                                                                                                                        |
| `CARGO_TARGET_DIR`                 | relay build      | unset                                              | See CARGO. Point it at a scratch directory to keep the build out of the repo tree.                                                                                                                                                                                                                                                                                |
| `RUSTUP_HOME`                      | relay build      | unset                                              | See CARGO.                                                                                                                                                                                                                                                                                                                                                        |
| `RUSTUP_TOOLCHAIN`                 | relay build      | unset                                              | See CARGO.                                                                                                                                                                                                                                                                                                                                                        |
| `MONAD_TESTNET_HTTP_RPC_URL`       | chain            | required                                           | Monad TESTNET JSON-RPC URL (chain id 10143), or several separated by commas (the relay and the bots use the first that answers; a tool given the whole value as one URL gets an authentication error). May embed an API key. Secret: never printed.                                                                                                               |
| `MONAD_TESTNET_WS_RPC_URL`         | chain            | optional                                           | Monad TESTNET WebSocket JSON-RPC URL used by the relay proxy. May embed an API key. Secret: never printed.                                                                                                                                                                                                                                                        |
| `XEC_TESTNET_CHRONIK_URL`          | relay            | https://chronik-testnet.fabien.cash                | Chronik indexer HTTP URL for XEC testnet relay proxying. Secret: never printed.                                                                                                                                                                                                                                                                                   |
| `SOLANA_DEVNET_HTTP_RPC_URL`       | relay            | https://api.devnet.solana.com                      | Solana devnet JSON-RPC HTTP URL used by the relay proxy. Secret: never printed.                                                                                                                                                                                                                                                                                   |
| `FRANK_NETWORK_TAG`                | chain            | MONT                                               | Network tag the relay and bots stamp messages with (MONT = Monad testnet).                                                                                                                                                                                                                                                                                        |
| `MONAD_STAMP_BURN_ADDRESS`         | relay, bots, app | 0x000000000000000000000000000000000000dEaD         | Burn address of stamps and topic votes (0x + 40 hex). Passed to the relay (without it every forum post and vote fails with HTTP 500), to the bots, and printed in the app command as QCLI_MONAD_STAMP_BURN_ADDRESS: all three must agree. The default is the well-known 0x...dEaD burn address.                                                                   |
| `CASHWEB_STAMP_MIN_BURN_VALUE_WEI` | relay            | 1000000000000                                      | Minimum wei a message stamp must pay (0.000001 MON).                                                                                                                                                                                                                                                                                                              |
| `FRANK_DM_DEFAULT_STAMP_VALUE_WEI` | bots             | 10000000000000000                                  | Default stamp value bots pay per message (0.01 MON).                                                                                                                                                                                                                                                                                                              |
| `E2E_DEMO_MAIN_WALLET_JSON`        | wallet           | required                                           | Path of a JSON file {"address","privateKey"} of a funded TESTNET wallet. It is the ONE funding wallet of the demo: the single bot process funds every bot from it and the faucet pays new profiles from it, so there is one source of nonces. The launcher reads only its address (to check balances). chmod 600. Secret: never printed.                          |
| `FRANK_TEST_WALLET_JSON`           | checks           | required for yarn demo:smoke and the browser check | Path of a SECOND funded testnet wallet file, used only by the checks that run beside a demo (they lend a test user a little MON). It must not be E2E_DEMO_MAIN_WALLET_JSON: the bot host counts that wallet's nonces in memory, so a transfer sent from it by another process makes the host's next payment fail. Never given to the bots. Secret: never printed. |
| `FRANK_DEMO_NO_FAUCET`             | faucet           | 0                                                  | Set to 1 to run without the faucet.                                                                                                                                                                                                                                                                                                                               |
| `QWEN_API_KEY`                     | qwen             | required unless QWEN_BOT_MODE=stub                 | Key of the model provider. Without it (and without an explicit stub) the Qwen bot fails to start, is reported by name, and the other bots run. Secret: never printed.                                                                                                                                                                                             |
| `QWEN_OPENAI_COMPATIBLE_ENDPOINT`  | qwen             | required unless QWEN_BOT_MODE=stub                 | OpenAI-compatible base URL of the model provider.                                                                                                                                                                                                                                                                                                                 |
| `QWEN_MODEL`                       | qwen             | qwen3.8-max                                        | Model name.                                                                                                                                                                                                                                                                                                                                                       |
| `QWEN_BOT_MODE`                    | qwen             | live                                               | Set to "stub" to ask for the offline stub explicitly (its replies say so). Never chosen for you.                                                                                                                                                                                                                                                                  |
| `QWEN_MODEL_TIMEOUT_MS`            | qwen             | 45000                                              | How long one model call may take.                                                                                                                                                                                                                                                                                                                                 |
| `QWEN_MODEL_TRIES`                 | qwen             | 3                                                  | Model calls tried for one message before the user is told it failed.                                                                                                                                                                                                                                                                                              |
| `QWEN_ENABLE_THINKING`             | qwen             | 0                                                  | Set to 1 to turn the model's thinking on (slower replies).                                                                                                                                                                                                                                                                                                        |
| `QWEN_SYSTEM_PROMPT`               | qwen             | the bot's own                                      | Replaces the system prompt the bot sends the model.                                                                                                                                                                                                                                                                                                               |
| `FRANK_BOT_TOP_UP_BELOW_WEI`       | bots             | host default (300000000000000000, 0.3 MON)         | The bot host refills the account a bot pays transfers and payouts from when it holds less than this. Passed on only when set.                                                                                                                                                                                                                                     |
| `FRANK_BOT_TOP_UP_TO_WEI`          | bots             | host default (500000000000000000, 0.5 MON)         | What that account is refilled to, from the funding wallet. Passed on only when set.                                                                                                                                                                                                                                                                               |
| `FRANK_DEMO_MAX_START_DRAW_WEI`    | launcher         | 1000000000000000000 (1 MON)                        | The most one start may draw from the funding wallet to fund bot accounts (their refills plus gas), worked out from chain balances before anything starts. A start that would draw more is refused with the exact amount. Raise it, or pass --allow-draw, to permit a first start on a new state directory (which funds every bot from nothing).                   |
| `RAFFLE_BOT_ENTRY_PRICE_WEI`       | raffle           | 20000000000000000                                  | Raffle entry price (0.02 MON).                                                                                                                                                                                                                                                                                                                                    |
| `RAFFLE_BOT_MAX_ENTRIES`           | raffle           | 5                                                  | Entrants per round. The demo default is 5 (the bot's own default is unchanged); use a smaller number for a quick round.                                                                                                                                                                                                                                           |
| `BLACKJACK_BOT_MIN_WAGER_WEI`      | blackjack        | bot default (0.01 MON)                             | Table minimum.                                                                                                                                                                                                                                                                                                                                                    |
| `BLACKJACK_BOT_MAX_WAGER_WEI`      | blackjack        | bot default (1 MON)                                | Table maximum.                                                                                                                                                                                                                                                                                                                                                    |
| `VENDOR_BOT_CATALOG_DIR`           | picture shop     | bundled demo-catalog/                              | Directory with manifest.json and image files the shop sells.                                                                                                                                                                                                                                                                                                      |
| `FAUCET_AMOUNT_WEI`                | faucet           | 50000000000000000 (0.05 MON)                       | MON sent to each new profile. The 0.05 MON default is small on purpose and is NOT enough for a blackjack hand (0.07 MON minimum: 0.01 bet + 0.01 stamp + 0.05 fee reserve); raise it (ceiling 1 MON) if you want players to be able to play. Each profile is granted once.                                                                                        |
| `FAUCET_MIN_RESERVE_WEI`           | faucet           | 100000000000000000                                 | The faucet stops paying when the funding wallet would drop below this balance.                                                                                                                                                                                                                                                                                    |
| `FRANK_BOT_PEER_DENYLIST`          | bots             | empty                                              | Comma-separated addresses no bot engages.                                                                                                                                                                                                                                                                                                                         |
| `FRANK_BOT_MAX_REPLIES_PER_PEER`   | bots             | 20; 300 for the game bots                          | Replies a hosted bot sends to one account per hour; past that it stops answering that account and tells it so once. Setting it overrides every bot, the game bots included. 0 means never reply.                                                                                                                                                                  |

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

A child that dies after startup is not restarted: a banner names it and its log, and the
summary is marked UNHEALTHY. If the relay dies the launcher stops everything and exits non-zero.

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
 (a wallet: the app, `yarn demo:smoke`) (real HTTP server, real Monad RPC)   (qwen-bot.livecheck.ts)
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
- `monad-mailbox-client.ts` — the authenticated mailbox client (`POST /message/auth/:me`
  challenge, identity-key signature, then `GET /message/inbox/:me` or `/message/mailbox/:me` with
  cursor paging). Bots read through the wallet's own message path, which uses it.
- `qwen-client.ts` — Qwen 3.8 Max streaming chat client (SSE, hand-parsed; the endpoint rejects
  non-streaming requests — see "Qwen API notes" below).
- `qwen-bot-common.ts` — shared identity/funding/sub-account-pool setup for both scripts below,
  including a nonce-race retry wrapper (see "Problems found and fixed" below).

Runnable entry points (`.livecheck.ts`, this app's existing convention for scripts that hit the
real network — excluded from `jest`'s `testMatch`, meant to be run manually):

- `qwen-bot.livecheck.ts` — the agent itself.

The "human" side of a live conversation is a wallet: the app, or the smoke user of
`yarn demo:smoke`, which sends each bot a real message and checks its reply.

## How the recipient-filtering gap was solved for this demo

> **Historical (pre-PR #197).** The relay now serves each recipient only its own inbox behind a
> signed challenge, so bots read their own mailbox through the wallet's message path and no
> longer download the global feed. The envelope's `to` check below is retained as
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
yarn bot   # keeps running until stopped
```

### How the Qwen bot answers

The Qwen bot is one implementation: `src/bots/qwen-bot.ts`, run by `FrankBotHost`
(`@frank/bot-framework`) from `qwen-bot.livecheck.ts`. An earlier stand-alone command-line bot
with its own state store and workflows was removed.

Every message ends in exactly one reply: the model's answer, or a short plain failure reply
("Sorry, I couldn't answer that just now. Please send it again.").

- **Model call.** One call has a time limit for the whole answer and is aborted when the bot
  stops. A failed call (an error, a timeout, an empty answer) is made again a bounded number of
  times, a second or two apart; then the user gets the failure reply. Thinking is off by default.
- **Delivery.** The answer is stored before it is first sent, and the host sends it on every poll
  (3 s) until it is delivered, also after a restart. Every send of one reply carries the same
  message identity, and the wallet pays at most once per identity, so a resend finishes the first
  attempt and never pays twice. A send refused before the wallet recorded a payment, such as a
  wallet with no funds, paid nothing and is simply repeated once it can succeed. A reply that is
  still undelivered after an hour is given up with an error log naming the peer and message.
- **Order.** Replies to one conversation go out in order; nothing else waits. There is no reply
  limit for a person and no limit on how many messages the bot has taken. Only a peer whose own
  profile says it is a bot is cut off after its hourly budget, so two bots cannot answer each
  other for ever.
- **Memory.** The last ten exchanges of a conversation are stored in the bot's state and sent
  with the next prompt. A conversation is its conversation ID; a message with none belongs to
  the default thread with that peer.
- **Funding.** When the shared funding wallet is configured, the host tops the bot's account up
  on the poll whenever it holds under 0.1 MON: one top-up at a time, and none for five minutes
  after one went out.

| Variable                          | Default        | Meaning                                                                 |
| --------------------------------- | -------------- | ----------------------------------------------------------------------- |
| `QWEN_BOT_MODE`                   | `live`         | `live` calls the model; `stub` answers offline with labelled replies.   |
| `QWEN_API_KEY`                    | required, live | Model provider key. Missing in live mode: the bot refuses to start.     |
| `QWEN_OPENAI_COMPATIBLE_ENDPOINT` | required, live | OpenAI-compatible base URL. Missing in live mode: refuses to start.     |
| `QWEN_MODEL`                      | `qwen3.8-max`  | Model name.                                                             |
| `QWEN_MODEL_TIMEOUT_MS`           | `45000`        | Limit for one whole model answer.                                       |
| `QWEN_MODEL_TRIES`                | `3`            | Model calls for one message before the failure reply.                   |
| `QWEN_ENABLE_THINKING`            | `0`            | `1` lets the model reason at length first; slower by seconds or more.   |
| `QWEN_SYSTEM_PROMPT`              | built in       | Replaces the system prompt (`DEFAULT_SYSTEM_PROMPT` in `qwen-reply.ts`). |

```sh
QWEN_BOT_MODE=stub yarn bot   # still needs the relay/RPC/wallet env, but no Qwen key
yarn workspace @frank/bot test --runInBand qwen-host-safety qwen-client qwen-reply src/bots/qwen-bot
```

## Auto-greet / auto-fund new signups (ticket #77)

Alongside its Qwen-reply behavior, `qwen-bot.livecheck.ts` also polls the live
`GET /metadata/monad?since=<t>` route (ticket #75, via `fetchMonadProfilesSince`,
`@frank/wallet/monad-identity`) for newly-registered Monad profiles. For each one seen after the
bot's own startup (never itself), it sends a real greeting DM (the same stamped-message path used
for Qwen replies) and funds the new
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

### Blackjack dealer

The dealer (`src/bots/blackjack-bot.ts`) plays the peer-to-peer hand of
`docs/protocol/blackjack-p2p.md`, the same state machine the app folds to work out every card. It
offers each new profile, and anyone who writes to it, a hand (table limits from
`BLACKJACK_BOT_MIN_WAGER_WEI` / `BLACKJACK_BOT_MAX_WAGER_WEI`). A bet is counted at what its message
is confirmed, on chain, to have paid; a payout or refund is the value of the dealer's own message,
written down before it is sent and sent once (see "How the game and shop bots take and pay money").

## Testnet faucet

`yarn faucet` (`faucet-bot.livecheck.ts`, logic in `src/bots/faucet-bot.ts`) grants each profile
testnet MON once: when it registers, or when it writes to the faucet. Settings, all enforced:
`FAUCET_AMOUNT_WEI` (default 0.05 MON; more than 1 MON is refused at start) and
`FAUCET_MIN_RESERVE_WEI` (default 0.1 MON; the faucet wallet is never taken below it). There is no
daily or per-run cap.

A grant is recorded before its transfer is sent, and transfers leave the funding wallet one at a
time. A record left unfinished by a crash counts as granted only if the address holds the grant.

**Where the grant goes.** To the profile's own address: the only address of a user that a sender
can learn. An account whose wallet spends from a separate receive address sees that money as
"cordoned" in the app and cannot spend it. Nothing a profile, a directory entry or a message
carries names the receive address, so the faucet cannot pay it; fixing that is wallet or directory
work, not the faucet's.

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
