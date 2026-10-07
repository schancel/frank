# @frank/wallet

Monad wallet client. It owns the HD keyring, the account pool and lease, stamp
and topic clients, and the `ActiveChain` compile-time chain-selection seam. It
has no Vue or Pinia dependency. The package is private. There is no barrel
`index.ts`; callers import the module they need.

Protocol semantics and the shipped/implemented/proposed boundary are indexed by
[`docs/CASHWEB-PROTOCOL-SPEC.md`](../../docs/CASHWEB-PROTOCOL-SPEC.md). This README describes the
current package, not target daemon support.

## Ownership

This package owns wallet workflows: identity, stamps, topic posts and votes,
and payment-proof requests against the relay. Monad HD derivation and signing
use ethers (`HDNodeWallet` and `Wallet`). It does not own CashWeb CBOR field
layouts or encryption suites. Frank-CBOR frames are `@frank/codec` and
`frank-cbor`. Deniable envelopes are `@frank/crypto-box`. Chain bytes and Lotus
address primitives are `@frank/nakamoto`.

The normal DM path and the default topic/profile writers still use protobuf
(`application/x-protobuf`); CBOR topic writes and account registration are
explicit opt-ins. Multi-chain UTXO serialization and script validation use
`@frank/nakamoto`. Relay encryption has not moved to `@frank/crypto-box` (issue
#258).

## Public entry points

- `monad-hd-keyring.ts`, `monad-identity.ts`, `monad-wallet-handle.ts`
- `monad-stamp-client.ts`, `monad-stamp-stealth.ts`
- `monad-topic-post-client.ts`, `monad-topic-vote-client.ts`, `monad-topic-tally-client.ts`
- `chain/active-chain.ts`
- `message-item-plugins/` for state channels and raffle

`@frank/cashweb` is the relay and registry client underneath these modules.
The headless demo that drives them is `@frank/bot`.

## Tests

From this directory: `yarn test`. Files named `*.livecheck.ts` talk to a
network and are not part of that Jest run.
