## Summary

A native recipient payment can be included successfully while the subsequent wallet self-sync rejects. Send currently leaves the original review visible and reenables Confirm, whose handler starts a new payment. Show the original operation's payment evidence and pending synchronization separately, retain an inspectable list across reopen, and replace that review's fresh-send control with truthful outcome/navigation controls. Do not expose a recovery action while its transport/correlation prerequisites are unavailable.

## Reproduction and observed result

At `aabb5688f7a04379d49a3f3732d66f3ef5a5b84f`, the parent performed one guarded original-operation resume. Public hash `0x71be95aba2e4a6798e10b240664e49906fa33b69b83640b71a844d355532f29c` paid .01 MON on Monad testnet; receipt succeeded at block 69526794 with .002142 MON fee. The retained operation became included-success with `syncApplied=false`; resume rejected; Send's review remained visible with Confirm enabled. No new resend was performed.

Safe evidence: `scratchpad/repair-chrome/native-original-public-receipt.json` and `native-resume-result.json`. The latter records rejection only, not the exception/cause. Neither a duplicate payment nor a created self-sync attempt is claimed. Current source also establishes unsupported wallet-sync encoding before canonical attempt/funding preparation, but the artifact does not establish that as the exact observed exception.

## Expected behavior

Show “Payment included on {network}” only from matching original recipient-operation evidence, with public hash/value and observed fee when known. Separately state that synchronization is not recorded complete. Present recovery as unavailable until its actual capability exists; `syncApplied=false` alone is not an error diagnosis. Keep the original operation identifiable after reopen. No retry control may call a fresh send for that review.

## Impact

The user can mistake a post-payment error for payment failure and click Confirm again. That is a duplicate-payment risk; no duplicate payment was observed. The current unresolved-only filter hides included-but-unsynced rows, making durable original evidence difficult to find through ordinary UI.

## Acceptance criteria

- Mounted real Send test: original inclusion followed by callback rejection shows the included payment and separate sync status, disables/removes the original fresh-send Confirm path, and repeated interaction issues no second send.
- Association uses the original captured wallet/chain and operation ID or unique validated final hash, never recipient/amount coincidence. Ambiguous post-dispatch outcomes stay unresolved; no fabricated definitely-not-broadcast result.
- Existing Wallet page lists retained native operations from inert owner inspection across a real disposable journal reopen, including paid-but-unsynced rows. Mounting/listing signs, submits and reconciles nothing; no new app transaction database.
- EN/FR distinguish included/pending/reverted/partial payment from sync pending/unavailable. Observed fee and intended amount remain separate. No claim of finality or local/all-device sync completion.
- Account/network replacement and stale route completion cannot redirect the action or update a later screen. Existing successful and Solana Send behavior remains covered.
- Original-operation recovery remains explicitly unavailable in this containment. A later action depends on durable self-sync correlation and supported typed transport; it must never invoke fresh `sendLegacy`/`sendNative`.

## Notes and deduplication

Read-only GitHub searches across open/closed items for native sync, self-sync, sync-pending, payment recovery and Confirm/send found no exact ticket for this UI behavior. Bounded follow-up to [#1230](https://github.com/schancel/frank/issues/1230) and [#1233](https://github.com/schancel/frank/issues/1233). [#1283](https://github.com/schancel/frank/issues/1283) is fee wording; [#1236](https://github.com/schancel/frank/issues/1236) is disjoint execution; closed [#658](https://github.com/schancel/frank/issues/658) is late-route navigation. None is this post-payment retry control. Fresh open/closed dedupe on 2026-10-09 found no exact duplicate.

Accepted U0 implementation scope: `native-sync-recovery-design.md`, U0. Financial authority stays in existing wallet journals; the UI is derived. No format/wire change, broad recovery framework, live-funds reproduction, storage reset or new retry policy. Owner: repair coordinator; implementation waits for an available lane and exact scope claim. U0 is accepted; financial correlation and typed transport remain separate nondispatchable successors.
