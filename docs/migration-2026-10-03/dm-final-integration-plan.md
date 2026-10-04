# #775 final integration plan — read-only preparation, 2026-10-03

This is a proposed parent-owned sequence, not an implementation claim or gate result. No source edits, branches, installs, tests, claims, publication, tracker writes, or cleanup were performed for this plan. PR809 remains a prerequisite until its exact candidate passes hosted checks, receives integration approval, and lands. All hashes below are full commit IDs; future landing hashes must be recorded when they exist.

## Preserved sources and current integration boundary

| Artifact | Exact source | Basis / disposition |
|---|---|---|
| Reviewed main, typed18 landed | `461cec2771b77ff954b3c5023388e09f29cf13e7` | PR808 landed; includes reviewed public-boundary guard |
| #774 directory candidate, PR809 | `ac74726efea3929b320d1aec0ce483ad395d218a` | Reviewed local gates passing; hosted CI pending; patch basis `71e2d6355081d5a7e0b8e091637920f05a9fe677` |
| Original Packet A, PR792 | `91f514b975d53e168c2553b5c13d8f11fd48a020` | Two commits, parent `bd34c080e31c1b4a9f68bfcfdc34127b7be88ed8`; original basis `e92004bf4dec0a13008736b03afcfe72750219ce` |
| Original Packet B, PR801 | `a48501b8e5a8f3d11f4ca398a24e222d4c687720` | Parent `e577548d29e584a37238e107a2541a449fc46b1a`; stacked basis `8b8f3f2451547b58b3c33f21f186da7a5ea2bffb` |
| Composed Packet B, PR807 | `91e386b6cd491a0add9977afddb0bf45378b3f2a` | Parent `39f828c4a8a71639d20f44dc97866f4f0809fdde`; foundation `4bdb4dc4b16b317730d54182e2cd9b9f5e7cb08e` |

Read-only binary patch comparisons: original A net patch SHA256 `d861cea128151de106bd70a1b17facf49e32d431b41664d9107ff546427eacd1`; original B and composed B net patches both SHA256 `55332e63c2d9c567a45248584d43a88738811f2722040889c19ef9d88aa19c49`, with exact patch-byte equality. All four original/composed B changed blobs are identical. All eleven A changed blobs match the composed foundation. Preserve these original branches, commits and PRs; do not force-push, relabel an unexecuted gate as passing, or clean up preserved work.

## Authority and ownership to reconcile before transport

Fresh read-only #775 tracker inspection retains the accepted effect-free Stage B contract: real shared prepare/open façade, pure Rust stamp verifier, authentic admission provenance, P signing only, distinct M/P′ role custody, inherited codec continuation budgets, exact-byte ownership, generation/grace rules and disposal. There is no route/default activation, payment, relay delivery, synthetic T1/identity fallback, CBC, or held #258 transplant.

* A claim `0e3c1457-9855-48bc-bcf5-59402e78e745`, worker `codex-overnight-implement-775`, original base e92004bf, authority/claim comments 5972214723/5972219154, remains frozen at 91f514b by authority 5973233841. No completion/release was found. Parent must explicitly dispose of or transfer that ownership before a replacement integrates its paths.
* Original B claim `f4e79265-6144-40af-8fce-f8e170d1d1a8` was ended/released by 5975074173/5975076389. Successor claim `7d2f7cb9-577c-4d4f-9465-8d9357865efc`, worker `codex-resume-canonical-775-20261003`, base e577548d, comment 5975076741, has no observed end disposition. Parent must reconcile it before issuing any fresh integration ownership.
* Authority 5973233841 transfers only `canonical-dm.ts`, its test, and additive DM corpus records to B; A retains its other scope. Repair authority 5972675774 permits the exact public codec package/Jest dependency fixes and verifier regressions. Authority 5975136236 permits B's type-only public directory-admission dependency. Do not broaden either into crypto, directory runtime, payment, or wallet attempt state.
* Boundary guard claim `db089de2-c970-411f-be76-e0c1306ef40a` completed at 5975392832, reviewed bd22338 and landed PR806 as 7c66a60. The earlier mistaken claim was released before edits. Preserve the landed checker; no suppression, private/root-value imports or wildcard widening.

The parent should establish one explicit integration owner for the necessary composition, with A and B scope kept separate and #774-owned shared-file changes preserved. A fresh claim is a future coordination action, not authorized by this read-only packet. Historical #60/#258 financial ownership remains untouched; #776 C0 needs its own reconciliation after B lands.

## Landing 1: clean Packet A foundation after #774

First land reviewed #774 onto typed18 main, record its actual resulting SHA, and verify that typed18 and the boundary guard survive. Build the A transport on that exact clean main. Current typed18 main has no changed-path overlap with the eleven-path original A patch; #774 introduces three overlaps:

| Shared path | Required composition |
|---|---|
| `backend/cashweb/cashweb-registry/src/lib.rs` | Add only `pub mod monad_dm_verify;`; retain `pub mod directory_runtime;` and every #774 registration/API. Never replace the file with the old A blob. |
| `packages/cashweb/package.json` | #774 already supplies one `@frank/codec` and one `@frank/directory-admission` workspace dependency. Keep its landed metadata; do not duplicate JSON keys, reorder unnecessarily, alter versions, or regenerate locks. |
| `packages/cashweb/jest.config.js` | #774 already supplies A's public codec mapper and its directory root/node mappings. Retain the landed config; do not replace it with A's older map. |

Expected A transport is therefore nine changed paths if #774 lands as reviewed: the eight independent A blobs below plus the additive registry module line. The original package/Jest amendments are fulfilled by ancestry, not repeated edits. Audit that conclusion against the actual landing bytes rather than forcing the historical eleven-file count.

Preserve byte-for-byte A's independent files: `monad_dm_verify.rs`, `monad_dm_verify_tests.rs`, `docs/protocol/cbor/vectors/dm-runtime.json`, `canonical-dm-stamp.ts`, `canonical-dm-stamp.jest.test.ts`, `monad-wallet-handle.ts`, `monad-wallet-material.ts`, and `monad-wallet-material.jest.test.ts` at their original paths. The existing domain-wallet test remains unchanged. Review the exact transported net diff and shared-file composition before landing A independently. Do not attach B or any C0 production changes to this landing.

Original A evidence is source approval and 52 selected TS tests (17 stamp plus 35 wallet custody/domain), plus the user-supplied handoff's all-seven native tests PASS at exact91f514b in .worktrees/issue-775. An earlier interrupted cold build selected tests but executed zero; it does not supersede that later exact-tip pass. Existing component results do not replace a fresh owned integrated dependency/boundary/native check on the new typed18/directory base. Two old TS2339 recipientPublicKeyHex diagnostics must be compared to the new baseline; never suppress a newly introduced error.

## Landing 2: pure Packet B façade on landed A

Only after A's independent reviewed landing, transport the exact original/composed B behavior. The four-path historical patch becomes an expected three-path net change because #774 already supplies the directory dependency: add `packages/cashweb/relay/canonical-dm.ts`, add its test, and append B's corpus records in `docs/protocol/cbor/vectors/dm-runtime.json`. Preserve A corpus keys/values and all frozen corpora. If the foundation corpus remains the exact original A blob, the resulting B corpus and both façade source/test blobs should match a48501b8/91e386b6 exactly. Record any necessary new verification-test delta separately; do not describe a changed test blob as byte identical.

B uses public codec imports, public crypto suite results, and type-only public Current/Historical admission evidence. `prepareDirectMessage` is effect-free; `openDirectMessage` classifies current receipt versus explicit archive opening. It consumes real role capabilities and authentic authority; it cannot manufacture admission evidence from HTTP JSON or reinterpret archive as fresh current. The Rust verifier remains a partial stamp/context verifier, not an AEAD, chain-observation, persistence, broadcast, or full Stage10 service. Keep launcher, runtime routes/defaults, allocator, financial journals, relay activation, crypto implementation and held #258 work outside both transports.

Original B component evidence: 44 focused façade tests, seven native verifier tests, distinct-party Chrome→Node AEAD and independent Rust stamp-context proof. Composed PR807 evidence: 79 focused tests (44 façade/stamp, 5 custody, 30 domain), focused types, public Node legacy boundary closure with 39 inputs/exactly five allowed consumers, source equality. Those are prior component/composed results. They do not prove the new type18+#774 integrated candidate.

## Mandatory verification on the actual two integration candidates

All execution is future parent-owned work. Use repository wrappers, frozen owned installs and each isolated tree's default caches; no borrowed target directory/cache override. Request the exclusive native/browser lease before heavy commands, enforce the disk guard, execute heavy gates sequentially and retain terminal output. A source-only run is not a native/browser pass. Capture exact base/tip, command, environment and terminal verdict for every gate.

For A: run scoped formatting/type/declaration checks; meaningful selected stamp, wallet material/custody and domain tests; public package/export boundary checks; all seven Rust verifier tests to terminal completion on the new composed native tree; immutable corpus/source-pins audit. Confirm distinct M/P′, wrong signer/context, current versus previous generation/grace direction, exact-byte ownership, capability disposal and no authority/persistence effects. Execute required affected registry/directory native regression checks rather than relying on compilation of the added module alone.

For B: rerun the complete selected 79-test family, focused types and the unchanged boundary checker. Run native verifier and codec regression suites against the actual integrated codec/runtime. Add or execute meaningful public integration probes for typed18 root/nested payload items through real suite1 prepare→open, strict schema/version rejection, retained unknown type60000, malformed typed18 rejection, nested 4096/byte/aggregate continuation limits, and immutable exact-byte copies. B already has an original ciphertext aggregate-budget test and a type60000 opaque roundtrip; neither alone covers the new recognized type18 schema. Any new regression is confined to the accepted façade test/additive corpus scope, reviewed as an explicit test delta. Do not implement blackjack application behavior or change codec production to make a façade test pass.

Run actual distinct-party browser seal→Node open and independent Rust stamp/context cross-consumption on the integrated tree, using admission obtained through #774's real HTTPS→Rust directory path and public Node admission store. An HTTP response shape or cast is not Current authority. Exercise both fresh current and explicit historical archive classification, previous-generation grace, rotated M, authentication failure, mutation/owned bytes and continuation budgets. Directory reload/clock and historical-first continuity-loss 409 behavior must remain intact. #774's new read-only `Directory::check_current` returns a validation result, does not mint Current evidence or persist a checkpoint, and must not be turned into a shortcut around admission. Reconfirm its no-write effect and actual serving/reload semantics in the affected directory regression gate.

Audit source equality after transport: all unaffected original A/B production helpers match their preserved blobs; registry registration is additive; package/Jest #774 bytes stay preserved unless an explicitly reviewed finite amendment is required; original corpus keys/values and frozen vectors/source hashes remain unchanged. Repeat the exact integrated checks after any repair. Review each frozen landing candidate independently and wait for its hosted checks before landing. No inherited component pass or pending CI constitutes integrated approval.

## Dependency disposition and downstream release

Fresh native tracker graph: #775 is blocked by closed #789 and open #774; it blocks open #696 and open #776. #774 must land and its edge be reconciled first. Packet A is the prerequisite foundation for B, not a second name for #774 Stage A. Typed18 was not an allocation blocker, but its now-landed decoding behavior is a mandatory integrated regression boundary. Only after both independent landings and all accepted Stage B proofs may the parent record #775 completion and reconcile native dependency edges. Do not close #775 on source review alone, and do not claim economic/delivery or full Stage10 completion.

Then #776 C0 becomes eligible for its separate test-only financial pinning packet, subject to historical #60/#258 ownership reconciliation. #777 C remains gated on C0; #703 follows its concrete #777 prerequisite. Nothing in this plan activates those workstreams, payments, relaying, launcher defaults, or #258. Preserve PR792, PR801 and PR807 as historical reviewed artifacts until the parent chooses their explicit supersession/disposition after the new two-landing chain is durable.

Tracker sources read: https://github.com/schancel/frank/issues/775 and PRs https://github.com/schancel/frank/pull/792, https://github.com/schancel/frank/pull/801, https://github.com/schancel/frank/pull/807, https://github.com/schancel/frank/pull/809. Authority comment IDs above resolve on issue775 or PR792 as described. Hosted status is a point-in-time observation; recheck before any actual integration.
