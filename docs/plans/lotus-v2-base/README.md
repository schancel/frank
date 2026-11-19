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

## Stage 2: Lotus v2 chain objects move into `@frank/nakamoto` (design, 2026-11-19)

Stage 1's codec in `packages/wallet/lotus-v2/native.ts` was an ownership violation: chain
primitives belong in `@frank/nakamoto`. Stage 2 moves them there, written from the spec
(`docs/lotus-v2/` in the Lotus repository: `addresses.md`, `decisions/encoding-and-signatures.md`
(P01), `decisions/commitments-and-state.md` (P02)), with lotusd source read only to confirm bytes.

### Which concepts are shared and which are per format

Genuinely shared between the Bitcoin-format chains (BTC/BCH/XEC/XPI v1/DOGE/LTC) and Lotus v2,
and reused as they are:

- protocol identity: `protocolId`, `proxyFamily`, `allowedProxyCapabilities`, `identityProbes`,
  `network`, `sources` (now the `ChainIdentity` base of every descriptor);
- secp256k1 keys and BIP32 HD (`keys.ts`, `hd.ts`; chain-independent already);
- BIP340 sign/verify (`curve.ts` `signSchnorr`/`verifySchnorr`, unmodified per P01: BIP340's
  own SHA256 challenge, Lotus supplies only the 32-byte message);
- CompactSize with shortest form required (`varint.ts`, `ByteReader`/`ByteWriter`);
- the 40-bit cashaddr BCH-code generator (`cashaddr.ts`), exported as a raw polymod without
  cashaddr's final xor and prefix expansion.

Per format, and changing together: transaction grammar, identity hash, signature message,
address layout, Merkle rule and script VM. No chain combines BLAKE3 identities with legacy
framing, or v7 framing with ECDSA. So these are **not** independent knobs on the existing
Bitcoin descriptor (that would let a caller build combinations no node accepts, and would give
Lotus v2 meaningless WIF/base58/p2p-magic/Bitcoin-script fields). Instead every descriptor
carries an explicit `format` discriminant:

- `format: 'bitcoin'`: the existing `ChainDescriptor`, unchanged otherwise. Its legacy capability
  fields (`merkleOddRule`, `sighash`, `bech32Hrp`, `cashaddrPrefix`, `lotusNetChar`, `script`)
  keep driving `address.ts`/`transaction.ts`/`block.ts`/`script.ts`, whose signatures still take
  only a `'bitcoin'` descriptor, so a Lotus v2 descriptor cannot reach them.
- `format: 'lotus-v2'`: `LotusV2ChainDescriptor`, with explicit capability fields read by
  `src/lotus-v2/`: `chainId` (32 bytes committed in every TxID/TxHash/signature),
  `transactionVersion: 7`, `hash` (`blake3-tagged`, tag prefix `Lotus/v2/`, `H_name(x) =
BLAKE3(tag || 00 || x)`), `merkle` (`indexed-tagged`: P02 `IndexedTreeRoot`, layer-numbered
  `H_merkleidx` nodes, odd levels padded with 32 zero bytes, empty root `H_merkleidx(02)`),
  `address` (`lotus-v2-typed`: hrp, 40-bit checksum constant, supported type selectors),
  `signature` (`bip340-x-only` with the signing modes the spec defines: 00 FULL, 01
  OWN_INPUT_ALL_OUTPUTS, 02 OWN_INPUT_ONE_OUTPUT).

Only the regtest descriptor `LOTUS_V2_REGTEST` exists. Mainnet and testnet are **not yet
defined** (lotusd refuses to start there until genesis and constants exist; their ChainIDs in
`addresses.md` are address-constant provenance, not launch parameters). The address codec knows
their prefixes and checksum constants only to report a well-formed `xpi1`/`txpi1` string as
`network-not-defined` instead of malformed. Frank's wallet still opens only on regtest (owner
ruling above); that refusal stays in the wallet, not in nakamoto.

### What nakamoto implements (`packages/nakamoto/src/lotus-v2/`, entry `@frank/nakamoto/lotus-v2`)

- Addresses: type 0 (explicit branch root) and type 1 (x-only keyhash template) encode/decode
  with checksum and the spec's ordered rejection reasons; types 2-31 rejected.
- Templates: type-1 keyhash program `DUP BLAKE3 PUSH32 EQUALVERIFY CHECKSIG`; `Leaf(script)`,
  `BranchNode`, branch proof roots.
- Transactions: the complete P01 grammar, encode and strict parse (spend, coinbase and mint
  inputs; native/token/burn/state output flags; lock kinds; shortest CompactSize; no trailing
  bytes), TxID, TxHash, `CoinsRoot`, `OwnInputHash`.
- Signature messages for modes 00/01/02 on spend invocations; a mint invocation's message
  (needs the accounting delta) is an explicit `unsupported` result. BIP340 signing via nakamoto
  `SigningKey`; verification of a spend witness's signature.
- Not implemented (explicit, not silent): VM execution, accounting and fee rules (the fee rule
  is wallet policy and is changing upstream, see below), UTXO/state commitments, block headers.

Fees: lotusd's current rule is 1 atom per signed byte (regtest profile: "the specification's
original 1000 atoms/kB and 546 atoms"). The spec's pending rule (subsidy-indexed cu term plus a
byte fee) replaces it before genesis, so the wallet keeps the fee rule as its own replaceable
policy (`LOTUS_V2_FEE_PER_BYTE`), not a nakamoto consensus fact.

### Stage 2 status and evidence (2026-11-19)

Landed on the task branch: `LOTUS_V2_REGTEST` and `src/lotus-v2/` in nakamoto (entry
`@frank/nakamoto/lotus-v2`, also re-exported from the root); `packages/wallet/lotus-v2/native.ts`
deleted; the wallet, chain adapter, Chronik indexer and regtest harness build through nakamoto.
Wallet behaviour and stored formats are unchanged (same addresses, roots, TxIDs and sizes; the
wallet suites pass unmodified apart from imports).

Evidence:

- nakamoto unit tests (`test/lotus-v2.jest.test.ts`) against copied vectors: lotusd
  `src/test/data/lotus_v2_address.json` (every valid and invalid address with its reason), the
  `addresses.md` type-1 vector, lotusd `test_commitment.cpp` (branch leaves/nodes, every domain
  tag, `IndexedTreeRoot` for 0..5 leaves), and the Lotus compiler fixtures
  `reference-signed-payment-v1.json` (wire, TxID, TxHash, CoinsRoot, OwnInputHash, the three
  signing messages, the FULL signature) and `key3-one-output.json` / `key4-two-outputs.json`
  (a nakamoto-built spend is byte-identical, BIP340 with all-zero aux). All other nakamoto suites
  (BTC/BCH/XEC/XPI v1/DOGE/LTC) unchanged and green.
- real `lotusd -regtest` (build c944520e13; codec files `signing.cpp`, `transaction.cpp`,
  `output.cpp`, `address.cpp`, `commitment.cpp`, `tagged_hash.cpp` are byte-identical in
  38cfb7d273 and in `scratch/v2fix/audit`): `wallet.regtest` 11/11, `relay.regtest` 2/2 (relay
  built from this branch), and the new `chain-objects.regtest` 3/3: a 5-input, 37-output payment
  (odd layers in both indexed trees), a type-0 address over a two-leaf `PUSH32 key CHECKSIG` tree
  spent through a membership proof with modes 01 and 02, and parsing the node's own blocks
  (coinbase included) to the TxIDs it reports.

Spec/code disagreements found (sent to the Lotus session; Frank follows the node):

1. JSON-RPC prints TxIDs byte-reversed (`src/rpc/mempool.cpp:203` `GetHex()`); C04/P01 say
   digests display in digest order. Chronik `/v2` uses digest order. Frank converts at the RPC
   boundary only (`rpcTxid`).
2. CHECKSIG with an empty signature pushes false (`vm.cpp:1979`); P01 says there is no
   empty-signature special case. Frank never signs empty.
3. The node rejects `HAS_STATE` with `IS_BURN` and token/state outputs in a coinbase; P01 does
   not state the first. Nakamoto follows the node.
4. The node has legacy coin entries (leading byte `0x80`) and a legacy-bridge leaf (`H_branch(03
|| …)`) not in P01/P02. Nakamoto does not implement them (no v7 spend of a legacy coin).
5. `addresses.md` step 2 puts "wrong network" at the prefix step; nakamoto (like stage 1) checks
   the checksum under that prefix's constant first, so a corrupted string is malformed rather than
   wrong-network. Asked whether that is acceptable.

The Coin record's 17-byte lifespan suffix (P02, fixed in the reference model this week) is not
in any signature message (`CoinEntry` is `Bytes(Output)` only) and Frank does not encode Coin
records, so nothing here depends on it.

To rerun on `daemon/.build/v2-current` when it exists (`LOTUSD_BIN=…/v2-current/lotusd
FRANK_REQUIRE_NODES=1`, regtest only): `packages/wallet/lotus-v2/wallet.regtest.jest.test.ts`,
`chain-objects.regtest.jest.test.ts`, and `relay.regtest.jest.test.ts` (with `CASHWEBD_BIN`).
The fee rule (1 atom/byte) is the one most likely to change there.

## Regtest only (owner ruling, 2026-11-19)

Lotus v2 native (v7) transactions are rejected outside regtest. Frank therefore has only the
regtest registry row (no Lotus v2 testnet or mainnet rows), and refuses at every boundary with
`LotusV2UnsupportedNetworkError` ("supported only on regtest"):

- the wallet's chain boundary (`lotus-v2/network.ts`, over `@frank/nakamoto/lotus-v2`): every
  entry point that addresses, hashes or signs takes a network and accepts only `regtest`; a well-formed mainnet (`xpi1`) or testnet (`txpi1`) address is refused as
  unsupported, not as malformed;
- the wallet (`LotusV2Wallet.create`, `lotusV2NetworkOf`): opens only a chain whose client registry
  row is family `bitcoin`, kind `lotus`, network `regtest`, before touching the indexer or seed;
- the chain adapter (`createLotusV2Chain`) and `openRelayUtxoChain` (adapter chosen by kind; Lotus
  v1 `xpi-*` rows have no wallet and are refused).

Tests: `lotus-v2/network.jest.test.ts` (boundary and wallet refusals), `chain/base-chain.jest.test.ts`
(chain adapter refusal), and the regtest suite's "recipient of another network" case.

How the node enforces it (checked, Lotus repo unchanged): the build used here
(`daemon/.build/v2/src/lotusd`, v0.34.1-c944520e13c9) is stale and does **not** refuse to start on
mainnet (it only warns about a placeholder genesis). The current V2 stack
(`scratch/smt/utxoC-folded6`, 38cfb7d273) refuses to start on any network whose consensus
constants or genesis are unset (`V2NetworkStartupError`, `src/pow/pow.cpp:104`, called from
`AppInitSanityChecks` in `src/init.cpp:3024`); per the Lotus coordinator that startup gate is the
intended way v7 stays off mainnet/testnet until launch (no mempool gate), and once mainnet
launches v7 is native there. The remainder of this paragraph describes the stale build. `kernel/chainparams.cpp`
defines separate mainnet/testnet V2 chain ids and genesis blocks, so a v7 transaction signed for
regtest (ChainID zero) cannot verify on another network, but no startup or mempool gate that
rejects v7 off regtest was found, and acceptance of v7 off regtest was not tested. The checkout
inspected (`scratch/smt/utxoC-folded6`, 38cfb7d273) differs from the build tree, so the earlier
probe that saw a refusal may have used another build. Frank's refusal does not depend on the node.

## Decisions taken for stage 1 (owner defaults, recorded)

| #   | Decision                                                                                                                                                                                                                                                                                                                | Status after investigation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | New registry row `lotus-v2-regtest` in `docs/protocol/chains/v1.json`: family `bitcoin`, network `regtest`, CAIP-2 `bip122:lotus-v2-regtest`, operator block checkpoint, proxy capabilities `json-rpc` and `chronik`. Client extension: kind `lotus`, 6 decimals, unit `rXPI`. The Lotus v1 rows `xpi-*` are untouched. | Holds.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| D2  | Identity, directory and DM stamps stay on the EVM key and the EVM messaging chain (`ActiveChain`, Monad). Lotus is the base wallet for balance, receive, send and history.                                                                                                                                              | Holds. This removes the need to split `ActiveChain` now: `ActiveChain` is the _messaging_ contract and stays EVM; the base wallet uses the existing family-neutral `NativeAssetChain` / `NativeWalletHandle` contracts, which already have no EVM pieces.                                                                                                                                                                                                                                                     |
| D3  | A Lotus v2 family adapter, a peer of the eCash (`EcashWallet`) and Electrum (`UtxoWallet`) adapters, implementing `NativeWalletHandle` where family-neutral.                                                                                                                                                            | Holds.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| D4  | The base chain is chosen by configuration (registry row), replacing the hard-wired choice; an unknown identifier is rejected, never defaulted to Monad.                                                                                                                                                                 | Narrowed, see "Base chain seam". `chain/index.ts`'s module-level `MonadChain` is the messaging chain (D2) and stays; the _base wallet_ chain is a new configured seam.                                                                                                                                                                                                                                                                                                                                        |
| D5  | Lotus v1 code (bitcore-lib-xpi, legacy-wallet, nakamoto xpi, relay `lotus_adapter.rs`) is not deleted here.                                                                                                                                                                                                             | Follow-up F1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| D6  | No fake chain: tests run on a real `lotusd -regtest` with Chronik, gated by `nodeSuiteReady` / `FRANK_REQUIRE_NODES`, with a `findLotusd` helper.                                                                                                                                                                       | Holds.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| D7  | Reuse `@lotus/v2-payment-compiler` if consumable.                                                                                                                                                                                                                                                                       | **Not consumable**: it is `private: true`, unpublished, and lives in the Lotus repository (`tools/lotus-v2-compiler`). Stage 1 had its own minimal codec in the wallet; stage 2 replaced it with `@frank/nakamoto/lotus-v2` (written from the spec). It followed the compiler's transaction runtime framing for exactly one shape (type-1 keyhash spends, native single-branch outputs, FULL signatures). The node, not the compiler, is the arbiter: every byte is checked by `lotusd` in the regtest suite. |

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

| Fact                                                                                                | Owner                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Lotus v2 protocol identity (id, family, network, CAIP-2, proxy capabilities, probes)                | `docs/protocol/chains/v1.json` row `lotus-v2-regtest`                                                                                                                                                                                                                                            |
| Presentation (kind `lotus`, unit, 6 decimals, wallet indexer `chronik`)                             | client extension in `packages/wallet/chain/chains-registry.ts`                                                                                                                                                                                                                                   |
| ChainID, address format, keyhash program, output/tx framing, TxID, signing message                  | `@frank/nakamoto/lotus-v2` (stage 2; pure, no I/O). The wallet's `lotus-v2/network.ts` adds only the regtest-only rule, hex and the RPC id order                                                                                                                                                 |
| Which coins are unspent                                                                             | the chain, read through Chronik `/v2/branches/utxos`; rebuilt on every sync, never cached for selection                                                                                                                                                                                          |
| Next receive/change index, recorded sends (exact signed bytes + claimed inputs), inputs known spent | the wallet's durable store (`LotusV2WalletStore`), one per wallet, keyed by chain and first address                                                                                                                                                                                              |
| Keys and signing                                                                                    | the wallet's HD account from the `ecash-bch-wallet` domain root (the Bitcoin-family root), path `m/44'/10605'/0'` (SLIP-44 coin type of Lotus), receive `0/i`, change `1/i`; x-only BIP340 keys                                                                                                  |
| Adapter choice for a Chronik wallet row                                                             | registry `kind` (`ecash` -> eCash SDK wallet, `lotus` -> Lotus v2 wallet) in `openRelayUtxoChain`, replacing the identifier list                                                                                                                                                                 |
| Which network is the base wallet                                                                    | host configuration `QCLI_FRANK_BASE_CHAIN` / `FRANK_BASE_CHAIN`, validated against the client registry by `resolveBaseChain` (`packages/wallet/chain/base-chain.ts`); unknown or walletless ids are refused; absent means the EVM primary network, as today (seam landed; host wiring is gap G1) |
| Identity, directory, DM stamps, topics, games, swaps                                                | unchanged: EVM (`ActiveChain`)                                                                                                                                                                                                                                                                   |

Dependency direction (stage 2): `@frank/nakamoto/lotus-v2` depends only on `@noble/curves` and
`@noble/hashes` (BLAKE3 from the already-pinned `@noble/hashes` 1.8.0; no new dependency).
`lotus-v2/network.ts` depends on nakamoto. `lotus-v2/wallet.ts` depends on `network.ts`, `chain/chain-wallet.ts` contracts
and `@frank/nakamoto` HD derivation. `lotus-v2/chronik.ts` (indexer) uses `fetch` for the `/v2`
JSON routes and `chronik-client` for the legacy `GET /tx`, `POST /broadcast-tx` and
`GET /block` routes (it never parses a transaction).
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
- **Refusal is not proof.** A first broadcast the node refuses frees the coins only when the node
  then does not have the transaction; a mined one is settled, a mempool one stays claimed (the
  bytes may have been broadcast by another holder, for example another tab via `onSigned`).
- **Coinbase maturity.** A coinbase output (Chronik `creation.tx_index === 0`) is neither balance
  nor selectable until the next block is 100 above it (the node's `nSpendHeight - height >= 100`),
  read against the `/v2/status` tip.
- **Keys on the coins.** Each coin carries its spend key, as the owner's wallet model rules
  (memory: "store the key on the coin"; a derivation reference was rejected). The independent
  review asked to derive keys at signing time instead; that conflicts with the owner ruling and
  was not changed. Owner decision if it should be.
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

Real `lotusd -regtest` + Chronik (`packages/wallet/lotus-v2/wallet.regtest.jest.test.ts`, 11
tests, all passing locally with `FRANK_REQUIRE_NODES=1`):

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
7. recorded bytes another party broadcast and mined before the wallet's own broadcast settle the
   send (the wallet's broadcast is refused, the send still succeeds, the coin is never offered
   again);
8. a coinbase the wallet mined is not balance or spendable until mature, then spends;
9. one send gathers three coins; a fee above the reviewed maximum is refused; the fee quote's
   input count is the real selection;
10. a node not on the checkpoint chain is refused; a recipient of another network is refused
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
- F9 (review, 2026-11-19): a node refusing a rebroadcast is taken as proof the inputs went
  elsewhere (`finishPending`, and the eCash adapter's equivalent); on a multi-node network the
  refusing node may lag. Revisit both adapters before any non-regtest use.
- F10: `onSigned` across tabs: the per-wallet exclusive section is per realm; two tabs exposing
  the same recorded bytes are handled by refusal-then-lookup, not prevented.
- F11: the session's identity secret is held for every UTXO wallet's lifetime; the Lotus adapter
  takes no stealth custody and does not need it.
- F12: change-index gap: discovery scans 20 unused addresses; a run of more than 20 recorded but
  never-mined change addresses would be missed on restore.
- F13: relay cost of `/v2` reads is one anonymous unit per request regardless of the branches or
  page size asked for.
- F14: sync batching: the wallet reads one address per request; `/v2/branches/*` accepts several.
- F15: the wallet store is keyed by chain and first address, not bound to the run's checkpoint; a
  new regtest chain with the same seed reuses the old store's indices and records.
- F6: coin expiry (`expiration_height`) is not exposed by Chronik or `gettxout`; the wallet
  cannot warn before a coin expires (regtest minimum lifespan 131,400 blocks).
