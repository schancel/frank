# `@frank/swap-protocol`

Experimental, testnet-only Stage-0 atomic-swap protocol core. It implements the specification's
exact v1 coordination-event bytes, domain-separated hashes, sender hash chains, bounded event
budgets, prerequisite ordering, deterministic semantic reduction, and conservative cancel cutoff.

`advanceStage0` is a deterministic fake-adapter lifecycle model for preparation gates, local
authorization cutoffs, funding/reveal readiness, custody-mode-specific settlement, restart, and
explicit recovery outcomes. It consumes facts that a caller has already authenticated or observed;
it does not turn peer reports into chain authority.

It deliberately does not allocate message type IDs or payload schemas. A pair manifest supplies
those values, authorized producers, canonical payload interpretation, and state transitions. It
also does not sign transactions, broadcast, persist secrets, watch chains, or claim recoverable
atomic settlement. Those remain separate typed boundaries in `docs/atomic-swap-specification.md`.

## Authenticated negotiation predecessor

`@frank/swap-protocol/src/negotiation` is a separate pure entry point. The existing package entry
and Stage-0/pair experiments are unchanged. It freezes offer/accept/reject payload version1,
pair-policy version1, lane0 and manifest-local message types1/2/3, with A depositing XEC and B
EVM. Principal quantities use bigint, with uint64 XEC and fixed big-endian uint256 EVM wire
encodings. These amounts exclude execution fees. Negotiation contains no inputs, nonces, J/T,
deployments, refund signatures or funding authorization.

Callers must select `TESTNET_NEGOTIATION_POLICY` (`xec-testnet`/`monad-testnet`) or the separately
named `REGTEST_PROOF_NEGOTIATION_POLICY` (`xec-regtest`/`monad-regtest`). The implementation reads
IDs, family and JSON-RPC permission directly from `docs/protocol/chains/v1.json`; it neither
accepts aliases nor substitutes native IDs. This structural registry check is not upstream
checkpoint or chain-state verification.

Builders receive explicit swap/conversation IDs, ordered identity keys and an asynchronous
`signDigest` capability. They snapshot their inputs before awaiting it, hash the existing
`frank/swap-event-signature/v1` preimage exactly once, and verify the returned central algorithm-1
strict-DER low-S signature. Identity key IDs use `frank/swap-identity-key-id/v1`; terms hashes use
`frank/swap-negotiation-terms/v1`. Golden vectors pin all these bytes in the negotiation tests.
The signer capability provides identity authorization only, never financial transaction signing.

`decodeNegotiationEventSchema` lets a stateless transport plugin parse and verify the self-contained
signer under an explicitly installed pair policy. Offers contain both party keys; responses contain
only B. This schema result has no operation-admission or state-effect authority. The full-context
`decodeNegotiationEvent` additionally binds the expected swap, conversation and ordered parties;
its internal parse/bind split decodes the payload once under the same supplied budget.

`decodeNegotiationEvent` and `reduceNegotiation` require a `NestedItemBudget`: transport plugins
must pass the enclosing message's budget. Only explicitly named `...Standalone` paths create
one for a distinct tool/journal reconstruction operation. Admission limits are64 input events,
1024 bytes per event,65536 total bytes and512 payload bytes, checked before signature verification;
duplicates count toward admission. Every event is fully prevalidated, including response orphans
which the core reducer would otherwise buffer without visiting their descriptors.

A canonical receive host calls `validateAuthenticatedNegotiationEvent` with the authenticated
sender/recipient identity keys, actual wire conversation and local key. It must explicitly name
incoming versus outbound replay. This helper checks those assertions; it cannot establish their
provenance. Do not supply profile lookups or arbitrary restored display messages as authentication.

Reduction preserves historical offer/decision evidence and reports violations separately.
`usableAcceptance` is always null on a violation. `negotiationEligibility` accepts an explicit
Unix-seconds clock, requires `now < expiry`, and does not erase old acceptance. Eligibility means
only that further preparation may be considered: it never authorizes funding, signature release,
reservation release, data deletion or cancellation of financial recovery. Authenticated host/runtime installation, UI, durable custody and execution remain separate work.

The package's declared runtime dependency check can be run with:

```sh
node packages/nakamoto/scripts/check-deps.mjs --root packages/swap-protocol
```

The separate `src/message-plugin.ts` entry provides the inert `swap-negotiation-v1` application
plugin. Supply an explicit pair policy to `createNegotiationMessagePlugin`; each descriptor owns
its validation cache and never registers globally. It projects exact signed bytes as
`{eventHex: string}` for ordinary JSON persistence, validates restored projections fully, and
continues the enclosing receive budget. Its factual previews and hydration have no admission,
signing, funding or settlement authority. App and the concrete all-bots target explicitly install
the testnet policy. Wallet defaults and other bot targets do not install this feature. There is no
proposal UI or automatic negotiation writer yet. A wire change requires coordinated feature
writer/reader changes; no compatibility reader or migration is provided.

## Authenticated single-negotiation journal

`@frank/swap-protocol/src/negotiation-journal` is a separate headless entry.
`new NegotiationJournal({ owner, context, store })` binds one immutable existing
`NegotiationContext` to an explicit account incarnation, local party identity and
canonical messaging chain. Inputs, including Buffers, are copied before storage
awaits. Incarnation is an opaque nonempty scalar UTF-8 string of at most256 bytes;
it is not derived from a key or automatically rebound after account restoration.
No app/bot installs this engine yet.

The host supplies `read(key): Promise<string | undefined>` and
`compareAndSwap(key, expectedRaw, nextRaw): Promise<boolean>`. This capability must
provide linearizable comparison+commit across handles, durable success before
`true`, committed reads or observable failure, and absent inspection without
initialization. `false` means another committed writer won. Exceptions can mean
ambiguous writes and propagate without an automatic retry. An adapter cannot
implement CAS as independently queued get and put operations. The test memory
capability proves the algorithm only; it is not a production storage fallback or
physical durability qualification.

`journal.read()` returns explicit `presence`, copied evidence entries and the S5a
reduction. It fetches and validates the actual row each time, without writes or a
competing authoritative cache. `journal.admit({ eventBytes, authenticated,
messageId, stampedPayloadDigest })` requires actual signed bytes plus trusted
canonical host delivery assertions. `authenticated` includes S5a's explicit
incoming/outbound-replay direction, local/sender/recipient keys and actual wire
conversation, plus `messagingChainIdentifier`, which must match the owner.
Message ID is exactly16 bytes and stamped payload digest exactly32 bytes; the
latter is distinct from contentDigest. This engine checks supplied assertions;
it cannot establish outer-envelope provenance or authenticate arbitrary restored
presentation messages.

Admission validates the fresh row and new delivery, retains original signed bytes,
and uses CAS to append. CAS-false retries from a fresh row at most eight times;
exhaustion raises `NegotiationJournalError` with `code: 'contention'`. Invalid
inputs, corrupt rows and capacity have distinct codes; storage exceptions retain
their original identity. Exact event-byte duplicates authenticate again and write
nothing, including at capacity or under a different valid delivery ID/digest. The
first valid metadata remains sufficient. Distinct valid signatures count as
distinct evidence bytes, while S5a decides semantic duplication. Signed conflicts
remain present and produce an unusable acceptance; response-before-offer remains
buffered. No accepted/status flags are persisted.

The exact version1 JSON shape is `{ version, owner, context, entries }`. Owner is
`{ accountIncarnation, localPublicKey, messagingChainIdentifier }`; context is
`{ swapId, conversationId, parties, policy }`, with existing explicit ordered pair
policy fields. Every entry is `{ eventBytes, senderPublicKey, recipientPublicKey,
direction, messageId, stampedPayloadDigest }`. Byte fields use lowercase hex.
The messaging chain is stored once in the owner binding. Unknown fields, versions,
invalid signatures and changed immutable/authenticated bindings fail visibly.
Duplicate entries in a stored row are malformed. Limits are262144 UTF-8 JSON bytes,
64 entries,1024 original bytes per event and65536 aggregate original bytes, checked
before expensive validation. No eviction, reset, migration or compatibility parser
is provided.

`rowKey` is lowercase SHA256 hex over twelve concatenated length-framed components.
Each component uses its unsigned four-byte big-endian byte length followed by its
bytes, in this order: UTF-8 domain `frank/swap-negotiation-journal-key/v1`, UTF-8
version `1`, UTF-8 incarnation, raw local compressed key, UTF-8 messaging chain,
raw swap ID, raw conversation ID, raw party A key, raw party B key, UTF-8 policy
name, UTF-8 XEC chain, UTF-8 EVM chain. This is a public local storage identifier,
not a confidentiality boundary or cross-user identifier. Golden key and serialized
record vectors are fixed in the co-located tests.

`inspectNegotiationJournalRecord(raw)` performs the same strict pure validation
and reconstruction, returning rowKey plus owned copies of owner/context/evidence
and reduction. It assumes no host account affinity: concrete adapters must compare
account incarnation, local key and requested row key explicitly before CAS.
Local admission metadata remains trusted application state; changing valid-looking
local metadata or rolling back storage is not cryptographically prevented, and
stored outer envelopes are not reauthenticated.

Required successors qualify actual native/browser CAS storage, atomically bound
the number of negotiations per account, and install authenticated host polling,
streaming and outbound replay with lifecycle revocation and retention. Account
restoration versus incarnation rebinding and pre-activation history need explicit
host policy. Negotiation remains historical evidence; it provides no signing,
funding, reservation, secret, acceptance automation or financial recovery authority.

Verification from the repository root:

```sh
node_modules/.bin/jest --config packages/swap-protocol/jest.config.cjs --runInBand
node packages/nakamoto/scripts/check-deps.mjs --root packages/swap-protocol
node_modules/.bin/prettier --single-quote --no-semi --trailing-comma all --check packages/swap-protocol/src/negotiation-journal.ts packages/swap-protocol/src/negotiation-journal.jest.test.ts
yarn typecheck:fast
```
