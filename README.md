# Frank

<p align="center">
  <img src="app/src/assets/stamp-icon.png" alt="Frank" width="112" />
</p>

<p align="center">
  <strong>Private, economically spam-resistant messaging for Monad.</strong><br />
  Every direct message carries a real payment to its recipient. Public topic posts and votes burn value.
</p>

Frank is a Monad port and continuation of [Stamp](https://github.com/stampchat/stamp), a cryptomessenger built around a simple rule: **speaking is not free**. A sender must attach an on-chain stamp transaction to every message, and the relay independently verifies that transaction before accepting the message.

That economic primitive makes Frank more than chat. It is a candidate transport for any Ethereum-family protocol that needs private, asynchronous negotiation before on-chain settlement: agent coordination, swaps, payment channels, threshold signing, credentials, escrow, games, and other multi-round protocols.

> [!WARNING]
> Frank is an early testnet prototype. It uses real cryptography and real Monad testnet transactions, but its protocol and wire formats are still changing. Do not use it with valuable keys or mainnet funds.

## Why Frank

Most encrypted messengers still require an account from one operator. Most blockchain applications can settle a transaction but have no private, authenticated, spam-resistant channel for the negotiation that comes first.

Frank combines:

- **Permissionless accounts:** generate a secp256k1 identity locally without a phone number, email address, legal name, or central account issuer.
- **Paid delivery:** a relay accepts a direct message only after verifying its recipient payment on Monad.
- **Burn-weighted broadcasts:** public topic posts and votes burn MON because there is no single recipient to compensate.
- **Transaction-carrying messages:** the raw stamp transaction travels with the off-chain message, so relays can validate and submit it directly instead of relying on a chain-wide transaction indexer to discover it.
- **End-to-end encrypted content:** relays route and validate delivery without receiving the plaintext.
- **User-run infrastructure:** Stamp's architecture lets users choose or run mailbox relays; restoring per-profile relay discovery and migration on Monad is an active design gap.
- **Parallel nonce lanes:** disposable funding accounts avoid forcing unrelated outgoing stamps through one EVM account's ordered nonce queue.
- **Wallet and agent primitives:** the protocol client is separated from Vue/Pinia, and the repository includes a headless Qwen bot with its own Frank identity.

The distinction between payments and burns is fundamental:

```text
direct message  ── stamp payment ──▶ recipient
topic broadcast ── burn ───────────▶ unspendable address
```

## Why this belongs in the Ethereum ecosystem

Frank is an implementation-driven exploration of themes that have repeatedly appeared in Ethereum research:

- Vitalik's [guide to stealth addresses](https://vitalik.eth.limo/general/2023/01/20/stealth.html) describes recipient-controlled one-time destinations that a sender can derive without another interaction.
- [The Three Transitions](https://vitalik.eth.limo/general/2023/06/09/three_transitions.html) argues that an address must evolve into richer instructions containing payment addresses, encryption keys, and multichain information—and explicitly considers direct sender-recipient communication as part of that future.
- [What I would love to see in a wallet](https://vitalik.eth.limo/general/2024/12/03/wallets.html) emphasizes that wallets must preserve the privacy and decentralization properties users expect from Ethereum itself.
- [Make Ethereum Cypherpunk Again](https://vitalik.eth.limo/general/2023/12/28/cypherpunk.html) calls for permissionless, censorship-resistant, auditable tools instead of new centralized empires.

These links are context, not endorsements. Frank's contribution is to combine identity, encrypted messaging, economic spam resistance, recipient payments, and federated mailbox infrastructure in a working system.

## What works today

The current branch demonstrates a complete Monad testnet path:

1. A wallet generates a local identity and registers its public profile with the relay.
2. The sender resolves the recipient's registered public key.
3. The client encrypts the message content using ECDH-derived key material.
4. The client builds and signs a Monad stamp transaction from a leased funding sub-account.
5. The relay validates the envelope and raw transaction before broadcasting it.
6. The relay waits for confirmation, verifies the payment, and stores the message.
7. The recipient discovers the message, resolves the sender's registered key, and decrypts it.

The same stack also supports Monad-native topic posts, burn-weighted votes, a browser UI, and a headless Qwen-backed bot.

```text
┌──────────────┐     encrypted envelope      ┌──────────────────┐
│ Frank client │ ───────────────────────────▶ │ CashWeb relay    │
│              │     signed stamp tx         │                  │
└──────┬───────┘                              └────────┬─────────┘
       │                                               │
       │ local identity + funding account pool        │ verify / broadcast
       │                                               ▼
       │                                      ┌──────────────────┐
       └─────────────────────────────────────▶│ Monad testnet    │
                                              └──────────────────┘
```

### Honest status

Frank is a port of a deeper protocol, not a finished security product. This table separates the working hackathon path from the privacy work still being restored:

| Capability                                                       | Monad status                                                                                               |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Local account creation without required PII                      | Working                                                                                                    |
| Signed Monad-native profile registration                         | Working                                                                                                    |
| Encrypted direct-message content                                 | Working; legacy CBC construction needs an authenticated-encryption redesign                                |
| Direct-message stamp pays the recipient                          | Working; currently one transaction to the recipient's known EOA                                            |
| Topic posts and votes burn MON                                   | Working                                                                                                    |
| Relay-side transaction broadcast, confirmation, and verification | Working                                                                                                    |
| Single-use sender funding accounts and change handling           | Working                                                                                                    |
| Recipient one-time stamp-child destinations                      | Designed in original Stamp; not yet restored on Monad ([#60](https://github.com/schancel/frank/issues/60)) |
| Greedy multi-transaction stamp construction                      | Designed in original Stamp; not yet restored on Monad ([#60](https://github.com/schancel/frank/issues/60)) |
| Per-profile relay discovery and mailbox migration                | Original Stamp behavior; not yet restored on Monad                                                         |
| Cross-device checkpoints and safe state compaction               | Design work ([#58](https://github.com/schancel/frank/issues/58))                                           |
| True simultaneous multichain operation                           | Design work ([#59](https://github.com/schancel/frank/issues/59))                                           |

## The original Stamp privacy construction

For a direct message, Stamp does not pay the recipient's familiar public address. It derives a recipient-controlled one-time public key from the encrypted payload digest and the recipient's destination public key:

```text
stamp public key = H(payload digest)·G + recipient public key
```

The recipient reconstructs the matching private key:

```text
stamp private key = H(payload digest) + recipient private key  (mod n)
```

Stamp then derives child destinations and greedily builds at least two transactions from distinct funding sources. No single transaction or address needs to reveal the complete stamp amount. Frank's current Monad path restores the essential payment semantics first; [#60](https://github.com/schancel/frank/issues/60) tracks the byte-exact EVM derivation, multi-transaction wire format, relay verification, and recipient spending lifecycle.

For EVM, a derived secp256k1 public key becomes an address through:

```text
keccak256(uncompressed_public_key[1:])[12:]
```

## Architecture

```text
frank/
├── app/                  Quasar/Vue browser and desktop client
├── packages/
│   ├── wallet/           Monad wallet, account pool, stamp/topic clients
│   ├── cashweb/          Protocol, envelope, feed, and legacy Stamp code
│   └── bot/              Headless Qwen agent and live-demo scripts
└── backend/
    ├── cashweb/          Rust registry/relay workspace
    └── bitcoinsuite/     Vendored chain/protocol dependencies
```

The UI talks through an `ActiveChain` boundary rather than importing chain-specific clients directly. The current runtime selects Monad; [#59](https://github.com/schancel/frank/issues/59) tracks a unified multichain event stream and chain-as-data wire design.

## Run the whole demo with one command

```bash
yarn install --frozen-lockfile
yarn demo --fake-chain      # relay + blackjack, raffle, picture shop, Qwen (stub) and faucet, no keys or funds
yarn demo                   # the same against Monad testnet, from your own .env (never committed)
```

It creates the bot identities, starts the relay and the bots, waits until they are ready, prints
their addresses and the command to start the app, and shuts everything down on Ctrl-C. Every
variable it reads is documented in the table in [`packages/bot/README.md`](packages/bot/README.md#one-command-demo-yarn-demo);
`yarn demo:smoke` checks that each bot answers.

## Run the local testnet demo

### Requirements

- Node.js 24+
- Yarn 1.x
- A current Rust toolchain
- A Monad testnet JSON-RPC endpoint

Install JavaScript dependencies and create local configuration:

```bash
git clone https://github.com/schancel/frank.git
cd frank
yarn install --frozen-lockfile
cp .env.example .env
```

Set `MONAD_TESTNET_HTTP_RPC_URL` in `.env`. The remaining example values are suitable for local testnet development; never commit secrets or funded private keys.

Start the persistent Monad development server:

```bash
backend/cashweb/run-local-monad.sh
```

The default local config stores profiles, messages, and topics in
`backend/cashweb/data/registry.rocksdb`, which is gitignored and survives server restarts. It
deliberately omits `[bitcoin_rpc]`: legacy Lotus routes fail closed, while the Monad routes do not
require a running Lotus daemon. The Monad mailbox (direct messages) is enabled in the checked-in config, which stays secret-free:
the launcher reads `MONAD_TESTNET_HTTP_RPC_URL` (required) and `FRANK_NETWORK_TAG` (default `MONT`)
from `.env`/the environment, prints the effective non-secret values, compiles through the
repository's shared cache/slot wrapper, and validates the configuration with the production parser
first. It releases the build slot before starting the long-lived relay, which reads the config from
standard input. `cashwebd-exe` itself refuses to start with the mailbox enabled but no RPC URL or
network tag; see `docs/backend-topology.md` for the full variable list and production notes.

The dependency-free launcher regression can be run with
`backend/cashweb/run-local-monad.test.sh`.

For an isolated throwaway run, use the explicitly ephemeral test/demo server instead:

```bash
cargo run -p cashweb-registry --example e2e_demo_server -- 127.0.0.1:8098
```

That command creates a fresh temporary database and deletes it when the process exits.

In another terminal, start the browser client:

```bash
cd app
set -a
source ../.env
set +a
export QCLI_MONAD_TESTNET_HTTP_RPC_URL="$MONAD_TESTNET_HTTP_RPC_URL"
export QCLI_MONAD_RELAY_BASE_URL=http://localhost:8098
export QCLI_MONAD_STAMP_BURN_ADDRESS="$MONAD_STAMP_BURN_ADDRESS"
export QCLI_CASHWEB_STAMP_MIN_BURN_VALUE_WEI="$CASHWEB_STAMP_MIN_BURN_VALUE_WEI"
yarn dev:browser
```

Open [http://localhost:8080](http://localhost:8080).

> [!NOTE]
> Docker definitions are present, but the Docker build has not been verified in the current development environment. The commands above are the known local path.

## Tests

Backend:

```bash
cd backend/cashweb
cargo test -p cashweb-registry
cargo build --all-targets
```

Wallet and protocol packages:

```bash
cd packages/wallet
yarn jest

cd ../cashweb
yarn jest
```

Frontend:

```bash
cd app
yarn test:unit:ci
```

## The larger idea

Smart contracts are excellent at deterministic settlement, but many useful protocols are interactive before they settle. Participants need to exchange commitments, negotiate terms, acknowledge state, or privately provide evidence.

Stamp was also designed to avoid making a general-purpose blockchain indexer part of the messaging path. A message carries the transaction needed to justify its delivery; the receiver or relay can validate that supplied transaction and query only the relevant chain state. On Monad, using multiple single-use funding accounts also creates independent nonce lanes, allowing unrelated stamp payments to progress without sharing one account's strictly ordered transaction queue.

Frank offers a reusable channel with four unusual properties:

1. It is addressed by cryptographic identities rather than mandatory PII.
2. Content is encrypted end to end.
3. Unsolicited delivery has an enforceable economic cost.
4. Relays are infrastructure providers, not identity issuers.

That makes the messenger a reference application for a broader primitive: **private, metered interactive protocol transport for the Monad and Ethereum ecosystem**.

The longer-term multichain direction separates the network that supplies the mandatory stamp from the networks and assets negotiated inside a message. Lotus could eventually serve as the stamp or “gas” layer while the same encrypted conversation coordinates atomic settlement on Monad, Ethereum, or other chains. Reaching that design requires restoring Lotus infrastructure and specifying the atomic-swap or proof protocol; it is not part of the current Monad-only hackathon runtime.

## Development priorities

The immediate goal is correctness, not expansive claims:

- Restore recipient stamp-child derivation and greedy multi-transaction payments.
- Replace the legacy encryption envelope with reviewed deniable authenticated encryption.
- Restore federated per-profile relay routing and migration.
- Separate logical message IDs from recipient-specific payload digests.
- Make deletion, checkpoints, wallet effects, accounts, and nonces safe across devices.
- Generalize the Pinia store around conversations before implementing group mailboxes.

See the [open issues](https://github.com/schancel/frank/issues) and [PLAN.md](PLAN.md) for implementation history and current constraints.

## Origins and licensing

Frank is derived from Stamp and CashWeb. The application and extracted protocol packages retain their respective upstream licensing boundaries; consult the package-level documentation and source headers before redistribution.
