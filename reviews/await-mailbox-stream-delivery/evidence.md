# S5c3a candidate evidence

Base `b45f333b9fa8816b5f6b4e7d05c6268055860049` (root contract on source
`f20181df3ca25b4f44cfd95d5becfd5285d28432`). Owner-requested GPT-6.1 Sol
medium; runtime model identifier is not independently exposed. Parent owns review
and integration. No external/public/funded calls, deployment or feature installation.

## Behavior and ownership

Cashweb owns one active delivery plus a bounded pending FIFO per WebSocket. The
active record counts toward both 32-record and CANONICAL_DM_MAX_BYTES aggregate
original decoded delivery/context limits. Limits are compared before hex decoding
or admission of a new record. Callback failure/overflow closes that connection and
clears pending work; closed connections cannot start later callbacks. Ping/pong is
independent of awaiting the host. Every delivery rejection is consumed and reported
once to the stream error observer; synchronous and asynchronous observer failure
cannot resume the queue or become an unhandled internal promise.

The public callback contract is void|Promise<void>. Canonical stream opening uses
a generation/abort lifetime and closes late handles rather than installing them.
Historical lookup/decode waits are fenced before publication. Existing malformed
record/decode handling remains separate; host delivery rejection propagates to the
cashweb owner, avoiding duplicate intermediate onError routing. The EVM facade
awaits existing coin/self-note processing before host delivery, and unsubscribe
revokes that forwarding across delayed processing. Existing financial algorithms,
retry/refusal classifications and original obligations are unchanged.

App streaming passes its captured recipient and polling's same stopped lease to
real chats.receiveMessages, checking before/after awaited wrapper transformation
and delivery. It neither recaptures another selected account nor updates a cursor
from callback completion. No new journal, inbox owner, protocol schema, ACK,
reservation, plugin or financial behavior is introduced.

## Failure-before and scope correction

On the exact unmodified source, the public cashweb test started both callbacks
before the first asynchronous callback completed; the required single active
callback assertion failed. The actual app/chat queue test also failed because a
stream delivery queued behind an unrelated mutation persisted after stop(). Logs:
`/tmp/s5c3a-before-cashweb.log` and `/tmp/s5c3a-before-app.log`. Both regressions pass
after the source correction.

Initial full wallet validation reported 127/129 tests passing: only two unchanged
historical-evidence polling fixture guards failed. The shared assertion expected
canonical delivery type 1, while current protocol/production/other fixtures use
10. Root independently inspected and approved the single 1→10 test guard correction,
retaining all recovered digest/payment assertions. No production polling or
frontier change was made. Initial log: `/tmp/s5c3a-wallet.log`.

## Gate matrix

Commands run from repository root:

| Command | Result |
| --- | --- |
| `yarn typecheck:fast` | 23 configured projects pass |
| `node_modules/.bin/jest --config packages/cashweb/jest.config.js relay/monad-mailbox-client.jest.test.ts relay/canonical-dm-transport.jest.test.ts --runInBand` | 2 suites, 123 tests pass |
| `node_modules/.bin/jest --config app/jest.config.js src/adapters/pinia-chain-adapter.jest.test.ts src/adapters/pinia-chain-adapter.polling.jest.test.ts --runInBand` | 2 suites, 49 tests pass |
| `node_modules/.bin/jest --config packages/wallet/jest.config.js chain/monad-chain-canonical-dm.jest.test.ts chain/monad-canonical-dm.jest.test.ts chain/monad-canonical-dm-message-id.jest.test.ts --runInBand` | Existing two helper/message-ID suites pass; canonical fixture correction/rerun follows below |
| `node_modules/.bin/jest --config packages/wallet/jest.config.js chain/monad-chain-canonical-dm.jest.test.ts --runInBand` | 1 suite, 79 tests pass (151.392 seconds); both historical-evidence regressions pass |
| `node_modules/.bin/prettier --check packages/cashweb/relay/monad-mailbox-client.ts` | Pass |
| `node_modules/.bin/prettier --config app/.prettierrc.json --check app/src/adapters/pinia-chain-adapter.ts` | Pass |
| `node /tmp/s5c3a-format-check.cjs` | Changed stream method/test regions and callback type match their existing formatter conventions |
| `git diff --check` | Pass |

All five production import lists were compared exactly to the dispatched base;
they are unchanged, with no new dependency or feature back-edge. The scoped format
check formats each complete file in memory then compares only the changed stream
regions; inherited whole-file drift outside those regions is retained. The approved
existing type 10 fixture guard preserves its original line formatting. Broad source
formatting and unrelated native/crypto/bot suites were not repeated.

Logs: `/tmp/s5c3a-{typecheck,cashweb,app,wallet,wallet-canonical-final,scoped-format,format-check}.log`.
Candidate-local dependency overlays remain available for independent review;
package-local versions and candidate-local @frank resolution were preserved.

Coverage uses actual public stream callbacks, bounded fake WebSocket events,
actual canonical opening/SDK wallet fixtures and actual app/chat mutation queues.
It proves ordering/rejection, count/decoded-byte overflow, ping responsiveness,
close/error/abort discard, late signed connection cancellation, throwing observers,
ordinary sync consumers, awaited coin/self-note processing with unsubscribe,
opened consumer error propagation, late handle closure, captured queued lease and
polling retry after failed streamed persistence. No global unhandled-rejection
handler masks the production path; the initial failing test separately observes
its deliberately ignored baseline promise to keep the test process bounded.

## Residual semantics

This is local connection buffering, not server record acknowledgment or global
exactly-once delivery. Already-started asynchronous effects cannot be undone.
Polling replay and existing dedupe remain responsible for recovery. A separate
connection may start after failure; saved later rows can still affect the existing
receipt frontier. Durable complete-prefix/consumer coverage is an explicitly
required separate successor, as are authenticated journal installation, retention,
UI and financial execution. This predecessor does not claim those guarantees.
Source rollback is an ordinary revert; no data format/migration/reset is involved.
Independent review is required before integration.

## Confirmed review repair: terminal connection revocation

Independent review reproduced a delayed canonical directory lookup reaching the
host after that connection closed or errored, before reconnect began. The same
actual encrypted public fixture was ported into the candidate: both close/error
cases fail on `84dcc4f2` (`/tmp/s5c3a-terminal-before.log`, 2 failures).

Each connection now has a synchronous delivery-liveness fence separate from the
subscription/generation ownership used for reconnect and terminal error reporting.
Close/error revokes delivery before scheduling reconnect. Existing checks after
directory/historical awaits and before host invocation use this fence; late
connection handles are closed as well. One terminal error remains observable even
if close is delivered first, with duplicate error reports suppressed per
connection. Subscription cancellation and reconnect generation remain unchanged.
Already-started host effects retain the original documented limit.

Focused regression plus consumer-error, late-handle and reconnect cases pass
(5 tests, `/tmp/s5c3a-terminal-after.log`). The new close/error tests additionally
assert the expected observable error count. Final repair gates:

| Command | Result |
| --- | --- |
| `yarn typecheck:fast` | 23 configured projects pass (61.77 seconds, exit 0) |
| `node_modules/.bin/jest --config packages/wallet/jest.config.js chain/monad-chain-canonical-dm.jest.test.ts chain/monad-canonical-dm.jest.test.ts chain/monad-canonical-dm-message-id.jest.test.ts --runInBand` | 3 suites, 131 tests pass (314.301 seconds; existing PID 14061 completed naturally) |
| `node_modules/.bin/jest --config packages/cashweb/jest.config.js relay/monad-mailbox-client.jest.test.ts --runInBand` | 1 suite, 87 tests pass (50.749 seconds, exit 0) |
| `node /tmp/s5c3a-format-check.cjs` | Pass; new close/error test block also formatted with the existing app Prettier configuration |
| `git diff --check` | Pass |

Final logs: `/tmp/s5c3a-terminal-{typecheck,wallet,cashweb,format}.log`.
Only the canonical stream implementation, its existing public fixture test and
this evidence changed. Previously green app/transport gates remain applicable;
no app, polling, durable coverage frontier or journal change was made.

The final wallet run was monitored through its existing stdout/stderr log and was
not restarted or terminated. Its normal Jest completion summary reports all three
suites passing; the replacement worker did not own its shell and cannot independently
recover the process exit code. Candidate-local ignored dependency overlays remain
for review; no unrelated worktrees, processes or local data were cleaned up.


## Confirmed review repair: forwarding connection lease (STR-LIFETIME-2)

Independent review and verification found the remaining EVM forwarding wait could
start the application host after terminal close/error. The actual encrypted stealth
fixture now pauses the real `recordStoredEvmCoin`, terminates the connection, then
finishes the admitted write. Both cases fail on `4f5ac084` (host called once rather
than zero; `/tmp/s5c3a-lifetime2-before.log`). Four additional received-coin/wallet-sync
self-note consumer-seam cases fail before repair when their explicit connection
lease is revoked during `applyWalletSyncItem`
(`/tmp/s5c3a-lifetime2-self-before.log`). Wallet-sync remains unsupported on the
current wire, so that coverage deliberately uses the existing internal fixture seam.

The internal canonical callback now requires a `CanonicalStreamDeliveryLease`
second argument bound to the actual connection's existing `current()` predicate.
The EVM wrapper checks subscription and connection liveness on entry, after awaited
coin processing, and after awaited self-note processing immediately before calling
the public host. There is no optional/default live lease. The public app callback
contract and persistent/wire formats are unchanged. Existing fixture forwarding
supplies an explicit revocable lease.

Await-boundary audit: canonical self-directory opening, peer lookup and historical
evidence resolution already fence the same connection after their waits. The
forwarded callback carries that fence through both EVM awaits; there are no further
awaits before host admission. Reconnect ownership remains subscription/generation
scoped. Already-admitted wallet writes may finish; already-started host effects
retain the earlier limit. No globals, financial algorithms, polling, frontier,
pagination, journal or application behavior changed.

| Command | Result |
| --- | --- |
| `node_modules/.bin/jest --config packages/wallet/jest.config.js chain/monad-chain-canonical-dm.jest.test.ts --runInBand --testNamePattern 'during coin wait|during decode|fences lifetime|opened stream consumer|late stream handle|automatically reconnects'` | 15 tests pass (10.339 seconds, exit 0) |
| `yarn typecheck:fast` | 23 projects pass (4.40 seconds, exit 0) |
| `node_modules/.bin/jest --config packages/wallet/jest.config.js chain/monad-chain-canonical-dm.jest.test.ts chain/monad-canonical-dm.jest.test.ts chain/monad-canonical-dm-message-id.jest.test.ts --runInBand` | 3 suites, 137 tests pass (271.794 seconds, exit 0) |
| `node /tmp/s5c3a-format-check.cjs` | Pass; new regression block also checked against existing app Prettier configuration |
| `git diff --check` | Pass |

Logs: `/tmp/s5c3a-lifetime2-{before,self-before,focused,typecheck,wallet}.log`.
Prior cashweb/app gates remain applicable to unchanged production boundaries.
Only the canonical callback, EVM forwarding, their existing test file and this
evidence changed. Independent review/verification is required on the new frozen tip.
