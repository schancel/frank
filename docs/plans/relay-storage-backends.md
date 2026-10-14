# Relay storage backend adoption

## Runtime boundary

`registry.cluster.driver` is parsed by `cashweb-config`. The daemon resolves it through
`RegistryConf::storage_driver` before creating a database directory or session secret.
Only `rocksdb` is currently implemented for the complete relay. FoundationDB, Kvrocks,
RESP aliases, and unknown names fail startup; they must never silently open RocksDB.
`registry.cluster.kvrocks_url` is also rejected while it has no runtime consumer.

Core NATS is selected separately by `registry.cluster.nats`. It carries ephemeral
notifications, not durable messages. Enabling NATS does not make independent RocksDB
replicas share data. Clients recover missed notifications by reading durable state.

The optional `cashweb-registry` `foundationdb` feature provides a real transaction driver
for component contract tests. It does **not** enable `driver = "foundationdb"` in the
daemon. The host must own the FoundationDB network lifetime and run synchronous driver
methods on blocking workers. The local labs describe the executable test boundary.

## Current durable owners

| State | Owner | Current persistence |
| --- | --- | --- |
| Registry metadata, profiles, topics, usernames and derived indexes | `store/db.rs` and its typed stores | RocksDB column families and atomic write batches |
| Canonical messages, payment claims, inboxes, challenges, notification policies and VAPID identity | `store/monad_dm_cbor.rs::Owner` | Separate RocksDB database, lazy opening and process-local mutation locks |
| Directory preview history | `store/directory_preview_owner.rs` | Separate RocksDB owner |
| Self-published directory subjects and continuity | `store/directory_subjects.rs` | Separate RocksDB database owned by the registry |
| Session signing secret for challenges, cursors and RPC capabilities | Daemon composition / `SessionSecret` | File beside the registry database |
| Notification delivery hints | `events::RelayEventBus` | In-memory broadcast or Core NATS; no durable authority |

`RelayKvStore` is a component transaction interface. Its existence does not replace the
owners above. In particular, a VAPID helper accepting this interface is not evidence
that canonical message admission or registry writes use it.

## Required predecessor stack

1. Pin the existing owners' externally observable behavior: atomic message admission,
   challenge consumption, username claims, profile/index replacement, payment recovery,
   inbox pagination, repeated delivery and restart. These tests must exercise the owners,
   not only an isolated KV implementation.
2. Move each owner to a backend-neutral transaction boundary in separately reviewed
   changes. Preserve one authoritative record and atomic updates to its derived indexes.
   Network waits must remain outside transactions. Process-local locks must not be
   represented as multi-replica exclusion; shared writes require backend conflict checks.
3. Resolve versionstamp semantics explicitly before adopting the driver for all owners.
   Native FoundationDB supplies one 10-byte stamp per transaction. The current in-process
   implementations allocate stamps per mutation. The live adapter therefore rejects
   more than one stamped mutation in a batch instead of pretending these contracts agree.
   A replacement contract must specify mutation disambiguation and pagination ordering,
   with tests for every supported backend.
4. Inject the validated backend through daemon composition into **every** durable owner.
   Shared deployments also need one stable cluster session-signing identity, explicit
   secret provisioning, and cross-replica validation. Independent filesystem-generated
   secrets are insufficient even when database data is shared.
5. Enable the additional runtime driver only after a multi-relay lab proves cross-replica
   reads, concurrent CAS, atomic indexes and stamped writes, VAPID bootstrap, durable
   catch-up after lost NATS events, process and database restart, and ambiguous commit
   handling without duplicate payment/message effects.

Dependency direction stays daemon composition → typed state owners → transaction
backend. State owners must not acquire NATS dependencies. Application and wire payloads
remain unchanged by the driver/lab work.

## Persistence and production scope

Local driver contracts use uniquely scoped synthetic records and disposable lab volumes.
They do not migrate, reset, copy or replace existing relay/wallet state. A future owner
refactor must explicitly document any key encoding or format changes and their reset
scope; pre-user development policy does not authorize deleting keys or funded wallets.

These labs do not modify private deployment manifests, release records, production
images or signet.mx. Backend adoption and any later deployment are separate decisions.
