# Outgoing retry decision

`decideOutgoingRetry(error, context)` preserves the existing foreground decision
from `chats.ts.runOutgoingExclusive`. It returns one of `retry-messaging`,
`retry-transport`, `queue-unattempted`, or `fail`. It performs no wait or mutation.

The chat caller captures the wallet/session, maintains message/conversation IDs,
owns per-message locking and persists presentation. Wallet and message journals
remain the authorities for original payments, signed bytes and delivery. The
helper owns none of those facts and cannot authorize a new payment.

| Result              | Caller action                                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `retry-messaging`   | Wait up to 5000 ms for readiness; if not ready, delay by attempt number × 500 ms, then retry the same message.                      |
| `retry-transport`   | Delay by attempt number × 500 ms, then retry the same message.                                                                      |
| `queue-unattempted` | Retain the original message for the existing reconciliation queue; permitted only with the caller's accumulated no-effect evidence. |
| `fail`              | Continue existing failure classification and presentation. It does not release reservations or declare financial failure.           |

The caller currently limits foreground sends to three calls. Once it has an own
attempt digest, it does not take another foreground retry branch. It computes
`allCallsUnattempted` from the exact rejected object across every call; neither a
labelled cause nor the helper's transport classification substitutes for that
evidence. Already-attempted adoption, pending-payment handling and financial
exposure callbacks stay in the caller.

Wallet facts come from `describeWalletFailure` in
[`wallet-failure.ts`](../../../packages/wallet/wallet-failure.ts). Authoritative
vetoes defeat transient facts and messaging fallback. Actual setup classes retain
readiness retry; actual `OpenDirectoryError('unreachable')` retains transport retry.
Unknown names, vendor shapes and strings grant no permission. Recognition catches
hostile prototype traps; it never formats arbitrary errors. Separate `isCurrent()`
calls remain intentional. The helper does not choose a wallet or read app state.

For the composed capabilities and caller-owned timing/evidence, see
[`createOutgoingExecution` in outgoing-execution.ts](outgoing-execution.ts) and its
production composition in [`chats.ts`](../stores/chats.ts). These are app policy,
not a shared bot/mail delivery engine. Failure presentation in
[`chats-self-notes.ts`](../stores/chats-self-notes.ts) retains every known original
digest, including terminal/rejected and abandoned errors with a different digest.

Local unit tests pin classification and evaluation order. The AST test enforces
direct dependency syntax; it is not a whole dependency-graph audit or a runtime
sandbox. `../stores/chats.outgoing.jest.test.ts` exercises real chat decisions
with fake scheduling and transport boundaries, including retry timing, stable
identity, original-attempt recovery and exact-rejection evidence. See
[AGENTS.md](AGENTS.md) for commands. None of these tests claim live RPC or browser
durability verification.

## Row-bound outgoing recovery

`createOutgoingRecovery(ports)` returns `resumeCutOffOutgoing`, `reconcileOutgoing`
and `applyAttemptStatus`. Its sole implementation lives in `outgoing-recovery.ts`;
public Pinia actions delegate through `chats.ts:createChatOutgoingRecovery`.

The engine finds cut-off sends, asks for their original attempt, batches existing
attempt reconciliation, routes financial rows back through original execution,
and interprets delivered/live/dead/unknown results. It never constructs a new
payment. Existing queued rows may request the existing host execution capability.

The host retains original message/conversation objects, shared in-flight/starting
sets, Web Locks, the serialized projection mutation queue and persistence. The
adapter supplies these narrow capabilities and captures account/network context
at each invocation. Public wallet methods retain their captured receiver. An
assertion tied to the original object, digest, wallet and context travels into
state/confirmation mutations; only the original private stale-result sentinel
maps to `stale`. Ordinary errors retain their existing propagation/warnings.
No new cache, queue, lifecycle, wallet selection or persistent format is owned here.

Conversation entries are snapshotted for the two selection passes, preserving
object identity and their different array traversal semantics. The final pending
count reads current conversation references again. It counts presentation rows,
not all financial obligations. Retained-envelope recovery in
`../stealth-payments/financial-envelope-recovery.ts` and scheduling in
`../adapters/pinia-chain-adapter.ts` remain independent of this enumeration.

Headless tests use plain shared-reference objects and injected external boundaries.
They prove policy runs without Pinia. `chats.outgoing.jest.test.ts`, tombstone tests
and adapter suites still prove the real state/queue/storage integration. The
queue-suspension characterization observes `confirmOutgoing` enqueueing the
mutation; internal policy no longer dispatches a Pinia `applyAttemptStatus` action.
The recovery AST test allows only public type dependencies and pins the three
public actions as delegates; it is not a transitive dependency/security audit.

This slice does not move foreground execution or bot/mail host policy. Canonical
wallet messaging remains the shared original-envelope execution/replay engine.

## Outgoing execution

`createOutgoingExecution(ports)` owns the full `runOutgoing` and
`runOutgoingExclusive` orchestration. Public chat actions delegate through
`createChatOutgoingExecution`; the store reexports the unchanged `OutgoingOutcome`
type. The actual application handoff action is `deliverPersistedApplicationMessage`:
it retains its existing lock before calling exclusive execution.

Execution owns original-attempt-first branching, strict pending/bound financial
retention, envelope callback construction, interrupted-send authorization checks,
request assembly, exact-error retry evidence and post-delivery original submission.
It delegates result interpretation to the existing recovery owner. There is no
second state cache, journal, recovery loop or global wallet/session capture.

The composition adapter retains the exact captured directMessages object behind a
narrow public type, preserving method receivers and optional lookup timing. It
captures financial account/session invariants through the existing shared sentinel;
the engine decides when to assert them. Existing durable mutation owners receive
those assertions and preserve queue-entry/post-read checks. Repository acquisition
and binding remain separate awaits with their original context checks.

Subject metadata, best-effort contact wakeup sidecars, cancellable-send registration
and progress sets remain synchronous presentation capabilities. The engine invokes
them at their original per-attempt points; attempt-created digest assignment still
precedes strict persistence. Optional readiness retains its absent-function branch
without introducing an extra await. Retry delays and exact no-effect evidence remain
owned by the existing policy/caller contract.

Group send/retry dispatch and rowless retained-envelope scheduling are unchanged.
This app-specific execution module is not a universal bot/mail facade. Canonical
messaging remains the shared original-byte execution and replay implementation.
Plain-object execution tests cover ordering and failure boundaries; composed
outgoing, retained-envelope and group tests remain required for real owner wiring.
