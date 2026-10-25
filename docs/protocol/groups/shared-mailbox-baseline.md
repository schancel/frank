# Shared mailbox review baseline (#1584)

This breaking, unmerged protocol stack implements encrypted group creation, direct-message invitations with explicit accept/decline, shared-mailbox chat, admin invitations/removal and local stop-following. It must not be deployed with the current production wire format.

## Authority and ownership

Custody derives and signs an account-bound additive member key through `accountSession.getGroupSigner`; messaging never obtains private identity material. Each roster binds a canonical address to its public account identity and derived member key. The group root signs epoch certificates, and only its founding administrator retains the root secret. Every rotation mixes administrator-only entropy into the successor secret: `HKDF-SHA256(ikm = root secret, salt = groupId32 || prevEpochHash32, info = "frank-group-admin-rotation-v1:" || nextEpoch)` (`deriveAdminEpochSecret`). An excluded holder of the preceding epoch secret cannot derive the successor, while every device of the administrator account derives the same successor secret without coordination. Relay storage authenticates certificates and atomically checks the active epoch and message sequence when appending.

A rotation is prepared from the relay's latest epoch (adopting first anything another administrator device published), persisted as a pending successor with its recipient queue, and applied locally only once the relay acknowledges it or shows it as current. A timeout leaves it pending for reconciliation. When the relay CAS instead shows a different successor, the administrator device derives its secret, verifies the certificate against its signed roster and predecessor, adopts it, and drops the prepared successor and its never-sent deliveries; the user's change fails with a retryable error. A later identical group-control for an adopted epoch is a no-op.

The signed epoch certificate owns membership and presentation. Frontend roster indexes are derived views. The durable message receipt owns each exact signed group envelope; pending indexes only reference it. Persist certificates, recipient queues and original authorized content before publishing. Persist authenticated incoming receipts before advancing a mailbox cursor.

A group message's identity is the member-signed inner digest (`innerDigestHex` from `openGroupMessage`), not its ciphertext. A member who re-encrypts another member's signed frame under a new nonce produces a row with the same identity, which collapses into the original. Messages are shown at the sender-signed `timestampMs`; the relay's `server_time_ms` only records acceptance, so a replay's later relay time changes nothing members see. The relay appends only at its current epoch, so once a row of a later epoch has been accepted, a later row of an older epoch is skipped rather than shown. Rows carry `server_seq` and `server_time_ms`; the relay keeps no separate versionstamp row. Retries reconcile the original certificate/envelope and recipient queue rather than preparing fresh operations.

## Idempotent authoritative append and development storage baseline

The hosting `GroupStore` owns each original accepted signed-content receipt. Its `G_accept`
index maps `(group_id, existing envelope signing digest)` to the original sequence, and is
committed in the same transaction as the row, sequence and epoch/local-ownership guards.
The immutable row owns content, signature, sequence and time; the lookup owns no competing
financial fact. Matching authenticated retries return that exact row, including after an
epoch rotation, using its root-signed historical certificate. Equivalent hex/JSON/CBOR and
valid signature encodings do not append again. New content still requires the active epoch.
This relay key is the outer write-signature digest over `(group_id, epoch, nonce, ciphertext)`,
not the member-signed inner digest that names a message to members: the relay cannot read the
inner frame, so a re-encryption under a new nonce is new content to the relay and appends, and
members collapse it by inner digest as described above. The index only stops a retried
identical envelope from appending twice.
Mirrors never accept local authoritative appends. No credit ledger, charge or grant is added. The high-level
TypeScript client deliberately retains strict acknowledgement signature equality and retries
its original compact signature. Low-level authorized clients can submit equivalent signature
encodings and receive the original receipt; teaching the high-level client to validate such a
different signature needs a separately scoped epoch-verification capability, not weaker echo
checks.

Only a newly committed append publishes an ephemeral wake. The HTTP
`X-Group-Append-Disposition` response (`appended` or `existing`) carries this notification
hint through the home proxy; it never advances a durable cursor or establishes financial
acceptance. Ordered reads and persisted authenticated receipts remain authoritative.

The dedicated relay store at `registry_db.with_extension("groups-v1")` requires `G_format = group-binary-rows-v1`.
Message rows are binary CBOR; a ciphertext over 64 KiB is stored in the relay's large-value object
store as its own upload (`groups/sha256/<hex>/<upload-id>`) and the row keeps the upload id,
SHA-256 and length. A store with the earlier
`group-append-idempotency-v1` marker (JSON rows) is refused without migration.
Read-only opening inspects only GroupStore-owned prefixes and never writes a marker.
Unrelated KV namespaces are ignored. An empty group namespace is valid; the first authorized
epoch/foreign-admission/import mutation initializes the marker by CAS. A crash leaving only
the marker safely reopens. Old nonempty unmarked group state and unknown markers fail
explicitly. There is no migration, duplicate-row cleanup, index backfill, dual reader or
automatic deletion. An operator may manually replace only disposable dedicated development
group-relay state after preserving/exporting any required original certificates/envelopes;
this never authorizes deleting registry data, private keys, funded wallets, financial journals
or unrelated local data. A corrupt acceptance locator or referenced receipt fails visibly rather
than synthesizing a successful retry. Reversal requires restoring the complete matching
old development store/code baseline, never mixing old writers with this marker/index.

The Rust append/HTTP regression gate is:

```sh
CARGO_TARGET_DIR=/tmp/frank-group-live-cargo-target cargo test --manifest-path backend/cashweb/Cargo.toml -p cashweb-registry groups --lib
```

The explicit two-router TypeScript gate below also checks repeated direct/proxied writes,
unchanged receipt sequences and historical retries after rotation.

## Paid group writes

Every new write to a group carries one payment to the group's hosting relay: a signed EVM
transaction, in the envelope's `payment` field (`group-write-payment` in
`docs/protocol/message-types/fields/groups.json`: `network`, the canonical chain identifier, and
`raw-transaction`; JSON carries the transaction as hex in `payment.raw_transaction`). Writes
that do not pay are refused; there is no free write and no credit ledger.

Every relay configuration must include `[registry.group_writes]`, checked by `--check-config`
and at startup before any database is opened:

```toml
[registry.group_writes]
price_wei = "1000000000000"  # decimal wei, more than zero
payee = "burn"               # or { address = "0x…" } or { xpub = "xpub…" }
```

Payments commit to the relay's public origin, `host_origin` below. It is the configuration's
top-level `url`, which must be a bare `http(s)` origin and equal the `[registry.directory]`
endpoint; there is no second setting for it. The removed `[registry.groups]` section is
refused at load with a message that says to delete it.

The payment's network is the relay's `[registry] network`. The payee is exactly one of: the
burn address `0x000000000000000000000000000000000000dEaD`; one operator address; or an extended
public key (`xpub`/`tpub`), where each write pays its own child address. `GET
/groups/:group_id/write-policy` reports `{network, price_wei, host_origin, payee}`; a home
relay proxies it to the host like every other group route, and the client refuses a policy
whose `host_origin` is not the relay it writes to.

The transaction's calldata commits to exactly one write on exactly one relay:

```text
commitment = SHA256( lp("frank/group-write-payment/v1") || lp(network) || lp(host_origin)
                     || group_id[32] || epoch_be[8] || write_signing_digest[32] )
calldata   = "GRPW" || 0x01 || commitment          (37 bytes)
lp(x)      = u16_be(len(x)) || x
```

`write_signing_digest` is the digest the group write key signs (`computeOuterWriteSigningHash`).
For an `xpub` payee the child is `xpub/0/i` (non-hardened), `i = u32_be(commitment[0..4]) &
0x7fffffff`, so writer and relay agree on the address with no round trip. This rule is
proposed and awaits the owner's confirmation.

The hosting relay checks the payment from its bytes before anything is stored: the network
string, a decodable signed transaction (legacy or EIP-1559) of at most 128 KiB with the native
chain ID of that network, the calldata, the payee address and a value of at least the price.
Refusals are HTTP 402 with `group_payment_required` (no payment) or `group_payment_invalid` and
a `reason` of `wrong_network`, `malformed`, `wrong_chain`, `wrong_commitment`, `wrong_payee` or
`underpaid`; no sequence is consumed. A relay without `group_writes` answers 503
`group_writes_unavailable`.

A payment that passes these checks must also be able to land. Just before the accept
transaction the host reads the payer's pending nonce and balance from its verified node
upstream (3 s timeout). The writer's wallet shuffles the payment among its own self-sends
(change, splits, consolidation) on the same account in random order, and broadcasts them, in
nonce order, only after the host holds the write; so the host accepts a nonce anywhere in
`[pending, pending + 63]` (`PAYMENT_NONCE_WINDOW`: the most self-sends one EVM transaction set can
place before its payment). It requires a balance of at least value plus gas limit times max fee.
A payment the node already holds, pending or mined, passes.

- Nonce below the pending one, and not held: 402 `group_payment_unfunded`, reason
  `stale_nonce`. Definitive: the payment can never land.
- Nonce above the window (`nonce_gap`, for example a stacked successor whose predecessor set has
  not reached the node) or too little balance (`insufficient_balance`, for example a deposit not
  yet seen): 503 `group_payment_not_ready` with `Retry-After`. Not a refusal: the writer keeps
  the write pending and retries the same bytes.
- The node cannot be read, or the relay has no verified upstream for its network: 503
  `group_payment_check_unavailable` with `Retry-After`, so a relay never accepts writes it
  cannot check.

No sequence is consumed in any of these cases. The check keeps no state; the store does. The
accept transaction also writes `'G_pnonce:' || u8(len(network)) || network || payer || nonce_be`
with the payment's hash. A different payment at a (payer, nonce) that already funded a write is
refused, 402 `group_payment_invalid` with reason `nonce_used`, and nothing is stored; the exact
retry of the accepted write still gets its receipt first. The remaining exposure: an accepted
payment that never lands, because the payer gets another transaction included at its nonce. Each
such write still costs the payer one landed transaction at that nonce, and at most 64 of a payer's
writes (the window) can be outstanding unlanded: the same class as the replaced-nonce exposure DM
stamps have. A Monad node checks a new transaction against state a
few blocks behind the head and keeps turning down bytes it once turned down, so a payment the host
accepts right after its deposit may be refused by that node for a while (seen on solonet). A home relay forwards the payment untouched: only the host checks
it, and a payment committed to one host is `wrong_commitment` on every other. Before any of these checks the host looks up whether
it already accepted the envelope: a retry of an accepted write gets its original receipt
(`existing`) whatever its payment and whatever the price or payee are now, and hands nothing
over. A new write's payment is recorded at `'G_pay:' || tx_hash` (network, payer, payee, value,
and the group and sequence it funded) in the same transaction that accepts the write; a payment
that already funded another write is refused 402 `group_payment_invalid` with reason
`already_used`, and two writes racing on one payment conflict in the store, so one of them is
appended. The relay's own failures to reach another relay or node are 502, or 504 for a
timeout, never a 4xx. A retry of an accepted write may omit `payment` (it is optional in the
field table): the host answers from its receipt before it looks at the payment. The host hands the payment of a newly appended write to its node after the write
commits, once; the writer's wallet broadcasts the same bytes either way. The
pure checks are `backend/cashweb/cashweb-registry/src/group_write_payment.rs`; the writer's
half is `packages/cashweb/groups/group-write-payment.ts`, checked against the same vectors.

The writer pays through the wallet's transaction-set capability
(`packages/group-messaging/groups/write-payment.ts`). The order is persist, submit to the relay,
then broadcast, each step durable before the next: the plan (payee, price, calldata) and its
wallet operation `group-write-<write_signing_digest>` are stored on the message; the wallet signs
its transaction set (`maxRecipientTransactions: 1`: one payment, plus the set's own self-sends in
random order) and claims its coin, broadcasting nothing; the payment's signed bytes are stored on
the message, and only they go to the relay; the write goes to the host with those bytes; and
only when the host answers that it holds the write (`appended` or `existing`) does the wallet
authorize the set, broadcast all of it sorted by (account, nonce) and keep reconciling it. Until that authorization
succeeds the message stays pending, and the next retry repeats the (existing) write and this
step.

The message records `submitted` before the bytes first leave the device. A 503 with a
`group_payment_*` code is the host saying it checked the payment and stored nothing yet: the
write stays pending and is retried with the same bytes. Any other outcome without a refusal (no
answer, a timeout, another 5xx, any other error) may still have stored the write and broadcast
its payment: the message records `uncertain` and the write is retried with the same bytes;
nothing is signed again, after a restart too. Only these are definitive refusals: a 402 with a
`group_payment_*` code, which only the host produces after checking the payment, and a 403 or 404,
which the relay the writer submits to produces itself (a home relay, for example, refusing a
write to a group it only mirrors) or passes on from the host. Any other 4xx is treated as
unknown.

On a definitive refusal with no earlier unknown outcome, the message records `releasing`, then
the wallet's `releaseTransactionSet` reads the chain and releases the coin only when no member
was authorized or exposed and the node holds none of them; the message records `released` and
is shown as `rejected`; this is final. If the chain does show the payment, the funds have moved:
the wallet authorizes and tracks the set so reconciliation applies its mined state, the message
records `spent`, and the write stays pending as `rejected-paid` and is retried with the same
bytes, since the payment is owed its write (a host accepts a payment the node already holds). A
restart with `releasing` stored finishes the same step (a release already done is recognised).
After an unknown outcome a later refusal never releases: the writer asks the wallet to observe
the chain; a seen payment is tracked as `spent` as above, an unseen one leaves the write pending
as `unverified` and it is retried with the same bytes. Once the relay holds the write, from a
retry or from a sync that shows it, the earlier failure reason is cleared.

Another device of the account derives the same operation. A plan whose bytes were never
submitted is replanned when the host's policy changed (for example a price rise): the old
operation is released and a new one, `group-write-<digest>-<generation>`, is signed. If the
wallet will not release a set whose bytes were stored, the plan is kept and the write fails to
retry; a plan whose set was never constructed has nothing to release. Once bytes
were submitted the policy is never read again. A wallet on another network than the host's signs
nothing and the write stays pending as `unavailable`.

## Home-relay boundary

Relay addresses are canonical root origins; client configuration, creation and signed-roster admission reject path prefixes, credentials, queries and fragments before creating durable group state. Browser clients require HTTPS except local HTTP development endpoints. Production upstream transport validates public IP/DNS destinations, pins the validated resolution, disables redirects and environment proxies, and applies DNS/connect/total deadlines plus streamed response budgets. Loopback upstream allowance is compiled only into Rust tests.

Only a successfully authorized read may establish a foreign upstream/subscriber record. A subscriber counts by its blinded `X-Group-Subscriber-Tag`, or without one by a SHA-256 hash of its read capability; the read token itself is never stored. The lazily opened group store is opened once under a lock, off the async runtime. Its upstream affinity cannot be replaced by a different caller. Mirrored groups reject authoritative local writes. Latest foreign epoch reads consult the upstream even after promotion; immutable historical certificates may be cached. A routed write acknowledgement never advances the contiguous mirror cursor over unseen messages. Ordered fetched prefixes alone advance that watermark.

Foreign fetches use pages of at most eight envelopes so the existing 1 MiB ciphertext limit fits the 20 MiB response budget. Epoch, acknowledgement and error bodies have separate smaller budgets. Success and error streams are bounded, including chunked bodies; deadlines cover stalled streams. Smaller pages preserve sequence-based progress across repeated polling.

## Conversation namespaces and admission

The previous development proposal used a UUIDv5-shaped group conversation identifier. This baseline deliberately changes only group conversation IDs to UUIDv8: take the first 16 bytes of SHA256(`frank-group-conversation-uuid-v1:` || groupId32), set version bits to 8 and RFC variant bits to 10, and format as a UUID. All group writers/readers use `groupConversationUuid`; `isGroupConversationId` reserves that namespace. Account/key/payment derivations, default direct UUIDv5 and explicitly created direct UUIDv4 IDs are unchanged. There are no aliases or migrations for old group IDs.

An ordinary direct message cannot own a reserved group ID, including before an invitation arrives. It projects into the authenticated sender's default direct thread using the existing private account salt. Only validated shared-mailbox envelopes enter a group conversation. Pending and declined invitations do not relax admission. A new member receives only the invited epoch secret. Older opaque rows are skipped only after verifying their public historical root certificate and outer write signature; current or already-owned historical content must decrypt and validate before cursor progress. Owned historical epoch keys remain available for backlog sync across rotations.

Direct conversations have the closed set {self, peer}. A third party claiming a known direct thread is stored in their own direct thread. The persisted `requestedConversationId` retains the authenticated original claim separately from the local owner; content, payment items, stamps, outpoints and signed financial records remain intact. The original thread displays a reference with View 1:1/Create Group/Dismiss. Dismissal only removes that reference and persists a watermark. Email and group conversations do not display this direct-thread reference banner.

## Unsupported development records and remaining scope

Read-only hydration validates required signed group certificates/envelopes and persisted direct projection. Unsupported unsigned group records or old unprojected third-party claims fail visibly; hydration does not initialize custody or delete records. A developer may manually reset only disposable chat-view metadata after exporting anything needed. This is not an automatic reset and never authorizes deleting private keys, spend inventory/reservations, original signed envelopes, outbox/submission journals, or financial recovery records. No reset is performed by this change.

Payment items and stamps inside group messages are explicitly unsupported and rejected at the headless send boundary; the write itself pays the hosting relay (see Paid group writes). Prepaid group credits, relay migration, invite links/QR, external cryptographic review remain outside this implemented baseline; this does not close all of #70. Local stop-following is not cryptographic revocation.

Group welcome/control payload types, pure CBOR codecs and the nested epoch certificate schema are owned by the headless `@frank/group-messaging` feature. App, bot, mail and CLI composition explicitly install its plugins through `groups/plugin`; importing the feature does not register it. Cashweb owns the neutral registry contract and relay epoch transport type; core codec retains framing and enclosing validation budgets. Wallet custody does not import the group feature. See [group feature ownership and checks](../../../packages/group-messaging/README.md). External cryptographic review remains required.

## Reproducible HTTP gate

Build the synthetic loopback-only server from this worktree:

```sh
cd backend/cashweb
CARGO_TARGET_DIR=/tmp/frank-group-backend-cargo-target cargo build -p cashweb-registry --example group_http_fixture
```

Then, from the worktree root:

```sh
FRANK_GROUP_HTTP_FIXTURE=/tmp/frank-group-backend-cargo-target/debug/examples/group_http_fixture ./node_modules/.bin/jest --config packages/cashweb/jest.config.js --runInBand --runTestsByPath packages/cashweb/groups/group-http.jest.test.ts
```

The gate spawns and terminates the ephemeral in-memory router. It validates actual routes, headers, serialization, signatures, acknowledgements, read-token authorization, client reconnect/repeated reads, removal and stale epoch CAS. It uses synthetic identities and no public service. Rust store tests separately cover RocksDB reopen, concurrent append, rotation races and fault injection. This is not live browser or distributed deployment evidence.

The foreign-home gate explicitly starts two Rust test routers and invokes the actual TypeScript client:

```sh
cd backend/cashweb
CARGO_TARGET_DIR=/tmp/frank-group-security-final-target cargo test -p cashweb-registry typescript_foreign_client_against_real_rust_relays --lib -- --ignored --nocapture
```

This test is ignored by default because Rust-only CI need not install Node dependencies. Run it explicitly from a worktree with the JavaScript dependencies available. It proves post-promotion rotation and preservation of unread backlog when a later send is routed through the home relay. Each original mirror defect independently fails this same real-network gate. The loopback policy exception exists only in the Rust test build.

## Live wakeups and durable recovery (#70 followup)

Browsers open `GET /groups/:group_id/live` only at their configured Home Relay, including foreign groups. The URL has no query parameters or credentials. The first bounded WebSocket frame carries `{ epoch, read_token, upstream_relay?, subscriber_tag? }`; TLS protects the read capability in production. The server reuses the authorized ordered-read boundary to validate the epoch/read capability and established upstream affinity. Promoted mirrors remain foreign even when a subscriber omits its upstream. Rotation invalidates subscriptions, and host composition closes old subscriptions on session cleanup, Home Relay replacement, local stop-following and epoch changes.

Only `{ "type": "group-wakeup" }` travels to the browser. No message, payment, receipt or sequence is authoritative on this channel. Successful durable epoch/message commits publish best-effort local or ephemeral Core NATS hints in the separate `frank.<cluster>.grp.<group_id>` namespace (`<cluster>` is `registry.cluster.cluster_name`); publication is bounded and cannot turn a committed write into a failed acknowledgement. Notification loss, repetition or reordering is harmless because the existing authenticated range reader and signed-envelope receipt remain the sole persistence/progress owners. Startup and reconnect trigger a range read; the app drains small foreign pages and coalesces concurrent hints.

Foreign live delivery currently uses five-second server-side HTTP probes through the existing validated, pinned, deadline-bounded transport. It is not remote push: foreign delivery latency includes that interval and request time. The same probe repairs lost local/NATS notifications. Each socket is limited to a 4 KiB first frame, five seconds for authentication, fifteen minutes of lifetime and bounded writes; unauthenticated, slow and disconnected sockets are closed. There is no per-process socket or probe admission cap (abuse hardening is out of scope). The browser follows at most 32 group subscriptions per store, leaving the existing durable polling path to catch remaining groups; browser reconnect uses capped backoff. No new durable journal, wallet lock, credit policy, message codec or cryptographic format is introduced.

The foreign-home Rust gate above also runs `packages/cashweb/groups/group-live-http.jest.test.ts`. It proves actual Home Relay-only browser-shaped WebSocket connections through two Rust routers, local immediate wakeups, missed foreign hints, disconnect/reconnect, stop/start catchup, rotation and stale-capability rejection. `group-live.jest.test.ts` covers repeated hints, coalescing and stale socket callbacks; app group-sync tests cover idempotent receipt persistence, interrupted reads and bounded subscription teardown. The separately reviewed `LevelMessageStore.saveMessage` cancellation guard checks the serialized mutation boundary and immediately before the durable write, including first-write initialization. Existing callers without a guard retain their prior behavior; already-started database writes are not rolled back by cancellation.
