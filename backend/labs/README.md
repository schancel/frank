# Local storage and notification labs

These labs are separate from the root demo Compose stack and from all deployment
configuration. Run commands from the repository root of an isolated worktree.
Docker Compose v2 and a running Docker Engine are required. Every published port
binds to `127.0.0.1`; each lab has its own project network and disposable volumes.
Do not point either lab at existing databases, funded identities, or production
NATS. There are no chain RPC credentials or wallet keys in these files.

## Ownership and scope

This ordinary implementation adds local test infrastructure only. The daemon
currently opens the registry and direct-message stores with raw RocksDB APIs.
`RelayKvStore` is a separate transactional storage contract; implementing its
FoundationDB driver does not switch those daemon stores to FoundationDB.
NATS carries ephemeral wakeups, while durable store reads supply catch-up data.
No persistent or wire format changes, migrations, production configuration changes,
or deployment commands are part of these labs.

The acceptance evidence is a running single Rocks relay that selects the real
NATS bus, a real NATS delivery plus Rocks cursor/reopen contract, and a real FDB
transaction-driver test when its optional implementation is present. These
component contracts do not establish end-to-end HTTP payment admission or a
multi-replica FoundationDB-backed relay. That requires migrating every durable
owner onto the selected storage contract before selecting it in the daemon.

## Single Rocks relay + Core NATS

```sh
docker compose -f backend/labs/compose.rocks-nats.yml up -d --build relay
curl --fail http://127.0.0.1:18222/healthz
docker compose -f backend/labs/compose.rocks-nats.yml logs relay
# The log must say "Connecting to Clustered Core NATS notification bus".
curl --fail http://127.0.0.1:18084/metadata

docker compose -f backend/labs/compose.rocks-nats.yml --profile test run --build --rm contract
```

If port 18084 is occupied, set `FRANK_LAB_RELAY_PORT` for Compose and use that
port in the HTTP probe. For experiments that rely on the relay's advertised URL,
update `url` in your isolated copy of `rocks-nats.toml` to match the override.

The lab reads `rocks-nats.toml`, including the actual
`[registry.cluster.nats]` settings. Setting an arbitrary `NATS_URL` environment
variable is not equivalent. The explicit driver is `rocksdb`; only one relay
opens its embedded database. Do not scale that service or share its data volume
with another relay. Mailbox/payment routes and external RPC proxies are disabled
so starting the lab cannot broadcast transactions or query a production chain.
The directory/profile and legacy metadata routes may still reject operations
that require a real chain adapter; this is a storage and bus baseline.

The `contract` profile compiles `backend_contract.rs` as an integration test of the
real registry crate inside the image. It subscribes on one real Core NATS
connection and publishes from another, then disconnects the subscriber, stores a
second envelope, reopens RocksDB, and reads only the missing row after the saved
cursor. The database and recipient are fresh per test. It deliberately asserts
durability via storage rather than expecting Core NATS to replay missed events.

```sh
# Stop while retaining this lab's state:
docker compose -f backend/labs/compose.rocks-nats.yml down
# Explicitly delete only this disposable lab's state:
docker compose -f backend/labs/compose.rocks-nats.yml down --volumes
```

## FoundationDB + Core NATS infrastructure and driver contract

This Compose file does **not** launch a FoundationDB-backed Frank relay. It
provides FDB 7.3.63 and Core NATS, plus an optional `driver-contract` profile for
checkouts containing the `cashweb-registry` `foundationdb` feature and ignored
`live_foundationdb_contract` test. Server and native client versions are matched.
The profile intentionally fails to build if that implementation is absent.

```sh
docker compose -f backend/labs/compose.foundationdb-nats.yml up -d fdb nats
# On a NEW disposable database only, initialize the single-node lab:
docker compose -f backend/labs/compose.foundationdb-nats.yml exec fdb \
  fdbcli -C /cluster/fdb.cluster --timeout 20 --exec 'configure new single ssd'
docker compose -f backend/labs/compose.foundationdb-nats.yml exec fdb \
  fdbcli -C /cluster/fdb.cluster --timeout 10 --exec 'status minimal'
curl --fail http://127.0.0.1:28222/healthz

docker compose -f backend/labs/compose.foundationdb-nats.yml --profile test \
  run --build --rm driver-contract
```

The first test runs:

```sh
cargo test -p cashweb-registry --features foundationdb live_foundationdb_contract \
  -- --ignored --nocapture
```

`FRANK_FDB_CLUSTER_FILE=/cluster/fdb.cluster` points at the cluster file shared
with the FDB container. The driver tests use a fresh subspace and check real
transactional behavior. A second process runs the same real NATS/offline cursor
contract as the Rocks lab, with `FoundationDbKvStore` and the live driver selected
at compile time by the feature. It reopens an independent client and deletes only
its random test subspace's inbox rows on success. NATS does not provide the FDB
durability or CAS.
FDB advertises its container IP, so tests run inside the Compose network. Merely
publishing its coordinator port would not provide a working host client on
Docker Desktop. The FDB service therefore has no published host port. Its initial
health check remains unhealthy until the explicit initialization command runs.
Do not run `configure new` against a previously initialized database.

The cluster file persists with its data, including the advertised coordinator IP.
These are disposable single-node labs, not a stable cluster topology: after a
container/network recreation, reset this lab's volumes if its coordinator address
changes. This is not a production restart/recovery procedure.

```sh
docker compose -f backend/labs/compose.foundationdb-nats.yml down
# Explicitly reset only this lab, then repeat initialization:
docker compose -f backend/labs/compose.foundationdb-nats.yml down --volumes
```

## References

- [FDB container entrypoint](https://github.com/apple/foundationdb/blob/main/packaging/docker/fdb.bash)
  documents container networking and cluster-file generation.
- [FDB Docker README](https://github.com/apple/foundationdb/blob/main/packaging/docker/README.md)
  warns its older Compose samples are outdated; these labs follow the current entrypoint.
- [NATS configuration](https://docs.nats.io/running-a-nats-service/configuration)
  and [Core NATS](https://docs.nats.io/nats-concepts/core-nats) describe its
  ephemeral delivery semantics. No JetStream persistence is enabled here.
