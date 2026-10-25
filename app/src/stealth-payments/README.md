# Financial message recovery

`outgoing.ts` captures existing financial operations through their family owners. It never prepares replacement payments. The returned `expose` and `submit` capabilities retain the original operation references and wallet bindings.

`financial-envelope-recovery.ts` resumes an authorized message independently of its chat row. It receives narrow storage, original-message lookup, delivery, reconciliation and financial capabilities. It does not import Pinia, custody, or transport implementations. [`startOutgoingReconciliation`](../adapters/pinia-chain-adapter.ts) is the production composition example: it supplies the factory capabilities from the captured messaging session and stops new effects when that session changes.

## Durable ownership and ordering

The message store owns the existing version-1 `FinancialEnvelopeBinding` metadata, scoped by account, canonical messaging chain and sealed message ID. It contains references to financial operations, not keys or signed transactions. Canonical messaging owns the encrypted original and exposure barrier. Each family payment owner owns signed bytes, reservations and settlement. Presentation deletion does not delete these owners.

A new financial send persists a pending binding before canonical execution. Its durability callback strictly links the presentation row, persists the bound digest, and then authorizes financial exposure. Each write can fail independently. Recovery does not assume an atomic transaction across these owners.

For an existing recorded attempt, foreground recovery validates the durable presentation association and looks up the canonical original by sealed message ID before creating a pending binding. Digest and paid/free kind must match. It then binds the digest before reconciliation. A crash between pending and bound is recoverable: the headless owner resolves pending metadata through authoritative original lookup and persists the bound digest. Lookup alone does not authorize exposure.

A held original still invokes the canonical durability callback before it can leave the messaging owner. Financial submission requires durable delivery of that exact original. Submission success is not necessarily settlement; retained references remain eligible for bounded retries, and family owners retain idempotence and exact-byte recovery.

## Failure and lifecycle rules

- Missing originals remain observable; recovery never calls fresh send, prepare, sign or release.
- Failed or ambiguously acknowledged writes retry the immutable association.
- Partial exposure/submission continues through the original owners; it never creates a replacement operation.
- Session checks run across awaited boundaries. The composition captures account revision, wallet and messaging chain; changing UI selection cannot redirect old work.
- Per-message exclusion prevents duplicate local processing while a rotating bounded batch lets other bindings advance. There is no new wallet-wide send lock.
- Existing records without trustworthy financial associations cannot be reconstructed by guessing. Completed bindings are retained; no cleanup policy or new persistent index is introduced here.

## What a failed send tells the user

`failure.ts` maps a failure to app-authored text; provider and relay text (an ethers dump with
URLs and response bodies) stays in the console. "Nothing was sent" is said only while nothing
signed has left the financial owner: during review, which only reads, or when
`sendReviewedStealthPayment` throws `StealthPaymentNotSentError` because the owner's `release`
proved the prepared operation unexposed. Once messaging has adopted the payment, or the release
cannot be proven, a 429 or a timeout is no proof the payment failed: the user is told the payment
is saved and to retry the message, which reuses the same operation. Throttled chain reads are
retried in the relay RPC transport (`packages/wallet/evm-provider.ts`), never a transaction.

## Verification

From the repository root:

```sh
yarn --cwd app test:unit:ci --runInBand financial-envelope-recovery.jest.test.ts financial-envelope-recovery-boundary.jest.test.ts recovery.jest.test.ts outgoing.jest.test.ts
yarn --cwd app test:unit:ci --runInBand failure.jest.test.ts review-payment.jest.test.ts Chat.sendFollowUp.jest.test.ts SendStealthDialog.jest.test.ts
yarn --cwd app test:unit:ci --runInBand chats.financial-retained-recovery.jest.test.ts chats.outgoing.jest.test.ts pinia-chain-adapter.outgoing.jest.test.ts pinia-chain-adapter.retained-scheduling.jest.test.ts
yarn typecheck:fast
```

The retained-envelope fixture uses real message stores, canonical sealing and financial journals with synthetic custody and injected external I/O. It reopens durable stores and verifies original recipient/change broadcasts. It is not a native-browser restart or a live funded-chain test. Factory tests additionally cover context changes, overlapping batches, missing originals and ambiguous writes.
