# Old-machine restart verification — 2026-10-03

The original goal is active again. This record contains no full runtime-integration claim.

## Environment

Shell DNS resolves api.github.com, Python UID lookup returns the actual home directory, and a PATH-only Node child resolves its home directory. Git fetch succeeded. Remote main was a7d0275e1e01c45c7af93f1cf2be1ee98d5b6553. Chrome and native TLS execute successfully after restart. One later GitHub GraphQL read transiently failed with a socket address error; a subsequent read succeeded.

Node is v26.10.0. The Homebrew yarn symlink points into removed Node23; cached Yarn Classic1.22.22 was invoked explicitly. Frozen-lockfile installations succeeded in the isolated verification worktrees. The optional protoc package reports its unsupported darwin_x86_32 postinstall; no generated wrapper was changed.

## Exact-tip gates

- #794 / PR799, eff3be14ef1fc673956033b125b27d6d0eeb1199: repository Cargo slot wrapped check:browser. PASS33 lifecycle tests, browser build193784 bytes/33inputs, bare VM and actual Chrome full414 TypeScript/6 Rust/30 registration/82 Forum, no failures or leaked Node globals. Native Chrome exit0/no signal, runner exit0; ownedMembersAbsent true, exact disposable profile removed. Independent postflight confirmed launcher PID65883 and profile absent. Prior failed attempts remain failures.
- #750 / PR793, 788846cd44980dc366f48b772ba569275f3572f0: repository Cargo slot wrapped actual owned per-worktree standalone directory_trust_probe. Both real Rust TLS tests PASS, including exact Node agreement/restart/quarantine and wrongCA/SAN/expiry/same-key recertification negatives. Then full admission suite with actual Rust and Chromium enabled PASS24/24, zero skips, including controlled-origin browser restart and lifetime ownership. Existing five native probe unit tests and standalone build remain the exact-tip handoff evidence.
- Exact-tip hosted checks refreshed: PR799 client/rust-conformance SUCCESS; PR793 backend/client/rust-conformance SUCCESS. Existing independent source reviews are converged and explicitly require no fresh confidence round for unchanged production source after passing pending gates.
- #775 Packet A91f514b retains its prior exact-tip seven-native-test pass. Complete canonical facade and runtime dependencies remain held.

Both verification worktrees stayed clean. The primary dirty checkout and preserved branding snapshots were untouched. Fresh clean integration checkout created at .worktrees/resume-integration-20261003 from origin/main; no production changes there yet.

## Integration disposition

PR799 and PR793 now satisfy their named outstanding gates. Explicit approval for external squash merges, evidence publication, terminal claim events, and further reviewed goal landings has been requested under the repository GitHub binding. No pending approval is inferred from elapsed time. #774 remains the immediate runtime successor, under its accepted one-worker/eight-pending and60/65/>=70-second policy. No held258 activation, synthetic authority, or CBC waiver.
