# Frank new-machine handoff — 2026-10-03

## Stop state

The user requested migration drain, not completion of the original goal. New dispatch, feature expansion and heavy tests stopped. The encrypted UI Qwen/blackjack, two-relay delivery, and complete active protobuf/CBC retirement goal remains unfinished. Drafts below are checkpoints, not merge-ready features.

Last verified remote main: `a7d0275e1e01c45c7af93f1cf2be1ee98d5b6553`. Do not reset the old machine's dirty primary checkout to it.

## Remote source manifest

| Work | Remote branch / PR | Exact checkpoint | Base and state |
| --- | --- | --- | --- |
| Directory demo integration #750 | `issue-750`, [PR793](https://github.com/schancel/frank/pull/793) | `788846cd44980dc366f48b772ba569275f3572f0` | Main `a7d0275`; source correction SAFE, native and final integrated Chrome gates pending |
| DM roles/stamp Packet A #775 | `issue-775`, [PR792](https://github.com/schancel/frank/pull/792) | `91f514b975d53e168c2553b5c13d8f11fd48a020` | `e92004bf4dec0a13008736b03afcfe72750219ce`; source correction approved; local native gate interrupted; runtime holds |
| Canonical DM prepare/open #775 | `issue-775-canonical`, [PR801](https://github.com/schancel/frank/pull/801) | `e577548d29e584a37238e107a2541a449fc46b1a` | Remote base `issue-775-canonical-base` at `8b8f3f2451547b58b3c33f21f186da7a5ea2bffb`; partial, untested, unreviewed |
| Forum server #769 | `issue-769`, [PR800](https://github.com/schancel/frank/pull/800) | `845425e459574d5b863576fafeb967bf2d50536a` | `4876a1636b95b0a62266470a21be57581986c396`; uncompiled/incomplete |
| Active blackjack codec #782 | `issue-782`, [PR802](https://github.com/schancel/frank/pull/802) | `81e9ce288a3a6186877863f690baef4a41c729bc` | `e9b7371dfdaea0d0aaf4bb9bf8b45eb167344a8c`; partial TS, Rust production absent |
| Chrome gate lifecycle #794 | `issue-794`, [PR799](https://github.com/schancel/frank/pull/799) | `eff3be14ef1fc673956033b125b27d6d0eeb1199` | `4876a163`; correction SAFE, corrected-tip Chrome/CI must finish |
| Directory release assessment #768 | `wip/20261003/issue-768` (checkpoint publication in progress) | `243bee6b65e8db4646a8d6248b6f18f725d11e44` | Reviewed `8c4b9bc12d99223b9223a4d244bcceb4eecd86dc`; benchmark driver only, not a production feature |

The canonical base is an intentionally preserved linear composition of reviewed main `a7d0275` plus Packet A's two commits. Its whole tree equals clean merge tree `a897caecde1958b954c04e932f75bf9958aa38cc`. Preserve that base branch until PR801 is deliberately rebased/retargeted: deleting an ordinary PR base can close dependent PRs.

Remote heads were independently inspected during drain. Workers reported pushed/clean checkpoints; several old worktrees subsequently disappeared or returned `ENOENT`. No worker cleanup was requested or performed during drain. Remote commit preservation is verified; do not infer every old local directory is intact.

## Exact gate limits and first repairs

- **#750:** current light tests: 8 suites, 212 pass, 6 explicit skips; scoped/public/mixed-legacy types and boundary/shared corpus pass. Full bot types still have 14 baseline-style errors. Source review [5973278405](https://github.com/schancel/frank/pull/793#issuecomment-5973278405) resolves C1–C4. Real controlled-origin Chromium passed at `696ed853b73fac5403d33ec06d9e40dd4faba9ea`; the final direct adapter/runner bytes match, but transitive codec changed. Therefore final integrated Chromium is **unrun**, as are Rust example five unit tests and real TLS/admission negative scenarios. Earlier browser failures were preserved; explicit top-level await plus a CDP rejection sentinel repaired a REPL harness issue, not the ownership product logic.
- **Packet A #775:** 52 TS tests and required hosted checks passed; source review [5972751507](https://github.com/schancel/frank/pull/792#issuecomment-5972751507) approved public-package imports and directional history tests. The local native run selected seven tests but executed **zero**: migration interrupted cold RocksDB compilation after 8m20s, exit143. This is neither pass nor test failure. No source edits during the run. Original PID group was terminated by its owner; root later verified supervisor79974/wrapper79985/Cargo80139 and group79985 absent.
- **Canonical #775:** only `canonical-dm.ts` (272 lines) is added. Syntax transpilation and whitespace check passed. No test/corpus additions; typecheck, format, behavioral/security/browser/native gates and review are pending. Archive semantics remain unreviewed and cannot confer fresh mailbox/payment authority.
- **#769:** 15 allowed files; diff checks and earlier Rust syntax formatting only. No Cargo compilation, tests, actual predecessor DB opener, final lifecycle/resource-bound/multipage proof, or independent review. Preserve all legacy pending economic authority; #770 owns the normal client switch and predecessor deletion.
- **#782:** targeted TS 176/180 pass. Four valid mixed/uppercase wager/double hash cases fail because the writer must normalize only **after** strict grammar validation. Source typecheck and preservation/parity of the immutable 90 frame/79 writer-input corpus pass. Rust production activation is absent; all remaining cross-language/browser/provenance gates are pending. The existing metadata17→18/frame17 mismatch regression must remain unchanged.
- **#794:** correction `eff3be14` passes 33 lifecycle tests and is independently SAFE [5973252244](https://github.com/schancel/frank/pull/799#issuecomment-5973252244). It fixes early native leader exit leaving an unobserved helper alive while profile cleanup falsely reported absence. Real Chrome and both CI passed the **previous** `7754eba` tip, not this correction. Do not inherit that browser pass across changed process ownership. Run corrected-tip Chrome and applicable CI; no extra product review round if unchanged.
- **#768:** full 74-sample release matrix passed, 74 archives verified after re-extraction, 260 timing events, 897.73s. Full4096-row current medians12.249–15.320s; authenticated reopen12.930s; prefix catch-up19.814s (maximum31.335s). Near-byte-cap33-row current0.183s. These are small shared-host samples, not p95/SLO/internal lock-wait evidence. Driver timing serialization failure was fixed with checked u64; failed attempts remain distinct. Raw binaries/DB archives are not Git artifacts.

## What main does and does not prove

Main includes Codex32 custody/default typed onboarding, explicit legacy BIP39 recovery/quarantine, separated wallet roles, authenticated admission libraries/stores, canonical Forum codecs and opaque one-shot DM validation continuation. It does **not** yet use the full new authenticated DM runtime in the UI/bots.

Exact-main wallet browser evidence belongs to `c9e945d4071f9d3b3eb009c8cc19a6a018ddc379`: actual rendered create/backup/recovery, explicit fake funding to spending account (not auth account), visible balance, native send, restart and independent restore passed. Post-send/restart/restore balance was 0.98868 MON, auth balance zero. This is not encrypted DM proof and has not been rerun on the final drain main.

Earlier demo smoke exercised Qwen stub/vendor/faucet/blackjack/raffle/topic roundtrip, but topic default was still protobuf. Do not label that canonical CBOR wire proof. An earlier smoke falsely returned success after a child crash; the supervisor/smoke correction and Qwen receipt projection landed later. Final goal still needs exact-current user journeys, meaningful typed blackjack, actual AEAD/CBOR wire, two independent relays with restart/store-forward, and removal of active legacy callers.

Experimental atomic-swap Stage0 tests (21), Codex32 tests (18), and adaptor-signature tests (53) passed on the earlier main. They do not establish live atomic settlement or an app swap UI. Bitcore references examined were dev dependencies, but a final built UI import/bundle audit is still required; the dev prebundle configuration retained a bitcore entry.

## New Mac setup and safe resumption

1. Clone/fetch the repository and all checkpoint branches; verify exact SHAs from this manifest and each PR. Do not copy the old dirty primary directory over a clean clone or overwrite it on the old machine.
2. Install Node24+ and Yarn Classic1.x (manifest minimum1.21.1), the Rust toolchain/native build prerequisites, Xcode command-line tools/clang/libclang as needed by RocksDB/bindgen, and Chrome for actual browser gates. Prior native evidence used Rust/Cargo1.93.0 on aarch64-apple-darwin. Follow current checked-in build/bootstrap scripts; don't normalize generated protoc wrappers by hand as a permanent fix. Cargo dependencies may need network fetch on the new machine.
3. From the repository root, run `yarn install --frozen-lockfile`. Create local configuration from `.env.example` only as needed. Never commit credentials, funded keys, recovery phrases, profiles or private state. Test fixtures generate disposable material; no system certificate trust installation is authorized.
4. Recreate isolated worktrees from remote branches, not from stale absolute paths. Read the repository skills/binding and durable issue claims before taking ownership. Only one Frank Rust/browser gate at a time. Use `.agents/scripts/with-cargo-slot`, normal per-worktree cache ownership and bounded jobs; no hidden target overrides, broad cache deletion, or shared target reuse. Start with at least10GiB free and enough additional cold-build headroom; continuously stop only owned processes before exhaustion. Cold native builds can consume many GiB.
5. Revalidate current main, exact diff, claims, dependent PR bases and CI before any merge. Independent source approval is not authority to skip pending boundary gates. No new-machine work is implicitly started by this document.

Useful commands after selecting the correct isolated branch:

```sh
git fetch origin
git status --short
git rev-parse HEAD
gh pr view 793 --repo schancel/frank --json headRefOid,baseRefName,statusCheckRollup

# Packet A #775: from its repository root; omit --offline on a fresh machine.
bash .agents/scripts/with-cargo-slot cargo test \
  --manifest-path backend/cashweb/Cargo.toml --locked \
  -p cashweb-registry --lib monad_dm_verify

# #750 native public probe, on issue-750:
bash .agents/scripts/with-cargo-slot cargo test \
  --manifest-path backend/cashweb/Cargo.toml --locked \
  -p cashweb-registry --example directory_trust_probe -- --test-threads=1
bash .agents/scripts/with-cargo-slot cargo build \
  --manifest-path backend/cashweb/Cargo.toml --locked \
  -p cashweb-registry --example directory_trust_probe
```

Then use the actual wrapper-selected binary path for `DIRECTORY_ADMISSION_RUST_PROBE` and the existing admission Jest `real Rust` cases; use `DIRECTORY_ADMISSION_CHROMIUM` for the `real controlled-origin` case. Follow each PR's exact package/config commands, not a different consumer's tsconfig. For #794 use its `check:browser` package stage, preserving full corpus counts/native exit/owned cleanup. Commands above are resume instructions, not new runs reported as passing.

`yarn demo --fake-chain` and `yarn demo:smoke` are checked-in existing demo commands, not a claim that the final target runtime is complete. Typed accounts may start with zero funds; explicit fake funding must target the EVM spending receive address. Do not reuse authentication keys for funds or silently replace a user's newly created identity with a preseeded fixture.

## Dependency order and retained decisions

1. Finish #794 corrected browser gate and #750 native/final-browser gates/review integration; preserve existing main libraries and pinned public trust boundaries.
2. #774 exposes authenticated directory routes under accepted one-worker/store plus8pending policy. Reserve before bounded body ingestion;60s server/65s dedicated client/>=70s directory HTTPS. Queued cancelled work must not mutate; started work retains ownership through terminal/checkpoint despite timeout/disconnect. Return uncertainty rather than a false durable acknowledgement; exact-request recovery is required. No fresh-authority cache waiver or reduced protocol caps.
3. Finish #775 pure prepare/open/stamp facade using public admitted evidence and #789 original-graph continuation; then #776 financial pinning, #777 exact durable transport, #703 outbound attribution, #778 actual UI/Qwen, #779 two-relay delivery and #780 blackjack/DM legacy retirement. Preserve native dependencies and final integration holds even where isolated source preparation was allowed.
4. #782 active type18 codec unlocks #780 typed blackjack; #771 stays open until active promotion proof. #784 vendor and #785 raffle remain typed consumer obligations, not permanent unsupported-mode completion.
5. #769 canonical Forum server precedes #770 whole normal-client switch and removal. #797 owns remaining profile/RPC/P2P/error/generated protobuf boundaries; its inventory needs finite reviewed replacements/allocations. Do not silently remove supported Bitcoin/Chronik/faucet functionality.
6. Full goal closes only after actual user/wire/two-relay evidence and active protobuf/CBC removal. Held #258 never becomes fallback. BIP39 legacy wallet import does not authorize message CBC decrypt compatibility. #765 local-capacity design is deferred after demo; #786 production enrollment is outside bounded explicit operator-provisioned local demo. Ngrok was advisory only: no public deployment or TLS waiver authorized.

The consolidated portable handoff is also recorded in [goal issue comment 5973361299](https://github.com/schancel/frank/issues/696#issuecomment-5973361299). Contract snapshots are not bundled in this checkpoint; read the accepted native issue/PR packets before implementation. Durable native issue/PR comments remain authoritative when they explicitly supersede an earlier paragraph; do not copy an obsolete test-sentinel permission from historical comments.

After each reviewed landing, fetch remote main, refresh a clean integration checkout with fast-forward-only semantics, verify owned worktrees have no unpreserved changes, and remove only verified disposable merged worktrees. The old accumulation of defunct worktrees and stale local main was a workflow failure, not a required tradeoff. Never reset a dirty primary checkout or delete user-owned work to satisfy this rule.

## Local-only migration warning

Git does not contain the old `/private/tmp` logs, browser personas, IndexedDB, Level/RocksDB data, native binaries/caches, `.env`, or wallet/recovery material. This PR contains sanitized prose only. Copy private data separately via a user-controlled secure backup if desired; never put it in a public PR, issue comment or broad evidence archive. Do not infer successful UI recovery from copying a browser profile. Preserve complete raw logs privately if exact provenance is important; otherwise rerun named gates on the new machine.

The old primary worktree has user-owned branding/UI edits: **do not stage, reset or discard them**. Root's read-only audit also found historical dirty domain-root/swap review mutants, base309/base605, Codex32-spec work, review478 Quasar edits, review567 verifier, review582 coverage and verify582 crypto/scratch. These are not new overnight feature checkpoints. Historical issue187 app deletions and a missing issue177 worktree are not ours to commit or repair. Preserve and classify them separately with the user. No broad cleanup was performed during migration drain.

Live work claims are durable locks, not timers. Check the migration handoff comments before resuming; explicitly release/transfer only the relevant stopped owner scope. Preserve all held historical artifacts and ordinary stacked base branches. The active source branches above are the portable resumption path; machine-local worktree absence is not permission to recreate or delete unrelated data.
