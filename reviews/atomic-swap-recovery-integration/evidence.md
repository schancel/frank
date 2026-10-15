# Exact recovery and conditional-success integration

Candidate code tip: `7c31ee8c4689c738d894ad978ad94c7a8a0c8442` on protected predecessor plus C0 `828848a7af44436721aed880d51d26b1a6ac667d`. This record is an evidence-only addition after that code tip. Tier 3; coordinator-supplied bounded contract, requested implementation lane gpt-6.1-sol medium. Independent review remains the next step. The breaking-release hold remains: no main merge, publication, deployment or runtime activation.

The existing readiness fixture owns disposable ABC processes, authentication and datadirs; the existing exported lifecycle owns disposable loopback Anvil and its provider/tempdir. Experiments own ephemeral keys, public-file barriers and observations. C0 retains local signing metadata ownership without runtime consumers. Ownership and dependency direction are unchanged. No wire/persistence/product API change or removal was introduced.

## Transport and dependency equivalence

The following commits were cherry-picked in order without conflict or edit. For each row, `git show --format= --binary ORIGINAL` and the corresponding transported commit produce **identical patch bytes**, including preserved evidence artifacts.

| Original | Transported |
| --- | --- |
| `594b7011f6a7a74b30b270cc1f535597e94b89a5` | `5ae03d4f03a7886edd38e7c2a0f9b0591a679364` |
| `a7f7017a43d97d0188aaaa53a0c02b9f6d1cb029` | `1ba924e7d4ecdfee88bfa12f513dc61f9a0d1d3e` |
| `f3532c0f9d7250020e3ec547b79cc1f2702c042f` | `ebbbb539b78da610bd647ce3eb0a834a50189240` |
| `e4b108faa4f442381f7dc2861af87a266e87a229` | `7c31ee8c4689c738d894ad978ad94c7a8a0c8442` |

Final transported fixture/helper/test files and both original review directories compare byte-for-byte equal to original `e4b108f`. Threshold-ecdsa, adaptor-signatures, StateChannel source/artifact and ABC readiness source also compare unchanged against that original. C0 was not edited. The protected stack's newer import-safety fixes and policy formatting remain present.

The protected predecessor includes Nakamoto #1594 strategy dispatch changes relative to the experiments' original base. Inspection found the exercised XEC ForkID0x41 path retains its encoding (XEC forkId0). Before fresh native tests, integrated helpers round-tripped all 15 saved CLTV raw transactions/digests and all three saved pair-spend raw transactions/digests. The saved B1c public-only package plus observed ABC signature reproduced its exact EVM authorization. This is scoped equivalence evidence for the exercised path, not a claim that Nakamoto's whole tree is identical. Native tests below additionally exercise the integrated implementation.

## Preserved public evidence versus fresh verification

Original public proofs remain unchanged:

- Pair evidence SHA-256: `d1be7a17920279ef7ef3447328142cb88499ce24abb227deb647b8d845c166e9`.
- Native conditional-success evidence SHA-256: `2f6f3adff200020d7fb75ffa351a6e0b4e0fe7d5749cdf958360ef72c552c37e`.

Those artifacts describe their original runs, not transactions newly submitted by this integration. This run parsed both complete saved JSON artifacts, verified their 1375 and 1362 header chains and every available eleven-header median, and replayed the saved native bindings as described above.

Fresh tests ran on the integrated checkout using the existing cached verified ABC0.34.0 archive/binaries and owned loopback one-thread Anvil, with synthetic local funds. No download, public/shared/funded network, VM or external deployment was used. Fresh native transaction details are asserted in-process by the unchanged fixtures; this integration does not replace the original public JSON with a second trace.

| Fresh gate | Result | Log in `/tmp/` |
| --- | --- | --- |
| Owned ABC readiness/import/disconnection/SIGTERM | 3/3 pass | `frank-integration-readiness.log` |
| CLTV native/import/error cleanup | 3/3 pass | `frank-integration-cltv.log` |
| Pair native/import/error/SIGTERM cleanup | 4/4 pass | `frank-integration-pair.log` |
| Native conditional success/import/EEXIST barrier | 3/3 pass | `frank-integration-native.log` |
| Protected native livecheck import safety | 2/2 pass | `frank-integration-import-safety.log` |
| Threshold suite | 6 suites, 94/94 pass | `frank-integration-threshold.log` |
| Swap-protocol suite | 3 suites, 28/28 pass | `frank-integration-policy.log` |
| Whole configured typecheck | 23/23 projects pass | `frank-integration-typecheck.log` |
| Pair/native source and test formatting | Pass | `frank-integration-new-format.log` |
| Whole swap-protocol configured formatting | Pass | `frank-integration-policy-format.log` |
| Expanded CLTV source/test formatting probe | FAIL: inherited CLTV source/test formatting | `frank-integration-format.log` |

The expanded formatting probe additionally included `cltv-consensus-fixture.ts` and `.test.cjs`, which already have formatting gaps in the original frozen experiment. The coordinator explicitly kept the exact-transport scope and directed recording this limitation without expanding into a formatting change. No all-affected-files formatter pass or hosted-CI pass is claimed.

Commands reuse the gates recorded in original evidence (plus the protected import-safety regression). Native commands were serialized to keep owned lifecycle snapshot assertions meaningful:

```sh
export TSX_TSCONFIG_PATH=packages/bot/tsconfig.json
export ADAPTOR_ABC_ARCHIVE=/tmp/frank-adaptor-abc.tar.gz
export FRANK_BITCOIN_ABC_BIN_DIR=/tmp/frank-adaptor-abc-verified/bitcoin-abc-0.34.0/bin
node --import tsx --test packages/bot/demo/regtest/cltv-consensus-fixture.test.cjs
node --import tsx --test packages/bot/demo/regtest/pair-recovery-clock-fixture.test.cjs
node --import tsx --test packages/bot/demo/regtest/threshold-adaptor/native-conditional-success.test.cjs
node --import tsx --test packages/bot/demo/regtest/owned-template-fixture.test.cjs
yarn --cwd packages/bot test --runInBand demo/regtest/threshold-adaptor/import-safety.jest.test.ts
yarn --cwd packages/threshold-ecdsa test --runInBand
yarn --cwd packages/swap-protocol test --runInBand
yarn typecheck:fast
node_modules/.bin/prettier --config app/.prettierrc.json --check packages/bot/demo/regtest/pair-recovery-clock-fixture.ts packages/bot/demo/regtest/pair-recovery-clock-fixture.test.cjs packages/bot/demo/regtest/threshold-adaptor/native-conditional-success.ts packages/bot/demo/regtest/threshold-adaptor/native-conditional-success.test.cjs
(cd packages/swap-protocol && ../../node_modules/.bin/prettier --config ../../app/.prettierrc.json --check .)
```

Dependency provisioning used only disposable node_modules overlays in this checkout. Existing external package entries were linked from installed dependencies; all @frank workspace links pointed exclusively to this checkout, and wallet Chronik was verified4.3.1. No manifest or lockfile changed. After all gates completed, only this lane's overlays were removed. Native tests assert owned node shutdown, port closure and tempdir restoration, including error and interruption paths. Other worktrees, stashes and local data were untouched.

## Limits and next action

Mandatory original contracts/evidence and `/tmp/frank-astra-composition-review/crypto-assurance-gap.md` were read. These are bounded ordinary recovery and conditional-success experiments. They do not establish malicious security of the joint DLEQ/Paillier composition, secure JavaScript erasure, durable browser disclosure/burn ownership, bidirectional reorg recovery, malicious burn with independent refunds, or production fee/clock/finality policy. C0 is present but no runtime consumer was added. The owner-selected recoverable timed escrow with threshold/adaptor remains subject to its assurance and release gates.

This candidate is prepared for independent exact-tip review. Passing tests do not mean completed atomic swaps or permission to lift the breaking-release hold.
