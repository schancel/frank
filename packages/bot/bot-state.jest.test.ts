import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import level from 'level'

import {
  hasRaffleEntrant,
  RaffleBotStateStore,
  RaffleEntrantIdentityCollisionError,
  RaffleRoundRecord,
} from './raffle-bot-state'

const CHECKSUM_ADDRESS = '0x52908400098527886E0F7030069857D2E4169EE7'
const LOWER_ADDRESS = CHECKSUM_ADDRESS.toLowerCase()

describe('bot durable EVM identity keys', () => {
  let location: string

  beforeEach(() => {
    location = mkdtempSync(join(tmpdir(), 'frank-bot-state-'))
  })

  afterEach(() => {
    rmSync(location, { recursive: true, force: true })
  })

  it('migrates a raw legacy raffle round canonically and idempotently', async () => {
    const round: RaffleRoundRecord = {
      raffleId: 'round-1',
      entryPriceWei: '100',
      maxEntries: 2,
      serverSeedHash: 'seed-hash',
      entrants: [{ address: CHECKSUM_ADDRESS, txHash: 'tx-1' }],
    }
    const dbLocation = join(location, 'raffle-bot-state')
    const raw = level(dbLocation)
    await raw.put('__current_round__', JSON.stringify(round))
    await raw.close()

    const first = new RaffleBotStateStore(location)
    await first.Open()
    const restored = first.getCurrentRound() as RaffleRoundRecord
    expect(restored.entrants).toEqual([
      { address: LOWER_ADDRESS, txHash: 'tx-1' },
    ])
    expect(hasRaffleEntrant(restored, LOWER_ADDRESS)).toBe(true)
    expect(hasRaffleEntrant(restored, CHECKSUM_ADDRESS)).toBe(true)
    expect(restored.entrants).toHaveLength(1)
    await first.Close()

    const migrated = level(dbLocation)
    const firstMigration = await migrated.get('__current_round__')
    expect(JSON.parse(firstMigration)).toEqual(restored)
    await migrated.close()

    const second = new RaffleBotStateStore(location)
    await second.Open()
    await second.Close()
    const reopened = level(dbLocation)
    expect(await reopened.get('__current_round__')).toBe(firstMigration)
    await reopened.close()
  })

  it('rejects a raw legacy round whose checksum spellings collapse to one entrant', async () => {
    const round: RaffleRoundRecord = {
      raffleId: 'round-collision',
      entryPriceWei: '100',
      maxEntries: 2,
      serverSeedHash: 'seed-hash',
      entrants: [
        { address: CHECKSUM_ADDRESS, txHash: 'paid-tx-1' },
        { address: LOWER_ADDRESS, txHash: 'paid-tx-2' },
      ],
    }
    const dbLocation = join(location, 'raffle-bot-state')
    const original = JSON.stringify(round)
    const raw = level(dbLocation)
    await raw.put('__current_round__', original)
    await raw.close()

    const state = new RaffleBotStateStore(location)
    await expect(state.Open()).rejects.toBeInstanceOf(
      RaffleEntrantIdentityCollisionError,
    )
    expect(state.getCurrentRound()).toBeUndefined()
    await state.Close()

    const unchanged = level(dbLocation)
    expect(await unchanged.get('__current_round__')).toBe(original)
    await unchanged.close()
  })
})
