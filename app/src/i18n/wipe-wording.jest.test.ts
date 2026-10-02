import enUS from './en-us'
import frFR from './fr-fr'

// #367: the French locale used to label the destructive relay wipe "Consolidation du
// portefeuille", hiding deletion behind a harmless-sounding word, and the English copy claimed
// funds were consolidated when nothing consolidates (#590). Neither locale may describe this
// flow as consolidation again.
function lookup(locale: unknown, key: string): string {
  const value = key
    .split('.')
    .reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], locale)
  return typeof value === 'string' ? value : ''
}

describe('relay-wipe wording (#367)', () => {
  it.each([enUS, frFR])(
    'labels and warns about the wipe without any consolidation claim',
    locale => {
      for (const key of [
        'SettingPanel.wipeAndSave',
        'wipeWallet.warning',
        'wipeWallet.warningMsg',
        'wipeWallet.wipe',
      ]) {
        expect(lookup(locale, key).toLowerCase()).not.toContain('consolidat')
      }
    },
  )
})
