# Frank public federation, directory, and profile plan

Status: reviewed architecture plan; production protobuf and storage migrations require the
ticketed, staged implementation described below.

This document defines the public replication side of Frank. It deliberately excludes private
mailbox delivery, mailbox synchronization, and deniable direct-message authentication except where
their boundaries constrain public federation. SMTP-style private delivery remains issue #89;
mailbox migration remains issue #65.

## Outcomes

Frank operators run one `cashwebd` binary while participating in distinct data topologies:

1. a small, public, federated directory maps a network-qualified account to its current mailbox
   relay bindings and cryptographic authority;
2. full presentation profiles remain on the user's selected mailbox relay or relays;
3. public topic events federate among operators that elect to retain those topics;
4. public relay descriptors advertise operator endpoints, capabilities, and pricing references;
5. private inboxes, outboxes, delivery attempts, notification state, and mailbox profiles never
   enter public gossip; and
6. a node that was offline can discover peers and catch up without connecting to every node in the
   network.

Directory entries, presentation profiles, relay descriptors, and key transitions are publicly
verifiable and intentionally non-repudiable. Direct messages remain a separate, deniable protocol.

## Ground truth in the current repository

The legacy keyserver and relay were separate logical systems:

- `AddressMetadata` contained a timestamp, TTL, and extensible entries. The implemented client
  published a `relay-server` entry containing a relay URL.
- The metadata was wrapped by `SignedPayload`, which carried the public key and signature. The
  registry derived a PKH from that public key and required it to match the address used as the
  database key.
- Keyservers forwarded accepted metadata to configured peers and performed an initial range
  download ordered by `(timestamp, address)`.
- Each peer kept rotating Bloom filters of recently known payload hashes to suppress redundant
  forwarding.
- `relay.Profile`, including vCard/avatar-style entries, was stored separately at
  `/profiles/{address}` on the selected relay.

The legacy schema did not contain an explicit key-rotation, revocation, successor, predecessor, or
offline-recovery field. The wallet contains a TODO saying revocation still needed to be designed.

The imported time handling is inconsistent: protobuf comments describe milliseconds, some client
constructors write Unix seconds, and other paths write `Date.now()` milliseconds. The Monad port
then reused the generic profile shape and added global name and timestamp indexes. Consequently,
the current `MonadProfile` conflates the small federated directory record with the relay-local full
profile.

The replacement must preserve the useful legacy properties without copying these ambiguities.

## Data ownership and replication classes

| Class | Examples | Public federation |
| --- | --- | --- |
| Address directory | account, relay bindings, revision, expiry, recovery authority | yes |
| Relay descriptor | node identity, public endpoints, networks, services, pricing-policy reference | yes |
| Presentation profile | display name, bio, avatar, public application fields | no; fetch from selected relay |
| Public pubsub | topic posts, replies, edits, votes, tombstones, moderation events | yes, subject to subscription |
| Private mailbox | inbox/outbox ciphertext, delivery jobs, attempts, mailbox tombstones, notifications | never |
| Node-local operations | peer health, cursors, crawl frontier, retry timers, schema migrations | never |

The old Lotus `BroadcastMessage`/`DbTopics` transport is deprecated and is not a federation record
source. Monad topic events receive their own validated journal in #111. The current Forum also
reuses the Lotus broadcast protobuf as its inner content encoding; replacing that wire payload is
a separate staged migration, not a reason to replicate the old Lotus topic store.

A profile remains publicly readable and publicly verifiable, but it is not automatically copied to
every federation node. A client normally asks its own home relay to resolve the public directory and
fetch the signed profile. This avoids requiring the client to contact the destination relay
directly and disclose its IP address merely to render a contact.

Operators may add an explicit profile-mirroring or public-search product later. That is not the
default topology and must not be smuggled into directory replication.

## Network-qualified accounts

Users continue to identify contacts with ordinary chain addresses. There is no separate
user-visible mailbox identifier, encryption identifier, or stamp-payment identifier.

Servers use a typed canonical key so identically shaped addresses on different networks cannot
collide:

```proto
message NetworkAccount {
  bytes network_tag = 1;
  AddressType address_type = 2;
  bytes canonical_address = 3;
  string display_address = 4;
}
```

`(network_tag, address_type, canonical_address)` is authoritative. `display_address` is derived and
never used as a database key or signature identity. Initial address types must cover EVM EOAs,
Bitcoin-family P2PKH/P2WPKH/Taproot forms, Lotus P2PKH, and Solana accounts without pretending
their validation rules are interchangeable.

The current four-byte `NetworkTag` convention (`MONT`, `MON1`, reserved `LTUS`) is retained as the
Frank routing discriminator. Tags are protocol registry values, not arbitrary user strings. Nodes
reject unsupported or empty tags at new federation boundaries; legacy untagged stored records are
handled only by an explicit migration reader.

## Exact public attestation

Public records need transferable proof of authorship. A public attestation contains the signing
key, exact signature suite, exact payload bytes, and enough context to prevent cross-purpose and
cross-network replay:

```proto
message PublicKey {
  PublicKeyType type = 1;
  bytes key = 2;
}

message PublicSignature {
  SignatureSuite suite = 1;
  bytes signature = 2;
}

message AccountAttestation {
  uint32 envelope_version = 1;
  PublicRecordType record_type = 2;
  NetworkAccount account = 3;
  PublicKey signer = 4;
  bytes payload = 5;
  PublicSignature signature = 6;
}

message NodeAttestation {
  uint32 envelope_version = 1;
  PublicRecordType record_type = 2;
  bytes node_id = 3;
  PublicKey signer = 4;
  bytes payload = 5;
  PublicSignature signature = 6;
}
```

Initial key encodings:

- 33-byte compressed secp256k1;
- 32-byte x-only secp256k1; and
- 32-byte Ed25519.

Initial signature suites are exact algorithms, not family names:

- Bitcoin Cash May-2019 secp256k1 Schnorr;
- BIP-340 secp256k1 Schnorr;
- normalized RFC6979 secp256k1 ECDSA over SHA-256;
- recoverable secp256k1 ECDSA over the Frank attestation digest; and
- RFC8032 Ed25519.

The old protobuf value `SCHNORR` actually invokes `schnorrabc_sign`/`schnorrabc_verify`; migration
must identify it as the BCH-2019 construction, not reinterpret it as BIP-340. BCH Schnorr uses a
compressed public key, a plain SHA-256 challenge over its specified inputs, quadratic-residue point
selection, and a nonce-generation algorithm identifier. BIP-340 uses x-only keys, even-Y point
selection, and BIP-340 tagged hashes. They are not interchangeable.

Each suite has one allowed key encoding and exact length/canonicality checks. Unknown algorithms,
malformed keys, non-canonical signatures, and incompatible key/suite pairs fail closed.

### Signing digest

Protobuf serialization is not assumed to be canonical. The signature covers the exact `payload`
bytes and an explicitly framed context:

```text
payload_hash = SHA256(payload)

attestation_digest = SHA256(
    ASCII("frank/public-attestation/v1")
    || U32BE(envelope_version)
    || U32BE(record_type)
    || U32BE(length(network_tag)) || network_tag
    || U32BE(address_type)
    || U32BE(length(canonical_address)) || canonical_address
    || payload_hash
)
```

Every suite signs the 32-byte `attestation_digest` according to its own exact primitive. EVM
address recovery does not change that digest to an Ethereum `personal_sign` string or silently
rehash it with Keccak-256. This is application-level domain separation in addition to the suite's
internal challenge and nonce domain separation.

The verifier then proves that `signer` controls `account` using network/address-specific rules:

- EVM EOA: last 20 bytes of Keccak-256 of the uncompressed secp256k1 key without its SEC1 prefix;
- Bitcoin/Lotus P2PKH or P2WPKH: HASH160 of the canonical compressed secp256k1 key, followed by the
  address-type/network checks;
- Bitcoin Taproot: the specified x-only output-key relationship, not a P2PKH shortcut; and
- Solana: the 32-byte Ed25519 public key equals the canonical account bytes.

Script-based Bitcoin identities, multisignature policies, and BIP-322 proofs are known future
extensions. They must use an explicit proof type rather than being misrepresented as a single raw
public-key signature.

Relay descriptors use `NodeAttestation`, whose signing context substitutes a fixed-length node ID
for the network-account fields above. The node ID is derived from the canonical node identity key.
The descriptor payload lists the networks that node serves; a multi-network node is not falsely
modeled as belonging to one chain account.

## Exact time and record succession

Frank retains nanosecond timestamps without passing Unix nanoseconds through a JavaScript
`number`:

```proto
message Timestamp {
  int64 seconds = 1;
  uint32 nanos = 2;
}
```

`nanos` must be less than one billion. TypeScript stores exact timestamps as the pair above or as a
`bigint` conversion; JSON boundaries use decimal strings when a scalar nanosecond value is needed.

Time does not decide authority or federation progress. Every mutable identity record additionally
contains:

- a monotonically increasing revision;
- the hash of its predecessor record; and
- its issue and expiry timestamps.

Revisions express intended succession. Predecessor hashes detect concurrent updates. Nanosecond
time preserves event chronology and expiry but cannot silently resolve a fork caused by two
devices publishing successors to the same record.

`uint64` revisions and server journal sequences receive the same precision treatment as time:
Rust uses native integers, while TypeScript bindings expose `bigint` or lossless decimal strings.
They must never round-trip through a JavaScript `number`. Opaque client cursors do not expose a
sequence for clients to increment.

## Address directory

The small replicated record is:

```proto
message AddressDirectoryRecord {
  uint32 version = 1;
  uint64 revision = 2;
  bytes predecessor_hash = 3;
  Timestamp issued_at = 4;
  Timestamp expires_at = 5;
  repeated RelayBinding relays = 6;
  RecoveryAuthority recovery = 7;
}

message RelayBinding {
  bytes relay_node_id = 1;
  bytes relay_descriptor_hash = 2;
  uint32 priority = 3;
  Timestamp valid_from = 4;
  Timestamp valid_until = 5;
}
```

The containing attestation supplies the `NetworkAccount`; it is not duplicated inside the payload.
Multiple bindings permit migration, overlap, redundancy, and gradual multi-device convergence.
The account address remains the mailbox lookup key.

Ordinary routing records expire unless refreshed. Expiry means that new senders stop routing from
the record; it does not delete presentation profiles or queued mailbox data. Clients or an
authorized home relay may refresh the record before expiry, but only by producing a valid new
attestation.

The relay binding references a signed relay descriptor rather than copying the relay payment key,
pricing policy, and capabilities into every user's record.

## Relay descriptors

A relay operator publishes a signed descriptor containing:

- a node identity key and derived node ID;
- public endpoints;
- supported protocol versions, `NetworkTag`s, and services;
- descriptor issue/expiry times and predecessor hash;
- delivery pricing-policy identifiers and payment public keys where enabled; and
- retention/size capabilities expressed as policy references rather than promises embedded in a
  user's profile.

Directory records bind to the descriptor hash, preventing an endpoint or payment-policy
substitution. Descriptor updates are independently replicated and cached.

## Relay-local presentation profiles

Full profiles are signed `PUBLIC_RECORD_PROFILE` attestations stored by the selected mailbox
relay. They may contain display names, avatars, biographies, application capabilities, and public
inbox/stamp-acceptance policy.

The relay verifies account control exactly as the directory does. A cached or proxied profile
remains verifiable without trusting the cache. Profile TTL controls cache freshness; mailbox
storage leases control retention and are separate.

The current global `MonadProfile` listing and name index must not be treated as the new directory.
Migration separates routing fields from presentation fields before federation is enabled. Existing
local profiles remain readable until rewritten into the new form; they are never bulk-gossiped as
an intermediate compatibility mechanism.

## Rotation and revocation

Key transition is an explicit public record, not an untyped directory entry:

```proto
message KeyTransition {
  NetworkAccount previous_account = 1;
  NetworkAccount next_account = 2;
  bytes previous_record_hash = 3;
  Timestamp issued_at = 4;
  RotationReason reason = 5;
  repeated TransitionAuthorization authorizations = 6;
}

message TransitionAuthorization {
  TransitionRole role = 1;
  PublicKey signer = 2;
  PublicSignature signature = 3;
}
```

Routine rotation requires proofs by the current and successor authorities. Compromise/loss
recovery requires the recovery authority pinned by an earlier accepted directory record. Updating
that recovery authority itself requires the existing recovery authority; possession of only the
hot key is insufficient.

The exact offline-key aggregation and social-recovery construction in issue #46 still requires a
specialist cryptographic review. This plan provides the wire and state-machine attachment point but
does not approve the currently sketched MuSig-derived recovery protocol for implementation.

The old address retains a compact successor/revocation tombstone, and the new address references
the old record. Security tombstones outlive ordinary routing TTLs; otherwise an attacker could wait
for a warning to expire and resurrect a compromised authority. Clients given an old address can
follow the verified transition chain to the current account.

## Public federation event identity

Federation transports already signed public records. It never confers trust merely because a peer
sent a record.

Every stream validator produces a stable `record_id` from the validated semantic commitment. For
an account attestation this is its `attestation_digest`; for an existing chain-authorized topic
event it is the protocol's already-defined content or transaction commitment. The federation ID is:

```text
event_id = SHA256(
    ASCII("frank/federation-event/v1")
    || U32BE(stream)
    || U32BE(length(record_id))
    || record_id
)
```

Hashing raw protobuf envelopes would let alternate field ordering or repeated valid signatures of
the same payload defeat deduplication, so raw envelope bytes are deliberately not the identity.
The receiver validates the record through the stream-specific public boundary, obtains its
canonical `record_id`, and then performs an exact persistent lookup by `event_id`. An existing ID
returns `ALREADY_KNOWN`; it is not appended or forwarded again. New records and their journal
entries are committed atomically.

Directory reconciliation follows valid revisions/predecessors and transition authority. Topic
reconciliation follows content IDs and explicit relations such as reply-to, edit-of, vote-target,
and tombstone-of. Neither stream uses arrival time as semantic truth.

## Durable catch-up journal

Each node has a stable random `replica_id` and a durable local append sequence. A journal row is:

```proto
message PublicJournalEntry {
  uint64 sequence = 1;
  PublicStream stream = 2;
  bytes event_id = 3;
  bytes signed_record = 4;
}
```

The local sequence is transport order for that node only. It is not included in `event_id` and
does not claim global event order. A valid event learned transitively may be appended to the local
journal once, allowing small-world propagation.

Peers retain a durable opaque cursor per remote node, stream, network, and subscription. A catch-up
page contains entries, the next cursor, a fixed high-water cursor captured for that catch-up
session, and `has_more`. Fixing the high-water mark prevents a busy stream from making initial
catch-up endless. Applying the records and advancing the cursor is one atomic local operation. A
crash either replays the page idempotently or commits both data and progress.

Federation endpoints are chain-generic, for example `/v1/federation/events`; `NetworkTag` is data,
not a chain name embedded in the URL.

### Compaction and expired cursors

Journal retention and content retention are distinct. The first implementation may retain the
journal while the corresponding hosted public content remains available, but the wire contract
must represent `CURSOR_EXPIRED` from the beginning.

When a cursor is older than retained history, the source produces a consistent RocksDB snapshot at
a declared high-water mark. The receiver pages through current content-addressed state, validates
and deduplicates it, atomically records the snapshot high-water cursor, and resumes incremental
events. Directory snapshots include active records and durable rotation/revocation tombstones.
Topic snapshots include the events the operator's advertised retention/subscription policy says it
hosts.

A Merkle state root and inclusion proofs are a later integrity/efficiency enhancement. V1 does not
pretend a root is useful without specifying canonical ordering, snapshot isolation, and proofs.
Individual record signatures and content hashes remain mandatory in every version.

## Live gossip and loop suppression

Exact persistent `event_id` deduplication is the correctness mechanism. Rotating Bloom filters are
an optimization maintained per peer:

- receipt from a peer adds the event ID to that peer's known set;
- successful delivery or `ALREADY_KNOWN` does the same;
- a negative Bloom result permits eager forwarding;
- a positive result may suppress eager forwarding but never suppresses journal catch-up;
- filters rotate at a configured capacity and a bounded number of old generations is retained.

This preserves the useful old design while ensuring Bloom false positives cannot permanently lose
records. A mutable hop counter provides storm containment, not correctness. Public live gossip uses
bounded fanout rather than broadcasting to every known server.

## Peer discovery

An operator configures one or more seeds. After connecting, the node exchanges a signed,
expiring node descriptor and a version/capability handshake, then requests a randomized bounded
sample of additional descriptors. This is the conceptual equivalent of Bitcoin's `getaddr`/`addr`.

The persistent node-local peer table records descriptor hash, discovery source, supported networks
and streams, first/last seen, last success, failure/backoff state, and expiry. It never stores
private mailbox-cluster credentials.

Nodes maintain a modest stable outbound set plus periodic exploratory connections. Candidate
selection limits concentration by IP prefix and discovery source, rejects self-peering and
duplicates, and applies explicit operator policy to private/link-local endpoints to prevent SSRF.
Endpoint policy is rechecked against resolved addresses at connection time to resist DNS rebinding.
Redirects do not silently add peers. A nonce challenge signed by the node identity proves that the
live endpoint controls the descriptor key. Peer-list responses are randomized, rate-limited, and
capped; no requester receives the complete table by default.

Seeds are bootstrap hints, not permanent authorities. Once healthy peers are known, losing one
seed cannot isolate the node. Every received application record is still independently validated;
a signed node descriptor establishes descriptor continuity, not trust in relayed data.

## Selective topic federation

Directory records and relay descriptors are small and broadly replicated. Topic history can be
large, so operators advertise a topic-retention mode:

- full public mirror;
- selected topic IDs;
- bounded recent-history cache; or
- no topic service.

Catch-up cursors are scoped to the negotiated network, stream, and subscription generation.
Changing a subscription creates a new generation and snapshot/catch-up boundary rather than
reinterpreting an old cursor. Topic IDs and stable logical message UUIDs remain distinct from
recipient-specific encrypted payload digests.

## Process lifecycle

Startup order:

1. open durable RocksDB and finish schema migrations;
2. recover the node identity, peer table, journal, and committed cursors;
3. construct typed directory, relay-descriptor, pubsub, profile, mailbox, and node-local stores;
4. start peer discovery and public catch-up for enabled streams;
5. establish the catch-up high-water marks required by operator policy;
6. enable live gossip and public writes;
7. start private mailbox-cluster and delivery workers; and
8. accept client traffic.

Shutdown stops new writes, checkpoints cursors and delivery jobs, drains bounded work, stops peer
tasks, and closes RocksDB. No process is killed by pattern; each background task is owned by the
server lifecycle.

## Resource and abuse limits

Every boundary specifies limits for record bytes, batch bytes, entries per page, peers returned,
URLs per descriptor, relay bindings per account, signature operations per request, concurrent
fetches, retry budgets, journal growth, and snapshot duration. Invalid signatures, unsupported
algorithms/networks, decompression bombs, oversized unknown fields, and repeated invalid peers fail
before durable insertion.

Directory TTL prevents abandoned routing records from remaining active forever; it is not a
complete Sybil defense. Operator rate limits and any future proof-of-payment policy are separate.
No public federation endpoint accepts or emits mailbox ciphertext merely because both services run
in one binary.

### Economic boundary

Admission and replication are different economic events. An origin node may require a valid
network-specific proof of payment or other configured admission policy before accepting a new
directory or topic record. Peers validate and replicate the accepted proof; they do not demand a
fresh on-chain payment at every federation hop. Destination mailbox delivery/storage fees remain
the separate outer delivery wrapper designed in #89. V1 must expose admission-policy identifiers
in capabilities without hard-coding one universal fee model.

## Migration and rollout

This is a replacement stack, not one mixed migration:

1. Pin current legacy directory/profile behavior with tests and fix the protobuf toolchain as
   required by #85.
2. Add multialgorithm public-attestation and canonical network-account primitives alongside legacy
   readers; do not reinterpret old enum values.
3. Add separate directory, relay-descriptor, presentation-profile, journal, cursor, and peer-table
   storage families behind typed facades.
4. Write new directory records when a profile/relay selection is registered; continue local legacy
   reads during the bounded migration window.
5. Add exact event deduplication and cursor catch-up before live gossip.
6. Add peer discovery and bounded live forwarding with Bloom-filter hints.
7. Enable directory/descriptor convergence, then topic convergence.
8. Switch in-repository clients and bots to directory lookup plus relay-local profile fetch.
9. Remove the current global Monad full-profile listing from federation paths and delete legacy
   migration writers after the recorded removal trigger.
10. Implement key rotation only after #46's specialist cryptographic review.

No step enables full-profile gossip or exposes private mailbox stores as an intermediate state.
Rollback before the client switch disables new federation workers and continues legacy local reads;
after the switch, rollback retains new column families and journal cursors so a later deployment
does not replay or lose accepted public records.

## Proof matrix

The implementation is not complete without deterministic boundary tests for:

- BCH-2019 Schnorr, BIP-340, ECDSA, and Ed25519 positive and negative vectors;
- key/suite mismatch, malformed encodings, non-canonical signatures, wrong account, wrong network,
  wrong record type, and modified payload rejection;
- exact seconds/nanoseconds round-trip through Rust, TypeScript, protobuf, and persistence;
- directory revision, predecessor, fork, expiry, refresh, overlap, rollback, and tombstone behavior;
- stable-key relay migration while the old relay is hostile or offline;
- full presentation profiles never appearing in public directory pages or gossip;
- exact event deduplication through cycles in a three-node topology;
- Bloom-filter false positives repaired by cursor catch-up;
- offline peer catch-up, crash between page application and cursor commit, and expired-cursor
  snapshot recovery;
- seed-to-peer crawling, peer-table bounds, diversity selection, expiry/backoff, incompatibility,
  self-peering, redirect abuse, and private-address policy;
- topic convergence after missed live pushes and after subscription changes;
- a database populated with every record class proving public federation exports only directory,
  relay-descriptor, and selected pubsub records; and
- two independent relays where the bot lives on one and the user on the other, with public routing
  convergence and no private mailbox replication.

## Reviewed gaps and resulting decisions

The review rejected or corrected the following tempting shortcuts:

- **Replicate `MonadProfile` globally:** rejected; it repeats the current directory/profile
  conflation and creates ecosystem-wide avatar/bio bloat.
- **Use timestamps as versions or cursors:** rejected; clocks and malicious authored times cannot
  determine authority or replication progress.
- **Represent Unix nanoseconds as a JavaScript number:** rejected; it loses precision.
- **Call the signature scheme `SCHNORR`:** rejected; BCH-2019 and BIP-340 are incompatible.
- **Assume protobuf serialization is canonical:** rejected; signatures cover exact payload bytes
  through explicitly framed context.
- **Hash raw protobuf envelopes for event identity:** rejected; semantically identical encodings
  or repeated signatures could evade deduplication, so validators yield canonical record IDs.
- **Use Bloom membership as proof of delivery:** rejected; false positives require authoritative
  cursor anti-entropy.
- **Append a duplicate event every time it arrives through another peer:** rejected; exact durable
  deduplication precedes journaling and prevents perpetual circulation.
- **Put chain names in federation URLs:** rejected; `NetworkTag` is protocol data.
- **Make a relay URL the relay identity:** rejected; endpoints rotate, while node identity and
  signed descriptors provide continuity.
- **Expire revocation records with ordinary routing TTLs:** rejected; that permits resurrection of
  compromised identities.
- **Invent a Merkle checkpoint without proofs and canonical snapshot rules:** deferred; signed
  content-addressed snapshots are sufficient for V1 correctness.
- **Implement the sketched offline MuSig recovery immediately:** rejected pending #46's specialist
  review; the schema leaves the necessary authority and transition seam.
- **Build a generic replication framework:** rejected; V1 has three explicit public stream
  validators and typed stores, with shared journal mechanics only where directory, descriptors,
  and topics demonstrably need the same behavior.

## Ticket decomposition

The rollout should be tracked as a dependency stack rather than one federation mega-ticket:

1. correct #87's topology document and add enforceable typed public/private store boundaries;
2. add the multialgorithm public-attestation and network-account primitives;
3. split the address directory from relay-local signed presentation profiles;
4. add the durable public journal, exact deduplication, cursors, and snapshot recovery;
5. implement #88's seed-and-crawl peer table and bounded discovery protocol;
6. add Bloom-assisted live gossip on top of authoritative catch-up;
7. converge directory records and relay descriptors;
8. converge selectively retained topic events;
9. prove the complete multi-node topology and isolation behavior; and
10. retain #46 rotation/recovery as a security-reviewed successor rather than silently including
    unsettled recovery cryptography.
