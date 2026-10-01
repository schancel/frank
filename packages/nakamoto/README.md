# @frank/nakamoto

Typed chain library for BTC, BCH, XEC, and XPI. Consensus bytes follow those
chains. The public API does not follow bitcore-lib. The package is private and
unpublished. Browser-safe: the public modules do not use Node built-ins.

## Ownership

This package owns the chain objects: HD private and public nodes, keys,
transactions, scripts, addresses, integers, and script numbers, plus script
evaluation, base58, cashaddr, ECDSA, Schnorr, and ECDH. Callers build and
pass those objects. They do not drop down to raw scalars for ordinary work.

It does not read or write CashWeb CBOR. `@frank/codec` and `frank-cbor`
marshal a frame and pass the digest bytes into a nakamoto sign or hash call.
The key that signs is still a nakamoto key object. Encryption suites are
`@frank/crypto-box`. That package seals byte arrays and does not parse CBOR.

XPI address strings are not pinned (issue #242). `encodeAddress` and
`decodeAddress` for the XPI family return `address-format-not-pinned` and do
not invent a prefix.

## Public entry points

`package.json` `exports` is the surface. Import `@frank/nakamoto` or a chain
entry (`./btc`, `./bch`, `./xec`, `./xpi`). Feature entries include `./keys`,
`./hd`, `./sign`, `./transaction`, `./script`, `./address`, and `./curve`.
`src/index.ts` re-exports that surface. Built files live under `dist/`.

## Callers

`@frank/cashweb` and `@frank/wallet` derive HD nodes, build keys, and sign
with those objects. A digest that came from a CashWeb frame is a byte string
argument to that call. Callers do not import `bitcore-lib-xpi` from this
package. Attribution for the bitcore-derived parts is `ATTRIBUTION.md`.

## Tests

From this directory: `yarn test`.
