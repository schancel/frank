/** @jest-environment jsdom */

import { createPinia, setActivePinia } from 'pinia'

jest.mock('../adapters/level-utxo-store', () => ({
  store: Promise.resolve({}),
}))

import {
  rehydrateWallet,
  restoreWallet,
  saveWallet,
  useWalletStore,
} from './wallet'

const SEED = 'test test test test test test test test test test test junk'
const OTHER =
  'legal winner thank year wave sausage worth useful legal winner thank yellow'

describe('wallet seed confirmation marker', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('starts unconfirmed', () => {
    expect(useWalletStore().seedConfirmedAt).toBeNull()
  })

  it('stores the seed and the marker together', () => {
    const w = useWalletStore()
    w.setSeedPhrase(SEED, 42)
    expect(w.seedPhrase).toBe(SEED)
    expect(w.seedConfirmedAt).toBe(42)
  })

  it('a seed written without a marker is unconfirmed', () => {
    const w = useWalletStore()
    w.setSeedPhrase(SEED)
    expect(w.seedConfirmedAt).toBeNull()
  })

  it('re-storing the same phrase keeps its marker; a different phrase drops it', () => {
    const w = useWalletStore()
    w.setSeedPhrase(SEED, 42)
    w.setSeedPhrase(SEED)
    expect(w.seedConfirmedAt).toBe(42)
    w.setSeedPhrase(OTHER)
    expect(w.seedConfirmedAt).toBeNull()
  })

  it('a marker never comes back for a phrase it was not confirmed against', () => {
    const w = useWalletStore()
    w.setSeedPhrase(SEED, 42)
    w.setSeedPhrase(OTHER)
    w.setSeedPhrase(SEED)
    expect(w.seedConfirmedAt).toBeNull()
  })

  it('an explicit marker for a new phrase replaces the old one', () => {
    const w = useWalletStore()
    w.setSeedPhrase(SEED, 42)
    w.setSeedPhrase(OTHER, 99)
    expect(w.seedConfirmedAt).toBe(99)
  })

  it('persists the marker with the seed and restores it', async () => {
    const data: Record<string, string> = {}
    const storage = {
      put: async (k: string, v: string) => {
        data[k] = v
      },
      get: async (k: string) => data[k],
    }
    const w = useWalletStore()
    w.setSeedPhrase(SEED, 42)
    await saveWallet(storage, w.$state)

    const restored = await restoreWallet(storage)
    expect(restored.seedPhrase).toBe(SEED)
    expect(restored.seedConfirmedAt).toBe(42)
  })

  it('existing users: data stored before the marker existed keeps its seed, marker is null', async () => {
    const restored = await rehydrateWallet({
      xPrivKey: null,
      seedPhrase: SEED,
      utxos: {},
      balance: 0,
      feePerByte: 2,
    })
    expect(restored.seedPhrase).toBe(SEED)
    expect(restored.seedConfirmedAt).toBeNull()
  })

  it('restores a stored marker', async () => {
    const restored = await rehydrateWallet({
      xPrivKey: null,
      seedPhrase: SEED,
      seedConfirmedAt: 7,
      utxos: {},
      balance: 0,
      feePerByte: 2,
    })
    expect(restored.seedConfirmedAt).toBe(7)
  })
})
