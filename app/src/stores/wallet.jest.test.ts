import { createApp, nextTick } from 'vue'
import { createPinia } from 'pinia'
import { createStoragePlugin } from '../boot/pinia'
import { useWalletStore } from './wallet'
import { legacyStatus, assertLegacyUnchanged } from '../accounts/legacy'
jest.mock('quasar/wrappers', () => ({ boot: (value: unknown) => value }))
const PHRASE = 'test test test test test test test test test test test junk'
test('real persistence plugin quarantines the exact legacy blob without hydrating or rewriting it', async () => {
  let raw = JSON.stringify({
    seedPhrase: PHRASE,
    seedConfirmedAt: 123,
    xPrivKey: { sentinel: 'OLD-PRIVATE-SENTINEL' },
  })
  const original = raw
  const storage = {
    get: jest.fn(async () => raw),
    put: jest.fn(async () => undefined),
  }
  const pinia = createPinia()
  pinia.use(
    createStoragePlugin(
      storage as never,
      Promise.resolve({ networkName: 'test', version: 4 }),
    ),
  )
  createApp({}).use(pinia)
  const wallet = useWalletStore(pinia)
  await wallet.restored
  wallet.balance = 99
  await nextTick()
  await wallet.flushPersistence()
  expect(storage.put).not.toHaveBeenCalled()
  expect(raw).toBe(original)
  expect(JSON.stringify(pinia.state.value)).not.toContain(PHRASE)
  expect(JSON.stringify(pinia.state.value)).not.toContain(
    'OLD-PRIVATE-SENTINEL',
  )
  expect(legacyStatus.present).toBe(true)
  const revision = legacyStatus.revision
  await assertLegacyUnchanged(revision)
  raw = JSON.stringify({ seedPhrase: PHRASE, changed: true })
  await expect(assertLegacyUnchanged(revision)).rejects.toThrow('changed')
})
test('legacy storage errors remain unavailable instead of becoming fresh', async () => {
  const { inspectLegacyWallet } = await import('../accounts/legacy')
  await inspectLegacyWallet({
    get: async () => {
      throw new Error('storage unavailable')
    },
  })
  expect(legacyStatus.unavailable).toBe(true)
  expect(legacyStatus.present).toBe(true)
})
