# Wallet storage boundaries

Follow the repository-wide custody, persistence and recovery invariants. Storage
modules own different durable facts; this directory is not one interchangeable
repository API.

For the outgoing-message repository, read [its contract](outgoing-message-store.md)
and `outgoing-message-store.ts` before opening canonical delivery implementation.
The public internal API is `OutgoingMessageStore`, its record types, the memory and
Level implementations, `noticeOldLinkState`, and `validateSharedStoredMessage`.

Do not move payment transitions, reservation policy or transport into that module.
Keep its existing namespaces, encoded records, write-before-memory ordering and
read-only v1 normalization unchanged unless the task explicitly authorizes a new
contract. A failed presentation write is not permission to discard signed work.

Run from the repository root:

```sh
yarn --cwd packages/wallet test chain/outgoing-message-store.jest.test.ts storage/outgoing-message-store-boundary.jest.test.ts --runInBand
```

Execution/recovery changes also require the composed suites named in the contract.
Do not infer that other stores share this repository's concurrency or lifecycle
semantics: the native operation journal owns its own serialization and admission.
