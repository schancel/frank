# Group message feature ownership

This headless feature owns the `group-welcome` and `group-control` payload types,
CBOR schemas, previews and hydration. `groups/*-codec.ts` and
`groups/epoch-certificate.ts` are pure; `groups/plugin.ts` explicitly installs the
runtime plugins. UI state transitions and renderers remain in app composition.

Cashweb owns the neutral registry contract in `message-items/registry.ts` and the
signed relay epoch transport record in `groups/types.ts`. Core codec owns FRNK
framing, identifier allocation and the enclosing traversal/size budget. Wallet
custody supplies signing capabilities and does not import this feature.

Hosts create their base registry and call
`installGroupMessageItemPlugins(registry, capabilities)`. Importing types or
runtime modules does not install anything. The `MessageItemExtensions` type map
adds the feature's discriminated payload types without a transport-to-feature
import; runtime installation remains required. App, bot, mail and CLI hosts
install explicitly. Wallet-only composition treats group items as unsupported.

This extraction preserves wire identifiers, CBOR bytes, certificates, encrypted
group semantics and all persisted/derived identities. Signed certificates remain
authoritative; frontend roster views remain derived. No migration or reset is
required. This is ownership work, not external cryptographic review.

The before-extraction fixtures were encoded directly from revision
`24f474fe575f8399738c4eec7d3a3118e510db95` and are checked byte-for-byte in
`groups/plugin.jest.test.ts`. Run:

```sh
yarn typecheck:fast
./node_modules/.bin/jest --config packages/group-messaging/jest.config.js --runInBand
./node_modules/.bin/jest --config packages/wallet/jest.config.js --runInBand --runTestsByPath packages/wallet/chain/canonical-item-roundtrip.jest.test.ts packages/wallet/message-item-plugins/decoder-limits.jest.test.ts
./node_modules/.bin/jest --config app/jest.config.js --runInBand --runTestsByPath app/src/stores/chats-group-sync.jest.test.ts
```

The dependency check covers this feature, neutral registry/helpers, and wallet
production imports. A pre-existing broader Cashweb backedge remains separately
scoped: `relay/canonical-dm-transport.ts` imports wallet's `PROTOCOL_CHAINS` for
network selection. This extraction does not claim that whole-package gap is fixed.
