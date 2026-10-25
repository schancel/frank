# Relay HA cluster: FoundationDB, S3 and NATS

Status: accepted in part, 2026-10-25 (decisions A–C below are the owner's). Extends [relay-storage-backends.md](relay-storage-backends.md),
whose rules still hold. Ships to signet.mx in one joint release with the pre-user wire break
(CBOR type renumbering, sealed sender, per-item payment network). Each PR lands on `main` once it is
rebased, reviewed and green. Nothing is deployed until the whole stack has landed. Until
the cutover PR, `main` keeps running the single-replica RocksDB relay by default.

## Where things stand (main @ 9d9fe339a)

- `registry.cluster.driver` is parsed, but every value except `rocksdb` is refused at startup
  (`cashweb-config/src/lib.rs` `storage_driver()`). `fdb_cluster_file` and
  `fdb_subspace_prefix` are parsed and never read.
- `RelayKvStore` (`store/kv_store.rs`) is a fixed list of CAS operations, one synchronous
  call each. It cannot express an interactive read-then-write transaction or a
  conflicting range read.
  - Only `GroupStore`, the unused `blob_store.rs`, an uncalled `SessionSecret::from_kv_store`,
    and a VAPID helper use it.
  - `kv_store.rs` also holds a second, uncalled set of key layouts (`admit_inbox_message_tx`,
    `claim_username_kv`, ...) and a simulated FDB cluster.
- `foundationdb_driver.rs` is a real driver behind an optional crate feature that the
  daemon does not enable. The host never boots the FDB network. The driver reports
  ambiguous commits without retrying.
- `S3BlobStore` (SigV4 over reqwest) exists for encrypted chunked attachments, but nothing
  constructs any `BlobStore`. MinIO appears only in the root compose file, for the mail
  gateway.
- NATS (`events::RelayEventBus`) carries hints only. A DM arrival is published only when a
  push wakeup triggers (`http/monad_message_cbor.rs`), so a reader connected to another replica
  misses most arrivals. Subjects have no cluster namespace.
- Labs: one RocksDB relay plus NATS, and FDB plus NATS with a KV contract test. No lab runs
  several relays, MinIO, or HTTP checks.

Owners missing from the predecessor plan's table: groups (`*.groups-v1`), forum
(`*.rocksdb.forum-cbor-v1`), oracle (`*.oracle-v1`), and the directory forward queue with
its stored request bodies.

## Target ownership

Dependency direction: daemon composition → typed owners → a transaction contract
(FoundationDB driver, plus a RocksDB driver for single-node use) and a large-value store
(S3). HTTP handlers publish to the event bus after a commit. Owners never import NATS or S3
clients; composition passes them capabilities and is the only reader of environment
variables.

| Owner | Single-replica assumption to remove | Target |
|---|---|---|
| Registry `Db` (profiles, indexes, usernames, metadata) | `monad_profile_lock` / `username_lock` mutexes; retired topic column families | One transaction per claim or profile replace, including its index rows. Retired column families deleted. |
| DM owner (`monad_dm_cbor`) | One process mutex around the DB; one global last-delivery key `L`; in-process broadcast channel for the websocket | Per-mailbox delivery-time keys (no cluster-wide hot key). Requests over 64 KiB in S3. The websocket uses only the bus. |
| Groups | Mirror ingest does get-then-put on the sequence; JSON rows with hex ciphertext | Transactional ingest, binary rows, ciphertext over 64 KiB in S3, payment dedup key in the accept transaction. |
| Directory preview, subjects, forwards | Single worker thread with cached handles and counters; no CAS | CAS on the previous checkpoint, atomic counters, forwards claimed by CAS, peer sync under a lease, bodies in S3. |
| Forum | `revision`/`incarnation` in memory but carried in cursors | Stored revision counter, so a cursor from replica A works on B. |
| Oracle | One collector per process | Stays replica-local; it is derived, not authoritative. |
| Session secret, VAPID key | File or key generated on first start, so each replica would differ | Operator-provisioned files, identical on every replica, required in cluster mode. |
| Event bus | Publish only on wakeup; websocket fallback invents a timestamp when the row is missing | Publish after every new commit on `frank.<cluster>.dm.<addr>` / `frank.<cluster>.grp.<id>`. Drop a hint whose row is missing; the client catches up from its cursor. |

FoundationDB limits shape the large-value rule: 100 KB per value, 10 MB and 5 s per
transaction. Values that can be larger are DM requests (up to 8 MiB), group messages (about
2 MiB stored), profiles, forum and DM frames (up to 1 MiB), directory evidence (up to 256 KiB)
and forward bodies. These are inlined up to 64 KiB and stored in S3 above that. Each
upload is its own S3 object, `<namespace>/sha256/<hex>/<upload-id>`: content-verified on
read and unique per upload, so equal content is not deduplicated and deleting one upload
never touches another. Each object is written before the commit that references it.
Orphans (expired, unreferenced upload intents) are swept; a lease only keeps replicas from
repeating each other's work.

## PR sequence

Each PR is reviewed and merged on its own. Acceptance runs in the compose cluster lab:
3 relays, FoundationDB, NATS and MinIO in Colima. Paid flows also use solonet
(`monad-regtest`). No fake chain, relay, database or object store.

1. **Transaction contract.**
   - `transact(|tx| ...)` with get, conflicting range read, set, clear, atomic add and typed size errors.
   - Delete `put_versionstamped`, the simulated cluster and the uncalled key layouts.
   - Port `GroupStore`.
   - Accept: across two processes, conflicting transactions on one key give exactly one winner per round; a range read conflicts with an insert into the range; oversized values and transactions return the typed error.
2. **Cluster composition behind a preview flag.**
   - Enable the `foundationdb` feature in the daemon and boot the FDB network.
   - Inject one transaction backend into the registry, and run store calls on blocking workers.
   - Require `session_secret_file` and `vapid_private_key_file` in cluster mode.
   - Cluster mode refuses to start while any enabled owner is still replica-local, unless `preview_replica_local_owners = true`, which logs each one.
   - Namespace NATS subjects.
3. **Compose cluster lab** (`backend/labs/compose.cluster.yml`).
   - Services: `fdb` with one-shot configure, `nats`, `minio` with bucket init, and `relay-a/b/c`. A round-robin proxy on 127.0.0.1:18080 lets the app use one origin.
   - A `cluster-contract` profile runs an HTTP test binary against all three relays.
   - Accept, groups:
     - create on A, append on B, read on C;
     - 3 × 200 concurrent appends give gap-free unique sequence numbers;
     - one signed message sent to A and B gives one receipt;
     - a stale epoch on B is rejected after rotation on A;
     - a subscriber on A wakes for appends on B;
     - after NATS is killed, readers catch up with nothing lost;
     - after FDB restarts or a relay is killed mid-load, every acknowledged append is still readable.
4. **Large-value store (S3).**
   - Content-addressed objects reusing the SigV4 transport, and an orphan sweep. First consumer: group ciphertext over 64 KiB.
   - Accept: a 1 MiB group message written on A reads back byte-exact on B; with MinIO stopped the append fails closed, sequence unchanged; an orphan is swept and a referenced object never is.
5. **Paid group writes** (replaces the 503 gate from #1633; tracks #1842).
   - Each append carries a signed raw transaction to the relay's configured payee, which is either the burn address or the hosting relay's address. Its calldata commits to (hosting relay, group, epoch, signing digest).
   - The relay statically verifies chain, payee, value and commitment, CASes a payment key in the accept transaction, then broadcasts after the commit. An accepted retry returns its original receipt. The price is in wei and must be non-zero.
   - Wire: the group envelope gains a payment field.
   - Accept on solonet:
     - a paid append is accepted and broadcast;
     - a replay on another relay is rejected;
     - the same transaction sent to A and B concurrently gives one append;
     - underpaid, wrong-payee, wrong-chain and wrong-commitment payments are rejected with no sequence consumed;
     - a proxied foreign write is verified only by the host.
6. **DM owner port.**
   - Per-mailbox delivery times, challenges with a conflicting capacity check, notification policy, VAPID from file, publish on every commit, and a fixed websocket fallback.
   - Delete the in-process broadcast.
   - Accept:
     - a paid DM on A arrives over the websocket on B;
     - 300 concurrent DMs to one recipient through 3 relays get strictly increasing delivery times, and pagination skips nothing;
     - one request sent to A and B gives one row;
     - a challenge issued on A is consumed on B and refused on replay;
     - after A is killed mid-admission, a retry to B gives one message and one effect;
     - with NATS down, readers catch up from their cursor;
     - an 8 MiB request round-trips through S3.
   - Progress (branch `ha/dm-owner-port`): the owner runs on `RelayKvStore` transactions, opened
     through step 2's driver selection under `<fdb_subspace_prefix>messages-v3/`; an ambiguous
     commit is settled by a fence on the recipient's delivery-time key.
     `packages/bot/demo/regtest/monad-dm-cluster.livecheck.ts` checks every item above except S3
     on three real relays in cluster mode (`backend/labs/compose.dm-owner.yml`). Until step 4,
     rows over 100 kB are split across FDB values. Clients seal at most 512 KiB of ciphertext per
     message, so the livecheck sends a 400 kB message and a unit test covers an 8 MiB row.
7. **Registry `Db` port.** Accept: a username claimed concurrently on A and B has one winner, and the indexes agree; a profile replaced on A shows only its new index rows on B.
8. **Directory port.** Accept: an entry published on A resolves on B; conflicting revisions on A and B leave one accepted and no fork; a forward interrupted by killing A is delivered exactly once.
9. **Forum port.** Accept: a cursor from A works on B; one burn presented to A and B gives one post.
10. **Remaining process-local state.** Directory enrollment and hourly quotas become cluster-wide counters. Wakeup coalescing moves into FDB. The rebroadcast throttle stays local, and that is documented.
11. **Cutover.**
    - Remove the preview flag and the remaining RocksDB-only owners.
    - Rewrite relay-storage-backends.md. Add the signet reset runbook.
    - Accept: the full lab under mixed DM, group, directory and forum load, with FDB, NATS, MinIO and each relay restarted in turn and the invariants checked afterwards.

PRs 6–9 are independent of each other once 1–4 have landed. The wire-break PRs land before
the owner ports, and the ports are written against the new formats.

## Owner decisions

- **A. Group-write funding.** Decided 2026-10-25: "a burn or a payment to the relay server as
  the host"; the operator must provide "a relay address, or xpub".
  - One verifier. Each relay operator configures the payee: a single relay address, an xpub, or `burn`.
  - With an xpub, the relay and the writer derive the per-write payment address from it, so
    payments are not all sent to one address. The derivation index must follow from the write's
    commitment, so both sides compute the same address without a round trip.
  - A burn costs the writer and funds nobody, so it is opt-in.
  - The calldata commitment is required: without it, one burn could fund writes on several relays.
  - Confirmation is not awaited, as with DM stamps. Before accepting, the host reads the payer's
    pending nonce and balance from its node. It accepts a nonce in `[pending, pending + 63]`,
    because the wallet shuffles the payment among up to 63 of its own self-sends on the account
    (ruling of 2026-10-20: random order; self-sends never go to the relay; the wallet broadcasts
    the whole set in (account, nonce) order after the relay holds the write). It needs value plus
    gas in the balance. A nonce below pending is refused (402, definitive). A nonce past the
    window or too little balance is deferred (503 `group_payment_not_ready`, retried with the same
    bytes), and so is an unreadable node (503).
  - Remaining exposure: a payment that never lands, because it or a predecessor nonce is replaced
    after acceptance, buys that write; at most one write per window slot, the same class as the
    replaced-nonce exposure DMs have.
  - The payer's address links a wallet to its group writes at the host, as DM stamps already do.
  - Still open: the price, and the exact xpub derivation path and index rule.
    - Proposed (implemented on the paid-group-writes branch, awaiting confirmation): child
      `xpub/0/i`, non-hardened, with `i = u32_be(commitment[0..4]) & 0x7fffffff`. Both sides
      compute it from the commitment alone; a collision between two writes only means two
      payments reach one address. Accepted key versions: `xpub` and `tpub`.
    - Price: a required decimal-wei `price_wei`; the shipped development and lab configs use
      1e12 wei and the docker image's payee is `burn` until an operator sets one.
    - The writer follows persist, submit to the relay, then broadcast: its wallet broadcasts
      only after the host holds the write; a definitive refusal (a host 402 `group_payment_*`,
      or a 403 or 404 from the relay written to) releases the coin only after the chain shows no
      copy, and never after an attempt whose outcome was unknown; a payment the chain shows is
      tracked as spent and the write is retried until a relay holds it.
    - Each accepted write's payment record (`G_pay:<tx_hash>`: payer, payee, value, group and
      sequence) is written in its accept transaction. Also open: an operator view that lists
      which xpub children were paid from those records.
- **B. Session secret and VAPID key.** Decided 2026-10-25: operator-provisioned files, the same on every replica, never auto-created in cluster mode. Changing the VAPID key orphans every push subscription.
- **C. Signet data at cutover.**
  - Decided 2026-10-25: no migration (AGENTS §6). The old databases and disks are kept as
    archives; moving to FoundationDB starts from empty state. The renumbering changes signed type numbers, so stored directory evidence, forum commitments and DM frames cannot be revalidated.
  - Scope: the relay's RocksDB databases and its session secret. Keep config, the relay identity and payee keys. Archive the databases and disk snapshots; they are not deleted.
  - Users keep their wallets and republish directory entries. Reserved usernames protect the bots.
  - Bot and mail-gateway disks are a separate decision, and their custody is never reset.
- **D. RocksDB driver.** Recommendation: keep one behind the same contract for single-node, self-hosted relays and fast tests. Two real drivers, no in-memory fakes.
- **E. Large values.** Recommendation: inline up to 64 KiB, S3 above that. S3 then becomes part of admission availability.
- **F. Quotas.** Recommendation: cluster-wide for directory enrollment. Per replica (N × the limit) for RPC proxy quotas.
- **G. Production FDB topology and operator.** Must be decided before any deploy; not covered by these PRs.

## Risks

- A global hot key serializes every DM if the `L` key is ported as is.
- Blocking FDB calls on async workers starve the runtime.
- Ambiguous commits followed by payment broadcasts. Each owner reconciles by reading its accept keys before answering. The kill tests above cover this.
- The directory runtime is the largest semantic port; a wrong port forks subjects.
- The FDB image architecture and an exact libfdb_c version match in the lab. Check for arm64 before relying on Colima's default VM.
- A joint wire-break and storage release makes failures harder to attribute. Mitigation: every PR passes the lab before it merges.
