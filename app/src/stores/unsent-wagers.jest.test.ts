/** @jest-environment jsdom */
import { createPinia, setActivePinia } from 'pinia'
import { createApp } from 'vue'
import type { LevelDB } from 'level'

import { createStoragePlugin } from '../boot/pinia'
import { restoreUnsentWagers, useUnsentWagersStore } from './unsent-wagers'

const wager = (hash: string, dealer = '0xDealer', wallet = '0xMe') => ({
  gameId: `g-${hash}`,
  wagerTxHash: hash,
  dealerAddress: dealer,
  walletAddress: wallet,
  amountWei: '100000000000000000',
  createdAt: 1,
  state: 'signed' as const,
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
  it('preserves double intent and original stake through every durable phase', async () => {
    const data: Record<string, string> = {}
    const store = boot(data)
    await store.restored
    const double = {
      ...wager('0xdouble'),
      kind: 'double' as const,
      originalWagerTxHash: '0xoriginal',
      originalAmountWei: '100000000000000000',
    }
    store.add(double)
    for (const state of ['signed', 'paid', 'sent'] as const) {
      store.setState('0xdouble', state, 99, 2)
      await store.flushPersistence()
      const reloaded = boot(data)
      await reloaded.restored
      expect(reloaded.wagers).toEqual([
        { ...double, state, sentAt: 99, seenMessages: 2 },
      ])
      expect(reloaded.inFlight).toEqual([])
    }
  })

  it.each([{ kind: 'unknown' }, { kind: 'double' }])(
    'refuses an unreadable intent without overwriting it: %j',
    intent => {
      const raw = JSON.stringify({
        wagers: [{ ...wager('0xdouble'), ...intent }],
      })
      const data = { unsentWagers: raw }
      return (async () => {
        const store = boot(data)
        await store.restored
        expect(store.loadError).toBeTruthy()
        expect(() => store.add(wager('0xnew'))).toThrow()
        expect(data.unsentWagers).toBe(raw)
      })()
    },
  )
  it('a recorded unsent wager survives a reload, but "in flight" does not', async () => {
    const data: Record<string, string> = {}
    const first = boot(data)
    await first.restored
    first.add(wager('0xh1'))
    first.setInFlight('0xh1', true)
    await first.flushPersistence()
    expect(first.inFlight).toEqual(['0xh1'])

    const reloaded = boot(data) // same storage, fresh app
    await reloaded.restored
    expect(reloaded.wagers).toEqual([wager('0xh1')])
    expect(reloaded.inFlight).toEqual([])
    expect(reloaded.forDealer('0xdealer', '0xme')).toEqual([wager('0xh1')])
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

  it('scopes records by dealer AND paying wallet (another account never sees or is blocked by them)', async () => {
    const store = boot({})
    await store.restored
    store.add(wager('0xh1', '0xA', '0xMe'))
    store.add(wager('0xh2', '0xB', '0xMe'))
    store.add(wager('0xh3', '0xA', '0xSomeoneElse'))
    expect(store.forDealer('0xA', '0xMe').map(w => w.wagerTxHash)).toEqual([
      '0xh1',
    ])
    expect(store.forDealer('0xA', '0xNew')).toEqual([])
  })

  it('a state transition and sentAt are persisted', async () => {
    const data: Record<string, string> = {}
    const store = boot(data)
    await store.restored
    store.add(wager('0xh1'))
    store.setState('0xh1', 'sent', 99, 4)
    await store.flushPersistence()
    expect(JSON.parse(data.unsentWagers).wagers[0]).toMatchObject({
      state: 'sent',
      sentAt: 99,
      seenMessages: 4,
    })
  })

  it('F4: an unreadable stored value is never overwritten, and adding a record throws (aborting a new wager)', async () => {
    const data: Record<string, string> = { unsentWagers: '{not json' }
    const store = boot(data)
    await store.restored
    expect(store.loadError).toMatch(/unreadable/)
    expect(() => store.add(wager('0xh1'))).toThrow(/unreadable/)
    store.setInFlight('0xzz', true) // any mutation triggers a save attempt
    await store.flushPersistence()
    expect(data.unsentWagers).toBe('{not json')
  })

  it('F4: an I/O error (not "not found") is surfaced, a missing key is just empty', async () => {
    const io = {
      get: async () => {
        throw new Error('EIO disk')
      },
    } as unknown as LevelDB
    expect((await restoreUnsentWagers(io)).loadError).toMatch(/EIO disk/)
    const missing = {
      get: async () => {
        throw Object.assign(new Error('NotFound: key'), { notFound: true })
      },
    } as unknown as LevelDB
    expect(await restoreUnsentWagers(missing)).toEqual({})
  })

  it('a pre-state record (older format) restores as paid with no wallet', async () => {
    const old = {
      get: async () =>
        JSON.stringify({
          wagers: [
            {
              gameId: 'g',
              wagerTxHash: '0xh',
              dealerAddress: '0xD',
              amountWei: '1',
              createdAt: 1,
            },
          ],
        }),
    } as unknown as LevelDB
    expect((await restoreUnsentWagers(old)).wagers).toEqual([
      expect.objectContaining({ state: 'paid', walletAddress: '' }),
    ])
  })

  it('tolerates a corrupt or missing blob', async () => {
    const bad = { get: async () => 'not json' } as unknown as LevelDB
    expect((await restoreUnsentWagers(bad)).loadError).toBeTruthy()
    const junk = {
      get: async () => JSON.stringify({ wagers: [{ nope: 1 }, wager('0xok')] }),
    } as unknown as LevelDB
    expect((await restoreUnsentWagers(junk)).wagers).toEqual([
      expect.objectContaining({ wagerTxHash: '0xok' }),
    ])
  })
})
