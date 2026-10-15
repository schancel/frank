# Canonical polling coverage correction

Root-authored bounded correction. Frozen implementation base is `91e01c981bb9a1e7df7bed31fbfaef03ab6a1b3c`, containing the independently reviewed awaited-stream predecessor. Investigation source was `f20181df3ca25b4f44cfd95d5becfd5285d28432`; verify against this actual base. Parent owns the contract, review and integration; implementation uses the owner's requested GPT-6.1 Sol medium lane. No release authority is added.

Exclusive candidate: `.worktrees/canonical-poll-coverage`, branch `fix/canonical-poll-coverage`. Use installed dependencies only, with candidate-local overlays/source links if needed. Do not run a package-manager install, download dependencies, mutate shared dependency targets, or delete other workers' artifacts. Report unavailable dependencies to the parent. Freeze a clean candidate with evidence for independent review; no integration by the worker.

## Existing promise and observed failure

`DirectMessageClient.fetchSince` already promises a complete timestamp prefix on truncation and rejection if none exists. Canonical `fetchSince` violates this when all eight fetched pages share timestamp T: it returns the partial group, allowing callers to advance to T+1 and omit the unseen ninth page. It also publishes quarantine callbacks before determining the truncated boundary. Completion must refer to raw mailbox timestamps, including unreadable rows, rather than only successfully projected messages.

Correct that existing public contract. Keep the current bounded page budget and array/callback API. Do not introduce a paging framework, persistent cursor, protocol change, swap admission, financial action or historical backfill policy in this correction. A timestamp group exceeding the bounded scan remains an explicit retryable scan limitation; it must never look like successful coverage. Continuation for such oversized groups is a separately owned follow-up, not a claim this correction solves it.

## Ownership and behavior

The canonical reader owns which raw timestamp prefix was completely fetched. Collect bounded raw pages and their unreadable records, establish the coverage boundary, then decode/publish only the eligible prefix. On a later-page failure or remaining cursor at the page limit, withhold the entire greatest raw timestamp group. If no complete raw group remains, reject observably without publishing message or quarantine completion. Preserve first-page error behavior and existing authenticated transport checks. Detect a repeated cursor rather than pretending progress.

Directory/key unavailability remains an inclusive incomplete timestamp within the proven raw prefix. Quarantine callbacks must never include the withheld tail, including unreadable rows. A callback throwing must remain observable. Malformed timestamps or page ordering that prevent a sound coverage decision must fail explicitly; do not guess a boundary. Do not add new automatic quarantine classifications for cryptographic/structural failures as incidental cleanup.

`DirectMessageReceived.receivedTime` is documented as the relay's receipt timestamp. Preserve it through self-outbox reconstruction; `outboxItem.sentAt` is not mailbox coverage and must not replace it. This changes no signed payload or persisted wire schema. Verify callers and tests relying on this field. Original content digest remains unavailable for reconstructed self notes. Authenticated provenance installation is a host successor, not this correction.

No receipt maximum or returned array alone proves durable consumer completion. The host successor still owns the durable consumer replay frontier and must await admission plus receipt persistence before advancing it. This correction supplies the already-promised complete raw prefix; it does not solve stream-versus-poll restart progress.

## Scope and acceptance

Expected production scope: `packages/wallet/chain/monad-canonical-dm.ts`; `active-chain.ts` only if clarifying the existing contract. Co-located canonical wallet tests, actual app poller tests and bot polling tests may change to prove caller behavior. Cashweb changes, additional public APIs, persistent formats or broader error-classification changes require parent review before editing. Keep the awaited-stream predecessor intact.

Required fail-before/pass-after cases: a timestamp tie spanning the eighth/ninth page; an earlier complete group followed by a split group; later-page failure; an unreadable/quarantined tail; all-unreadable complete prefix; missing-directory incomplete records; a reconstructed outbox with sentAt differing from its relay receipt; repeated cursor. Assert withheld rows cause neither delivered messages nor quarantine callbacks. Exercise actual canonical decryption and actual app/bot progress consumption, not only an extracted helper. On rejection, callers must retain replay position. App/bot durable consumer-frontier restart proofs belong to the subsequent host installation and must not be claimed here.

Run affected canonical wallet, app polling and bot polling gates, all configured `yarn typecheck:fast`, scoped formatting and dependency checks. Use repository fixtures and owned loopback mock relays only; no funded/public-chain execution, push, merge or deployment. Record exact source, commands, failures and limits. Reversal is reverting the local source correction; there are no new stored records or migration/reset steps. Parent freezes the exact implementation packet before dispatch and independently reviews the finished candidate.
