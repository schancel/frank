import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

// Exercise the real public facade without a browser or substitute IndexedDB.
const require = createRequire(import.meta.url)
const { build } = require('esbuild')
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/index.ts', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'esm',
  alias: { '@frank/domain-roots': fileURLToPath(new URL('../../domain-roots/src/index.ts', import.meta.url)) },
})
const { createVaultWriteIntent, openPreviewVault, VaultError } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`,
)
const context = () => ({
  accountId: 'account-fixture', creationId: 'creation-fixture', recoveryFormat: 'codex32-master-v1',
  registry: 'frank-domain-roots-v1', purposes: ['ecash-bch-wallet', 'identity-authentication'],
  custodyEpoch: 1, recoveryFingerprint: 'public-fixture', retirementContext: '',
})
const code = expected => error => error instanceof VaultError && error.code === expected && error.message === `Preview vault: ${expected}`
const initial = () => createVaultWriteIntent({ context: context(), expected: null, operationId: 'initial' })

test('snapshots caller context into immutable public intents', () => {
  const input = context()
  const intent = createVaultWriteIntent({ context: input, expected: null, operationId: 'initial' })
  input.purposes[0] = 'evm-wallet'
  input.accountId = 'changed'
  assert.equal(intent.receipt.context.accountId, 'account-fixture')
  assert.equal(intent.receipt.context.purposes[0], 'ecash-bch-wallet')
  assert.ok(Object.isFrozen(intent) && Object.isFrozen(intent.receipt.context.purposes))
})

test('rejects invalid registry, format, purpose order, bounds and revisions', () => {
  for (const update of [
    { registry: 'other' }, { recoveryFormat: 'bip39' }, { purposes: [] },
    { purposes: ['identity-authentication', 'ecash-bch-wallet'] },
    { purposes: ['ecash-bch-wallet', 'ecash-bch-wallet'] }, { purposes: ['unallocated'] },
    { custodyEpoch: -1 }, { custodyEpoch: 0xffffffff }, { accountId: 'x'.repeat(129) },
  ]) assert.throws(() => createVaultWriteIntent({ context: { ...context(), ...update }, expected: null, operationId: 'invalid' }), code('invalid-input'))
  const first = initial().receipt
  for (const expected of [{ ...first, revision: 0 }, { ...first, schema: 2 }, { ...first, previousRevision: 9 }]) {
    assert.throws(() => createVaultWriteIntent({ context: context(), expected, operationId: 'replacement' }), code('invalid-input'))
  }
})

test('replacement binds stable account/creation IDs and monotonic custody epoch', () => {
  const expected = initial().receipt
  for (const update of [{ accountId: 'other' }, { creationId: 'other' }, { custodyEpoch: 0 }]) {
    assert.throws(() => createVaultWriteIntent({ context: { ...context(), ...update }, expected, operationId: 'replacement' }), code('invalid-input'))
  }
  assert.throws(() => createVaultWriteIntent({ context: context(), expected, operationId: 'initial' }), code('invalid-input'))
  const replacement = createVaultWriteIntent({ context: context(), expected, operationId: 'replacement' })
  assert.equal(replacement.receipt.previousRevision, 1)
  assert.equal(replacement.receipt.revision, 2)
})

test('caller getter failures are normalized without exposing their content', () => {
  assert.throws(() => createVaultWriteIntent({ get context() { throw new Error('caller-private-detail') } }), code('invalid-input'))
})

test('absent browser storage fails closed; malformed namespaces fail before capability access', async () => {
  assert.equal(globalThis.indexedDB, undefined)
  await assert.rejects(openPreviewVault({ namespace: 'node-fixture' }), code('unavailable'))
  await assert.rejects(openPreviewVault({ namespace: '../invalid' }), code('invalid-input'))
  await assert.rejects(openPreviewVault({ get namespace() { throw new Error('caller-private-detail') } }), code('invalid-input'))
})
