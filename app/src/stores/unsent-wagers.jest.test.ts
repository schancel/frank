/** @jest-environment jsdom */
import { createPinia, setActivePinia } from 'pinia'
import { createApp } from 'vue'
import type { LevelDB } from 'level'

import { createStoragePlugin } from '../boot/pinia'
import { restoreUnsentWagers, useUnsentWagersStore } from './unsent-wagers'

const wager = (hash: string, dealer = '0xDealer') => ({
  gameId: `g-${hash}`,
  wagerTxHash: hash,
  dealerAddress: dealer,
  amountWei: '100000000000000000',
  createdAt: 1,
})

function boot(data: Record<string, string>) {
  const storage = {
    put: async (k: string, v: string) => void (data[k] = v),
    get: async (k: string) => {
      if (!(k in data)) throw new Error('not found')
      return data[k]
    },
  } as unknown as LevelDB
  const pinia = createPinia()
  pinia.use(
    createStoragePlugin(
      storage,
      Promise.resolve({ networkName: 'n', version: 1 }),
    ),
  )
  createApp({}).use(pinia)
  setActivePinia(pinia)
  return useUnsentWagersStore()
}

describe('unsent wagers store (#310)', () => {
  it('a recorded unsent wager survives a reload, but "in flight" does not', async () => {
    const data: Record<string, string> = {}
    const first = boot(data)
    await first.restored
    first.add(wager('0xh1'))
    first.setInFlight('0xh1', true)
    await first.flushPersistence()
    expect(first.stranded('0xDealer')).toHaveLength(0) // being sent right now

    const reloaded = boot(data) // same storage, fresh app
    await reloaded.restored
    expect(reloaded.wagers).toEqual([wager('0xh1')])
    expect(reloaded.inFlight).toEqual([])
    expect(reloaded.stranded('0xdealer')).toEqual([wager('0xh1')]) // needs attention
  })

  it('is idempotent per transaction hash and removal clears the record', async () => {
    const store = boot({})
    await store.restored
    store.add(wager('0xh1'))
    store.add(wager('0xh1'))
    expect(store.wagers).toHaveLength(1)
    store.remove('0xh1')
    expect(store.wagers).toEqual([])
  })

  it('scopes records by dealer address', async () => {
    const store = boot({})
    await store.restored
    store.add(wager('0xh1', '0xA'))
    store.add(wager('0xh2', '0xB'))
    expect(store.forDealer('0xA').map(w => w.wagerTxHash)).toEqual(['0xh1'])
  })

  it('tolerates a corrupt or missing blob', async () => {
    const bad = { get: async () => 'not json' } as unknown as LevelDB
    expect(await restoreUnsentWagers(bad)).toEqual({})
    const junk = {
      get: async () => JSON.stringify({ wagers: [{ nope: 1 }, wager('0xok')] }),
    } as unknown as LevelDB
    expect((await restoreUnsentWagers(junk)).wagers).toEqual([wager('0xok')])
  })
})
