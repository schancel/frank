# Native observation capture precondition

Status: authorized local implementation; independent review and parent integration required. Base: e7f06cd2c3a0f277d339d46735f8de70f14c8271. Owner: parent coordinator; implementation claim: native_observation_capture, branch fix/native-observation-capture, worktree .worktrees/native-observation-capture. No tracker/public mutation or deployment authority.

## Failure and outcome

Independent investigation reproduced three delayed two-wrapper observations overwriting newer durable inclusion/account evidence. Actual EvmLegacyConsolidator.observe can publish missing/block1/nonce0 after another wrapper committed included-success/block2/nonce1 and syncApplied=true. Pending and older inclusion also overwrite. Reproducer /tmp/frank-stale-observation-verify; log /tmp/stale-observation-verifier.log; all three STALE-OBS expectations fail on the base.

An observation must commit only against the signed-member identity and observation/account evidence on which its capture was based. Compare that basis after durable reload inside existing coordinated mutation for every incoming state. Reject changed-basis results without altering persisted state or poisoning the journal. Reobservation must obtain new network evidence; refreshing a capture must not authorize replaying an old result.

## Ownership and scope

Journal remains sole durable owner of native submission and observation facts. Existing consolidator supplies evidence; no new observer, inventory, service, queue or state owner. Scope: packages/wallet/storage/evm-native-operation-journal.ts, its focused storage/concurrency tests, packages/wallet/chain/evm-legacy-consolidator.jest.test.ts if useful for actual call path coverage, reviews/native-observation-capture/*.md. Production consolidator edits require concrete need reported to parent first. No app/session/chat/swap feature edits (sibling-owned).

Keep captured basis private/immutable; prevent caller mutation or forged/mismatched capture from bypassing existing ownership. Preserve local supersession/close revocation. Compare only relevant evidence and signed identity, not entire rows: concurrent markExposed and markSyncApplied must remain preserved and must not invalidate a legitimate same-basis result. Preserve exact inclusion-contradiction requirements for unknown downgrades, valid fresh lower-height reorg observations, signed bytes, reservations and unrelated members. Network waits remain outside storage coordination.

No durable schema change planned: retain current row ownership/encoding and change only ephemeral capture preconditions. Equality of evidence is a compare-and-set condition, not proof of global RPC recency or a chain finality oracle. Explicitly assess change-away-and-back (ABA): if installed behavior makes a persisted observation revision necessary for this correction, report the concrete case before introducing a format change. Do not silently claim ABA/global ordering protection or add a migration/dual reader.

## Acceptance

- Adapt independent failing reproductions, using two wrappers over real durable storage; actual delayed observe path for at least missing, with pending and older inclusion coverage. Fail on base, pass on candidate.
- Changed account-only evidence also rejects stale result; same observation and same account with concurrent exposed/syncApplied changes remains valid and preserves those fields.
- Fresh capture after refresh accepts genuine new canonical evidence, including valid lower-height reorg; unknown without exact contradiction cannot invalidate known inclusion.
- Superseded/closed captures, repeated observations, unrelated member isolation, reservations and restart behavior remain correct. No new payment or resubmission on rejection.
- Run affected native journal/consolidator/input-admission suites and all configured yarn typecheck:fast projects; inspect dependency direction and diff formatting. State evidence limits honestly.

No funds, live services, main merge, push, deployment, package installs, shared node_modules mutation, cleanup or model attribution trailers. Candidate-owned dependency overlay may mirror integration external links with @frank links resolving into candidate packages. Keep worktree and evidence for independent review. Rollback is local code reversal before integration; it does not delete or rewrite any durable wallet records.
