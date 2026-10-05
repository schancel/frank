# Local end-to-end stack

Two native relays (`cashwebd`), a local EVM chain, loopback HTTPS fronts, the production app build,
and two bots running as ordinary accounts (the Qwen chat bot and the blackjack bot), on one machine,
with no live network and no real funds.

Nobody approves or installs an account. Every account, a person's or a bot's, signs its own directory
entry and publishes it to its relay when it starts; any address with a published entry can be messaged.

```sh
node demo/local-stack/stack.mjs build        # cashwebd (one cargo slot), the app (one build per relay), Hardhat
node demo/local-stack/stack.mjs up           # everything from clean state, both bots running (about 30 s)
node demo/local-stack/stack.mjs chrome alice # a Chrome window with its own throwaway profile
node demo/local-stack/stack.mjs chrome bob   # a second person, side by side
node demo/local-stack/stack.mjs fund 0x<address on the app's Receive page>   # 5 local MON; "fund <address> 20" for more
node demo/local-stack/stack.mjs down         # stops everything and removes the Chrome profiles
```

`up [live|stub]`: `live` (default) answers with the Alibaba Cloud Qwen API (configured via
`~/.frank-demo-qwen.env`, override with `QWEN_ENV_FILE`); `stub` uses the Qwen bot's deterministic model.
`status` lists what is running and the two bot addresses.

## By hand

1. `up`, then `chrome alice`. Create the account. Messaging is on as soon as the account exists; there
   is no Settings step.
2. Open the Receive page, copy the address shown there and `fund` it. (The Wallet page shows the
   address other people message you at; the Receive page shows the account that holds money.)
3. The blackjack bot challenges every newly published account, so a chat with it appears by itself
   within a few seconds. Both bots are also in the contact book (Ctrl/Cmd+K), and `status` prints
   their addresses for Add Contact.
4. `chrome bob` for a second person; fund it too. In one window press + next to "Direct Messages",
   paste the address from the other window's Wallet page, Add, and write.
5. Blackjack with anyone: in a chat, the menu left of the message box → "Blackjack challenge". Pick
   "I deal" or "I play, they deal" and a maximum bet. The newest blackjack message in the chat shows
   the buttons for your next move. A dealer's app deals cards by itself while it is open and asks
   before it pays.

`chrome <name> b` opens the app that is built for relay-b (`https://127.0.0.1:18441`). An account
made there lives on relay-b. The relays do not yet copy entries to each other or forward messages, so
such an account cannot be found from relay-a and the reverse; the app refuses before anything is paid.

## Driven in real Chrome

```sh
node demo/local-stack/stack.mjs e2e [live|stub]   # up, then every step below, then down
node demo/local-stack/drive.cjs alice onboard     # one step at a time against a stack that is up
node demo/local-stack/drive.cjs alice send 0x<address> "text"
```

`drive.cjs` runs one headless Chrome at a time (`HEADFUL=1` to watch) with the same throwaway
profiles `chrome <name>` uses. Its header lists the steps: `onboard`, `send`, `expect`, `ask`,
`refused`, `challenge`, `play`. Each step checks the chain as well as the page: a stamp is paid from
single-use accounts the sender's own account funds first, so the driver reads which accounts belong
to whom from those funding transfers and adds up what each owner paid in stamps. Reports go to
`logs/drive-*.json`, screenshots to `shots/`.

## What runs where

| Piece | Address | Notes |
| --- | --- | --- |
| app | `https://127.0.0.1:18440` | production build that talks to relay-a |
| app-b | `https://127.0.0.1:18441` | the same build made for relay-b |
| relay-a | `https://127.0.0.1:18443` → `127.0.0.1:18098` | both bots live here |
| relay-b | `https://127.0.0.1:18444` → `127.0.0.1:18099` | |
| chain | `127.0.0.1:18546` (shim) → `127.0.0.1:18545` (Hardhat) | chain id 10143 |
| Qwen bot, blackjack bot | no port | ordinary accounts on relay-a; logs `qwen-bot.log`, `blackjack-bot.log` |

State, certificates, logs and Chrome profiles live in `/private/tmp/frank-stack/open`
(`FRANK_STACK_DIR`). `logs/wire.jsonl` holds every relay exchange outside `/chain-rpc/` with base64
bodies; `wire-report.mts` prints the canonical message exchanges part by part.

A relay's whole directory configuration is five lines naming itself (`[registry.directory]`:
network, relay id, relay key, endpoint, binding expiry). relay-a also lists the two bots as default
contacts (`[[registry.curated_defaults]]`); that is a suggestion list for new users, not a permission.

## Stand-ins

- **Chain**: Hardhat with Monad testnet's chain id and a pre-funded development account. The relay
  requires the protocol-pinned Monad testnet genesis hash from its upstream, so `chain-shim.mjs`
  substitutes that hash in block-zero responses and answers `eth_getRawTransactionByHash` (which
  Hardhat lacks) from the transactions it relayed. The chain keeps no state across `up`.
- **TLS**: a throwaway CA and one leaf per origin. Chrome is started with a dedicated profile and
  `--ignore-certificate-errors-spki-list` for exactly those keys; the system keychain is untouched.
  Node clients use `NODE_EXTRA_CA_CERTS`.
- **Relay identity keys**: each relay names a public point in its tuple; this relay build holds no
  identity key, so the launcher generates a point and discards the private half.
- **Bot secrets**: random and disposable, mode 0600, under `bots/`.
- **Money**: local MON from the development account. `up` gives the Qwen bot 5 and the blackjack bot 50.
