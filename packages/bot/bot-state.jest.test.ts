import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { QwenBotStateStore } from './qwen-bot-state'
import {
  hasRaffleEntrant,
  RaffleBotStateStore,
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

  it('keeps one Qwen conversation and greeted identity across casing and restart', async () => {
    const first = new QwenBotStateStore(location)
    await first.Open()
    first.addGreeted(CHECKSUM_ADDRESS)
    first.setConversation(CHECKSUM_ADDRESS, [
      { role: 'user', content: 'first turn' },
    ])
    await first.Close()

    const second = new QwenBotStateStore(location)
    await second.Open()
    expect(second.hasGreeted(LOWER_ADDRESS)).toBe(true)
    expect(second.getConversation(LOWER_ADDRESS)).toEqual([
      { role: 'user', content: 'first turn' },
    ])
    second.setConversation(LOWER_ADDRESS, [
      { role: 'user', content: 'first turn' },
      { role: 'assistant', content: 'second turn' },
    ])
    // Non-address keys are not folded together accidentally.
    second.setConversation('LocalUser', [{ role: 'user', content: 'upper' }])
    second.setConversation('localuser', [{ role: 'user', content: 'lower' }])
    expect(second.getConversation('LocalUser')).not.toEqual(
      second.getConversation('localuser'),
    )
    await second.Close()

    const third = new QwenBotStateStore(location)
    await third.Open()
    expect(third.getConversation(CHECKSUM_ADDRESS)).toHaveLength(2)
    await third.Close()
  })

  it('persists raffle entrants canonically and detects a casing-only duplicate', async () => {
    const round: RaffleRoundRecord = {
      raffleId: 'round-1',
      entryPriceWei: '100',
      maxEntries: 2,
      serverSeedHash: 'seed-hash',
      entrants: [{ address: CHECKSUM_ADDRESS, txHash: 'tx-1' }],
    }
    const first = new RaffleBotStateStore(location)
    await first.Open()
    first.setCurrentRound(round)
    await first.Close()

    const second = new RaffleBotStateStore(location)
    await second.Open()
    const restored = second.getCurrentRound() as RaffleRoundRecord
    expect(restored.entrants).toEqual([
      { address: LOWER_ADDRESS, txHash: 'tx-1' },
    ])
    expect(hasRaffleEntrant(restored, LOWER_ADDRESS)).toBe(true)
    expect(hasRaffleEntrant(restored, CHECKSUM_ADDRESS)).toBe(true)
    expect(restored.entrants).toHaveLength(1)
    await second.Close()
  })
})
