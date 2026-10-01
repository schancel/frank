# @frank/wallet

Monad wallet client. It owns the HD keyring, the account pool and lease, stamp
and topic clients, and the `ActiveChain` compile-time chain-selection seam. It
has no Vue or Pinia dependency. The package is private. There is no barrel
`index.ts`; callers import the module they need.

## Ownership

This package owns wallet workflows: identity, stamps, topic posts and votes,
and payment-proof requests against the relay. It does not own CashWeb CBOR
field layouts or encryption suites. Frank-CBOR frames are `@frank/codec` and
`frank-cbor`. Deniable envelopes are `@frank/crypto-box`. Chain bytes are
`@frank/nakamoto`.

The live relay path in this package is still protobuf (`application/x-protobuf`).
Some key operations still use `bitcore-lib-xpi` while issue #257 is open.
Relay encryption has not moved to `@frank/crypto-box` (issue #258).

## Public entry points

- `monad-hd-keyring.ts`, `monad-identity.ts`, `monad-wallet-handle.ts`
- `monad-stamp-client.ts`, `monad-stamp-stealth.ts`, `monad-pop-client.ts`
- `monad-topic-post-client.ts`, `monad-topic-vote-client.ts`, `monad-topic-tally-client.ts`
- `chain/active-chain.ts`
- `message-item-plugins/` for blackjack and raffle

`@frank/cashweb` is the relay and registry client underneath these modules.
The headless demo that drives them is `@frank/bot`.

## Tests

From this directory: `yarn test`. Files named `*.livecheck.ts` talk to a
network and are not part of that Jest run.
