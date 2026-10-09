# Repair execution evidence

Initial base: `3620a49f12c491ddf9e618f9dec76a894e64943a`. Shammah accepted prepared publication and beginning bounded repairs, then explicitly authorized narrow takeover of historical canonical recovery scopes. Existing artifacts and unrelated claim scopes remain preserved.

## Publication

All 16 canonical issues, eight prepared comments and 31 native edges are recorded in [publication-ledger.json](publication-ledger.json). The proposed edges were checked with the live open dependency graph before mutation. Publication was retried concurrently by mistake; four duplicates were closed and mapped to the earliest canonical issue. Incremental ledger reconciliation verified the final mapping.

## Accepted work

- [Queue readiness #1232](https://github.com/schancel/frank/issues/1232): candidate `f2e403b00c94ab66adb1c6974ed7f8b5d579bbeb`; all seven Python suites pass. Independent strong review reproduced NEEDS_SPECIFICATION incorrectly dispatched on base and excluded on candidate; no findings. Review covers readiness correctness, test quality, shared parser ownership, simplicity, security and efficiency. Landed via [PR #1250](https://github.com/schancel/frank/pull/1250) as `7773dccabb3c39a3964b7fdf2e49e9dd1b2b78ea`; hosted TypeScript verification passed.
- [Session generation #1231](https://github.com/schancel/frank/issues/1231): two-path implementation at the session owner; generation and wallet-release epochs prevent stale publication, with promise-identity pending cleanup. No custody/derivation/wire change. Candidate/review pending.
- [Payment retention #1230](https://github.com/schancel/frank/issues/1230): first candidate limited to canonical DM owner and its existing tests. Retain uncertain operations through exhaustion/discard/missing links; preserve successful-delivery behavior. The full issue remains open for a separately reviewed durable-owner predecessor and original-operation recovery successor. Delivery observation is not chain settlement.
- Native Solana Send: direct owner bug request, separate app composition/UI scope. Selected canonical chain/account context must drive validation, review, signing and submission; unknown networks never default to Monad. Post-broadcast confirmation failure retains transaction identity and uncertainty. Existing custody derivation stays unchanged. Candidate/review pending.

## Historical scope resolution

Owner-authorized narrow amendments: [#60](https://github.com/schancel/frank/issues/60#issuecomment-6075795518), [#777](https://github.com/schancel/frank/issues/777#issuecomment-6075795887). These release only the listed current-main recovery repair paths for replacement claims. Historical branches/worktrees/PRs and every unrelated scope remain untouched.

## Remaining limits

Full original-operation recovery needs durable per-member financial evidence and safe cancellation of never-signed intents; existing relay terminal behavior may require a separately contracted delivery-resume path. Maintenance thresholds and asset inventory layout remain unresolved. Browser/runtime evidence and live testnet actions are owned by the parent coordinator, not repository workers.
