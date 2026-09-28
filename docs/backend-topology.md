# Frank backend topology

Status: owner-approved direction for #87, refined by `public-federation-plan.md`. Individual wire,
storage, and route migrations remain staged behind their implementation tickets.

## Goals

- Keep one operator-facing `cashwebd` binary.
- Federate compact public address-directory records, relay descriptors, and public pubsub records
  over the small-world peer graph.
- Keep full signed presentation profiles on the user's selected relay while allowing verified
  fetches and caches.
- Keep direct-message mailbox records inside the responsible operator's private cluster.
- Make it structurally difficult for a future replication feature to gossip mailbox ciphertext,
  delivery metadata, or payment-attempt state.
- Let an operator enable only the subsystems they intend to host.

One binary does not imply one replication domain. The process should compose four services with
separate storage facades and route groups:

1. `Directory`: compact signed account-to-relay bindings, relay descriptors, rotation/revocation
   state, and directory admission policy.
2. `Profiles`: full signed display names, biographies, avatars, application capabilities, and
   curated defaults stored on the selected relay. Profiles are publicly fetchable but not public
   gossip records.
3. `Pubsub`: Monad-native public topic posts, votes, discovery indexes, and future topic events.
   The Lotus broadcast/topic subsystem is deprecated and is not an input to the new federation.
4. `Mailbox`: inbox/outbox records, exact stamp-payment attempts, delivery jobs, tombstones, and
   client notification state.

Node-local peer health, retry timers, and migration bookkeeping form a fifth operational class;
they are not application records and are never federated.

## Current durable-data classification

| RocksDB column family | Class | Public peer replication |
| --- | --- | --- |
| `metadata`, `pkh_by_time` | public address directory (legacy Lotus) | allowed |
| `monad_profiles`, `monad_profiles_by_time`, `monad_profiles_by_name` | relay-local presentation profile | forbidden |
| `topic_messages`, `message_payloads`, `topic_burn_txs` | deprecated Lotus broadcasts | forbidden |
| `monad_topic_posts`, `monad_topic_posts_by_topic`, `monad_topic_discovery`, `monad_topic_votes` | public pubsub | allowed |
| `monad_messages`, `monad_messages_by_time` | private mailbox | forbidden |
| `monad_message_attempts` | private mailbox/payment state | forbidden |
| future outbox, delivery-job, tombstone, and notification column families | private mailbox | forbidden |
| future address-directory and relay-descriptor families | public directory | allowed through an explicit facade |
| future peer health, crawl frontier, schema version, and migration journal | node-local operational | forbidden |

For the hackathon, these classes may remain column families in one RocksDB database. The security
boundary is enforced by typed store facades and explicit replication allowlists, not by giving
federation code a generic `Db` handle. Separate database paths remain a later deployment option;
the logical ownership boundary must exist first so that split does not require redesigning records.

## Replication boundaries

Public federation receives only `Directory` and `Pubsub` interfaces. It may enumerate and apply
signed public records, but it cannot import the presentation-profile or mailbox store modules or
access a generic column-family iterator. Every replicated record carries a network tag and
protocol version, and is validated as if received from an untrusted client before insertion.

The current Monad profile store is not a temporary directory implementation: it contains display
name, bio, avatar, and search data that the original system kept on the selected relay. Federation
must wait for the dedicated directory schema rather than copying these full records as an
intermediate compatibility measure.

Mailbox replication, if enabled for an operator's private cluster, is a different interface,
configuration block, and authentication domain. Public peer discovery must never return private
cluster endpoints or credentials. A single-node operator is valid and is the hackathon default.

Tests must construct a database containing every record class, run public catch-up and push, and
prove that only the public allowlist appears at the receiving peer. In particular, neither full
profiles nor mailbox data may appear. Adding a new column family must not implicitly make it public.

## Proposed canonical HTTP namespace

The current paths put the chain name after the resource (`/metadata/monad`, `/message/monad`) and
mix private mail with public topics. The canonical Monad API should put the network first and the
replication domain second:

| Domain | Canonical routes |
| --- | --- |
| Directory | `/directory`, `/directory/:network/:address`, `/directory/relays/:node_id` |
| Profiles | `/profiles/:network/:address`, `/profiles/search`, `/profiles/curated-defaults` |
| Mailbox | `/monad/mailbox/inbox`, `/monad/mailbox/outbox`, `/monad/mailbox/sync`, `/monad/mailbox/events` |
| Pubsub | `/monad/pubsub/topics`, `/monad/pubsub/posts`, `/monad/pubsub/posts/:payload_hash`, `/monad/pubsub/votes`, `/monad/pubsub/events` |

Future store-and-forward and deletion routes extend the mailbox domain rather than creating
another top-level convention, for example `/monad/mailbox/deliveries` and
`/monad/mailbox/tombstones`. Peer discovery and public catch-up live under
`/v1/federation/...`.

Public federation itself uses chain-generic `/v1/federation/...` routes and carries `NetworkTag`
inside validated records and capability negotiation. The remaining chain-prefixed client routes in
this table are transitional and must converge with #59 rather than multiplying federation paths
for every supported network.

`inbox`, `outbox`, and the other named resources are storage and command views, not independent
replay streams. `/monad/mailbox/sync?cursor=<opaque>` is the single authoritative, mailbox-scoped
change journal. `/monad/mailbox/events` is only a live wake-up channel carrying the newest cursor;
after a disconnect the client always recovers through `sync`.

The server journal records changes to opaque mailbox objects. It does not need to understand every
encrypted application-level message type. In particular, encrypted self-sent messages can remain
the first implementation of cross-device checkpoints, as in Stamp; the journal transports and
orders them without turning checkpoint contents into relay-visible protocol fields.

The current `GET /message/monad?since=...` implementation is a global feed. Every client downloads
every retained encrypted message and filters using the envelope's plaintext routing fields. That
must be replaced by a recipient-scoped journal. A scoped-but-unauthenticated address query is only
a migration aid, not the final privacy boundary: normal mailbox reads must authenticate control of
the destination identity without signing the message contents or creating transferable authorship
evidence.

Recommended compatibility policy: update the in-repository Rust, TypeScript, app, and bot clients
in one reviewed change and remove the old Monad paths rather than maintaining permanent aliases.
The legacy Lotus routes remain isolated while the staged deletion removes their remaining callers
and compatibility module. They do not become aliases for Monad writes, and no new federation, UI,
or stored format may depend on them. The HTTP route migration itself does not require a protobuf
change; replacing the Forum's reused Lotus content payload does and is reviewed separately.

## Configuration and process lifecycle

`cashwebd` owns one listener and independently configurable route groups:

```toml
[services]
profiles = true
pubsub = true
mailbox = true
lotus_compat = false

[federation]
enabled = true
seeds = []

[mailbox_cluster]
enabled = false
```

All three Monad services default to enabled for the combined local server. Disabling a service
omits its routes and background tasks; it does not silently leave writes enabled. Startup validates
that enabled background workers have their required service and storage dependencies.

The process starts in this order:

1. open RocksDB and complete schema migrations;
2. construct the typed directory, profile, pubsub, mailbox, and node-local stores;
3. construct enabled route groups;
4. start private mailbox-cluster workers, if configured;
5. start public federation discovery/catch-up, if configured;
6. accept traffic only after required local recovery is complete.

Shutdown stops accepting writes, drains or checkpoints local delivery jobs, stops federation, and
then closes RocksDB.

## Existing-data migration

The first implementation does not rename column families. It records a schema version and maps the
existing families to the ownership table above, so existing persistent databases open without a
bulk rewrite. Route migration is independent of storage migration.

Future mailbox addressing (#65/#89) will need recipient-indexed inboxes and separately indexed
sender outboxes. That migration must derive or store the mailbox owner explicitly and must not
infer ownership from a global timestamp feed at read time. It belongs to the store-and-forward
change, not this boundary-enforcement slice.

## Client synchronization

Mailbox journal order provides deterministic replay and causal ordering; it does not require
serial blockchain processing. The client handles a sync batch in phases:

1. fetch one journal batch after the committed opaque cursor;
2. decrypt and deduplicate without changing committed wallet state;
3. resolve message versions, tombstones, checkpoints, and key dependencies;
4. extract and pool blockchain effects;
5. minimize the candidate account/payment set and query Monad state in parallel;
6. atomically commit messages, effects, account state, tombstones, and checkpoints;
7. advance the mailbox cursor only as part of that commit.

Strict journal order matters for key rotation, checkpoint predecessors, tombstones, and delivery
state transitions. Independent stamp-child balances and chain observations are reconciled as a
batch, following Stamp's existing pool/minimize/query approach rather than executing one blockchain
operation per message in transport order.

## Implementation sequence

1. Approve this classification, canonical route names, and cutover policy.
2. Add service configuration and route-group constructors; keep storage bytes unchanged.
3. Replace generic federation database access with public directory/pubsub facades and add the
   full-profile/private-record non-replication integration test.
4. Implement seed-and-crawl public federation in #88.
5. Implement private SMTP-style mailbox delivery in #89.
6. Add mailbox SSE/WebSocket notification and polling catch-up in #55.

No step may expose mailbox records through the public peer graph as an intermediate state.
