import enUS from './en-us'
import frFR from './fr-fr'

/**
 * Ticket #369: the sign-up steps called the recovery phrase a "character's secret name" (import
 * box, its error, the red banner) while the confirm step said "recovery phrase". One name for it.
 */
function strings(node: unknown, path = ''): Array<[string, string]> {
  if (typeof node === 'string') return [[path, node]]
  if (node && typeof node === 'object') {
    return Object.entries(node).flatMap(([k, v]) =>
      strings(v, path ? `${path}.${k}` : k),
    )
  }
  return []
}

describe('recovery phrase wording', () => {
  it('en-us never calls it a secret name', () => {
    const offenders = strings(enUS).filter(([, v]) => /secret name/i.test(v))
    expect(offenders).toEqual([])
  })

  it.each([
    ['en-us', enUS, /recovery phrase/i],
    ['fr-fr', frFR, /phrase de récupération/i],
  ])(
    '%s: the import box, its error and the setup banner say recovery phrase',
    (_l, messages, word) => {
      const m = messages as unknown as {
        profile: Record<string, string>
        setup: Record<string, string>
      }
      expect(m.profile.seedEntry).toMatch(word)
      expect(m.profile.invalidSeed).toMatch(word)
      expect(m.profile.enterSeed).toMatch(word)
      expect(m.setup.seedWarning).toMatch(word)
    },
  )
})
