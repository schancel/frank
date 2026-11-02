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
these owners: groups under `<fdb_subspace_prefix>groups-v1/`, the registry `Db` under
`<fdb_subspace_prefix>registry-v1/`, direct messages under `<fdb_subspace_prefix>messages-v4/`,
the directory under `<fdb_subspace_prefix>directory-v1/`, and the forum under
`<fdb_subspace_prefix>forum-v1/` (probed at startup only when `[registry.forum]` is set). Group and directory store calls run on blocking
workers; registry calls on a shared store hand their async worker over with
`block_in_place`. Startup and `--check-db` open these stores and read their format markers
(the directory only when `[registry.directory]` is configured), and fail if one cannot be
read. Every other owner below still opens its own RocksDB.

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
The flag is refused when cluster mode is off. `reserved_usernames` must be identical on every
replica, because it guards the username namespace they now share.

Core NATS is selected separately by `registry.cluster.nats`. It carries ephemeral
notifications, not durable messages, on `frank.<cluster>.dm.<address>` and
`frank.<cluster>.grp.<group_id>`. Enabling NATS does not make independent RocksDB
replicas share data. Clients recover missed notifications by reading durable state.

## Current durable owners

| State | Owner | Current persistence |
| --- | --- | --- |
| Registry metadata, profiles, topics, usernames and derived indexes | `store/db.rs` and its typed stores over `RelayKvStore` | RocksDB at the registry path, or FoundationDB (`driver = "foundationdb"`); one transaction per claim or replace, including its index rows (key layout in `store/db.rs`) |
| Canonical messages, payment claims, inboxes, challenges, notification policies and VAPID identity (the provisioned `registry.vapid_private_key_file` when set) | `store/evm_direct_messages.rs::Owner` | Separate RocksDB database, lazy opening and process-local mutation locks |
| Directory preview history, self-published subjects and continuity, address and first-accepted indexes, subject counters, forwards and their bodies, federation lease | `store/directory_store.rs` (`directory_preview.rs`, `directory_subjects.rs`) over `RelayKvStore` | RocksDB `directory-kv-v1.rocksdb` inside the registry path, or FoundationDB (`driver = "foundationdb"`); values over 64 KiB in the object store (`[registry.large_values]`) |
| Existing directory enrollment and RPC/WS/Electrum hourly quotas | `http/hourly_quota.rs::FixedHourQuota`, composed explicitly into every consumer | Standalone process memory by default; explicitly configured ephemeral Redis hashes with TTL/fail-open behavior |
| Shared group mailboxes | `store/groups.rs::GroupStore` over `RelayKvStore` | RocksDB beside the registry database, or FoundationDB (`driver = "foundationdb"`) |
| Session signing secret for challenges, cursors and RPC capabilities | Daemon composition / `SessionSecret` | `registry.session_secret_file` (required in cluster mode), else a file beside the registry database |
| Notification delivery hints | `events::RelayEventBus` | In-memory broadcast or Core NATS; no durable authority |

Hourly allowances are ephemeral and independent of the durable transaction driver. Standalone
relays default to process-local counters. Shared deployments explicitly configure:

```toml
[registry.hourly_quotas]
driver = "redis"
redis_url_env = "FRANK_QUOTA_REDIS_URL"
key_prefix = "frank-hourly-v1/frank-demo/"
timeout_ms = 100
max_in_flight = 64
```

Host composition reads the named environment variable (a `redis://` single-node URL; optional
Redis credentials stay in that variable), validates it without connecting, then shares one
bounded multiplexed client across all existing directory, RPC HTTP, WS and Electrum consumers.
The example URL for a private service is `redis://redis:6379/`; the Redis service's access and
resource policy belongs to operator deployment configuration. Redis 7+ is required by the Lua
ACL checks. No connection manager, local counter fallback, TLS/cluster transport, or background
unbounded reconnect queue is installed. A worker is spawned only after acquiring the shared
permit; at most the configured number can exist. It retains its permit and absolute deadline
after caller cancellation, and synchronously retires timed-out connection generations. This
bounds unanswered Redis commands even when WebSocket deadline handling cancels a quota wait. Static invalid configuration fails startup; a valid
unavailable Redis does not. The total quota deadline includes bounded connector waiting,
connect and command time. Saturation degrades immediately; reconnect attempts share one connector
and a cooldown of at least one second (never shorter than the configured timeout). Warnings contain fixed failure classes and the canonical relay
network, never URL/credentials/payers/body, and are suppressed for 30 seconds per backend.

One atomic script owns a hash per configured prefix, canonical relay network, existing domain
and UTC hour. Payer fields store weighted usage; distinct payer capacity stays 100,000 per bucket.
Arguments, existing counter values and write permissions are checked before writing. Absolute
expiry at `(hour+2)*3600` retains the current and previous bucket without a GC loop. Existing
weights, exemptions, IP normalization and per-handle rollback clock semantics remain. A typed
prepared request crosses reusable Axum middleware on directory PUT after its bounded body,
federation and signed-subject checks; known publishers are exempt, and first signed attempts
still precharge before business admission. RPC handlers and long-lived WS/Electrum messages
use the same limiter after their existing authentication and retain absolute session/pending
deadlines. No body decoding, signature verification or charge is duplicated by the generic layer.

Confirmed hourly exhaustion returns HTTP 429. Other policy denials retain each route’s existing
status: for example, RPC distinct-payer capacity is HTTP 503 while directory resource capacity
is HTTP 429. Redis connection/timeout/AUTH/OOM/script/uncertain
results produce explicit degraded allowance with no measured remaining snapshot; they fail
OPEN. Frank request authentication, enrollment/business rules, payments and durable FDB errors
retain their existing failure behavior. Disabled quotas and individually oversized charges
retain their existing rejection semantics even during Redis outage. This is deliberately a
best-effort allowance under backend failure, not a durable security or financial boundary.

Redis restart, data loss or initial switch resets ephemeral allowances; no allowance backup,
migration or continuity claim is made. Memory pressure with noeviction produces errors that
also fail open. Operators bound Redis memory separately. Reversing this choice changes failure
behavior and may reset the hourly budget; it does not change durable enrollment/payment data.
The superseded `<fdb_subspace_prefix>hourly-quotas-v1/` quota path has no reader/writer or cleanup
worker. Existing records are left untouched; quota-only disposal is an explicit operator action
after old writers are stopped, never a startup reset. Other FDB owners and formats are unchanged.

`RelayKvStore` is a component transaction interface. Its existence does not replace the
owners above: `GroupStore`, the registry `Db` and the directory use it today, so it is not
evidence that canonical message admission does. Groups, the registry and the directory are
the owners a FoundationDB-backed relay shares between replicas.

The registry's earlier RocksDB column families (including the retired protobuf topic
tables) have no reader: a registry database holding any of them is refused at startup with
the development reset, which deletes only that registry path and its message stores (no
keys, no funds). A shared store holding rows of another format, or rows without the
`registry-kv-v1` marker, is refused too; the reset is clearing that cluster's registry
subspace. Profile and topic values longer than 100 KB are split into parts in the same
transaction until large values move to the object store.

Large values over 64 KiB live in `[registry.large_values]`, one object namespace per owner:
`groups/`, `directory/` and `forum/`. Each namespace holds a `claim` object tying it to that owner's
transaction store. A development reset of an owner therefore deletes both its transaction
store (RocksDB path or FoundationDB subspace) and its object prefix (`<bucket
prefix>/groups/`, `<bucket prefix>/directory/` or `<bucket prefix>/forum/`), or the next start refuses the namespace
as claimed by another index. A single-node relay without `[registry.large_values]` keeps its
objects in `<registry db_path>.large-values`, for example `registry.rocksdb.large-values`. A
relay built before #1858 kept local large values at `<stem>.large-values`; delete it.

A single-node relay keeps the forum in `<registry db_path>.forum-kv-v1`. The earlier forum
sidecar `<registry db_path>.forum-cbor-v1` has no reader: startup refuses while it exists and
names it (public posts and burn records only; no keys, no funds).

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
