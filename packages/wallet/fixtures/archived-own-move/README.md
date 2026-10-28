# Archived own-move baseline fixture

This is **test-only salvage evidence**, captured from the real isolated-Anvil lifecycle on product baseline `371445d685aabcc06a77c2cf4c489fbde25a9c60`. Preserve the original evidence commit `febf2936b4fa686392f64a57c73705b9113c96f0` and fixture checkpoint `57c5540e5`. C2's prospective guard intentionally prevents new runs on repaired product code from generating this old state.

`baseline-lifecycle.json` contains one actual archived signing graph/completion, the actual retained CoinList records (keys belong only to deterministic synthetic test accounts), and the later actual receipt proving its original own raw still executes. Its two sparse format samples are unpersisted examples of the approved format, not a claim that product recovery or sync has run. They reference original hashes and contain no copy of signed/unsigned transaction data. They deliberately omit the original inventoryApplied checkpoint.

Source/generator: `packages/wallet/evm-archived-own-move.anvil.jest.test.ts`, explicit `ARCHIVED_OWN_MOVE_FIXTURE_PATH` capture hook. Default tests write no repository fixtures. To regenerate, create an isolated worktree at preserved fixture checkpoint `57c5540e5`, whose product files remain at the baseline, with isolated Anvil installed:

```sh
ARCHIVED_OWN_MOVE_FIXTURE_PATH=/tmp/frank-archived-own-move-baseline.json node_modules/.bin/jest --config packages/wallet/jest.config.js --runInBand --runTestsByPath packages/wallet/evm-archived-own-move.anvil.jest.test.ts
cp /tmp/frank-archived-own-move-baseline.json packages/wallet/fixtures/archived-own-move/baseline-lifecycle.json
node_modules/.bin/jest --config packages/wallet/jest.config.js --runInBand --runTestsByPath packages/wallet/evm-archived-own-move-fixture.jest.test.ts
```

Block hashes and completion digests can change between isolated-node runs; graph hashes/raw bytes remain validated against the captured original. Do not hand-edit the generated archive or use these synthetic keys against another service.

The existing baseline evidence test passes by proving normal recovery does nothing and then broadcasting original raw bytes as a counterproof. An explicit behavioral red gate records the missing automatic recovery without making up a future product API:

```sh
ARCHIVED_OWN_MOVE_REQUIRE_RECOVERY=1 node_modules/.bin/jest --config packages/wallet/jest.config.js --runInBand --runTestsByPath packages/wallet/evm-archived-own-move.anvil.jest.test.ts --testNamePattern='newer claim=false'
```

That gate must fail on this baseline because no old receipt exists after normal reconciliation. On the fresh post-C2 implementation branch, tests must seed this genuine immutable old archive through isolated test storage and invoke the approved archived recovery entry. They must retain original digest/history assertions and the newer-reservation negative control. Do not weaken C2's prospective guard to make old fixture generation work.
