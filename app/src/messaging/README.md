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

Startup retry is evaluated before error-string/info formatting. Otherwise that
formatting occurs even for recognized transport codes and may throw. Separate
`isCurrent()` calls are intentionally not memoized; preserving this evaluation
order is part of this behavior-preserving extraction.

The helper imports the existing `CanonicalMessagingPendingError` to retain its
class identity check, but does not choose an active wallet or read application
state. It is not a generic shared delivery engine and is not installed into bot
or mail-gateway workflows.

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
