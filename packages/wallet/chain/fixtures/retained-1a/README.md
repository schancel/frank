# Retained original storage bridge fixture

The two `.ts.txt` files are exact Git blobs from public source
`1a2326ce0d02f351dbfdd3e67c0b5ea83692268a`; `manifest.json` records their
paths, sizes and SHA256. `retained-original-cutover.suite.ts` checks the raw bytes
before transpilation, then resolves their imports against current dependencies.
The suite is registered once by `chain/outgoing-message-store.jest.test.ts`, which
is already selected by the hosted wallet job. Run that existing suite with:

```sh
yarn workspace @frank/wallet test --ci --runInBand chain/outgoing-message-store.jest.test.ts
```

This tests historical storage writers and current readers with freshly constructed
synthetic typed-wallet graphs. Construction, crypto, protocol validators, coin
store and directory dependencies are current. It does not reproduce the complete
historical sender/codec or independently prove deployed image source contents.
Root independently matched these two raw files (plus canonical-dm and level-storage)
to the exact generation-pinned source archives of the actual old frontend/relay
builds, including source.json full1a SHA and compressed archive metadata checks.
That proves these selected source members, not every historical dependency or the
complete historical sender/codec. Private qualification receipt:
`old-source-selected-member-proof-3b874e8f-9752-4de0-8fa0-0137605c0b39/ROOT-ASSESSMENT.json`.

The old writers are called directly, never adapted into current wallet ports. In
particular the old outgoing store lacks current self-copy enumeration methods.
The test deliberately selects fields present in the old StoredMessage interface:
current-only `unstored`, self-copy flags, replacement graphs and recovery ceilings
are not smuggled into the historical fixture. The covered family is an ordinary
unsealed shared-set message with its complete original signed graph. Original
bytes, destinations, values, and account/nonce claims survive current reopen and
empty-backend recipient refusal. Exposure/observations may advance as recovery
learns facts; those are distinct from the immutable economic original.

Four cuts cover durable host barrier, handed/lost answer, stored/lost answer and
delivered/before stamp settlement. Missing graph must fail restoration visibly.
The empty-backend response is the current relay semantic stand-in, not an actual
FDB/HTTP qualification. No real chain, funds, wallet/profile or network is used.

Reproduce an archive without modification (use the corresponding path for each):

```sh
git show 1a2326ce0d02f351dbfdd3e67c0b5ea83692268a:packages/wallet/storage/outgoing-message-store.ts > outgoing-message-store.ts.txt
git show 1a2326ce0d02f351dbfdd3e67c0b5ea83692268a:packages/wallet/storage/evm-native-operation-journal.ts > evm-native-operation-journal.ts.txt
```

These archives are test data, not production compatibility implementations. Root
owns any further provenance, full historical writer or browser cutover evidence.
