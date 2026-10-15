# Verification

Only `packages/bot/demo/regtest/owned-template-fixture.ts`, its `.test.cjs`, and this review directory are changed. No existing fixture or dependency manifest changed. The preserved partial B1 worktree was read only. Neither `native.livecheck.ts` nor `consensus-block.ts` ran.

Pinned input: existing `/tmp/frank-adaptor-abc.tar.gz`, SHA-256 `08dbe296274c7940d47e9db15d2c6aa99aa6eb749d84f7888a1d5ce19cfb6233`; executable `/tmp/frank-adaptor-abc-verified/bitcoin-abc-0.34.0/bin/bitcoind` compared byte-for-byte by digest against that archive before every start. No downloads.

Run from this worktree:

```
ADAPTOR_ABC_ARCHIVE=/tmp/frank-adaptor-abc.tar.gz \
FRANK_BITCOIN_ABC_BIN_DIR=/tmp/frank-adaptor-abc-verified/bitcoin-abc-0.34.0/bin \
node --import tsx --test packages/bot/demo/regtest/owned-template-fixture.test.cjs
yarn typecheck:fast
```

Actual test output: 3 passed, 0 failed (5.88 seconds). Import traps cover process creation, mkdir/mkdtemp/write, sockets/fetch, listener changes and exitCode. Real nodes prove the disconnected -9 error, one normal fully validated OP_RETURN bootstrap block, both nodes at the same height/hash and out of IBD, a height-2 empty template, repeated/concurrent stop, forced startup timeout, and SIGTERM cleanup. Datadir snapshots return to baseline; stop verifies all four RPC/P2P ports close. Process inspection after tests found no owned bitcoind. SIGINT shares the same tested shutdown handler; abrupt SIGKILL cannot run JavaScript cleanup.

Initial experiment: two genesis nodes completed protocol handshake but remained IBD=true. Waiting timed out and cleaned them. Upstream mining.cpp 902-910 requires both a peer and no IBD; validation.cpp 1460-1461 rejects stale tips. A second experiment proved both peers validate the ordinary bootstrap block, but peer synced_blocks can remain -1 on its sender; it is not used as an extra readiness condition.

Public use: import `startOwnedTemplateFixture`, call with the verified archive and binaryDir, await the ready result, use its generic typed `rpc<T>()`, always `await fixture.stop()` in finally. A guarded standalone CLI prints only chainIdentifier, disconnected error, and template counts. This fixture does not initialize wallets, keys, payment transactions, swaps, or adapters. Its only block is disposable local readiness data.

Whole-tree compilation: 23/23 configured projects passed. Dependency overlay points @frank packages to this worktree; no new dependency installed. Overlay symlinks are removed before commit. Independent Astra review is required before any integration; no PR, merge, deployment or publication is authorized here.
