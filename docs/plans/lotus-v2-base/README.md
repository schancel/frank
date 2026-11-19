# Lotus v2 as Frank's base coin — stage 1 contract (local regtest)

Status: stage 1 implemented on a task branch (not yet reviewed or landed). This file is the change contract required by
AGENTS.md §7: what owns what today, what owns it after this change, the dependency direction,
the formats it creates, what it deliberately does not do, and the evidence that it works.

## Goal

Frank's base coin becomes Lotus v2, locally. Lotus v2 native transactions are accepted only on
regtest by design, so a local `lotusd -regtest` with Chronik is the target network. Stage 1 is
a real Lotus v2 wallet that uses **native version-7 transactions** (BIP340 Schnorr, BLAKE3
TxID, `rxpi1` addresses, 1 XPI = 1,000,000 atoms), not the node's legacy eCash-format path:
legacy transactions cannot spend native coins, and ecash-lib computes wrong v7 txids, so
ecash-lib never hashes, parses or signs a v7 transaction anywhere in this change.

## Regtest only (owner ruling, 2026-11-19)

Lotus v2 native (v7) transactions are rejected outside regtest. Frank therefore has only the
regtest registry row (no Lotus v2 testnet or mainnet rows), and refuses at every boundary with
`LotusV2UnsupportedNetworkError` ("supported only on regtest"):

- the codec (`native.ts`): every entry point that addresses, hashes or signs takes a network and
  accepts only `regtest`; a well-formed mainnet (`xpi1`) or testnet (`txpi1`) address is refused as
  unsupported, not as malformed;
- the wallet (`LotusV2Wallet.create`, `lotusV2NetworkOf`): opens only a chain whose client registry
  row is family `bitcoin`, kind `lotus`, network `regtest`, before touching the indexer or seed;
- the chain adapter (`createLotusV2Chain`) and `openRelayUtxoChain` (adapter chosen by kind; Lotus
  v1 `xpi-*` rows have no wallet and are refused).

Tests: `lotus-v2/native.jest.test.ts` (codec and wallet refusals), `chain/base-chain.jest.test.ts`
(chain adapter refusal), and the regtest suite's "recipient of another network" case.

How the node enforces it (checked, Lotus repo unchanged): the build used here
(`daemon/.build/v2/src/lotusd`, v0.34.1-c944520e13c9) does **not** refuse to start on mainnet. It
logs "This network uses a placeholder Lotus V2 genesis block" and keeps running; the current
source's `src/init.cpp` (~line 2686, `IsPlaceholderGenesis`) only warns. `kernel/chainparams.cpp`
defines separate mainnet/testnet V2 chain ids and genesis blocks, so a v7 transaction signed for
regtest (ChainID zero) cannot verify on another network, but no startup or mempool gate that
rejects v7 off regtest was found, and acceptance of v7 off regtest was not tested. The checkout
inspected (`scratch/smt/utxoC-folded6`, 38cfb7d273) differs from the build tree, so the earlier
probe that saw a refusal may have used another build. Frank's refusal does not depend on the node.

## Decisions taken for stage 1 (owner defaults, recorded)

| # | Decision | Status after investigation |
|---|---|---|
| D1 | New registry row `lotus-v2-regtest` in `docs/protocol/chains/v1.json`: family `bitcoin`, network `regtest`, CAIP-2 `bip122:lotus-v2-regtest`, operator block checkpoint, proxy capabilities `json-rpc` and `chronik`. Client extension: kind `lotus`, 6 decimals, unit `rXPI`. The Lotus v1 rows `xpi-*` are untouched. | Holds. |
| D2 | Identity, directory and DM stamps stay on the EVM key and the EVM messaging chain (`ActiveChain`, Monad). Lotus is the base wallet for balance, receive, send and history. | Holds. This removes the need to split `ActiveChain` now: `ActiveChain` is the *messaging* contract and stays EVM; the base wallet uses the existing family-neutral `NativeAssetChain` / `NativeWalletHandle` contracts, which already have no EVM pieces. |
| D3 | A Lotus v2 family adapter, a peer of the eCash (`EcashWallet`) and Electrum (`UtxoWallet`) adapters, implementing `NativeWalletHandle` where family-neutral. | Holds. |
| D4 | The base chain is chosen by configuration (registry row), replacing the hard-wired choice; an unknown identifier is rejected, never defaulted to Monad. | Narrowed, see "Base chain seam". `chain/index.ts`'s module-level `MonadChain` is the messaging chain (D2) and stays; the *base wallet* chain is a new configured seam. |
| D5 | Lotus v1 code (bitcore-lib-xpi, legacy-wallet, nakamoto xpi, relay `lotus_adapter.rs`) is not deleted here. | Follow-up F1. |
| D6 | No fake chain: tests run on a real `lotusd -regtest` with Chronik, gated by `nodeSuiteReady` / `FRANK_REQUIRE_NODES`, with a `findLotusd` helper. | Holds. |
| D7 | Reuse `@lotus/v2-payment-compiler` if consumable. | **Not consumable**: it is `private: true`, unpublished, and lives in the Lotus repository (`tools/lotus-v2-compiler`). Frank has its own minimal codec (`packages/wallet/lotus-v2/native.ts`) that follows the compiler's transaction runtime framing for exactly one shape (type-1 keyhash spends, native single-branch outputs, FULL signatures). The node, not the compiler, is the arbiter: every byte is checked by `lotusd` in the regtest suite. |

Node build used: `/Users/shammah/repos/lotus/daemon/.build/v2/src/lotusd` (0.34.1, built
2026-11-02). It accepts native v7 transactions and type-1 addresses on regtest, serves
Chronik's confirmed-only `/v2/*` routes, and its legacy Chronik routes accept and look up v7
transactions (`POST /broadcast-tx`, `GET /tx/:id`). Its source checkout has since moved on
(the build directory's tree is not the current submodule head); a newer build was not needed.
Tests take the binary from `LOTUSD_BIN` (or `lotusd` on `PATH`).

## Facts verified against the node (2026-11-19)

- Regtest ChainID is 32 zero bytes (`V2_REGTEST_CHAIN_ID{}` in `kernel/chainparams.cpp`); the
  wallet commits to it in every TxID and signature.
- Type-1 address vector from `docs/lotus-v2/addresses.md` (scalar 1 ->
  `rxpi1pl8e2pv6n7jp0g9fgrk36qzff6z98mxnynqz57hhkvga4tq8xqlmsq2859j5u`, leaf
  `84f3ac42…67bb`) reproduces, and `validateaddress` agrees.
- A Frank-built 1-in/2-out spend of a native coinbase coin passes `testv2transaction`,
  `testmempoolaccept`, is mined, and Chronik `/v2` lists its outputs under the TxID Frank computed.
- Ids: Chronik `/v2/*` and the wire use BLAKE3 output order; node JSON-RPC and legacy Chronik
  routes (`/tx/:id`, `/broadcast-tx` replies) print the byte-reversed order. Frank stores the
  wire order and converts only at those boundaries.
- Minimum relay fee is 1 atom per byte of the complete signed transaction ("min relay fee not
  met, 0 < 287"). The fee is burned at least 50% by consensus; the wallet only pays it.
- Rebroadcasting an accepted transaction succeeds (idempotent); a conflicting spend is refused
  with `txn-mempool-conflict` (HTTP 400 from Chronik, RPC -26).
- Chronik `/v2/*` is **confirmed-only** (`pool_indexed: false`): mempool outputs and spends are
  not visible there. Consequences are in "Wallet state" below.
- Coinbase outputs mature after 100 blocks. Single-node regtest never reaches Avalanche finality,
  so nothing here waits on it.

## Ownership

### Current

- Base wallet in the app: the EVM wallet opened by the account session (`openEvmWallet`), on the
  network `loadMonadChainConfigFromEnv()` selects. Bitcoin-family wallets are secondary
  networks, opened through `openRelayUtxoChain` (`chain/utxo-family.ts`), which picks the eCash
  adapter for Chronik rows by a hard-coded list of `xec-*` identifiers.
- No Lotus v2 code exists in Frank. Lotus v1 code exists (bitcore-lib-xpi, nakamoto `xpi`).

### Target (stage 1)

| Fact | Owner |
|---|---|
| Lotus v2 protocol identity (id, family, network, CAIP-2, proxy capabilities, probes) | `docs/protocol/chains/v1.json` row `lotus-v2-regtest` |
| Presentation (kind `lotus`, unit, 6 decimals, wallet indexer `chronik`) | client extension in `packages/wallet/chain/chains-registry.ts` |
| ChainID, address format, keyhash program, output/tx framing, TxID, signing message | `packages/wallet/lotus-v2/native.ts` (pure; no I/O) |
| Which coins are unspent | the chain, read through Chronik `/v2/branches/utxos`; rebuilt on every sync, never cached for selection |
| Next receive/change index, recorded sends (exact signed bytes + claimed inputs), inputs known spent | the wallet's durable store (`LotusV2WalletStore`), one per wallet, keyed by chain and first address |
| Keys and signing | the wallet's HD account from the `ecash-bch-wallet` domain root (the Bitcoin-family root), path `m/44'/10605'/0'` (SLIP-44 coin type of Lotus), receive `0/i`, change `1/i`; x-only BIP340 keys |
| Adapter choice for a Chronik wallet row | registry `kind` (`ecash` -> eCash SDK wallet, `lotus` -> Lotus v2 wallet) in `openRelayUtxoChain`, replacing the identifier list |
| Which network is the base wallet | host configuration `QCLI_FRANK_BASE_CHAIN` / `FRANK_BASE_CHAIN`, validated against the client registry by `resolveBaseChain` (`packages/wallet/chain/base-chain.ts`); unknown or walletless ids are refused; absent means the EVM primary network, as today (seam landed; host wiring is gap G1) |
| Identity, directory, DM stamps, topics, games, swaps | unchanged: EVM (`ActiveChain`) |

Dependency direction: `lotus-v2/native.ts` depends only on `@noble/curves` and
`@noble/hashes`. `lotus-v2/wallet.ts` depends on `native.ts`, `chain/chain-wallet.ts` contracts
and `@frank/nakamoto` HD derivation. `lotus-v2/chronik.ts` (indexer) depends on `fetch` only.
Nothing in `lotus-v2/` imports messaging, cashweb transport, EVM code or ecash-lib. The app
reaches the wallet only through `openRelayUtxoChain` / `openUtxoWallet`.

## Wallet state (AGENTS.md §3)

A keyring plus a flat coin list, like `UtxoWallet`:

- **Selection and reservation.** A send reads the chain unlocked, then in one short critical
  section (Web Lock / per-wallet queue, no network wait) chooses coins not claimed by any
  recorded send, signs, and records `{txid, raw, inputs}` before any byte leaves. Two
  concurrent sends therefore never choose the same coin; the second picks other coins or fails
  with insufficient funds.
- **Broadcast-uncertain recovery.** A network error or timeout during broadcast is not a
  refusal: the record and its claimed inputs stay, `NativeTransactionSubmissionError` carries
  the exact bytes, and the next send, balance read or wallet open re-sends the same bytes
  (never a new payment). A node refusal releases the claim. A recorded send the indexer knows
  (legacy `GET /tx/:id`, mempool or block) is settled; its inputs are remembered as consumed
  so a lagging confirmed-only index cannot hand them out again.
- **Confirmed-only index.** Because `/v2` shows only confirmed outputs, a pending send's change
  and an incoming unconfirmed payment do not appear in the balance until mined, and the wallet
  never spends an unconfirmed output. (No pending-balance figure is reported in stage 1.) Lotus
  v2 Chronik answers a `/v2` read 503 `index_unavailable` while it connects a block; the indexer
  repeats such reads briefly (a relay passes the 503 on as 502).
- **Chain isolation.** The store's rows carry `chainIdentifier`; a row of another chain fails
  the open. The wallet's handle reports family `bitcoin`, its canonical id and network.

Not in stage 1: stealth payments, Frank-to-Frank contact payments, message stamps, wallet sync
items (`applyWalletSyncItem`) for Lotus sends, multi-device send sharing. A device's Lotus
sends live in that device's store, as eCash sends do today (follow-up F4).

## Formats created

- Registry row `lotus-v2-regtest` (protocol). Editing `v1.json` changes the Solana WASM package
  that embeds it; see "Verification" for the regeneration status.
- Browser storage key `frank:lotus-v2-wallet:v1:<chainIdentifier>:<firstAddress>`: JSON
  `{version: 1, chainIdentifier, receiveIndex, changeIndex, pending[], consumedInputs[]}`.
  New format; no reader of an older one exists or is added.
- No wire/message format changes.

## Base chain seam

Landed: `resolveBaseChain(configured)` returns the registry entry of the configured base network
or throws `UnsupportedBaseChainError` for an unknown id, a family name, a non-wallet row, or a
family without a base-wallet adapter; absent configuration returns nothing (no default network).
`openRelayUtxoChain` picks the Chronik adapter by registry `kind`. The app opens a
`lotus-v2-regtest` wallet through `openUtxoWallet` wherever it opens Bitcoin-family wallets
(balance, Wallet page receive/send), first reading the relay's operator checkpoint for the row;
session custody passes stealth custody only to the eCash and Electrum adapters.

Not yet done (gap G1): no host composition reads `QCLI_FRANK_BASE_CHAIN` and calls
`resolveBaseChain`, so the Lotus wallet appears as one more Bitcoin-family network, not as the
account's primary balance in place of the EVM network.

## Relay

Landed: the Chronik proxy allows `GET /v2/status`, `GET /v2/utxos/:txid/:idx`,
`POST /v2/branches/utxos` and `POST /v2/branches/outputs` (public reads, JSON content type; one
anonymous unit per request), and `GET /chains` advertises `operator_checkpoint` for a
Bitcoin-family **regtest** row whose probes leave the checkpoint to the operator (hash in the
node's display hex, no `0x`). A protocol-pinned row (for example `xec-testnet`) is never
restated. The operator adds a `[[registry.bitcoin_proxy.chains]]` row for `lotus-v2-regtest` with
a Chronik upstream and the run's checkpoint (see `lotus-v2/relay.regtest.jest.test.ts`); the
committed `cashwebd.local.toml` has no such row, since each regtest run is a new chain.

## Acceptance evidence

Real `lotusd -regtest` + Chronik (`packages/wallet/lotus-v2/wallet.regtest.jest.test.ts`, 8
tests, all passing locally):

1. receive: a coin paid to the wallet's receive address shows in its balance once mined, and the
   receive address moves on;
2. send: a payment to another wallet arrives with the exact value; the fee is the signed size;
3. change: the remainder returns to a fresh change address and is spendable after mining;
4. restart mid-send: a send whose broadcast never reached the node (simulated transport failure
   after recording) is re-sent with the same txid by a wallet reopened on the same store; the
   payee is paid once;
5. two concurrent sends from one wallet choose disjoint coins; both land, nothing double-spends,
   and a concurrent send that cannot be covered fails cleanly without touching claimed coins;
6. a send the node refuses (another device on the same seed spent the coin first:
   `txn-mempool-conflict`) frees its claim and pays nothing;
7. a node not on the checkpoint chain is refused; a recipient of another network is refused
   before anything is signed; the chain adapter reads, sends and reports status.

Through the real relay binary (`lotus-v2/relay.regtest.jest.test.ts`, 2 tests, `CASHWEBD_BIN`
plus `LOTUSD_BIN`): the wallet takes the checkpoint the relay advertises, receives, sends with
change through the relay's `/v2` reads and `broadcast-tx`, and settles; a wrong checkpoint is
refused.

Both suites are `NOT_IN_CI` (no published Lotus v2 release). Plus pure tests of the codec
against the addresses.md vector, the relay's route and discovery unit tests, app tests for the
checkpoint spelling and Lotus wallet opening, and `yarn typecheck:fast` (27/27).

Registry regeneration: the Solana WASM that embeds `v1.json` was regenerated with the pinned
toolchain (Docker `--platform linux/amd64 rust:1.93.0`), and
`packages/wallet/solana-crypto-backend/build-wasm.sh --check` reports that the committed WASM
matches the pinned source generation. The relay network-tag table covers the row (`XP2R`).

## Follow-ups

- F1: delete Lotus v1 code (bitcore-lib-xpi, legacy-wallet, nakamoto `xpi`, relay
  `lotus_adapter.rs`, `xpi-*` registry rows) once v2 is the base.
- F2: relay — Bitcoin-family Lotus v2 payment verifier for stamps/forum/group writes; relay
  accepting a non-EVM `[registry] network`; JSON-RPC allow-list `submitrawtxbatch`.
- F3: identity and stamps on Lotus (x-only keys, IS_BURN commitments, atom-based payment floor).
- F4: share Lotus sends across a user's devices (self-sync item), as Monad does.
- F5: a mempool-aware index (Chronik `/v2` is confirmed-only) so unconfirmed change is spendable.
- F7 (gap G1 above): host composition reads `QCLI_FRANK_BASE_CHAIN` and shows the Lotus wallet
  as the primary balance; Lotus transaction history in the Wallet page (the wallet reports no
  history list yet).
- F8: a regtest-stack (`packages/bot/demo/regtest`) Lotus chain, so the local demo starts lotusd
  and the relay row together.
- F6: coin expiry (`expiration_height`) is not exposed by Chronik or `gettxout`; the wallet
  cannot warn before a coin expires (regtest minimum lifespan 131,400 blocks).
