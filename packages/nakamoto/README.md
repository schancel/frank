# @frank/nakamoto

Typed chain library for BTC, BCH, XEC, XPI, DOGE, and LTC. Consensus bytes
follow those chains. The public API does not follow bitcore-lib. The package is
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
`./hd`, `./sign`, `./transaction`, `./script`, `./address`, `./block`, and
`./curve`. `src/index.ts` re-exports that surface. Built files live under
`dist/`.

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

