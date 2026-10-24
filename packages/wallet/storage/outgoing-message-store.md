# Outgoing-message repository

`outgoing-message-store.ts` owns persistence mechanics for canonical outgoing
message records. Canonical execution owns their transitions. The native operation
journal separately owns reservations, signed members, authorization and chain
observations; this repository does not duplicate that authority.

## API and durable representation

`OutgoingMessageStore` exposes `all`, `get`, `put`, `unpaid`, `unpaidByDigest`,
`setUnpaid` and `close`. `LevelOutgoingMessageStore.open(location)` opens the
`outgoing-messages-v1` namespace. Paid rows are JSON keyed by `consumerId`; retained
free envelopes use `unpaid-envelope:<messageId>`. Host-bound free envelopes retain
their delivery facts for the owning financial workflow.

`put` and `setUnpaid` await durable writes/deletes before changing their in-memory
views. A rejected write leaves the prior memory view intact. There is no private
serialization queue or `flush` method: execution owners retain their existing
ordering/exclusion responsibilities. Read access does not deep-clone records.

Opening v1 rows supplies the historical empty change list in memory without
rewriting disk. v2 rows require valid construction, operation/stage references and
payment/change shapes. Open failures close the acquired handle and remain errors.
`noticeOldLinkState` observes and warns about the old namespace; it does not read,
migrate or delete its contents.

`validateSharedStoredMessage` is exported for internal execution use. Repository
open/put, canonical construction and claim restoration all retain their validation
calls. This structural validator does not prove signatures or journal consistency;
execution performs those additional checks against the financial authority.

## Recovery boundary

Persisted intent, signed payment/change bytes and delivery status belong to the
original message. The repository never regenerates transactions or determines that
a failed/uncertain submission had no financial effect. Canonical execution keeps
pre-exposure authorization, durable-envelope authorization and attempt-created
notification distinct. Ordinary digest-link failure stops the current invocation;
the durable-envelope barrier additionally gates subsequent replay.

## Verification

The focused command is in [AGENTS.md](AGENTS.md). Its tests use real Level storage,
reopen fixtures and injected write failures. The dependency test checks imports,
type imports, re-exports, aliases, dynamic imports and require calls, including the
local durability helper. Keep these checks in CI when changing the boundary.

For execution integration, run the wallet suites `canonical-before-exposure`,
`canonical-dm-message-id`, `canonical-dm-delivery`, `evm-combined-payment-stamp`,
`evm-completed-history-composition` and `evm-shared-canonical-callers`, plus app
`chats.outgoing` and bot `qwen-host-safety`. These exercise exposure ordering,
original-byte replay and consumers; repository-only tests do not prove those facts
or native-browser durability.
