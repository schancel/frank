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
