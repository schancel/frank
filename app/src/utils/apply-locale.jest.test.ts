import { applyLocale } from './apply-locale'

describe('applyLocale', () => {
  it('synchronously sets both locales with a real static Quasar pack for every known locale', () => {
    // Real statically imported modules, not mocked -- a computed bare-module import works in Jest
    // but is left unresolved by Vite in a real browser (#179).
    for (const [locale, expectedIsoName] of [
      ['en-us', 'en-US'],
      ['fr-fr', 'fr'],
    ] as const) {
      let setLocaleCalledWith: string | undefined
      const setLang = jest.fn()

      const result = applyLocale({
        $q: { lang: { set: setLang } },
        setI18nLocale: value => {
          setLocaleCalledWith = value
        },
        locale,
      })

      expect(setLocaleCalledWith).toBe(locale)
      expect(result).toBeUndefined()
      expect(setLang).toHaveBeenCalledTimes(1)
      expect(setLang.mock.calls[0][0]).toMatchObject({
        isoName: expectedIsoName,
      })
    }
  })

  it('falls back to the default locale pack for an unrecognized locale', () => {
    const setLang = jest.fn()

    const result = applyLocale({
      $q: { lang: { set: setLang } },
      setI18nLocale: () => undefined,
      locale: 'xx-xx',
    })

    expect(result).toBeUndefined()
    expect(setLang).toHaveBeenCalledTimes(1)
    expect(setLang.mock.calls[0][0]).toMatchObject({ isoName: 'en-US' })
  })

  it('safely handles setI18nLocale throwing (e.g. this.$i18n is undefined)', () => {
    const setLang = jest.fn()
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})

    expect(() => {
      applyLocale({
        $q: { lang: { set: setLang } },
        setI18nLocale: () => {
          throw new TypeError("undefined is not an object (evaluating 'this.$i18n.locale = value')")
        },
        locale: 'fr-fr',
      })
    }).not.toThrow()

    expect(setLang).toHaveBeenCalledTimes(1)
    expect(setLang.mock.calls[0][0]).toMatchObject({ isoName: 'fr' })
    warnSpy.mockRestore()
  })

  it('works when setI18nLocale is omitted', () => {
    const setLang = jest.fn()

    expect(() => {
      applyLocale({
        $q: { lang: { set: setLang } },
        locale: 'en-us',
      })
    }).not.toThrow()

    expect(setLang).toHaveBeenCalledTimes(1)
    expect(setLang.mock.calls[0][0]).toMatchObject({ isoName: 'en-US' })
  })
})

