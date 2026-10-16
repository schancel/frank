# EVM wallet identity gates: candidate evidence

Code candidate: `6d3411327b71a8d08cc305baf57e00c1d35efa53`, based on
`4184740f` (the parent contract commit over `da1d87cf`). Requested worker lane/model:
GPT-6.1 Sol medium. The worktree and local dependency overlays are retained.

## Boundary and implementation

The actual shared factory qualifies its own constructed provider before publishing a new
handle, and qualifies later cached-handle acquisitions. Concurrent callers awaiting the original
opening share its pending result. `reobserveNativeOperations` qualifies before its evidence,
application and resend sequence; `watchNativeOperation` qualifies before the watcher or fallback
wait can read a head. Qualification runs outside storage and spend/send queues.

The wallet-specific lifetime helper holds one physical qualification at a time. Its logical
wait defaults to 30,000ms; overrides must be positive safe integers at most 30,000ms. Timeout
or close rejects the wait immediately, but the physical request remains owned until it settles.
Its expired lifecycle prevents another probe step. A late success cannot qualify a new pass.
Settlement permits a fresh attempt. Provider destruction remains the actual disposal mechanism.

Factory configuration captures canonical identity, RPC/relay routing and copied operator
checkpoints. The host's late stamp-resolver installation is deliberately retained. Typed operator
anchors and the strictly paired environment variables are forwarded through current hosts;
regtest opening and its restart subprocess receive the established run checkpoint, never an
anchor discovered during opening. Public registry pins and native-wallet-ineligible Tempo remain
unchanged. The app changes are confined to the approved secondary configuration block/type.

## Fail-before proof

With only the initial three regression tests added and the original factory/recovery source
still installed:

```
node node_modules/jest/bin/jest.js --config packages/wallet/jest.config.js --runInBand packages/wallet/chain/evm-wallet-identity-gates.jest.test.ts > /tmp/evm-wallet-gates-fail-before.log 2>&1
```

All three failed because promises resolved rather than rejecting: wrong pinned checkpoint on
new factory publication, changed upstream on cached-handle publication, and wrong checkpoint
on the actual installed recovery method. The log was saved before production edits. A first
fixture-authoring attempt used an invalid material shape; it was corrected before the recorded
fail-before run. These tests call the actual factory and owner methods, not a verifier substitute.

## Completed acceptance checks

Commands below run from `.worktrees/evm-wallet-identity-gates` with candidate-local dependencies;
no installation, shared dependency mutation or live RPC was used.

- Installed gate suite: **27 passed**, `/tmp/evm-wallet-gates-focused.log`.
  `node node_modules/jest/bin/jest.js --config packages/wallet/jest.config.js --runInBand packages/wallet/chain/evm-wallet-identity-gates.jest.test.ts`
- Real domain-wallet suite: **98 passed**, `/tmp/evm-wallet-gates-domain-repeat.log`.
  Same wallet Jest command with `packages/wallet/chain/monad-domain-wallet.jest.test.ts`.
- Canonical wallet suite plus delivery and then-current gate suite: **142 passed**,
  `/tmp/evm-wallet-gates-repeat-wallet.log`. Same command with
  `monad-dm-delivery.jest.test.ts`, `evm-wallet-identity-gates.jest.test.ts` and
  `monad-chain-canonical-dm.jest.test.ts` under `packages/wallet/chain/`.
  The canonical suite contains 121 tests; the gate suite subsequently grew to 27 and was rerun.
- Multisource/native-host/bound-pool fixture checks: **23 passed**,
  `/tmp/evm-wallet-gates-fixtures-repeat.log`. Same command with
  `evm-multisource-composition.jest.test.ts`, `evm-host.jest.test.ts` and
  `evm-bound-pool.jest.test.ts` under `packages/wallet/chain/`.
- Full self-sync suite: **14 passed**, `/tmp/evm-wallet-gates-self-sync-repeat.log`.
  Same command with `packages/wallet/chain/self-wallet-sync.jest.test.ts`.
  Sepolia-specific proof also passed independently in `/tmp/evm-wallet-gates-sepolia.log`.
- App: **143 passed, 1 intentional live test skipped**, `/tmp/evm-wallet-gates-app-final.log`.
  `node node_modules/jest/bin/jest.js --config app/jest.config.js --runInBand app/src/accounts/session.jest.test.ts app/src/accounts/evm-wallets.jest.test.ts app/src/accounts/evm-rpc-identity.jest.test.ts app/src/accounts/evm-relay-route.jest.test.ts`
- Actual Qwen/BotHost composition: **46 passed**, `/tmp/evm-wallet-gates-bot-final.log`.
  `node node_modules/jest/bin/jest.js --config packages/bot/jest.config.js --runInBand packages/bot/qwen-bot-common.jest.test.ts packages/bot/qwen-host-safety.jest.test.ts`
- **25/25 configured projects typecheck**, `/tmp/evm-wallet-gates-types.log`.
  `node --import tsx scripts/typecheck.ts --fast`.
  This includes the bot's real regtest/restart fixture sources; no funded native run was made.
- New helper/test files pass Prettier, `/tmp/evm-wallet-gates-format.log`:
  `node node_modules/.bin/prettier --check packages/wallet/chain/evm-wallet-qualification.ts packages/wallet/chain/evm-identity-rpc.testutil.ts packages/wallet/chain/evm-wallet-identity-gates.jest.test.ts`.
  Existing-file formatting was restricted to touched blocks; no whole-file formatting pass is claimed.
- `git diff --check` passed. App ESLint JSON is `/tmp/evm-wallet-gates-app-lint.json`:
  `node node_modules/.bin/eslint app/src/accounts/session.ts app/src/accounts/evm-wallets.ts app/src/accounts/session.jest.test.ts app/src/accounts/evm-wallets.jest.test.ts --format json`.
  Both production files and the EVM owner suite have zero errors. The session suite retains its
  20 unrelated baseline UTXO formatting errors, also observed before this packet.

Physical request assertions: two concurrent initial opens issue **2 raw probe calls total**;
two overlapping recovery passes issue **2 additional calls total**. An unresolved first probe
and three timed-out/repeated polls remain at **1 physical call**; after settlement the fresh pass
adds exactly **2 calls**. Opening timeout destroys the provider and never starts the checkpoint
step when the first RPC settles late. Close rejects the pending wait before late settlement.
Mainnet/testnet pins, explicit regtest anchor capture, malformed configuration/env refusal,
input mutation and Tempo refusal are exercised through the installed factory.

The domain retained-attempt regression creates a signed ambiguous native attempt using the
owned fake RPC. Refused recovery performs no receipt lookup or resend and preserves the entire
operation. A failed reopening followed by a valid reopening preserves that same signed operation.
Primary app activation stays visibly unavailable on a refused actual factory opening. The actual
BotHost poll calls the installed wallet method; the method's rejected qualification is observed
and no transaction evidence read follows it.

## Exact frozen-code consumer rerun

After code commit `6d341132` was frozen, all three affected consumer suites were rerun together:

```
node node_modules/jest/bin/jest.js --config packages/wallet/jest.config.js --runInBand packages/wallet/chain/monad-chain-canonical-dm.jest.test.ts packages/wallet/chain/monad-domain-wallet.jest.test.ts packages/wallet/chain/evm-multisource-composition.jest.test.ts > /tmp/evm-wallet-gates-frozen-consumers.log 2>&1
```

**233/233 passed** (canonical 121, domain 98, multisource 14). No source or test edits occurred
after the code freeze. The full self-sync rerun and targeted Sepolia proof above used the repaired
canonical route fixture before freezing; their relevant executable sources match the frozen
candidate. The independent reviewer additionally ran the installed gate and domain suites against
this exact frozen code (125 passing tests).

## Broad offline sweep and baseline attribution

The broad sweep was started before several deterministic-fixture repairs and remains running
at the time of this evidence commit. **No aggregate pass is claimed.** Its command/log:

```
node node_modules/jest/bin/jest.js --config packages/wallet/jest.config.js --runInBand --testPathIgnorePatterns 'utxo-chains.live.jest.test.ts|monad-parallel-send.anvil.jest.test.ts|monad-dm-delivery.jest.test.ts' > /tmp/evm-wallet-gates-full-wallet.log 2>&1
```

The first two exclusions are intentional live/native suites. `monad-dm-delivery` was mistakenly
excluded by name and is offline; it was separately run successfully above. Test order is saved
in `/tmp/evm-wallet-gates-test-order.log`.

Failures repaired during the sweep: the domain suite had one obsolete `chain: 'monad'` fixture
field, corrected to canonical `chainIdentifier`; canonical DM had its own unadapted provider;
multisource opened in a root hook preceding the fixture hook and explicitly restored mocks
before reopening; the shared offline provider answered Monad identity for a Sepolia owner.
All four complete affected suites passed the reruns listed above. Valid raw responses were
installed before the real opening checks; no verification exemptions or success stubs were added.
Financial `_perform` responses remain the existing synthetic chain behavior.

Two remaining suites have exact pre-change factory attribution: contact-payment **10 failures**
(repeated mailbox cursor), and topic-burn **15 failures** (unsupported Forum type 15 V6.1).
A disposable exact `git show 4184740f:packages/wallet/chain/monad-chain.ts` snapshot was mapped through
`^\./monad-chain$` in `/tmp/evm-wallet-gates-baseline.config.cjs`; all other candidate consumers
and deterministic fixtures remained installed. The baseline command was:

```
node node_modules/jest/bin/jest.js --config /tmp/evm-wallet-gates-baseline.config.cjs --runInBand packages/wallet/chain/contact-payment.jest.test.ts packages/wallet/chain/monad-chain-topic-burn.jest.test.ts > /tmp/evm-wallet-gates-baseline.log 2>&1
```

Baseline: **25 failed, 32 passed, 4 todo**. The failing test names match the sweep exactly,
10/10 contact and 15/15 Forum, with the same assertions/errors. The comparison is saved at
`/tmp/evm-wallet-gates-baseline-comparison.json`. The disposable source was removed before the
final typecheck. These failures require follow-up; this candidate does not repair the mailbox
or Forum protocol boundary.

## Limits and next action

The broader sweep's final aggregate is pending and will be recorded separately without code
changes. The base predates the independently reviewed signed-negotiation UI integration; parent
owns its combined actual-flow check. No main merge, push, deployment, keys, live funds/messages,
registry change, migration or durable format change occurred.

Opening still applies existing local pool/journal transitions before constructing the provider;
these gates do not establish read-only or pre-mutation opening safety. No-owner/closed recovery
returns early; an existing owner currently qualifies even when its pass ultimately has no work.
This packet does not gate every financial send, provide prompt cancellation of all opening steps,
retain a durable identity certificate, track ancestry, roll back inventories or complete reorg
recovery. Independent review of the exact candidate is the next action.
