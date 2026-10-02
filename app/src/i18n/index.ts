import { getActivePinia } from 'pinia'
import enUS from './en-us'
import frFR from './fr-fr'
import quasarEnUS from 'quasar/lang/en-US'
import quasarFr from 'quasar/lang/fr'

const defaultLocale = 'en-us'

const messages = {
  'en-us': enUS,
  'fr-fr': frFR,
}

type SupportedLocale = keyof typeof messages

const translatedLocaleOptions = [
  { value: 'en-us', label: 'English' },
  { value: 'fr-fr', label: 'Français' },
]

/** Maps this app's own vue-i18n locale codes to statically imported Quasar language packs. Bare
 * package specifiers cannot be assembled at runtime: Vite cannot transform
 * `import(`quasar/lang/${name}`)`, so a real browser receives an unresolved module specifier and
 * the app fails before rendering. Every locale option must have an explicit import here. */
const quasarLangPackByLocale = {
  'en-us': quasarEnUS,
  'fr-fr': quasarFr,
} satisfies Record<SupportedLocale, typeof quasarEnUS>

const quasarLangPackForLocale = (locale: string) =>
  Object.prototype.hasOwnProperty.call(quasarLangPackByLocale, locale)
    ? quasarLangPackByLocale[locale as SupportedLocale]
    : quasarLangPackByLocale[defaultLocale]

export function translateMessage(key: string, locale?: string): string {
  let targetLocale = locale
  if (!targetLocale) {
    try {
      const pinia = getActivePinia()
      if (pinia?.state?.value?.appearance?.locale) {
        targetLocale = pinia.state.value.appearance.locale as string
      }
    } catch {
      targetLocale = defaultLocale
    }
  }
  const normalized =
    targetLocale && targetLocale.toLowerCase().startsWith('fr')
      ? 'fr-fr'
      : 'en-us'
  const dict =
    (messages as Record<string, unknown>)[normalized] || messages[defaultLocale]
  const val = key
    .split('.')
    .reduce<unknown>(
      (acc, part) => (acc as Record<string, unknown>)?.[part],
      dict,
    )
  return typeof val === 'string' ? val : key
}

export {
  messages,
  defaultLocale,
  translatedLocaleOptions as localeOptions,
  quasarLangPackForLocale,
}
