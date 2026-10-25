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
`RelayKvStore` is a separate transaction contract with RocksDB and FoundationDB
drivers; only the group store uses it. A daemon built with `--features foundationdb`
can select FoundationDB for groups (`registry.cluster.driver = "foundationdb"`); every
other owner stays on the replica's RocksDB.
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

This Compose file does not run a long-lived relay service. It provides FDB 7.3.63
and Core NATS, plus a `driver-contract` profile that runs the `RelayKvStore`
transaction contract against the live cluster and then starts real cluster-mode
relays as processes against it. Server and native client versions are matched.

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

The first test runs the transaction contract
(`cashweb-registry/tests/kv_transaction_contract.rs`):

```sh
FRANK_FDB_CLUSTER_FILE=/cluster/fdb.cluster cargo test -p cashweb-registry \
  --features foundationdb --test kv_transaction_contract -- --ignored --exact \
  live_fdb::foundationdb_transaction_contract --nocapture
```

It starts two worker processes from its own executable, each booting its own FDB
client, and runs 1,000 rounds in which both read one key before either commits:
each round must have exactly one winner, the loser must have re-run, and the final
value must equal the number of wins. It also checks that a range read conflicts
with a concurrent insert into that range (and not with one outside it), that
oversized values and transactions and a transaction over 5 s return their typed
errors without committing, and that concurrent atomic adds commute. The same
contract runs against RocksDB in every `cargo test` (`rocksdb_transaction_contract`).
It uses a fresh random subspace and clears only that subspace on success.

Next, the directory's cross-process test
(`cashweb-registry/src/store/directory_subjects_fdb_tests.rs`, in the library's test
binary) claims a forward in one worker process and SIGKILLs it before it sends; a second
worker is refused while that claim lives, then takes the forward over and sends it once.
Four processes racing to claim one forward give one winner, and three processes enrolling
20 subjects each against a cap of 25 enroll exactly 25:

```sh
FRANK_FDB_CLUSTER_FILE=/cluster/fdb.cluster cargo test -p cashweb-registry \
  --features foundationdb --lib -- --ignored --exact --nocapture \
  store::directory_subjects::fdb::forward_claims_and_counters_across_processes
```

`FRANK_FDB_CLUSTER_FILE=/cluster/fdb.cluster` points at the cluster file shared
with the FDB container. A second process runs the same real NATS/offline cursor
contract as the Rocks lab, with `FoundationDbKvStore` selected at compile time by
the feature. It reopens an independent client and deletes only its random test
subspace's inbox rows on success. NATS does not provide the FDB
durability or CAS.
The third test (`cashwebd-exe/tests/foundationdb_daemon.rs`) starts the real
`cashwebd-exe`, built with `--features foundationdb`, in cluster mode with the preview
flag and freshly provisioned session-secret and VAPID files: replica A creates a group,
replica B reads it and appends, A is killed, and replica C on an empty local disk reads
the message. It checks that the startup log names the replica-local owners (and not
groups) and that no session secret is generated beside the database. It uses a fresh
cluster name and subspace per run and does not clear them.

```sh
FRANK_FDB_CLUSTER_FILE=/cluster/fdb.cluster FRANK_LAB_NATS_URL=nats://nats:4222 \
  cargo test -p cashwebd-exe --features foundationdb --test foundationdb_daemon -- --ignored
```

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

## Three-relay cluster: FoundationDB, NATS, MinIO and a proxy

`compose.cluster.yml` runs three real relays (`relay-a`, `relay-b`, `relay-c`) built
with `--features foundationdb`, in cluster mode against one FoundationDB 7.3.63, one
Core NATS server, and MinIO, with an nginx round-robin proxy on
`127.0.0.1:18080` so the app can use one origin. Set `FRANK_LAB_CLUSTER_PORT` if that
port is taken. Nothing else is published.

- `fdb-init` creates the single-node database on first start (`configure new single ssd`)
  and does nothing once it exists. FoundationDB has a fixed address (10.89.42.10 on the
  lab's own 10.89.42.0/24 network) because its cluster file names the coordinator by
  address and the contract restarts it. Change the subnet if it collides with a local one.
- `secrets-init` writes the operator-provisioned files once into the `secrets` volume:
  a random 32-byte session secret and a random hex VAPID key. All three relays mount the
  same files. They are lab-only and never written to the host.
- `minio-init` creates the `frank-lab-blobs` bucket with one SigV4 request. MinIO stopped
  publishing container images, so `Dockerfile.minio` builds the server from its upstream
  source at a pinned release tag. No relay uses S3 yet; step 4 of the HA plan adds the
  first consumer.
- The relays share `cluster/relay.toml`: driver `foundationdb`, subspace
  `frank-cluster-lab/`, cluster `lab` (NATS subjects `frank.lab.…`), the free group
  policy, large values in the MinIO bucket under `cluster-lab/`, the open directory with
  a synthetic relay tuple, and no mailbox, forum or chain upstream. Each keeps its own
  RocksDB registry database in its own volume. Groups and the directory are the owners
  they share. The other owners, and the directory's per-source hourly enrollment quota,
  are still replica-local, so the preview flag is set, and each relay's startup log names
  them:

```sh
docker compose -f backend/labs/compose.cluster.yml logs relay-a | grep 'Replica-local owner'
```

Commands, from the repository root of a clean checkout:

```sh
docker compose -f backend/labs/compose.cluster.yml up -d --build
curl --fail http://127.0.0.1:18080/chains

docker compose -f backend/labs/compose.cluster.yml --profile cluster-contract \
  run --build --rm cluster-contract

docker compose -f backend/labs/compose.cluster.yml --profile cluster-contract down --volumes
```

The first build compiles the relay in release mode and builds MinIO. Both take several
minutes and are cached afterwards.

The `cluster-contract` profile (`cluster_contract.rs`) is an HTTP test binary that talks
to all three relays and to the proxy:

- create a group on A, append on B, read on C, and read the same rows through the proxy;
- 3 × 200 concurrent appends, 200 per relay, all acknowledged, with sequence numbers
  1..=600, unique and gap-free on every relay;
- the same signed message sent to A and B at once gives one receipt (one `appended`, one
  `existing`, the same row), over 20 rounds;
- after a rotation on A, an old-epoch append on B is refused (403), the old read token is
  refused, and an exact retry of a pre-rotation message keeps its receipt;
- a websocket subscriber on A wakes within 3 s of an append on B, before A's own 5 s
  recovery tick, so the wakeup came over NATS;
- with NATS killed, 20 appends on B are still acknowledged, readers on C and A catch up
  from their cursors with nothing lost, and once NATS is back wakeups cross replicas again;
- directory: an entry published on A resolves on B, C and the proxy, by key and by
  address, and a renewal on C is what A and B serve next;
- directory: over 20 rounds, two conflicting renewals of one revision sent to A and B at
  once give exactly one 200 and one 409, every relay serves the winner, the subject is not
  quarantined and renews again on C, and one first entry sent to A and B at once enrolls
  once with both answering 200;
- directory: relay-a killed mid-load while three writers publish 40 accounts each (revision
  0 and one renewal, retried on the next relay): every acknowledged account resolves at its
  acknowledged head on every relay;
- FoundationDB restarted mid-load, and separately relay-b killed mid-load and started again:
  three writers append 150 messages each and retry a failed append, with the same
  envelope, on the next relay. Afterwards every acknowledged append is readable on every
  relay at its acknowledged sequence number, and no retried append was stored twice.

The fault cases stop and start this project's own containers through the Docker socket,
which the profile mounts; the test finds them by its own container's Compose project
label. The tests therefore run one at a time. Each uses a fresh group, so reruns against
the same volumes are fine. Paid group writes are not covered yet: HA step 5 (PR #1847)
adds them, on solonet, once `[registry.group_writes]` lands, and the hook is marked at the
top of `cluster_contract.rs` and in `cluster/relay.toml`.

## Large-value store: FoundationDB + MinIO acceptance

`compose.large-values.yml` runs FDB 7.3.63 and MinIO (pinned by digest) with a
`relay-a` and a `relay-b` test container. It is not a Frank relay: each phase in
`cashweb-registry/tests/large_value_contract.rs` opens its own FDB client and S3
client in its own container, and phases share state only through the cluster.
The script initializes FDB, creates the bucket, runs the phases, stops and restarts
MinIO between them, and removes the project with `--volumes` on exit
(`FRANK_LAB_KEEP=1` keeps it).

```sh
COMPOSE_PROJECT_NAME=frank-lab-large-values-$USER backend/labs/large-values-acceptance.sh
```

Phases, in order:

1. Relay A creates a group and appends a 1 MiB message (and a small one).
2. Relay B reads the 1 MiB message back byte-exact.
3. With MinIO stopped, a large append fails closed and `G_seq` is unchanged; a read
   that needs an object fails instead of returning a gap.
4. With MinIO restarted, the same append lands as the next sequence.
5. An orphan (uploaded, never committed) is swept and the referenced 1 MiB object is
   kept; then writers on two clients race a sweeper with every intent already
   expired, and every committed message still reads back.
6. The run's FDB subspace is cleared.

The MinIO credentials in the Compose file are synthetic and local to the lab.

## References

- [FDB container entrypoint](https://github.com/apple/foundationdb/blob/main/packaging/docker/fdb.bash)
  documents container networking and cluster-file generation.
- [FDB Docker README](https://github.com/apple/foundationdb/blob/main/packaging/docker/README.md)
  warns its older Compose samples are outdated; these labs follow the current entrypoint.
- [NATS configuration](https://docs.nats.io/running-a-nats-service/configuration)
  and [Core NATS](https://docs.nats.io/nats-concepts/core-nats) describe its
  ephemeral delivery semantics. No JetStream persistence is enabled here.
