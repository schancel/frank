# Directory, provider, and profile semantics

Status: normative semantic contract for #458. The deterministic-CBOR field allocation and
production cutover belong to #133. Storage, HTTP routes, and federation transport belong to their
downstream tickets.

This document fixes the language-neutral meaning of the three public-record families used for
routing and presentation. It does not assign CBOR map keys. Terms such as `commitment`, `revision`,
and `predecessor` describe semantic inputs that #133 must encode without changing their meaning.

## Objects and identities

The following concepts are distinct:

- An **account** is the canonical `NetworkAccount` controlled by an account authority.
- A **provider** is an independent mailbox/profile administrative domain. Its stable identity is
  derived from its provider signing key and does not change when its endpoints or internal
  instances change.
- A **provider binding** says that an account currently accepts service from one provider. Several
  bindings name several independent providers, not several endpoints of one provider.
- A **public endpoint** is one advertised way to reach a provider. It is replaceable routing data,
  not an identity or trust root.
- A **provider instance** is one private process inside a provider cluster. Instance identities,
  membership addresses, database addresses, and credentials never occur in public records.
- A **presentation profile** is account-authored display/application data stored at selected
  providers. It is independently signed and fetchable, but not directory data and not a public
  enumeration stream.

Every signed object has a `commitment`: the canonical semantic record ID produced after full
validation. #133 must domain-separate these commitments by record family. Signatures outside the
signed statement do not change the statement commitment.

## Common succession rules

Directory records, provider descriptors, and presentation profiles each form a per-subject
authenticated history.

1. A bootstrap record has no predecessor. Its revision may be any `uint64`; in particular, #106's
   legacy registration mapping uses the nonnegative millisecond timestamp as the initial revision.
2. Every successor names the predecessor commitment and has a revision strictly greater than its
   predecessor. A revision is an ordering label, not a count: gaps are allowed, but a larger number
   cannot erase the required predecessor link or an unresolved competing branch.
3. `issued_at` is evidence and freshness input, not authority or ordering. It must not select a
   winner between branches.
4. A successor must not lower its schema version for the same authority. Unknown required schema,
   signature suite, transport, or capability semantics fail closed. Unknown optional fields are
   retained byte-exactly and do not become active behavior until understood.
5. A record is **structurally valid** after its schema, commitment, signatures, subject, succession,
   bounds, and family-specific rules pass. It is **active** only when it is also current and within
   its validity interval at the evaluator's supplied time.
6. Validation takes an explicit `evaluation_time`. Stored authored or arrival time is never used as
   an implicit clock. A record is not active before `valid_from` and ceases to be active at
   `valid_until`; intervals are half-open: `[valid_from, valid_until)`.
7. A successor may be accepted and retained before `valid_from`, but does not become active early.
   An expired record stays in authenticated history and deduplication state; expiry does not erase
   it or permit an older record to become current again.

### Competing successors

Two structurally valid records with the same predecessor are a fork. A node retains the bounded
fork evidence but does not choose a branch by arrival time, issue time, expiry, revision, byte
ordering, signature ordering, or provider preference.

While two incomparable live heads remain, the subject is **conflicted** and resolution fails
closed:

- a conflicted directory yields no new routing decision;
- a conflicted descriptor yields no newly learned endpoints;
- a conflicted profile yields no newly selected presentation data.

Previously completed operations are not undone. Existing provider delivery jobs may finish against
the exact directory and descriptor commitments they pinned, subject to their own expiry rules.

A fork is resolved only by a later signed resolution record that:

- names the common ancestor;
- names every retained competing head in canonical commitment order;
- chooses exactly one head as its predecessor and uses a revision greater than every named head;
- is authorized by an authority that was valid at the common ancestor; and
- passes the ordinary current-subject signature rule.

For a same-subject fork, the common account/provider authority can resolve it. If competing heads
changed authority, resolution additionally needs the already-defined transition/recovery
attachment authorized from the common ancestor. This rule reserves no new recovery construction
and does not approve the recovery protocol in #46.

An implementation retains at most eight competing heads per subject and at most 64 records from
the common ancestor through unresolved heads. Once either limit would be exceeded, it rejects the
new candidate with `resource_limit` while preserving existing evidence. Resolved losing heads stay
as audit/deduplication facts but can never become current through expiry or rollback.

The common state machine is:

```text
absent --valid bootstrap--> current
current --valid future successor--> current + pending
current --pending valid_from reached--> superseded + current
current --one valid immediate successor--> superseded + current
current --two incomparable successors--> conflicted
conflicted --valid complete resolution--> superseded branches + current
current --valid_until reached--> expired (no fallback)
```

Malformed, unauthorized, unsupported, stale, and over-limit inputs do not change durable current,
pending, or conflicted state.

## Directory record

A directory record is keyed by its canonical `NetworkAccount` and contains:

- schema version, revision, predecessor commitment, and optional fork-resolution evidence;
- `issued_at`, `valid_from`, and `valid_until`;
- one through 32 provider bindings;
- the account's current stamp key;
- optional transition/recovery attachment points; and
- no presentation-profile or mailbox content.

Consumers derive and durably retain the immediately previous stamp key as required by the
deterministic-CBOR protocol; it is not copied into each authored directory record.

The record is authorized by the current account subject. A subject change also requires the
transition linkage defined by the deterministic-CBOR contract. A provider, endpoint, profile key,
or stamp key alone cannot update the directory.

### Provider bindings

Each binding contains a stable provider ID, the exact provider-descriptor commitment the account
approved, a priority, and a validity interval. Bindings are unique by provider ID. Their intervals
must be contained in the directory interval. The descriptor subject must match the provider ID.

At an evaluation time, resolution returns every active binding in ascending priority and then
provider-ID byte order. Equal priority means independent alternatives; it does not merge providers
or expose their internal instances. A sender may try active providers in that deterministic order,
subject to local health/backoff policy. Local health changes attempt order only and never changes
the signed directory result.

Migration is an ordinary successor:

1. publish a record containing old and new provider bindings for an overlap interval;
2. allow both providers to serve profile/mailbox operations independently during the overlap; and
3. publish a later successor omitting the old provider.

The old provider does not sign either update and cannot block them. Removing a binding stops new
routing through it; it does not delete data or cancel work already committed there. A binding whose
descriptor is unavailable or invalid is unusable, not permission to substitute another descriptor
or an endpoint learned from DNS.

Directory expiry yields `no_active_directory`. It never falls back to an expired predecessor, a
legacy protobuf record, or a full presentation profile. Refresh is a normal successor, even when no
other field changes.

## Provider descriptor

A provider descriptor contains:

- stable provider ID and provider signing authority;
- schema version, sequence, predecessor commitment, and optional fork-resolution evidence;
- `issued_at`, `valid_from`, and `valid_until`;
- supported protocol versions, network tags, and public services;
- zero through 32 public ingress endpoints; and
- optional pricing-policy identifiers and payment public keys.

Descriptor `sequence` follows the common revision rules. Zero endpoints is valid and intentionally
withdraws reachability without revoking provider identity. A directory binding remains an
authenticated historical assertion but is unusable while its exact referenced descriptor has no
active compatible endpoint.

Each endpoint contains exactly one DNS name or literal IP address, transport, port, priority,
weight, and TLS/application-authentication name. DNS names are ASCII A-labels. Literal addresses
are canonical IPv4 or IPv6 bytes. Endpoint identity and TLS/application authentication are checked
against the signed descriptor; DNS answers are routing candidates only.

Resolution groups endpoints by lowest numeric priority, then uses weight only to distribute
attempts within that priority group. A zero weight remains eligible when every endpoint in the
group has zero weight. Local selection must re-apply private/link-local/loopback policy after DNS
resolution and on every connection. Redirects do not amend the signed endpoint set. An optional
literal-IP endpoint is an independently signed fallback; a DNS response cannot create one.

A descriptor successor may rotate endpoints without changing provider identity. A directory
binding pins an exact descriptor commitment, so a newer descriptor is not silently substituted.
The account publishes a directory successor when it accepts the new descriptor. This prevents a
provider from unilaterally changing the payment key or service contract an account advertised.

## Presentation profile

A presentation profile contains account-authored display and application metadata plus its own
schema version, revision, predecessor commitment, issue time, and cache expiry. It is signed by the
account authority and is independent of both the directory statement and provider descriptor.

#106's schema-3 field 9 is the bounded registration-migration representation of legacy profile
entries. #133 must split those entries into this independently signed profile record before public
directory federation is enabled; schema-3 compatibility bytes never become public enumeration.

Profiles are fetched from an active bound provider or a verified cache by account and expected
profile commitment. A cache may return exact signed bytes; it cannot resign, merge, normalize, or
invent fields. Expiry makes a profile stale for normal rendering but does not alter directory
routing or delete provider data.

Public federation and public directory enumeration expose only directory records and provider
descriptors. They must not expose profile bytes, display names, biographies, avatars, profile
search indexes, mailbox bytes, or provider-internal data. A profile-search product requires a
separate explicit publication and retention contract.

## Time and resource bounds

The following are protocol maxima, not recommended refresh intervals:

| Item                              |           Limit |
| --------------------------------- | --------------: |
| Directory record / attestation    |         256 KiB |
| Provider bindings per directory   |              32 |
| Directory validity window         |        366 days |
| Provider descriptor               |         128 KiB |
| Public endpoints per descriptor   |              32 |
| One DNS/authentication name       | 253 ASCII bytes |
| One exact endpoint representation |     2,048 bytes |
| Descriptor validity window        |         31 days |
| Presentation profile              |         256 KiB |
| Profile validity window           |        366 days |
| Future-issued tolerance           |      10 minutes |
| Competing heads per subject       |               8 |
| Retained unresolved-fork records  |              64 |

`valid_until` must be later than `valid_from`, and the interval must not exceed the applicable
maximum. `issued_at` must be no later than `evaluation_time + 10 minutes` when a record is admitted
from an untrusted peer. A locally authored record may be stored before that check but must not be
served or federated until it passes. Clock rollback does not reactivate an expired or superseded
record because the durable current-head state is monotonic.

## Legacy migration and rollback

Legacy `MonadProfile` and `AddressMetadata` records are input to a local migration reader only.
They are never public-directory records and are never exported by the new federation facade.

1. Before cutover, legacy reads and writes continue unchanged.
2. A user-authorized registration writes a new signed CBOR directory record and an independently
   signed CBOR presentation profile. The legacy timestamp may seed the new revision only through
   the exact #106 registration mapping; it does not create a trusted predecessor.
3. During the bounded compatibility window, local reads prefer a valid current CBOR record. They
   consult legacy state only when no CBOR history exists for that account. Invalid, expired,
   conflicted, or unsupported CBOR state must not fall back to legacy data.
4. A compatibility writer may update the legacy local view after a successful CBOR commit for old
   in-repository clients. It is not atomic authority, is never federated, and cannot be read back to
   overwrite CBOR state.
5. Legacy writers and readers are removed only after all in-repository clients use the CBOR API, a
   restart/catch-up migration test passes, and a repository audit proves no supported caller uses
   the legacy path. The deployment records a durable `legacy_directory_retired` marker before the
   code that depends on fallback is removed.

Rollback before client cutover disables CBOR writers/federation and resumes legacy local reads for
accounts with no CBOR history. Accounts with accepted CBOR history remain pinned to that history;
rollback never converts unknown CBOR fields to protobuf or makes stale legacy data authoritative.
Rollback after client cutover preserves CBOR stores, fork evidence, current heads, journal IDs, and
retirement markers. Restoring legacy authority after that point is a new migration, not an
operational toggle.

## State-machine scenarios required by #133

#133's cross-language vectors and the storage/API tests in #107 must cover at least these cases:

| ID  | Scenario                                                            | Required result                     |
| --- | ------------------------------------------------------------------- | ----------------------------------- |
| D01 | any `uint64` revision, no predecessor, valid signature and interval | bootstrap current                   |
| D02 | bootstrap names a predecessor                                       | reject succession                   |
| D03 | greater revision and matching predecessor                           | advance current                     |
| D04 | reused/lower revision or wrong predecessor                          | reject succession                   |
| D05 | future `valid_from` successor                                       | retain pending; keep current active |
| D06 | current directory expires                                           | no active directory; no fallback    |
| D07 | two successors of one predecessor                                   | conflicted; no new routing          |
| D08 | explicit resolution naming every fork head                          | chosen branch advances              |
| D09 | resolution omits a retained head or uses post-fork authority        | reject resolution                   |
| D10 | old/new providers overlap, then old is removed                      | both route, then only new           |
| D11 | old provider is hostile or offline during migration                 | account update still advances       |
| D12 | binding interval exceeds directory interval                         | reject bounds                       |
| P01 | descriptor rotates endpoints under stable provider ID               | accept successor only               |
| P02 | binding pins old descriptor while a new one exists                  | use pinned descriptor only          |
| P03 | poisoned DNS answer fails address policy                            | reject address; retain descriptor   |
| P04 | signed literal-IP fallback survives DNS failure                     | fallback remains eligible           |
| P05 | zero-endpoint descriptor                                            | provider intentionally unreachable  |
| R01 | valid independently signed profile from bound provider              | render/cache exact bytes            |
| R02 | profile expired while directory remains active                      | profile stale; routing unchanged    |
| R03 | public enumeration over database containing all classes             | no profile/private bytes            |
| M01 | account has legacy state and no CBOR history                        | compatibility read allowed          |
| M02 | account has invalid/expired/conflicted CBOR plus legacy state       | no legacy fallback                  |
| M03 | rollback after accepted unknown CBOR extension                      | preserve CBOR; no conversion        |
| L01 | ninth fork head or 65th unresolved record                           | reject resource limit               |

The same input set, evaluation time, and retained history must produce the same outcome regardless
of arrival order, process restart, peer source, or language implementation.
