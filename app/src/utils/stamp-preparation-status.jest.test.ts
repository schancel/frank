import enUS from 'src/i18n/en-us'
import frFR from 'src/i18n/fr-fr'
import { stampPreparationStatus } from './stamp-preparation-status'

const fee = { format: (raw: bigint) => `${raw} wei`, unit: 'MON' }

function translator(messages: typeof enUS) {
  return (key: string, params: Record<string, unknown> = {}) => {
    const text = key
      .split('.')
      .reduce<unknown>(
        (node, part) => (node as Record<string, unknown>)[part],
        messages,
      ) as string
    return text.replace(/\{(\w+)\}/g, (_m, name) => String(params[name]))
  }
}

describe('stampPreparationStatus', () => {
  it.each([
    ['en-us', enUS],
    ['fr-fr', frFR],
  ])(
    'renders every stage with no unfilled placeholder in %s',
    (_name, msgs) => {
      const t = translator(msgs as typeof enUS)
      const stages = [
        { stage: 'checking' as const },
        {
          stage: 'funding' as const,
          completed: 0,
          total: 1,
          feeReserveWei: 7n,
        },
        { stage: 'ready' as const, fundingTxHashes: [] },
        { stage: 'waiting-for-payment' as const },
        { stage: 'waiting-for-payment' as const, blocksRemaining: 2 },
        { stage: 'waiting-for-chain' as const },
      ]
      const texts = stages.map(p => stampPreparationStatus(p, t, fee))
      expect(new Set(texts).size).toBe(6)
      expect(texts[4]).toContain('2')
      expect(texts[5]).toBe(t('chat.chainUnreachable'))
      // Waiting for the previous payment has its own words, not the "checking" ones.
      expect(texts[3]).toBe(t('chat.stampPreparationWaiting'))
      for (const text of texts) expect(text).not.toMatch(/[{}]|undefined/)
      expect(texts[1]).toContain('0/1')
      expect(texts[1]).toContain('7 wei MON')
    },
  )
})
