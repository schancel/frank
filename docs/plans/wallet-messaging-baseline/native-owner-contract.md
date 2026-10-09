# P1: durable EVM native-operation owner

Status: independently reviewed READY and dispatched under #1230 claim6077862708. Tier 3.
Source baseline: `d8b0d556e5fa9db42c7af6797e4d8279c0c6e5c5`. The traced native-owner files are unchanged from `bf0423609206507748988da2c45d178a3ace1c59` and the earlier `cbe9ffd60d33b45d9688f904d9841f57e77e4ee5` trace.
Owner: payment_recovery; coordinator owns claim, worktree assignment and integration.

## Outcome and stack

Both EVM `sendNative` and `sendLegacy` (direct, fan-in and drain) use one wallet-lifetime durable operation owner. Evolve the existing `LegacySendJournalStore` responsibility; replace its singleton, per-call in-memory production construction, persisted staging private key and direct-send bypass. Stop the EVM hash-only native-attempt writer. Other families keep their current native-attempt store.

This is an enabling predecessor, not completion of payment recovery or shared admission. P2 derives one shared admission view from native operations, canonical attempts/intents, topic leases/raw transactions, pool funding and change-sweep intent, then cuts over every spending consumer. P3 removes long send queues only after P2 and recovery are proven. P1 retains existing queues and does not claim all-spender exclusion.

Mandatory P2 consumer: the actual `SendContact.vue` → `nativeTransfers.sendToContact` → `buildEvmStealthPayment` path currently signs identity/stealth transfers without native admission. Parent explicitly accepted leaving this existing bypass to P2. P2 must reserve before its signing and retain exact operation/custody/economic binding before claiming shared-spender exclusion or removing queues. No `monad-stealth.ts` implementation widening in P1.

## Ownership and facade

The wallet bundle opens and validates one `EvmNativeOperationJournal` before startup lease-orphan retirement, and closes it after its owned tasks drain. A single wallet-lifetime native-operation executor is reused by send, list/inspect, retry and resume. Each operation has a durable operationId; no pending singleton. Public snapshots are typed and immutable. Claims derived from its records identify exact `[normalized address, nonce]` pairs; there is no second persistent reservation table.

Journal owns frozen authorization, submission and recovery facts. Custody owns private keys and signing. Existing inventories own inventory state; their construction views and the native selection view are derived, not competing reservation owners. Consolidation orchestration depends on a narrow custody signing capability and provider/builder capabilities; it does not acquire messaging transport. Composition retains local sync/self-mailbox wiring.

No canonical journal/client changes, UI changes, new daemon, maintenance policy, universal asset model, or generic reservation framework. Existing long network queues are not removed in this predecessor.

## Versioned record and transitions

Version 1 namespace and strict manifest bind the canonical chainIdentifier, verified native chain ID and stable economic wallet binding. Economic binding is the deterministic public main account + public spend/change branch descriptors + derivation registry + chain tuple. It excludes messaging root. Identity-derived source references separately commit to the identity public key actually used.

Each row contains operationId, immutable original recipient/full intended amount, immutable spending/fee constraints, and ordered direct or dependent fan-in members. A member freezes its custody source reference, address, exact nonce, complete unsigned transaction serialization and predecessor member IDs. It then checkpoints exact signed raw bytes and expected transaction hash. Validate recovered raw bytes against the complete frozen unsigned transaction, sender and chain. All members' complete authorized unsigned requests are frozen before the first signature; a resumed signed member is never rebuilt or re-signed.

States are distinct facts: unsigned plan; exact signed checkpoint; possible exposure; latest chain observation; recipient fulfillment. Persist the exposure marker before handing raw bytes to a broadcaster. Persist exact signed bytes before any callback or broadcast. A lost response, rejection, timeout, restart, receipt absence or UI action cannot clear exposure or the original claim. RPC observations are taken outside short journal mutation locks and committed only against current owner generation/member capture token. A stale response cannot overwrite a newer capture or a reopened/closed owner.

Chain observations distinguish unknown, missing, pending, included-success and included-revert, with exact expected transaction hash and checked inclusion block identity/index. Inclusion is not finality. Latest bounded account evidence includes concrete block hash/number, nonce and balance; no unbounded event/error log. No receipt, delivery or caller-provided outcome releases signed reservations in P1.

Open validates every row, manifest, immutable binding, size charge, signed transaction and dependency reference before native admission. Unsupported/corrupt funded records and old EVM hash-only guards are preserved and explicitly block unsafe native admission; they are not absent records. No migration shim, reset or deletion. EVM no longer writes the old hash-only owner; it only detects retained unsupported evidence at the cutover boundary. Other families' readers/writers remain unchanged.

An uncertain durable write faults this owner until close/reopen establishes the actual committed state. It must not continue from a guessed in-memory result. Close invalidates captures and rejects new work. Restart reconstructs claims and resumes original exact members, never starts a replacement payment.

## Custody references

Supported source references are main account; identity with its public point; HD spend or change with branch/index; and `identity-stealth-v1` with identity public point, ephemeral public point and expected address. References are scoped by the record's chain binding. Resolve through private walletMaterial main/identity/keyring/changeKeyring owners, using existing derivation, and verify the resulting address before signing. Do not trust a construction coin's privateKey or index as authority.

Both current canonical-DM indexing and game escrow derive received stealth accounts from the owned identity secret and public ephemeral point. Thus this reference recovers those accounts after the memory stealth keyring disappears. No new derivation or secret store is required. Arbitrary key-only imported accounts without a validated recoverable origin are explicitly unsupported before selection/signing and remain preserved.

Cancellation is allowed only for a provably unsigned/unexposed plan under the operation lock. It releases that plan's claims, but retains public source/derivation references and charged storage. This prevents cancellation from erasing the only durable provenance of a received stealth account. Existing HD allocation ownership is never removed.

## Economics, adapters and residuals

Freeze builder-produced to/value/data/type/access-list/nonce/gas/fee fields, separately from the caller's intended recipient and amount. Native send preserves existing builder semantics, including calldata transfers; generic EVM is not Monad specialization. Immutable fees cannot increase on retry. Native consolidation proves exact full recipient value plus each member's maximum gas liability fits the owned inputs before prepare. Internal fan-in credits are not counted twice as external expenditure and remain provisional to their owning operation until observed on chain. Reject insufficient funding; never use the current `min(target, balance-fee)` partial drain fallback.

The existing builder interface gains a narrow explicit native-consolidation capability. Native EVM builder supplies it. A builder without this capability is rejected before legacy consolidation signing; do not silently apply plain-ETH fan-in accounting to token-as-gas semantics. This is not a new token inventory framework.

A dependent drain is broadcast only after matching prerequisite observations; its already-frozen transaction and fee constraints do not change. The unused consolidator-only async/waitForDrain optimistic result path is removed. Production callers already use synchronous mode. A pending/lost-response result exposes the original operation through a typed pending/submission error and inspect/resume; a fulfilled legacy result requires the exact recipient member's successful observation. Do not report a fan-in hash as the recipient payment. Native send retains its existing broadcast-ack ChainTransaction return semantics; a hash does not claim finality.

An observed consumed nonce remains reserved in its historical row; no old pair becomes selectable. Native candidate discovery includes retained public source refs, including canceled/spent stealth provenance, and refreshes actual balance and transaction count at one concrete block, checking its block identity. It derives `[address,currentNonce]` with actual residual balance, but account-state advancement alone does not establish workflow eligibility. The native owner derives an additional workflow claim from the same immutable dependency/member records: leader funds, provisional credits and other resources still required by an unresolved dependent operation remain available only to that operation across nonce advancement. No duplicate persistent lock table is introduced. A newer unclaimed pair is offered to an unrelated operation only when the original workflow's exact relevant member/prerequisite evidence establishes that its remaining funds are no longer committed to that workflow. A foreign/contact transaction advancing the leader nonce, or a missing/mismatched original drain, cannot satisfy this condition. Retain the dependent-resource hold while that condition remains unresolved; it is scoped to that workflow's resources, not the whole wallet. The original exact pair claim remains even after the workflow condition is satisfied. If the view rolls back to the old nonce, its retained claim prevents reuse. Do not mark an entire account permanently spent on broadcast acknowledgment or invent residual balance by subtracting only the transfer amount. Account evidence is an observation, not finality; existing public inventory update boundaries maintain derived construction state. Retained history alone never causes an any-pending wallet-wide hold. Global cross-consumer exclusion is P2, not P1.

## Storage limits and retention cost

Defaults: at most 1,024 retained operation rows; 64 MiB aggregate charged bytes; 64 transaction members per operation; 64 KiB unsigned serialization per member; 16 MiB encoded row. These limits reject admission rather than evict evidence. Validate bounded uint256 economic values and safe integer nonce/block/index/time fields. Do not persist arbitrary error strings.

Before any signing, reserve the maximum encoded row using the production serializer: frozen plan plus each member's maximum signed envelope (unsigned bytes plus 128 bytes), maximum-sized exposure/inclusion/account-observation fields and maximum-width bounded counters. Compute reservedBytes to a serialization fixed point. Tests prove supported signed envelopes fit the bound. Every update must fit the original reserved charge; open recomputes row and aggregate charges. Configuration may lower journal row/byte limits for tests; it cannot bypass validation.

Canceled rows retain public provenance and charged space. Signed/history rows are not compacted on delivery or receipt. Consequently P1 admits at most 1,024 retained operations, potentially fewer at the 64 MiB limit, before the settlement/disposition successor provides evidence-backed compaction or custody provenance transfer. Capacity refusal affects new admission only; existing exact replay and bounded evidence updates retain their reserved capacity. There is no automatic timeout, eviction, finality threshold or budget reset.

## Allowed files

Production:

- `packages/wallet/chain/evm-legacy-consolidator.ts`
- `packages/wallet/chain/monad-chain.ts`
- `packages/wallet/chain/chain-wallet.ts`
- `packages/wallet/chain/index.ts` (required export/type cutover only)
- `packages/wallet/chain/evm-transaction-builder.ts` (explicit consolidation capability only)
- `packages/wallet/storage/evm-native-operation-journal.ts` (new)
- `packages/wallet/storage/monad-wallet-bundle.ts`

Tests:

- `packages/wallet/chain/evm-legacy-consolidator.jest.test.ts`
- `packages/wallet/chain/monad-chain.jest.test.ts`
- `packages/wallet/chain/monad-domain-wallet.jest.test.ts`
- `packages/wallet/chain/chain-wallet.jest.test.ts`
- `packages/wallet/chain/evm-transaction-builder.jest.test.ts` (new only if no matching existing suite)
- `packages/wallet/storage/evm-native-operation-journal.jest.test.ts` (new)
- `packages/wallet/storage/monad-wallet-bundle.jest.test.ts`

No material/stealth source edits are required: resolve custody inside private composition using existing derivation. No app, canonical DM, canonical journal/stamp-client, pool implementation, maintenance or other-family implementation edits.

## Acceptance evidence

1. Production-boundary fail-before/pass-after: direct legacy lost response then real Level close/reopen recovers the original signed bytes/operation and broadcasts no fresh payment. Baseline direct path has no durable operation.
2. Fan-in lost acknowledgment before current hash checkpoint: reopen retains every frozen member, exact source pair and dependency; late partial settlement resumes the original drain once, with unchanged recipient/amount/fees. Repeated resume is idempotent. Baseline only retains hashes after broadcast and re-signs an uncertain drain.
3. Two distinct operation IDs remain inspectable after reopen; same-input selection conflicts atomically, disjoint inputs remain admissible under existing queues. Baseline singleton/per-call stores cannot retain these operations. Do not claim this test proves P2 contact/canonical/maintenance exclusion.
4. Persistence failure before signed checkpoint or exposure barrier causes zero broadcast. Ambiguous write faults the owner; reopening observes committed-or-not state without guessing. Closing/stale RPC responses cannot mutate another lifetime.
5. Real durable bytes contain no private scalar. Reopen main, identity, spend/change and identity-stealth references after replacing memory keyrings; validate exact address and chain. Reject mismatched identity/ephemeral/index/address or arbitrary attached private key. Unsigned cancellation frees its pair while preserving derivation recovery.
6. Unsupported old hash-only/funded versions, wrong wallet/chain binding and corrupt records remain byte-for-byte preserved and produce explicit unavailability, never an empty journal or fresh signing. Startup native references participate before orphan retirement.
7. Boundary budget fixtures cover maximum member count, unsigned size, signed envelope, receipt/account evidence and row/aggregate charge. New admission fails before signature at capacity; an already-admitted operation can still persist its maximum observation and retry. Canceled provenance is not evicted to make room.
8. Exact receipt observation does not delete/release the old pair. Refresh records actual nonce/residual at one block; a newer pair can fund a subsequent authorized operation only after the original operation's exact relevant member/prerequisite evidence establishes that the residual is not committed to its workflow. Deterministic dependent-leader regression: A freezes peer fan-in to leader L and its drain; fan-in lands, L's nonce advances due a different transaction, and L retains balance, but A's exact drain is missing or mismatched. B must produce zero signatures from L at the advanced nonce, including after close/reopen; unrelated disjoint inputs remain eligible. Matching original workflow evidence may subsequently make the uncommitted residual eligible without releasing A's old pair or asserting finality. Rollback to the old pair remains blocked. Duplicate observation/sync cannot double-subtract or fabricate a clean account.
9. Builder-generated calldata/to/value remain unchanged through restart; original intended amount remains separate. Unsupported consolidation capability fails before signing. Fee changes after restart cannot change signed bytes or silently shrink recipient value.
10. Chain-isolation fixtures cover Monad testnet and Ethereum Sepolia as peer EVM configurations; existing Solana/eCash shared-type checks remain green. Native send and legacy direct/fan-in all reach the same lifetime owner; EVM hash-only writer and singleton constructor bypasses have no remaining call path.

Run targeted affected wallet suites, scoped formatting/lint and `yarn typecheck:fast` in an assigned heavy slot. Do not run live RPC or use owner funds/keys. Independent review assesses this exact contract before implementation and the exact candidate before integration.

## Removal and reversal

P1 removes the superseded EVM singleton/in-memory production owner, secret-bearing intent fields, direct bypass and EVM hash-only writer in its own cutover. P2 is the immediate consumer of derived operation claims and must cut over the contact bypass and other named spending consumers before queue removal. Settlement/disposition is the owner of eventual evidence-backed release/compaction; it must preserve public derivation provenance. No dual writer or compatibility migration remains. A rollback must not run an older writer over funded v1 rows; preserve the new store and disable unsupported native mutation instead of resetting it. Parent tickets remain open until dependent recovery/admission outcomes land.
