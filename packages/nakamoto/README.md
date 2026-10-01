# @frank/nakamoto

Typed chain library for BTC, BCH, XEC, and XPI. Consensus bytes follow those
chains. The public API does not follow bitcore-lib. The package is private and
unpublished. Browser-safe: the public modules do not use Node built-ins.

## Ownership

This package owns integers, script numbers, script evaluation, base58 and
cashaddr codecs, transactions, blocks, BIP32 HD nodes, secp256k1 keys, ECDSA,
Schnorr, and ECDH. It does not own CashWeb frames, protobuf, relay mail, or
encryption suites. Those belong to `@frank/codec`, `frank-cbor`, and
`@frank/crypto-box`.

XPI address strings are not pinned (issue #242). `encodeAddress` and
`decodeAddress` for the XPI family return `address-format-not-pinned` and do
not invent a prefix.

## Public entry points

`package.json` `exports` is the surface. Import `@frank/nakamoto` or a chain
entry (`./btc`, `./bch`, `./xec`, `./xpi`). Feature entries include `./keys`,
`./hd`, `./sign`, `./transaction`, `./script`, `./address`, and `./curve`.
`src/index.ts` re-exports that surface. Built files live under `dist/`.

## Callers

`@frank/cashweb` and `@frank/wallet` call the typed helpers for hashes, HD
derivation, and signatures. A caller passes bytes and a chain id. It does not
import `bitcore-lib-xpi` from this package. Attribution for the bitcore-derived
parts is `ATTRIBUTION.md`.

## Tests

From this directory: `yarn test`.
