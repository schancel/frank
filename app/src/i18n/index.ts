import { getActivePinia } from 'pinia'
import enUS from './en-us'
import frFR from './fr-fr'
import quasarEnUS from 'quasar/lang/en-US'
import quasarFr from 'quasar/lang/fr'
import tlPH from './tl-ph'
import esES from './es-es'
import viVN from './vi-vn'
import zhCN from './zh-cn'
import zhTW from './zh-tw'
import quasarTl from 'quasar/lang/tl'
import quasarEs from 'quasar/lang/es'
import quasarVi from 'quasar/lang/vi'
import quasarZhCN from 'quasar/lang/zh-CN'
import quasarZhTW from 'quasar/lang/zh-TW'
import {
  defaultLocale,
  localeOptions,
  resolveLocale,
  type SupportedLocale,
} from './locale'
export { defaultLocalePreference, resolveLocale } from './locale'
export type { LocalePreference, SupportedLocale } from './locale'

const messages = {
  'en-us': enUS,
  'fr-fr': frFR,
  'tl-ph': tlPH,
  'es-es': esES,
  'vi-vn': viVN,
  'zh-cn': zhCN,
  'zh-tw': zhTW,
}

/** Maps this app's own vue-i18n locale codes to statically imported Quasar language packs. Bare
 * package specifiers cannot be assembled at runtime: Vite cannot transform
 * `import(`quasar/lang/${name}`)`, so a real browser receives an unresolved module specifier and
 * the app fails before rendering. Every locale option must have an explicit import here. */
const quasarLangPackByLocale = {
  'en-us': quasarEnUS,
  'fr-fr': quasarFr,
  'tl-ph': quasarTl,
  'es-es': quasarEs,
  'vi-vn': quasarVi,
  'zh-cn': quasarZhCN,
  'zh-tw': quasarZhTW,
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
  const normalized = resolveLocale(targetLocale)
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

export { messages, defaultLocale, localeOptions, quasarLangPackForLocale }
