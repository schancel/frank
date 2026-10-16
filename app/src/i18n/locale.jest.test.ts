import { browserLanguages, resolveLocale } from './locale'

describe('effective UI locale', () => {
  it.each([
    ['en-GB', 'en-us'],
    ['FR-ca', 'fr-fr'],
    ['tl', 'tl-ph'],
    ['fil-PH', 'tl-ph'],
    ['es-MX', 'es-es'],
    ['vi', 'vi-vn'],
    ['zh', 'zh-cn'],
    ['zh-SG', 'zh-cn'],
    ['zh-CN', 'zh-cn'],
    ['zh-TW', 'zh-tw'],
    ['zh-HK', 'zh-tw'],
    ['zh-MO', 'zh-tw'],
    ['zh-Hans-TW', 'zh-cn'],
    ['zh-Hant-CN', 'zh-tw'],
    ['ZH-hANT-hk', 'zh-tw'],
  ])('resolves browser preference %s to %s', (tag, expected) => {
    expect(resolveLocale('auto', [tag])).toBe(expected)
  })

  it('uses preference order, skipping unsupported and malformed tags', () => {
    expect(
      resolveLocale('auto', ['de-DE', 'es--MX', ' fr ', 'vi-VN', 'fr']),
    ).toBe('vi-vn')
    expect(resolveLocale('auto', ['fr', 'es'])).toBe('fr-fr')
    expect(resolveLocale('auto', [])).toBe('en-us')
    expect(resolveLocale('auto', ['unknown', '???'])).toBe('en-us')
  })

  it('pins saved explicit choices independently of the browser', () => {
    expect(resolveLocale('en-us', ['vi'])).toBe('en-us')
    expect(resolveLocale('fr-fr', ['vi'])).toBe('fr-fr')
    expect(resolveLocale('auto', ['vi'])).toBe('vi-vn')
    expect(resolveLocale('invalid', ['vi'])).toBe('en-us')
  })

  it('uses navigator.language after the languages list', () => {
    const languages = jest
      .spyOn(navigator, 'languages', 'get')
      .mockReturnValue(['de'])
    const language = jest
      .spyOn(navigator, 'language', 'get')
      .mockReturnValue('fil')
    expect(resolveLocale()).toBe('tl-ph')
    languages.mockRestore()
    language.mockRestore()
  })

  it('works without browser globals', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    Object.defineProperty(globalThis, 'navigator', {
      value: undefined,
      configurable: true,
    })
    try {
      expect(browserLanguages()).toEqual([])
      expect(resolveLocale()).toBe('en-us')
    } finally {
      if (original) Object.defineProperty(globalThis, 'navigator', original)
    }
  })
})
