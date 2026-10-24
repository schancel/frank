# Outgoing retry decision

`decideOutgoingRetry(error, context)` preserves the existing foreground decision
from `chats.ts.runOutgoingExclusive`. It returns one of `retry-messaging`,
`retry-transport`, `queue-unattempted`, or `fail`. It performs no wait or mutation.

The chat caller captures the wallet/session, maintains message/conversation IDs,
owns per-message locking and persists presentation. Wallet and message journals
remain the authorities for original payments, signed bytes and delivery. The
helper owns none of those facts and cannot authorize a new payment.

| Result | Caller action |
| --- | --- |
| `retry-messaging` | Wait up to 5000 ms for readiness; if not ready, delay by attempt number × 500 ms, then retry the same message. |
| `retry-transport` | Delay by attempt number × 500 ms, then retry the same message. |
| `queue-unattempted` | Retain the original message for the existing reconciliation queue; permitted only with the caller's accumulated no-effect evidence. |
| `fail` | Continue existing failure classification and presentation. It does not release reservations or declare financial failure. |

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
