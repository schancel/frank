/** Supported UI languages. Catalogs and Quasar packs are bundled by i18n/index.ts. */
export const localeOptions = [
  { value: 'en-us', label: 'English' },
  { value: 'fr-fr', label: 'Français' },
  { value: 'tl-ph', label: 'Tagalog' },
  { value: 'es-es', label: 'Español' },
  { value: 'vi-vn', label: 'Tiếng Việt' },
  { value: 'zh-cn', label: '简体中文' },
  { value: 'zh-tw', label: '繁體中文' },
] as const

export type SupportedLocale = (typeof localeOptions)[number]['value']
export type LocalePreference = SupportedLocale | 'auto'
export const defaultLocale = 'en-us' satisfies SupportedLocale
export const defaultLocalePreference: LocalePreference = 'auto'

function matchLocale(value: string): SupportedLocale | undefined {
  // Intl rejects malformed BCP-47 tags, including whitespace and partial subtags.
  let tag: Intl.Locale
  try {
    tag = new Intl.Locale(value)
  } catch {
    return undefined
  }
  switch (tag.language) {
    case 'en':
      return 'en-us'
    case 'fr':
      return 'fr-fr'
    case 'tl':
    case 'fil':
      return 'tl-ph'
    case 'es':
      return 'es-es'
    case 'vi':
      return 'vi-vn'
    case 'zh':
      if (tag.script === 'Hant') return 'zh-tw'
      if (tag.script === 'Hans') return 'zh-cn'
      return ['TW', 'HK', 'MO'].includes(tag.region ?? '') ? 'zh-tw' : 'zh-cn'
    default:
      return undefined
  }
}

export function browserLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return []
  return [
    ...(navigator.languages ?? []),
    ...(navigator.language ? [navigator.language] : []),
  ]
}

/** The effective locale is derived, never another persisted preference. */
export function resolveLocale(
  preference: string = defaultLocalePreference,
  languages: readonly string[] = browserLanguages(),
): SupportedLocale {
  if (preference !== 'auto') return matchLocale(preference) ?? defaultLocale
  for (const language of languages) {
    const matched = matchLocale(language)
    if (matched) return matched
  }
  return defaultLocale
}
