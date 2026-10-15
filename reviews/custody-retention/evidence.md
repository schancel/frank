# H1 custody retention evidence

Base: `d7eb7e37adeca759dfcfd1f13ad740aecb5613a3`. Source candidate: `28fd325560d7e73e5999bd3b3005d9fe4db77099`, branch `feat/custody-retention`. Final gates ran against exactly the source/test contents committed in that candidate. This evidence-only successor freezes the candidate for independent coordinator review.

## Implemented boundary

Custody owns one internal `retention-v1` row in its existing `state` store, containing schema 1, the monotonic admission counter and at most 64 exact incarnation/operation/generation receipts. Account snapshot, account key, IDB layout, vault records, roots and derivations are unchanged. The financial owner supplies the operation ID and remains the only authority deciding release meaning.

`retentionSnapshot`, `acquireRetention` and `releaseRetention` use the same typed private transaction boundary as account activation and cleanup authorization. Every transaction reads and validates complete account and retention records together. All affected mutation transactions verify actual strict durability and acknowledge only after completion. Acquisition snapshots input before awaiting; exact retry preserves an original admission even after unrelated holds. Release never decrements the counter or removes a conflicting fresh generation. All held receipts must match the exact current active incarnation; malformed/stale rows fail closed.

Final replacement activation rejects live holds without changing account revision or staged preconditions. Already-committed activation retries remain idempotent. Pending cancellation remains possible while the active account is retained. Before vault discard, cleanup reauthorizes the exact current pending-discarding target, excludes the active receipt and matching holds, then uses the existing vault fence. Final cleanup still clears only its exact pending record.

No session/reset, vault, wallet, messaging, UI or swap source changed. No external consumer test-double edits were necessary. H0's existing-only opening, lazy vault access, absence inspection and after-await close checks remain intact. The new private retention module imports only the existing vault facade and custody record/type helpers.

## Acceptance evidence

| Gate from repository root | Result |
| --- | --- |
| `yarn typecheck:fast` | All 23 configured projects pass |
| `yarn --cwd app test:custody` | Real Chrome stage/activate/process-reopen pass; 570 regression assertions across 28 cases; zero network calls/logging effects |
| `node_modules/.bin/prettier --config app/.prettierrc.json --write app/src/accounts/custody/index.ts app/src/accounts/custody/persistence.ts app/src/accounts/custody/types.ts app/src/accounts/custody/retention.ts app/src/accounts/custody/test/suite.ts` | Scoped files formatted before final gates |
| `git diff --check` | Pass |

The nine new regression cases cover absent inspection; two concurrent admissions at one expected generation; copy/input ownership; exact retries after unrelated advancement and delayed/lost acknowledgment; closed-owner acknowledgment refusal; release/reacquire/stale release and old acquisition rejection; wrong incarnation/receipt; hold-versus-activation serialization and replacement-first refusal; idempotent committed activation with a hold; cancellation and exact stale-cleanup ownership; capacity/counter exhaustion; strict-durability refusal; and malformed/foreign/sparse/unsupported retention records. Existing custody failure, root-restoration, lost-ack and cleanup-race cases remain passing. The process-restart fixture now retains a hold and counter across Chrome termination, then reconciles the original activation without another replacement.

Independent facades use distinct real IndexedDB connections to the same namespace in one browser page; this is independent-handle transaction evidence, not a claim of a separate-tab run. The suite also launches separate Chrome processes for its restart phases. The blocked-replacement case restores exact account-root bytes, then proves hold changes preserve a staged replacement's original activation precondition.

Mutation sensitivity: temporarily removing only cleanup's new authorization transaction causes the browser regression to fail with `expected conflict` at the stale-cleanup boundary. The original production file was restored byte-for-byte before the final passing gates. No mutation remained. Log: `/tmp/frank-h1-cleanup-mutation.log`. Final logs: `/tmp/frank-h1-typecheck.log`, `/tmp/frank-h1-custody.log`.

The tested browser is Chrome `155.0.8059.40` on this macOS host. The existing harness owns its disposable profile; no user profile, funded account or public network is accessed. Owned checkout-local dependency overlays resolve `@frank/*` here and installed third-party dependencies without manifest/lockfile/shared-directory changes. Vault source/dependencies did not change, so unrelated vault/crypto/native-chain suites were not repeated.

## Limits and next owner

H2 must protect destructive reset before any production operation acquires holds. H1 does not make reset safe and installs no production admission. Missing retention after arbitrary deletion or rollback cannot be distinguished from pre-H1 absence. The authoritative operation journal must forbid terminal operation-ID reuse where required; custody intentionally permits a fresh-generation admission and keeps no unbounded terminal tombstones. `absent` release is not financial settlement. Preserve retention data on reversal and never restore an older activation writer while holds exist.

The coordinator owns independent review and integration. No push, merge, deployment, funded operation, root-purpose allocation or user-data deletion occurred.
