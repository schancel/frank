# Local end-to-end stack

Two native relays (`cashwebd`), a local EVM chain, loopback HTTPS fronts, the production app build
and the Qwen bot, on one machine, with no live network and no real funds.

```sh
node demo/local-stack/stack.mjs build     # cashwebd (one cargo slot), two workspace packages, the app, Hardhat
node demo/local-stack/stack.mjs e2e       # everything from clean state, browser steps in headless Chrome (~1 min)
node demo/local-stack/stack.mjs chrome driven   # open the account "e2e" created, in a real Chrome window
node demo/local-stack/stack.mjs down
```

`e2e [live|stub] ["message"]` runs: `up` → onboarding and public export in Chrome → bot export →
operator `approve` and install into both relays → fund and start the bot → "Check installation" →
fund the account → Add Contact → send → wait for the reply. `live` uses the local Ollama model
(`qwen2.5:7b` at `127.0.0.1:11434`, override with `QWEN_MODEL`); `stub` uses the bot's deterministic model.

## By hand, in your own Chrome window

```sh
node demo/local-stack/stack.mjs up
node demo/local-stack/stack.mjs chrome          # empty throwaway profile that trusts only this stack
#   create the account; Settings -> Networking -> "Export public directory evidence"; download the file
node demo/local-stack/stack.mjs provision ~/Downloads/frank-ui-public-export.json
#   open the Receive page and copy the address shown there (not the one on the Wallet page)
node demo/local-stack/stack.mjs fund 0x<receive address>
#   Settings -> Networking -> "Check installation"; Add Contact with the bot address shown; chat
node demo/local-stack/stack.mjs down
```

Everything must happen within one hour of `up`: the bootstrap policy is valid for at most 3600 s
and the installation cannot be renewed for the same account. Start again with `up` (it wipes all
state, about 20 s to a provisioned stack).

## What runs where

| Piece | Address | Notes |
| --- | --- | --- |
| app | `https://127.0.0.1:18440` | `app/dist/spa` plus the operator's `directory/` files |
| relay-a (home relay) | `https://127.0.0.1:18443` → `127.0.0.1:18098` | |
| relay-b | `https://127.0.0.1:18444` → `127.0.0.1:18099` | installed and reporting; nothing is homed on it |
| bot status | `https://127.0.0.1:18445` → `127.0.0.1:18097` | answers 502 until the bot runs |
| chain | `127.0.0.1:18546` (shim) → `127.0.0.1:18545` (Hardhat) | chain id 10143 |

State, certificates, logs and Chrome profiles live in `/private/tmp/frank-stack` (`FRANK_STACK_DIR`).
`logs/wire.jsonl` holds every relay and bot exchange outside `/chain-rpc/` with base64 bodies;
`wire-report.mts` prints the canonical message exchanges part by part.

## Stand-ins

- **Chain**: Hardhat with Monad testnet's chain id and a pre-funded development account. The relay
  requires the protocol-pinned Monad testnet genesis hash from its upstream, so `chain-shim.mjs`
  substitutes that hash in block-zero responses and answers `eth_getRawTransactionByHash` (which
  Hardhat lacks) from the transactions it relayed. The chain keeps no state across `up`.
- **TLS**: a throwaway CA and one leaf per origin. Chrome is started with a dedicated profile and
  `--ignore-certificate-errors-spki-list` for exactly those keys; the system keychain is untouched.
  Node clients use `NODE_EXTRA_CA_CERTS`.
- **Relay clock**: `clock.mjs` writes this machine's time into each relay's operator clock file.
- **Relay identity keys**: the policy names a public point per relay; this relay build holds no
  identity key, so the launcher generates a point and discards the private half.
- **Bot roots**: random disposable roots, mode 0600.

A relay restart after installation reopens principals that already enrolled and keeps the others
`new`; the launcher rewrites `mode` per principal from the presence of each continuity file.
