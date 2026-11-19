# @frank/nakamoto

Typed chain library for BTC, BCH, XEC, XPI, DOGE, LTC, and Lotus v2 (regtest).
Consensus bytes follow those chains. The public API does not follow bitcore-lib. The package is
private and unpublished. Browser-safe: the public modules do not use Node
built-ins.

## Ownership

This package owns the chain objects: HD private and public nodes, keys,
transactions, scripts, addresses, integers, and script numbers, plus script
evaluation, base58, cashaddr, bech32/bech32m, ECDSA, Schnorr, and ECDH. Callers
build and pass those objects. They do not drop down to raw scalars for ordinary
work.

Chain behavior in `address.ts`, `block.ts`, `transaction.ts`, and `script.ts`
is driven by explicit capability fields on `ChainDescriptor` (`lotusNetChar`,
`merkleOddRule`, `sighash.commitUtxos`, `bech32Hrp`, `cashaddrPrefix`,
`header`, and `script`) rather than `chain.family` switches.

Every descriptor has a `format`. `'bitcoin'` descriptors (`ChainDescriptor`,
the chains above) use those fields. `'lotus-v2'` descriptors
(`LotusV2ChainDescriptor`) are a different object model: native version-7
transactions, BLAKE3-tagged identities committed to a ChainID, the P02 indexed
Merkle tree, typed `xpi1`/`txpi1`/`rxpi1` addresses, and BIP340 x-only
signatures with three signing modes. Their capability fields (`chainId`,
`transactionVersion`, `hash`, `merkle`, `address`, `signature`) drive
`src/lotus-v2/`; nothing switches on a chain name. Only `LOTUS_V2_REGTEST` is
defined: Lotus v2 mainnet and testnet have no launch parameters yet, and the
address codec reports their well-formed strings as `network-not-defined`. The
spec is the Lotus repository's `docs/lotus-v2/` (P01, P02, `addresses.md`);
the test vectors in `test/fixtures/lotus-v2/` come from lotusd and the Lotus
reference tool. Legacy coins (P01 "Spending a legacy coin") are parsed and
their P2PKH and P2SH bridge signing messages computed; P2PKH bridge spends are
built and verified, P2SH script evaluation is an explicit unsupported error.
Fees are computed from the spec without running scripts: `lotusV2StaticCost`
(P05 static cost algebra, approved schedule), `lotusV2RequiredFee` under a
`LotusV2FeeRule` (the byte floor lotusd enforces today, or rule (c) with
caller-supplied E and subsidy indices), and `buildLotusV2Transaction`, which
signs a transaction paying exactly that fee
(`docs/plans/lotus-v2-base/README.md` "Fees"). VM execution and block/state
commitments are not implemented; a mint signature message is an explicit
unsupported error.

It does not read or write CashWeb CBOR. `@frank/codec` and `frank-cbor`
marshal a frame and pass the digest bytes into a nakamoto sign or hash call.
The key that signs is still a nakamoto key object. Encryption suites are
`@frank/crypto-box`. That package seals byte arrays. Crypto-box does not parse
Frank/CashWeb CBOR; it privately parses only its fixed-schema envelope CBOR.

XPI address strings are pinned to the Lotus encoding (`lotus_` on mainnet,
`lotusT` on testnet, `lotusR` on regtest) via `chain.lotusNetChar`.
`encodeAddress` and `decodeAddress` emit and parse those strings natively with
checksum verification.

## Public entry points

`package.json` `exports` is the surface. Import `@frank/nakamoto` (which
exports `BTC_*`, `BCH_*`, `XEC_*`, `XPI_*`, `DOGE_MAINNET`, `DOGE_TESTNET`,
`LTC_MAINNET`, `LTC_TESTNET`, `CHAINS`, and `getChain`) or a dedicated chain
entry (`./btc`, `./bch`, `./xec`, `./xpi`). Feature entries include `./keys`,
`./hd`, `./sign`, `./transaction`, `./script`, `./address`, `./block`,
`./curve`, and `./lotus-v2` (`LOTUS_V2_REGTEST` and the Lotus v2 objects).
`src/index.ts` re-exports that surface. Built files live under `dist/`.

## Callers

Monad wallet HD derivation and signing in `@frank/wallet` and `app/` use `ethers`
(`HDNodeWallet` and `Wallet`). `@frank/nakamoto` owns UTXO/Lotus chain primitives,
address codecs (Base58Check, Bech32/Bech32m, CashAddr, Lotus XAddress), and
secp256k1 curve primitives (`ecdh`, `publicFromPrivate`).
A digest that came from a CashWeb frame is a byte string argument to that call.
Callers do not import `bitcore-lib-xpi` from this package. Attribution for the
bitcore-derived parts is `ATTRIBUTION.md`.

## Tests

From this directory: `yarn test`.

