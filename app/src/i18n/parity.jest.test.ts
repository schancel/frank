import enUS from './en-us'
import frFR from './fr-fr'

function flatten(node: unknown, prefix = ''): string[] {
  if (typeof node === 'string') return [prefix]
  if (node && typeof node === 'object') {
    return Object.entries(node).flatMap(([k, v]) =>
      flatten(v, prefix ? `${prefix}.${k}` : k),
    )
  }
  return []
}

describe('leftDrawer i18n parity', () => {
  const en = flatten((enUS as Record<string, unknown>).leftDrawer).sort()
  const fr = flatten((frFR as Record<string, unknown>).leftDrawer).sort()

  it('has the same keys in en-us and fr-fr', () => {
    expect(fr).toEqual(en)
  })

  it('defines the rail tablist name in both locales', () => {
    for (const locale of [enUS, frFR] as Array<Record<string, any>>) {
      expect(typeof locale.leftDrawer.railLabel).toBe('string')
      expect(locale.leftDrawer.railLabel.length).toBeGreaterThan(0)
    }
  })
})
