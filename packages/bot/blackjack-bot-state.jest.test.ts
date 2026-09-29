import { createHash } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import level from 'level'

import {
  BlackjackBotStateStore,
  BlackjackGameRecord,
  MAX_BLACKJACK_GAME_ID_BYTES,
  normalizeWagerTxHash,
} from './blackjack-bot-state'

const PLAYER = '0x1111111111111111111111111111111111111111'
const WAGER_HASH = `0x${'AB'.repeat(32)}`
const OTHER_WAGER_HASH = `0x${'CD'.repeat(32)}`

function hashSeed(seed: string): string {
  return createHash('sha256').update(seed).digest('hex')
}

function gameRecord(
  wagerTxHash = normalizeWagerTxHash(WAGER_HASH),
): BlackjackGameRecord {
  return {
    authority: 'verified-wager-sender',
    serverSeed: 'committed-seed',
    serverSeedHash: hashSeed('committed-seed'),
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
    await store.setPendingCommitment(
      'committed-seed',
      hashSeed('committed-seed'),
    )
  }

  function claim(
    store: BlackjackBotStateStore,
    gameId: string,
    wagerTxHash = WAGER_HASH,
  ) {
    return store.claimWagerAndCreateGame({
      gameId,
      wagerTxHash,
      record: gameRecord(normalizeWagerTxHash(wagerTxHash)),
      expectedCommitment: {
        serverSeed: 'committed-seed',
        serverSeedHash: hashSeed('committed-seed'),
      },
      nextCommitment: {
        serverSeed: 'next-seed',
        serverSeedHash: hashSeed('next-seed'),
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
      serverSeedHash: hashSeed('next-seed'),
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

  it('allows only one of two different wagers sharing a stale commitment', async () => {
    const store = await openStore()
    await seedStore(store)

    const results = await Promise.all([
      claim(store, 'game-a', WAGER_HASH),
      claim(store, 'game-b', OTHER_WAGER_HASH),
    ])

    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, reason: 'commitment_changed' },
    ])
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

    await store.Close()
    stores = []
    const restarted = await openStore()
    expect(restarted.getGame('legacy-game')).toMatchObject({
      authority: 'legacy-unverified',
      revealed: true,
    })
  })

  it.each([
    ['object', {}],
    ['empty', ''],
    ['oversized', 'x'.repeat(MAX_BLACKJACK_GAME_ID_BYTES + 1)],
    ['lone high surrogate', '\ud800'],
    ['lone low surrogate', '\udc00'],
  ])(
    'rejects a %s gameId without consuming the wager or commitment',
    async (_label, invalidGameId) => {
      const store = await openStore()
      await seedStore(store)
      const pendingBefore = store.getPendingCommitment()

      await expect(
        claim(store, invalidGameId as string),
      ).rejects.toThrow('gameId')
      expect(store.getPendingCommitment()).toEqual(pendingBefore)
      await store.Close()
      stores = []

      const restarted = await openStore()
      await expect(claim(restarted, 'valid-game')).resolves.toEqual({
        ok: true,
      })
    },
  )

  it('keeps replacement-character and well-formed Unicode gameIds lossless across restart', async () => {
    const store = await openStore()
    await seedStore(store)
    const gameId = '牌局-😀-\ufffd-é'
    expect(Buffer.from('\ud800')).toEqual(Buffer.from('\ufffd'))

    await expect(claim(store, gameId)).resolves.toEqual({ ok: true })
    expect(store.getGame(gameId)).toBeDefined()
    await expect(
      claim(store, '\ud800', OTHER_WAGER_HASH),
    ).rejects.toThrow('well-formed Unicode')
    await store.Close()
    stores = []

    const restarted = await openStore()
    expect(restarted.getGame(gameId)).toBeDefined()
    expect(() => restarted.getGame('\ud800')).toThrow('well-formed Unicode')
  })

  it('quarantines an invalid persisted gameId without blocking valid state on later opens', async () => {
    const raw = level(join(directory, 'blackjack-bot-state'))
    await raw.batch([
      {
        type: 'put',
        key: '__pending_server_seed__',
        value: JSON.stringify('committed-seed'),
      },
      {
        type: 'put',
        key: '__pending_server_seed_hash__',
        value: JSON.stringify(hashSeed('committed-seed')),
      },
      {
        type: 'put',
        key: 'game:valid-game',
        value: JSON.stringify({
          ...gameRecord(normalizeWagerTxHash(OTHER_WAGER_HASH)),
          wagerWei: '100',
        }),
      },
      {
        type: 'put',
        key: 'game:',
        value: JSON.stringify({ ...gameRecord(), wagerWei: '100' }),
      },
    ])
    await raw.close()

    const store = await openStore()
    expect(store.getGame('valid-game')).toBeDefined()
    await expect(claim(store, 'replacement-game')).resolves.toEqual({
      ok: false,
      reason: 'wager_claimed',
    })
    await store.Close()
    stores = []

    const restarted = await openStore()
    expect(restarted.getGame('valid-game')).toBeDefined()
    await expect(claim(restarted, 'still-consumed')).resolves.toEqual({
      ok: false,
      reason: 'wager_claimed',
    })
  })

  it.each([
    [
      'game row without a canonical wager hash',
      'game:broken-game',
      '{"wagerTxHash":"not-a-hash"',
    ],
    [
      'claim row without a canonical wager hash',
      'wager-claim:not-a-hash',
      '{"gameId":"broken-game"}',
    ],
  ])(
    'fails closed and preserves a malformed %s byte-for-byte across reopen',
    async (_label, key, rawValue) => {
      const raw = level(join(directory, 'blackjack-bot-state'))
      await raw.put(key, rawValue)
      await raw.close()

      const first = new BlackjackBotStateStore(directory)
      await expect(first.Open()).rejects.toThrow('cannot safely quarantine')

      const evidence = level(join(directory, 'blackjack-bot-state'))
      const recovered = await evidence.get(key)
      expect(Buffer.from(recovered)).toEqual(Buffer.from(rawValue))
      await evidence.close()

      const second = new BlackjackBotStateStore(directory)
      await expect(second.Open()).rejects.toThrow('cannot safely quarantine')
      const recoveredAgain = level(join(directory, 'blackjack-bot-state'))
      expect(Buffer.from(await recoveredAgain.get(key))).toEqual(
        Buffer.from(rawValue),
      )
      await recoveredAgain.close()
    },
  )

  it('quarantines malformed claim metadata when its canonical wager hash remains durable', async () => {
    const wagerTxHash = normalizeWagerTxHash(WAGER_HASH)
    const claimKey = `wager-claim:${wagerTxHash}`
    const quarantineKey = `quarantined-wager-claim:${createHash('sha256')
      .update(claimKey)
      .digest('hex')}`
    const raw = level(join(directory, 'blackjack-bot-state'))
    await raw.batch([
      {
        type: 'put',
        key: '__pending_server_seed__',
        value: JSON.stringify('committed-seed'),
      },
      {
        type: 'put',
        key: '__pending_server_seed_hash__',
        value: JSON.stringify(hashSeed('committed-seed')),
      },
      {
        type: 'put',
        key: claimKey,
        value: 'not-json',
      },
    ])
    await raw.close()

    const store = await openStore()
    await expect(claim(store, 'replacement-game')).resolves.toEqual({
      ok: false,
      reason: 'wager_claimed',
    })
    await store.Close()
    stores = []

    const evidence = level(join(directory, 'blackjack-bot-state'))
    expect(JSON.parse(await evidence.get(claimKey))).toEqual({
      quarantined: true,
    })
    expect(await evidence.get(quarantineKey)).toBe('not-json')
    await evidence.close()
    const restarted = await openStore()
    await expect(claim(restarted, 'still-consumed')).resolves.toEqual({
      ok: false,
      reason: 'wager_claimed',
    })
  })

  it('fails closed on a torn pending commitment and can reopen after repair', async () => {
    const raw = level(join(directory, 'blackjack-bot-state'))
    await raw.batch([
      {
        type: 'put',
        key: '__pending_server_seed__',
        value: JSON.stringify('seed-b'),
      },
      {
        type: 'put',
        key: '__pending_server_seed_hash__',
        value: JSON.stringify(hashSeed('seed-a')),
      },
    ])
    await raw.close()

    const poisoned = new BlackjackBotStateStore(directory)
    await expect(poisoned.Open()).rejects.toThrow(
      'pending server seed commitment hash mismatch',
    )
    await expect(claim(poisoned, 'must-not-open')).rejects.toThrow(
      'No db opened',
    )

    const repair = level(join(directory, 'blackjack-bot-state'))
    await repair.put(
      '__pending_server_seed_hash__',
      JSON.stringify(hashSeed('seed-b')),
    )
    await repair.close()

    const restored = await openStore()
    expect(restored.getPendingCommitment()).toEqual({
      serverSeed: 'seed-b',
      serverSeedHash: hashSeed('seed-b'),
    })
    await expect(
      restored.claimWagerAndCreateGame({
        gameId: 'restored-game',
        wagerTxHash: WAGER_HASH,
        record: {
          ...gameRecord(),
          serverSeed: 'seed-b',
          serverSeedHash: hashSeed('seed-b'),
        },
        expectedCommitment: {
          serverSeed: 'seed-b',
          serverSeedHash: hashSeed('seed-b'),
        },
        nextCommitment: {
          serverSeed: 'seed-c',
          serverSeedHash: hashSeed('seed-c'),
        },
      }),
    ).resolves.toEqual({ ok: true })
  })

  it('rejects invalid commitments at mutation boundaries without state changes', async () => {
    const store = await openStore()
    await expect(
      store.setPendingCommitment('committed-seed', hashSeed('other-seed')),
    ).rejects.toThrow('pending server seed commitment hash mismatch')
    expect(store.getPendingCommitment()).toBeUndefined()

    await seedStore(store)
    const pendingBefore = store.getPendingCommitment()
    await expect(
      store.claimWagerAndCreateGame({
        gameId: 'game-a',
        wagerTxHash: WAGER_HASH,
        record: gameRecord(),
        expectedCommitment: pendingBefore!,
        nextCommitment: {
          serverSeed: 'next-seed',
          serverSeedHash: hashSeed('not-next-seed'),
        },
      }),
    ).rejects.toThrow('next server seed commitment hash mismatch')
    expect(store.getGame('game-a')).toBeUndefined()
    expect(store.getPendingCommitment()).toEqual(pendingBefore)
  })

  it('rejects malformed transaction hashes before they can become durable keys', () => {
    expect(() => normalizeWagerTxHash('0x1234')).toThrow(
      'wager transaction hash must be 32 bytes',
    )
  })
})
