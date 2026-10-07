# Frank Backend Daemon Topology

> [!IMPORTANT]
> [`CASHWEB-PROTOCOL-SPEC.md`](/protocol/cashweb-spec) supersedes this document for human protocol
> semantics and wire allocation. The protobuf, route, record and exact-wire sketches below are
> historical transition inputs and are non-wire; they MUST NOT be implemented as target formats.
> The service ownership, storage separation and public/private reachability constraints remain
> required topology inputs subordinate to that specification.

Status: Owner-approved direction for #87, refined by `public-federation-plan.md`. Individual wire,
storage, and route migrations remain staged behind their implementation tickets.

---

## 1. Architectural Goals

- Keep one operator-facing `cashwebd` binary.
- Federate compact public address-directory records, relay descriptors, and public pubsub records
  over the small-world peer graph.
- Keep full signed presentation profiles on the user's selected relay while allowing verified
  fetches and caches.
- Keep direct-message mailbox records inside the responsible operator's private cluster.
- Make it structurally difficult for a future replication feature to gossip mailbox ciphertext,
  delivery metadata, or payment-attempt state.
- Let an operator enable only the subsystems they intend to host.

One binary does not imply one replication domain. The process composes four services with
separate storage facades and route groups:

1. **`Directory`**: compact signed account-to-relay bindings, relay descriptors, rotation/revocation
   state, and directory admission policy.
2. **`Profiles`**: full signed display names, biographies, avatars, application capabilities, and
   curated defaults stored on the selected relay. Profiles are publicly fetchable but not public
   gossip records.
3. **`Pubsub`**: Monad-native public topic posts, votes, discovery indexes, and future topic events.
   The Lotus broadcast/topic subsystem is deprecated and is not an input to the new federation.
4. **`Mailbox`**: inbox/outbox records, exact stamp-payment attempts, delivery jobs, tombstones, and
   client notification state.

Node-local peer health, retry timers, and migration bookkeeping form a fifth operational class;
they are not application records and are never federated.

---

## 2. Durable-Data Classification

| RocksDB column family                                                                           | Class                                   | Public peer replication            |
| ----------------------------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------- |
| `metadata`, `pkh_by_time`                                                                       | public address directory (legacy Lotus) | allowed                            |
| `monad_profiles`, `monad_profiles_by_time`, `monad_profiles_by_name`                            | relay-local presentation profile        | forbidden                          |
| `topic_messages`, `message_payloads`, `topic_burn_txs`                                          | deprecated Lotus broadcasts             | forbidden                          |
| `monad_topic_posts`, `monad_topic_posts_by_topic`, `monad_topic_discovery`, `monad_topic_votes` | public pubsub                           | allowed                            |
| `monad_messages`, `monad_messages_by_time`                                                      | private mailbox                         | forbidden                          |
| `monad_message_attempts`                                                                        | private mailbox/payment state           | forbidden                          |
| future outbox, delivery-job, tombstone, and notification column families                        | private mailbox                         | forbidden                          |
| future address-directory and relay-descriptor families                                          | public directory                        | allowed through an explicit facade |
| future peer health, crawl frontier, schema version, and migration journal                       | node-local operational                  | forbidden                          |

The security boundary is enforced by typed store facades and explicit replication allowlists, not by giving
federation code a generic `Db` handle. Separate database paths remain a later deployment option;
the logical ownership boundary must exist first so that split does not require redesigning records.

---

## 3. Replication Boundaries

Public federation receives only `Directory` and `Pubsub` interfaces. It may enumerate and apply
signed public records, but it cannot import the presentation-profile or mailbox store modules or
access a generic column-family iterator. Every replicated record carries a network tag and
protocol version, and is validated as if received from an untrusted client before insertion.

The Monad profile store is not a temporary directory implementation: it contains display
name, bio, avatar, and search data that the original system kept on the selected relay. Federation
must wait for the dedicated directory schema rather than copying these full records as an
intermediate compatibility measure.

Mailbox replication, if enabled for an operator's private cluster, is a different interface,
configuration block, and authentication domain. Public peer discovery must never return private
cluster endpoints or credentials. A single-node operator is valid and is the default.

---

## 4. Canonical HTTP Namespace

The canonical Monad API puts the network first and the replication domain second:

| Domain    | Canonical routes                                                                                                                  |
| --------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Directory | `/directory`, `/directory/:network/:address`, `/directory/relays/:node_id`                                                        |
| Profiles  | `/profiles/:network/:address`, `/profiles/search`, `/profiles/curated-defaults`                                                   |
| Mailbox   | `/monad/mailbox/inbox`, `/monad/mailbox/outbox`, `/monad/mailbox/sync`, `/monad/mailbox/events`                                   |
| Pubsub    | `/monad/pubsub/topics`, `/monad/pubsub/posts`, `/monad/pubsub/posts/:payload_hash`, `/monad/pubsub/votes`, `/monad/pubsub/events` |

Future store-and-forward and deletion routes extend the mailbox domain rather than creating
another top-level convention, for example `/monad/mailbox/deliveries` and
`/monad/mailbox/tombstones`. Peer discovery and public catch-up live under
`/v1/federation/...`.

`/monad/mailbox/sync?cursor=<opaque>` is the single authoritative, mailbox-scoped
change journal. `/monad/mailbox/events` is a live wake-up channel carrying the newest cursor;
after a disconnect the client always recovers through `sync`.

---

## 5. Configuration and Process Lifecycle

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

The process starts in this order:

1. Open RocksDB and complete schema migrations;
2. Construct the typed directory, profile, pubsub, mailbox, and node-local stores;
3. Construct enabled route groups;
4. Start private mailbox-cluster workers, if configured;
5. Start public federation discovery/catch-up, if configured;
6. Accept traffic only after required local recovery is complete.

Shutdown stops accepting writes, drains or checkpoints local delivery jobs, stops federation, and
then closes RocksDB.
