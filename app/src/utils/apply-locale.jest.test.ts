/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": ["node", "node-addons"]}
 */

import { applyLocale } from './apply-locale'
import { i18n } from '../boot/i18n'
import { messages, defaultLocale } from '../i18n'

let previousLocale: string
beforeEach(() => {
  previousLocale = i18n.global.locale
})
afterEach(() => {
  i18n.global.locale = previousLocale
})

describe('applyLocale', () => {
  it('synchronously sets both locales with a real static Quasar pack for every known locale', () => {
    // Real statically imported modules, not mocked -- a computed bare-module import works in Jest
    // but is left unresolved by Vite in a real browser (#179).
    for (const [locale, expectedIsoName] of [
      ['en-us', 'en-US'],
      ['fr-fr', 'fr'],
      ['tl-ph', 'tl'],
      ['es-es', 'es'],
      ['vi-vn', 'vi'],
      ['zh-cn', 'zh-CN'],
      ['zh-tw', 'zh-TW'],
    ] as const) {
      let setLocaleCalledWith: string | undefined
      const effects: string[] = []
      const setLang = jest.fn(() => {
        expect(i18n.global.locale).toBe(locale)
        effects.push('quasar')
      })

      const result = applyLocale({
        $q: { lang: { set: setLang } },
        setI18nLocale: value => {
          setLocaleCalledWith = value
          effects.push('caller')
        },
        locale,
      })

      expect(i18n.mode).toBe('legacy')
      expect(effects).toEqual(['caller', 'quasar'])
      expect(i18n.global.locale).toBe(locale)
      expect(i18n.global.t('startupFailure.title')).toBe(
        messages[locale].startupFailure.title,
      )
      expect(document.documentElement.lang).toBe(locale)
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
    expect(i18n.global.locale).toBe(defaultLocale)
    expect(i18n.global.t('startupFailure.title')).toBe(
      messages[defaultLocale].startupFailure.title,
    )
    expect(setLang).toHaveBeenCalledTimes(1)
    expect(setLang.mock.calls[0][0]).toMatchObject({ isoName: 'en-US' })
  })

  it('safely handles setI18nLocale throwing (e.g. this.$i18n is undefined)', () => {
    const setLang = jest.fn()
    const warnSpy = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined)

    expect(() => {
      applyLocale({
        $q: { lang: { set: setLang } },
        setI18nLocale: () => {
          throw new TypeError(
            "undefined is not an object (evaluating 'this.$i18n.locale = value')",
          )
        },
        locale: 'fr-fr',
      })
    }).not.toThrow()

    expect(setLang).toHaveBeenCalledTimes(1)
    expect(i18n.global.locale).toBe('fr-fr')
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
