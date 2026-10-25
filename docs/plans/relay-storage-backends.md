# Relay storage backend adoption

> Cluster adoption plan: [relay-ha-cluster.md](relay-ha-cluster.md).

## Runtime boundary

`registry.cluster.driver` is parsed by `cashweb-config`. The daemon resolves it through
`RegistryConf::storage_driver` before creating a database directory or session secret.
`rocksdb` (the default) and `foundationdb` are accepted; Kvrocks, RESP aliases and unknown
names fail startup, and settings the chosen driver would ignore (`kvrocks_url`, or
`fdb_cluster_file`/`fdb_subspace_prefix` with RocksDB) are refused, so nothing silently
falls back to RocksDB.

`foundationdb` needs a daemon built with `cargo build -p cashwebd-exe --features
foundationdb`, which links the FoundationDB 7.3 client library (`libfdb_c`); a build
without the feature refuses the driver, at startup and in `--check-config`. The host boots
the FDB network once in `main`, before the async runtime. At shutdown it drops the runtime,
which waits for every blocking worker to return, and only then stops the network. Every FDB
transaction carries a 15 s timeout spanning its retries, so an unreachable cluster returns a
typed timeout to the request instead of holding a worker forever. If the network thread
itself stops, the daemon logs it and exits so its supervisor restarts it; the network cannot
be restarted in-process.

`fdb_subspace_prefix` is one or more segments of letters, digits, `-` or `_`, each ending in
`/` (for example `frank-prod/`), so `frank/` and `frank2/` never share keys. Two relays must
not use a prefix that is a leading run of the other's segments. The driver currently backs
one owner, groups, under `<fdb_subspace_prefix>groups-v1/`; group store calls run on
blocking workers. `--check-db` opens and reads that store. Every other owner below still
opens its own RocksDB.

Cluster mode is `registry.cluster.enabled = true`. It requires an enabled
`[registry.cluster.nats]`, a `cluster_name` (one NATS subject token), and the
operator-provisioned files `registry.session_secret_file` (32 raw bytes) and
`registry.vapid_private_key_file` (the P-256 scalar as hex or base64url, between 1 and n - 1;
it is refused, not reduced). Both files are read, never created, must be readable by their
owner only (mode `0400` or `0600`; on Kubernetes set the Secret volume's
`defaultMode: 0400` and run as the file owner, and `chmod 0400` host files that are bind
mounted), and must be identical on every replica. `--check-config`
reads and checks both. A single node without these keys
keeps creating its session secret beside the database. Cluster mode refuses to start while
any enabled owner is still replica-local (`RegistryConf::replica_local_owners`) unless
`registry.cluster.preview_replica_local_owners = true`, in which case each is logged by name.
The flag is refused when cluster mode is off.

Core NATS is selected separately by `registry.cluster.nats`. It carries ephemeral
notifications, not durable messages, on `frank.<cluster>.dm.<address>` and
`frank.<cluster>.grp.<group_id>`. Enabling NATS does not make independent RocksDB
replicas share data. Clients recover missed notifications by reading durable state.

## Current durable owners

| State | Owner | Current persistence |
| --- | --- | --- |
| Registry metadata, profiles, topics, usernames and derived indexes | `store/db.rs` and its typed stores | RocksDB column families and atomic write batches |
| Canonical messages, payment claims, inboxes, challenges, notification policies and VAPID identity (the provisioned `registry.vapid_private_key_file` when set) | `store/monad_dm_cbor.rs::Owner` | Separate RocksDB database, lazy opening and process-local mutation locks |
| Directory preview history | `store/directory_preview_owner.rs` | Separate RocksDB owner |
| Self-published directory subjects and continuity | `store/directory_subjects.rs` | Separate RocksDB database owned by the registry |
| Shared group mailboxes | `store/groups.rs::GroupStore` over `RelayKvStore` | RocksDB beside the registry database, or FoundationDB (`driver = "foundationdb"`) |
| Session signing secret for challenges, cursors and RPC capabilities | Daemon composition / `SessionSecret` | `registry.session_secret_file` (required in cluster mode), else a file beside the registry database |
| Notification delivery hints | `events::RelayEventBus` | In-memory broadcast or Core NATS; no durable authority |

`RelayKvStore` is a component transaction interface. Its existence does not replace the
owners above: only `GroupStore` uses it today, so it is not evidence that canonical message
admission or registry writes do. Groups are the only owner a FoundationDB-backed relay
shares between replicas.

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
