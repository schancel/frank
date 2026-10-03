# @frank/cashweb

CashWeb protocol client for the Lotus relay, including the Monad message
envelope and feed, the cashweb registry, BIP70, signed payloads, and the shared
legacy Lotus identity and UTXO wallet. No Vue or Pinia dependency. The package
is private. There is no barrel `index.ts`.

## Ownership

This package owns client workflows for the relay and the registry. It does not
own CashWeb CBOR field layouts. Canonical frames are `@frank/codec` and
`frank-cbor` (`docs/protocol/cbor/`). Chain primitives it has already migrated
go through `@frank/nakamoto`. Encryption suites are `@frank/crypto-box`.

The live wire in this package is still protobuf. `relay/` still uses
`node-forge` for stored mail until issue #258. Remaining `bitcore-lib-xpi`
imports are issue #257. Topic CBOR that the registry verifies is decoded with
`frank-cbor` on the Rust side, not by a second encoder in this package.

## Layout

- `relay/` — profiles, messages, stamps, stealth, and the Monad envelope
- `registry/` — names, burns, and broadcast payloads
- `legacy-wallet/` — Lotus identity, UTXOs, and signing
- `signed_payload/` — signed payload helpers
- `bip70/` — payment requests
- `types/` — shared client types
- `pop.ts` — proof-of-payment helper

`@frank/wallet` is the usual caller.

The normative human semantics and status index is
[`docs/CASHWEB-PROTOCOL-SPEC.md`](../../docs/CASHWEB-PROTOCOL-SPEC.md). This package's protobuf
wire remains the shipped compatibility path until the indexed clean-break cutover.

## License

The license of this directory is NOT GPLv3. It is MIT, so you can use it in
backend services on top of CashWeb. See `LICENSE`.
