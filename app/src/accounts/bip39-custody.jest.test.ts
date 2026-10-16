/** @jest-environment node */
import { webcrypto } from 'crypto'
import { IDBFactory } from 'fake-indexeddb'
import { Mnemonic, getBytes } from 'ethers'
import {
  BIP39_RECOVERY_FORMAT,
  BIP39_DERIVATION,
  openPreviewVault,
} from '@frank/account-vault'
import { MonadIdentity } from '@frank/wallet/evm-identity'
import {
  openAccountCustody,
  type AccountCustody,
  type StageBip39Account,
} from './custody'

const phrase = 'test test test test test test test test test test test junk'
const expectedSeed = () => getBytes(Mnemonic.fromPhrase(phrase).computeSeed())
const namespace = 'bip39-custody-test'
const opened: AccountCustody[] = []
const open = async () => {
  const custody = await openAccountCustody({ namespace })
  opened.push(custody)
  return custody
}
const input = (): StageBip39Account => ({
  attemptId: 'restore-bip39',
  accountId: 'historical-frank',
  expectedActive: { revision: 0, accountId: null },
  displayName: '',
  custodyEpoch: 1,
  bip39Seed: expectedSeed(),
})

beforeEach(async () => {
  Object.defineProperty(globalThis, 'indexedDB', {
    value: new IDBFactory(),
    configurable: true,
  })
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    configurable: true,
  })
  Object.defineProperty(globalThis, 'CryptoKey', {
    value: Object.getPrototypeOf(
      await webcrypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      ),
    ).constructor,
    configurable: true,
  })
})
afterEach(() => {
  for (const custody of opened.splice(0)) custody.close()
})

test('public custody stages, activates and reopens the exact historical seed without converting it', async () => {
  const custody = await open()
  const staged = input()
  const staging = custody.stage(staged)
  staged.bip39Seed.fill(0)
  const pending = (await staging).pending!
  const identity = MonadIdentity.fromSeed({ mnemonic: phrase })
  expect(pending.account.fingerprint).toBe(
    identity.compressedPubKey.toString('hex'),
  )
  expect(pending.account.receipt.context).toMatchObject({
    recoveryFormat: BIP39_RECOVERY_FORMAT,
    registry: BIP39_DERIVATION,
    purposes: [],
  })
  expect(JSON.stringify(pending)).not.toContain(phrase)
  expect(JSON.stringify(pending)).not.toContain(
    Buffer.from(expectedSeed()).toString('hex'),
  )
  expect(await custody.reconcile(staged.attemptId)).toBe('ready')
  const recovered = await custody.openPendingBip39Seed(staged.attemptId)
  expect(recovered).toEqual(expectedSeed())
  recovered.fill(0)
  await custody.activate(staged.attemptId, staged.expectedActive)
  await expect(
    custody.activate(staged.attemptId, staged.expectedActive),
  ).resolves.toMatchObject({ active: pending.account })
  custody.close()
  const reopened = await open()
  await expect(
    reopened.activate(staged.attemptId, staged.expectedActive),
  ).resolves.toMatchObject({ active: pending.account })
  expect((await reopened.snapshot()).active).toEqual(pending.account)
  const capability = await reopened.openActive()
  const seed = capability.takeBip39Seed()
  expect(seed).toEqual(expectedSeed())
  seed.fill(0)
  capability.close()
  expect(await reopened.exportAccountRoot()).toEqual({
    account: pending.account,
    accountRoot: null,
  })
  const vault = await openPreviewVault({ namespace })
  try {
    await expect(vault.open(pending.account.receipt)).rejects.toMatchObject({
      code: 'invalid-input',
    })
  } finally {
    vault.close()
  }
})

test('a root-sized substitution is refused before durable staging and replacement remains explicit', async () => {
  const custody = await open()
  const staged = input()
  await expect(
    custody.stage({ ...staged, bip39Seed: new Uint8Array(32) }),
  ).rejects.toMatchObject({ code: 'invalid-input' })
  expect((await custody.snapshot()).pending).toBeNull()
  await custody.stage(staged)
  await custody.activate(staged.attemptId, staged.expectedActive)
  await expect(
    custody.stage({ ...input(), attemptId: 'other-attempt' }),
  ).rejects.toMatchObject({ code: 'conflict' })
  expect((await custody.snapshot()).active?.fingerprint).toBe(
    MonadIdentity.fromSeed({ mnemonic: phrase }).compressedPubKey.toString(
      'hex',
    ),
  )
})
