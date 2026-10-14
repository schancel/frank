# Shared mailbox review baseline (#1584)

This breaking, unmerged protocol stack implements encrypted group creation, direct-message invitations with explicit accept/decline, shared-mailbox chat, admin invitations/removal and local stop-following. It must not be deployed with the current production wire format.

## Authority and ownership

Custody derives and signs an account-bound additive member key through `accountSession.getGroupSigner`; messaging never obtains private identity material. Each roster binds a canonical address to its public account identity and derived member key. The group root signs epoch certificates, and only its founding administrator retains the root secret. Removal rotates with fresh entropy, so an excluded holder of the preceding epoch secret cannot derive the successor. Relay storage authenticates certificates and atomically checks the active epoch and message sequence when appending.

The signed epoch certificate owns membership and presentation. Frontend roster indexes are derived views. The durable message receipt owns each exact signed group envelope; pending indexes only reference it. Persist certificates, recipient queues and original authorized content before publishing. Persist authenticated incoming receipts before advancing a mailbox cursor. Retries reconcile the original certificate/envelope and recipient queue rather than preparing fresh operations.

## Conversation namespaces and admission

The previous development proposal used a UUIDv5-shaped group conversation identifier. This baseline deliberately changes only group conversation IDs to UUIDv8: take the first 16 bytes of SHA256(`frank-group-conversation-uuid-v1:` || groupId32), set version bits to 8 and RFC variant bits to 10, and format as a UUID. All group writers/readers use `groupConversationUuid`; `isGroupConversationId` reserves that namespace. Account/key/payment derivations, default direct UUIDv5 and explicitly created direct UUIDv4 IDs are unchanged. There are no aliases or migrations for old group IDs.

An ordinary direct message cannot own a reserved group ID, including before an invitation arrives. It projects into the authenticated sender's default direct thread using the existing private account salt. Only validated shared-mailbox envelopes enter a group conversation. Pending and declined invitations do not relax admission. A new member receives only the invited epoch secret. Older opaque rows are skipped only after verifying their public historical root certificate and outer write signature; current or already-owned historical content must decrypt and validate before cursor progress. Owned historical epoch keys remain available for backlog sync across rotations.

Direct conversations have the closed set {self, peer}. A third party claiming a known direct thread is stored in their own direct thread. The persisted `requestedConversationId` retains the authenticated original claim separately from the local owner; content, payment items, stamps, outpoints and signed financial records remain intact. The original thread displays a reference with View 1:1/Create Group/Dismiss. Dismissal only removes that reference and persists a watermark. Email and group conversations do not display this direct-thread reference banner.

## Unsupported development records and remaining scope

Read-only hydration validates required signed group certificates/envelopes and persisted direct projection. Unsupported unsigned group records or old unprojected third-party claims fail visibly; hydration does not initialize custody or delete records. A developer may manually reset only disposable chat-view metadata after exporting anything needed. This is not an automatic reset and never authorizes deleting private keys, spend inventory/reservations, original signed envelopes, outbox/submission journals, or financial recovery records. No reset is performed by this change.

Group payment/stamp delivery is explicitly unsupported and rejected at the headless send boundary. Prepaid group credits, relay migration, invite links/QR, WebSocket delivery and external cryptographic review remain outside this implemented baseline; this does not close all of #70. Local stop-following is not cryptographic revocation.

Known ownership follow-up: extract `packages/wallet/message-item-plugins/group-welcome` and `group-control` plus their shared epoch certificate schema to a feature-owned headless entry, installed by host composition. These current feature implementations inside wallet violate the target package ownership invariant; the scoped custody signer does not depend on transport or these plugins.

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
