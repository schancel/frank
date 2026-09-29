import { applyLocale } from './apply-locale'

describe('applyLocale', () => {
  it('sets the i18n locale and loads the matching real Quasar lang pack for every known locale', async () => {
    // Real module resolution, not mocked -- ticket #156 was partly a naming mismatch bug
    // (`quasarLangPackByLocale`), so this test's whole point is catching a mapping that points at
    // a Quasar lang-pack module that doesn't actually exist.
    for (const [locale, expectedIsoName] of [
      ['en-us', 'en-US'],
      ['fr-fr', 'fr'],
    ] as const) {
      let setLocaleCalledWith: string | undefined
      const setLang = jest.fn()

      await applyLocale({
        $q: { lang: { set: setLang } },
        setI18nLocale: value => {
          setLocaleCalledWith = value
        },
        locale,
      })

      expect(setLocaleCalledWith).toBe(locale)
      expect(setLang).toHaveBeenCalledTimes(1)
      expect(setLang.mock.calls[0][0]).toMatchObject({
        isoName: expectedIsoName,
      })
    }
  })

  it('falls back to the default locale pack for an unrecognized locale', async () => {
    const setLang = jest.fn()

    await applyLocale({
      $q: { lang: { set: setLang } },
      setI18nLocale: () => undefined,
      locale: 'xx-xx',
    })

    expect(setLang).toHaveBeenCalledTimes(1)
    expect(setLang.mock.calls[0][0]).toMatchObject({ isoName: 'en-US' })
  })
})
