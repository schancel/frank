import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import level from 'level'

import {
  BlackjackBotStateStore,
  BlackjackGameRecord,
  normalizeWagerTxHash,
} from './blackjack-bot-state'

const PLAYER = '0x1111111111111111111111111111111111111111'
const WAGER_HASH = `0x${'AB'.repeat(32)}`

function gameRecord(
  wagerTxHash = normalizeWagerTxHash(WAGER_HASH),
): BlackjackGameRecord {
  return {
    authority: 'verified-wager-sender',
    serverSeed: 'committed-seed',
    serverSeedHash: 'committed-hash',
    wagerTxHash,
    wagerWei: 100n,
    playerAddress: PLAYER,
    dealtCount: 4,
    revealed: false,
  }
}

describe('BlackjackBotStateStore wager authority', () => {
  let directory: string
  let stores: BlackjackBotStateStore[]

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'blackjack-state-'))
    stores = []
  })

  afterEach(async () => {
    await Promise.all(stores.map((store) => store.Close()))
    rmSync(directory, { recursive: true, force: true })
  })

  async function openStore() {
    const store = new BlackjackBotStateStore(directory)
    await store.Open()
    stores.push(store)
    return store
  }

  async function seedStore(store: BlackjackBotStateStore) {
    await store.setPendingCommitment('committed-seed', 'committed-hash')
  }

  function claim(store: BlackjackBotStateStore, gameId: string) {
    return store.claimWagerAndCreateGame({
      gameId,
      wagerTxHash: WAGER_HASH,
      record: gameRecord(),
      expectedCommitment: {
        serverSeed: 'committed-seed',
        serverSeedHash: 'committed-hash',
      },
      nextCommitment: {
        serverSeed: 'next-seed',
        serverSeedHash: 'next-hash',
      },
    })
  }

  it('allows one game globally for a wager hash and preserves the seed ordering', async () => {
    const store = await openStore()
    await seedStore(store)

    await expect(claim(store, 'game-a')).resolves.toEqual({ ok: true })
    await expect(claim(store, 'game-b')).resolves.toEqual({
      ok: false,
      reason: 'wager_claimed',
    })

    expect(store.getGame('game-a')).toEqual(gameRecord())
    expect(store.getGame('game-b')).toBeUndefined()
    expect(store.getPendingCommitment()).toEqual({
      serverSeed: 'next-seed',
      serverSeedHash: 'next-hash',
    })
  })

  it('serializes simultaneous claims for the same wager hash', async () => {
    const store = await openStore()
    await seedStore(store)

    const results = await Promise.all([
      claim(store, 'game-a'),
      claim(store, 'game-b'),
    ])

    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, reason: 'wager_claimed' },
    ])
    expect(
      [store.getGame('game-a'), store.getGame('game-b')].filter(Boolean),
    ).toHaveLength(1)
  })

  it('rejects a replay after restart without rotating the pending commitment', async () => {
    const first = await openStore()
    await seedStore(first)
    await expect(claim(first, 'game-a')).resolves.toEqual({ ok: true })
    await first.Close()
    stores = []

    const restarted = await openStore()
    const pendingBefore = restarted.getPendingCommitment()
    await expect(claim(restarted, 'game-b')).resolves.toEqual({
      ok: false,
      reason: 'wager_claimed',
    })
    expect(restarted.getGame('game-b')).toBeUndefined()
    expect(restarted.getPendingCommitment()).toEqual(pendingBefore)
  })

  it('does not expose a partial claim or seed rotation when the atomic batch fails', async () => {
    const store = await openStore()
    await seedStore(store)
    const pendingBefore = store.getPendingCommitment()
    const db = (
      store as unknown as {
        db: { batch: (...args: unknown[]) => Promise<void> }
      }
    ).db
    jest.spyOn(db, 'batch').mockRejectedValueOnce(new Error('simulated crash'))

    await expect(claim(store, 'game-a')).rejects.toThrow('simulated crash')
    expect(store.getGame('game-a')).toBeUndefined()
    expect(store.getPendingCommitment()).toEqual(pendingBefore)
    await expect(store.flush()).rejects.toThrow('simulated crash')

    await expect(claim(store, 'game-a')).resolves.toEqual({ ok: true })
  })

  it('tombstones legacy games whose wager sender authority was never persisted', async () => {
    const raw = level(join(directory, 'blackjack-bot-state'))
    await raw.put(
      'game:legacy-game',
      JSON.stringify({
        ...gameRecord(),
        authority: undefined,
        wagerWei: '100',
      }),
    )
    await raw.close()

    const store = await openStore()
    expect(store.getGame('legacy-game')).toMatchObject({
      authority: 'legacy-unverified',
      revealed: true,
    })
    await expect(claim(store, 'new-game')).resolves.toEqual({
      ok: false,
      reason: 'wager_claimed',
    })
  })

  it('rejects malformed transaction hashes before they can become durable keys', () => {
    expect(() => normalizeWagerTxHash('0x1234')).toThrow(
      'wager transaction hash must be 32 bytes',
    )
  })
})
