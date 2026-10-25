# Local storage and notification labs

These labs are separate from the root demo Compose stack and from all deployment
configuration. Run commands from the repository root of an isolated worktree.
Docker Compose v2 and a running Docker Engine are required. Every published port
binds to `127.0.0.1`; each lab has its own project network and disposable volumes.
Do not point either lab at existing databases, funded identities, or production
NATS. There are no chain RPC credentials or wallet keys in these files.

## Ownership and scope

This ordinary implementation adds local test infrastructure only. The daemon
currently opens the direct-message store with raw RocksDB APIs.
`RelayKvStore` is a separate transaction contract with RocksDB and FoundationDB
drivers; the group store and the registry `Db` (profiles, usernames, metadata, topics)
use it. A daemon built with `--features foundationdb` can select FoundationDB for both
(`registry.cluster.driver = "foundationdb"`); every other owner stays on the replica's
RocksDB.
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
the message. A profile registered and then replaced on A is the only record B lists and
finds, and C reads it after A is gone. It checks that the startup log reports the
registry store readable, does not list the registry database or groups as replica-local,
and that no session secret is generated beside the database. It uses a fresh cluster
name and subspace per run and does not clear them.

```sh
FRANK_FDB_CLUSTER_FILE=/cluster/fdb.cluster FRANK_LAB_NATS_URL=nats://nats:4222 \
  cargo test -p cashwebd-exe --features foundationdb --test foundationdb_daemon -- --ignored
```

The fourth test (`cashweb-registry/src/store/registry_fdb_tests.rs`) starts two relay
processes from its own executable, each with its own FDB client and local disk, serving
the real HTTP routes over one fresh registry subspace. Each of 40 usernames is claimed at
the same moment by one key on A and another on B: exactly one claim succeeds, the other is
refused as taken, both relays resolve the name and both addresses identically, and the
stored name and reverse-index rows agree one to one. A profile replaced on A is the only
record B lists, searches and serves, its stale replay to B is refused, and only the new
record's index rows exist.

```sh
FRANK_FDB_CLUSTER_FILE=/cluster/fdb.cluster cargo test -p cashweb-registry \
  --features foundationdb --lib -- --ignored --exact \
  store::registry_fdb_tests::registry_is_shared_by_two_relays_through_foundationdb --nocapture
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
`127.0.0.1:$FRANK_LAB_CLUSTER_PORT`. Nothing else is published. Pick a port that is free
on your machine (the file's fallback, 18080, is often already taken by another local
service).

**What it is for today:** groups and the HTTP contract below. It is not yet a cluster the
app can use. Message routes are off, the directory is off and still replica-local, and
there is no chain upstream unless you supply one. Profiles, usernames, metadata and topics
are in the shared registry database (HA step 7). Direct messages and the directory move to
the shared store in HA steps 6 and 8; until they land, an app cannot message through the
proxy.

Overrides, all optional:

- `FRANK_LAB_CLUSTER_PORT`: the proxy's host port; set it to a free port. It also sets
  the relays' public `url`, which `lab-init` renders into their configuration on every
  start.
- `FRANK_LAB_CLUSTER_SUBNET`: the first three octets of the lab's own /24 network
  (default `10.89.42`), so two labs, or a colliding local network, can coexist. Run
  `down` before changing it on an existing project: Compose does not move a running
  network, and FoundationDB's cluster file keeps the old coordinator address, so with
  kept volumes also run `down --volumes`.
- `MONAD_TESTNET_HTTP_RPC_URL`: a Monad testnet RPC upstream, passed through from your
  shell to the relays and never written to a file. Unset, the relays serve no chain.
  Set, each relay checks the upstream's chain id and checkpoint before serving it, which
  is what turning the mailbox on will need once step 6 lands. Never commit a URL or key.

Services:

- `fdb-init` creates the single-node database only on a fresh volume. `status` cannot
  tell "no database yet" from "not reachable yet" (both time out), so the first
  successful `configure new single ssd` leaves a marker in the cluster volume; with the
  marker present, or once `status` reports the database available, it only waits and
  never configures again. FoundationDB has a fixed address (`.10` on the lab subnet)
  because its cluster file names the coordinator by address and the contract restarts it.
- `lab-init` writes the operator-provisioned files once into the `secrets` volume, mode
  0400 and never on the host: a random 32-byte session secret, a random VAPID key below
  the P-256 order, and MinIO's root user and random password. On every start it renders
  `cluster/relay.toml.in` into the `config` volume with the proxy origin as the relays'
  `url`. All three relays mount the same files. The relay refuses a provisioned file its
  group or other users can access, so this mode matters; see "Provisioned file
  permissions" below for real deployments.
- `minio` reads its root credentials from those files, and `minio-init` creates the
  `frank-lab-blobs` bucket with one SigV4 request. MinIO stopped publishing container
  images, so `Dockerfile.minio` builds the server from its upstream source at a pinned
  release tag. `lab-init` also writes `/secrets/s3-credentials` from those root credentials,
  and the relays keep group ciphertexts over 64 KiB in that bucket under the prefix `lab`
  (`[registry.large_values]`, HA step 4).
- The relays share one configuration: driver `foundationdb`, subspace
  `frank-cluster-lab/`, cluster `lab` (NATS subjects `frank.lab.…`), the free group
  policy, no mailbox, forum or directory, and the optional chain row above. Each keeps
  its own RocksDB volume. Groups and the registry database are shared through
  FoundationDB, and large values through MinIO; the other owners are still replica-local, so the preview flag is set,
  and each relay's startup log names them:

```sh
docker compose -f backend/labs/compose.cluster.yml logs relay-a | grep 'Replica-local owner'
```

Commands, from the repository root of a clean checkout:

```sh
# Choose a free port for the proxy.
export COMPOSE_PROJECT_NAME=frank-lab-cluster FRANK_LAB_CLUSTER_PORT=<free port>
docker compose -f backend/labs/compose.cluster.yml up -d --build
curl --fail "http://127.0.0.1:${FRANK_LAB_CLUSTER_PORT}/chains"

docker compose -f backend/labs/compose.cluster.yml --profile cluster-contract \
  run --build --rm cluster-contract

docker compose -f backend/labs/compose.cluster.yml --profile cluster-contract down --volumes
```

A cold first build is slow: building MinIO from source took about 14 minutes here, and
the release build of the relay and the contract several more. Both are cached afterwards.

### Provisioned file permissions

`registry.session_secret_file` and `registry.vapid_private_key_file` must be readable by
their owner only (mode 0400 or 0600); a relay refuses anything looser at `--check-config`
and at start. How to get there depends on how the files reach the container:

- Kubernetes Secret volume: set `defaultMode: 0400` (or per-item `mode: 0400`) on the
  volume. Mode 0400 gives no group access, so the relay must run as the files' owner
  (root, or the `runAsUser` the files are projected for).
- Compose or Docker bind mount of host files: `chmod 0400` the files on the host and own
  them by the uid the relay runs as; a bind mount keeps the host mode.
- Compose `secrets:` (long syntax): set `mode: 0400` and `uid` to the relay's user.
- This lab: `lab-init` creates the files with `umask 077` and `chmod 0400`.

The `cluster-contract` profile (`cluster_contract.rs`) is an HTTP test binary that talks
to all three relays and to the proxy:

- create a group on A, append on B, read on C, and read the same rows through the proxy;
- a 1 MiB message appended on A (stored in MinIO) reads back byte-exact on B and C, and an
  exact retry on B is answered from the row;
- 3 × 200 concurrent appends, 200 per relay, all acknowledged, with sequence numbers
  1..=600, unique and gap-free on every relay;
- the same signed message sent to A and B at once gives one receipt (one `appended`, one
  `existing`, the same row), over 20 rounds;
- after a rotation on A, an old-epoch append on B is refused (403), the old read token is
  refused, and an exact retry of a pre-rotation message keeps its receipt;
- a websocket subscriber on A wakes within 3 s of an append on B, before A's own 5 s
  recovery tick, so the wakeup came over NATS;
- with NATS killed (the open socket is drained first, so no earlier wakeup counts), 20
  appends on B are still acknowledged; while it is still down, the open subscriber on A
  is still woken (by A's own tick) and readers on C and A catch up
  from their cursors with nothing lost; after NATS starts again, wakeups cross replicas
  again on that same socket and on a new one;
- FoundationDB restarted mid-load, and separately relay-b killed mid-load and started again:
  three writers append 150 messages each and retry a failed append, with the same
  envelope, on the next relay. The test checks that the container really restarted
  (`State.StartedAt` changed) and that the writers felt it: an attempt overlapping the
  fault window failed or took at least 1 s. Relay-b's kill must cause a failed attempt.
  The pre-fault baseline, measured after each writer's first 10 attempts, is only
  reported. Afterwards every acknowledged append is readable on
  every relay at its acknowledged sequence number, and no retried append was stored
  twice. The load fails instead of hanging if it does not finish within 300 s.

The fault cases stop and start this project's own containers through the Docker socket,
which the profile mounts; the test finds them by its own container's Compose project
label. The tests therefore run one at a time. Each uses a fresh group, so reruns against
the same volumes are fine. Paid group writes are not covered yet: HA step 5 (PR #1847)
adds them, on solonet, once `[registry.group_writes]` lands, and the hook is marked at the
top of `cluster_contract.rs` and in `cluster/relay.toml.in`.

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
5. An orphan (uploaded, never committed) and an unreferenced second upload of the 1 MiB
   content are swept, and the referenced 1 MiB object is kept. Then, inside that one
   container and process, two writer threads race two sweeper threads with no lease
   exclusion (each with its own store handle and S3 client) and every intent already
   expired, and every committed message still reads back. Phase 3 cannot cover an
   upload that fails after its intent committed (with MinIO already stopped, the
   namespace claim fails first); the unit test
   `an_upload_that_fails_after_its_intent_committed_is_abandoned_and_swept` covers it.
6. The run's FDB subspace is cleared.

The MinIO credentials in the Compose file are synthetic and local to the lab.

## Three relays sharing direct messages (HA plan step 6)

`compose.dm-owner.yml` layers three real relays (`relay-a`, `relay-b`, `relay-c` on
127.0.0.1:18301-18303) over the FoundationDB + NATS lab above, in cluster mode on the
FoundationDB driver. Their direct messages and groups live in one FoundationDB subspace, and
their hints go over the lab's NATS (`frank.dm-owner-lab.…`); the registry, directory and forum
stay on each relay's own RocksDB under the preview flag until steps 7 to 9. It runs the mailbox
against the local Monad network, which the cluster lab above does not yet do; it will be retired
once direct messages are wired into `compose.cluster.yml`.

The livecheck writes the configurations and the provisioned session secret and VAPID key (0400),
starts the lab under its own Compose project (`FRANK_DM_LAB_PROJECT`, default `frank-ha-dm`),
runs the checks with real wallets on the local Monad network (monad-solonet), and removes the
project with its volumes:

```sh
docker build -f backend/labs/Dockerfile.relay-foundationdb -t frank-ha-dm-relay:latest .
yarn --cwd packages/bot regtest:monad-dm-cluster
```

`FRANK_DM_LAB_KEEP=1` leaves the lab running; remove it later with
`docker compose -p frank-ha-dm -f compose.foundationdb-nats.yml -f compose.dm-owner.yml down --volumes`
(with `FRANK_DM_LAB_STATE` set to any directory). `FRANK_DM_LAB_LOGS=1` saves the relays' logs.

## References

- [FDB container entrypoint](https://github.com/apple/foundationdb/blob/main/packaging/docker/fdb.bash)
  documents container networking and cluster-file generation.
- [FDB Docker README](https://github.com/apple/foundationdb/blob/main/packaging/docker/README.md)
  warns its older Compose samples are outdated; these labs follow the current entrypoint.
- [NATS configuration](https://docs.nats.io/running-a-nats-service/configuration)
  and [Core NATS](https://docs.nats.io/nats-concepts/core-nats) describe its
  ephemeral delivery semantics. No JetStream persistence is enabled here.
