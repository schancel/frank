# Shared mailbox review baseline (#1584)

This breaking, unmerged protocol stack implements encrypted group creation, direct-message invitations with explicit accept/decline, shared-mailbox chat, admin invitations/removal and local stop-following. It must not be deployed with the current production wire format.

## Authority and ownership

Custody derives and signs an account-bound additive member key through `accountSession.getGroupSigner`; messaging never obtains private identity material. Each roster binds a canonical address to its public account identity and derived member key. The group root signs epoch certificates, and only its founding administrator retains the root secret. Removal rotates with fresh entropy, so an excluded holder of the preceding epoch secret cannot derive the successor. Relay storage authenticates certificates and atomically checks the active epoch and message sequence when appending.

The signed epoch certificate owns membership and presentation. Frontend roster indexes are derived views. The durable message receipt owns each exact signed group envelope; pending indexes only reference it. Persist certificates, recipient queues and original authorized content before publishing. Persist authenticated incoming receipts before advancing a mailbox cursor. Retries reconcile the original certificate/envelope and recipient queue rather than preparing fresh operations.

## Home-relay boundary

Relay addresses are canonical root origins; client configuration, creation and signed-roster admission reject path prefixes, credentials, queries and fragments before creating durable group state. Browser clients require HTTPS except local HTTP development endpoints. Production upstream transport validates public IP/DNS destinations, pins the validated resolution, disables redirects and environment proxies, and applies DNS/connect/total deadlines plus streamed response budgets. Loopback upstream allowance is compiled only into Rust tests.

Only a successfully authorized read may establish a foreign upstream/subscriber record. Its upstream affinity cannot be replaced by a different caller. Mirrored groups reject authoritative local writes. Latest foreign epoch reads consult the upstream even after promotion; immutable historical certificates may be cached. A routed write acknowledgement never advances the contiguous mirror cursor over unseen messages. Ordered fetched prefixes alone advance that watermark.

Foreign fetches use pages of at most eight envelopes so the existing 1 MiB ciphertext limit fits the 20 MiB response budget. Epoch, acknowledgement and error bodies have separate smaller budgets. Success and error streams are bounded, including chunked bodies; deadlines cover stalled streams. Smaller pages preserve sequence-based progress across repeated polling.

## Conversation namespaces and admission

The previous development proposal used a UUIDv5-shaped group conversation identifier. This baseline deliberately changes only group conversation IDs to UUIDv8: take the first 16 bytes of SHA256(`frank-group-conversation-uuid-v1:` || groupId32), set version bits to 8 and RFC variant bits to 10, and format as a UUID. All group writers/readers use `groupConversationUuid`; `isGroupConversationId` reserves that namespace. Account/key/payment derivations, default direct UUIDv5 and explicitly created direct UUIDv4 IDs are unchanged. There are no aliases or migrations for old group IDs.

An ordinary direct message cannot own a reserved group ID, including before an invitation arrives. It projects into the authenticated sender's default direct thread using the existing private account salt. Only validated shared-mailbox envelopes enter a group conversation. Pending and declined invitations do not relax admission. A new member receives only the invited epoch secret. Older opaque rows are skipped only after verifying their public historical root certificate and outer write signature; current or already-owned historical content must decrypt and validate before cursor progress. Owned historical epoch keys remain available for backlog sync across rotations.

Direct conversations have the closed set {self, peer}. A third party claiming a known direct thread is stored in their own direct thread. The persisted `requestedConversationId` retains the authenticated original claim separately from the local owner; content, payment items, stamps, outpoints and signed financial records remain intact. The original thread displays a reference with View 1:1/Create Group/Dismiss. Dismissal only removes that reference and persists a watermark. Email and group conversations do not display this direct-thread reference banner.

## Unsupported development records and remaining scope

Read-only hydration validates required signed group certificates/envelopes and persisted direct projection. Unsupported unsigned group records or old unprojected third-party claims fail visibly; hydration does not initialize custody or delete records. A developer may manually reset only disposable chat-view metadata after exporting anything needed. This is not an automatic reset and never authorizes deleting private keys, spend inventory/reservations, original signed envelopes, outbox/submission journals, or financial recovery records. No reset is performed by this change.

Group payment/stamp delivery is explicitly unsupported and rejected at the headless send boundary. Prepaid group credits, relay migration, invite links/QR, WebSocket delivery and external cryptographic review remain outside this implemented baseline; this does not close all of #70. Local stop-following is not cryptographic revocation.

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
