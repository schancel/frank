# #811 test-proof handoff

Complete the dedicated runtime and retained-store proof obligations left by #769. Test-only cases exercise concurrent real Owner admission, exact compatible optional bytes through real derived rebuild, real reopen epochs and both expired cursor families, corrupt authority rejection, and revision exhaustion. Both admission tests explicitly assert reserved-up/down7/0 while pending and0/0 after confirmation.

Only cfg(test) regions in `src/forum.rs` and `src/store/forum_tests.rs` change; production source prefix and manifests/locks remain unchanged. Tested base: c8f8915eb05799fe4d1b000f717bc781e9d35d2b. Frozen reviewed candidate: 94b2e5e29e9c9ee4ca141ae6d16d2a696af10d8e.

Validation: exact four new tests PASS88.00s;13 bounded existing tests PASS44.35s; clippy exit0 (existing warnings retained); scoped formatting and clean two-file scope audit PASS. Owned wrapper/cache used with Rust1.93; heavy lease released. No new browser gate or unchanged4096/quota proof claimed.

The initial run at c0caebb failed the epoch fixture because identical content produced one topic row; distinct real posts corrected it. A subsequent two-filter invocation unintentionally selected an OR-union and was stopped (exit143); its log is retained and is not a passing gate. The final single `::proof_` filter selected exactly four tests.

Runtime tests prove `ForumError::Expired`; literal HTTP410 for both page families is separately assigned to #770. This PR does not claim HTTP boundary execution. No product defect or production policy repair is asserted. Refs #811; original claim remains active until coordinator integration.

Artifacts and commands:
- `/private/tmp/frank-811-focused-proof-final.log`: session30498; wrapper `cargo test --manifest-path backend/cashweb/Cargo.toml --locked -p cashweb-registry --lib ::proof_ -- --nocapture`.
- `/private/tmp/frank-811-bounded-existing.log`: session53821; same wrapper test filter `forum::tests::`, explicit skips proof_, actual_charged_snapshots, actual_pending_limit, actual_pending_byte, actual_predecessor, exact_retry_at_capacity.
- `/private/tmp/frank-811-clippy.log`: session70177; wrapper clippy --locked -p cashweb-registry --lib --tests --no-deps.
- `/private/tmp/frank-811-focused-proof.log`: initial3094 negativefixture.
- `/private/tmp/frank-811-union-filter-interrupted.log`: interrupted26880.
- `/private/tmp/frank-811-final-scope-evidence.json`: exact SHA/hashes/test-only production-prefix audit.

Active claimb7564365-a9c2-4ec4-b9fe-a8cc83fb4d3b; requestedstrong/actualinherited. Commit transport2bd9073 ->c0caebb ->94b2e5e. No agent attribution trailers. Coordinator owns review/integration/merge/closure/claim termination/cleanup.

Ready PR: https://github.com/schancel/frank/pull/817
