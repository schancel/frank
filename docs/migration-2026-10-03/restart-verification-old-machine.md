# Old-machine restart verification — 2026-10-03

The user resumed the original goal. The goal tool still reports paused and provides no resume setter; work proceeds under the explicit renewed instruction. This record contains no full runtime-integration claim.

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

Renewed autonomous-goal authorization covers routine goal claims, tracker evidence and reviewed landings. PR799 was marked ready and squash landed as84542f5c76d12c50a64c01ed49a9ebda5f61b40a after exact-tip review and gates. Its claim completed in comment5975036703. Clean current-main tracking worktree is .worktrees/current-main-20261003; primary main remains dirty and untouched.

PR793 remains HOLD pending final backend CI at exact403cf1688f3a7bbe6e1d6b81c210d4378017ae0d. Actual scoped TypeScript CLI revealed six errors at prior788846c, not detected by a config-path-less API parse. Accepted two-file correction uses declared Duplex cleanup and the equivalent explicit timeout listener; actual CLI now exits0. Four complete real provisioning/TLS/lifecycle/admission suites PASS88/88, zero skips. Independent bounded correction review SAFE; client and rust-conformance CI SUCCESS, backend still running. Review posted5975167718. Old Node/browser claim released; successor claim85610a26-e0f3-44a4-8300-25d59594d27e owns only that correction. Rust source claim remains frozen until integration.

#774 remains immediate runtime successor under its accepted one-worker/eight-pending and60/65/>=70-second policy. #775 pure facade source worker is progressing in its preserved stack; no runtime dependency waiver. Its sole heavy gate lease is active; parent must not overlap native/browser gates. Exact finite cashweb dependency/boundary amendment5975136236 permits public dependency declaration and parent-owned exact guard amendment after750 integration. No held258 activation, synthetic fresh authority, or CBC waiver.

#769 exact845425e native compilation FAIL exit101, zero tests: seven type/initializer errors. Evidence recorded on PR800 comment5975178269. No source modified and no passing Forum claim. #782 remains partial draft with known mixed-case hash failures and missing Rust production activation.

## Branding follow-on evidence

Preserved branding candidate e1164abf9b08961e76c7e5a916fbec0770c8289a remained source-clean. Frozen dependency installation succeeded; missing ignored workspace dist outputs initially prevented SPA build. Compiling the existing nakamoto and crypto-box package tsconfigs resolved those missing outputs without source edits. Production SPA build then PASS. Actual Chrome rendered initial account onboarding light/dark at1280×900, title Frank, no Runtime exceptions, native exit0/no signal and owned-process absence; screenshots and summary retained privately under frank-branding-render-64I96u. This is initial onboarding rendering, not all authenticated branding surfaces or wallet/messaging acceptance. One built bitcore string inspected is Nakamoto interpreter provenance text; no complete production bundle dependency audit is claimed.

Original PWA build FAILED at missing app/src-pwa/manifest.json. That failure is preserved. Finite repair b304ae7c1bac6d2be0b66fc5e3a0cf1e919ab3b7 on preservede1164ab now builds production PWA successfully. Four files supply current Quasar native-mode manifest/dependency template, supported worker-options hook and worker environment variable. Exact emitted branding fields and five icon bytes/dimensions match. Actual isolated Chrome proves service-worker installation,227 cached entries, offline reload, worker update/controller change and stale cached HTML eviction; owned process/profile cleanup verified. Parent independent source review found no confirmed defects. Draft preservation PR805 stacks on newly preserved remote recover/plainspoken-branding-20261003; both branding branches remain intact. First failed temporary browser harness attempts remain failures. Service-worker proof is not OS installation or native packaging proof. Full Xcode, Java and iOS Pods remain absent; Android/iOS acceptance unverified. No old drawer replacement.
