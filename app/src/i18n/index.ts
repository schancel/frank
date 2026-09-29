import enUS from './en-us'
import frFR from './fr-fr'

const defaultLocale = 'en-us'

const messages = {
  'en-us': enUS,
  'fr-fr': frFR,
}

const translatedLocaleOptions = [
  { value: 'en-us', label: 'English' },
  { value: 'fr-fr', label: 'Français' },
]

/** Maps this app's own vue-i18n locale codes to Quasar's own lang-pack module names -- the two
 * don't share a naming scheme (Quasar ships `en-US`/`fr`, not `en-us`/`fr-fr`), so this can't be
 * derived mechanically from `defaultLocale`/`translatedLocaleOptions` above. Every entry in
 * `translatedLocaleOptions` must have one here -- ticket #156. */
const quasarLangPackByLocale: Record<string, string> = {
  'en-us': 'en-US',
  'fr-fr': 'fr',
}

export {
  messages,
  defaultLocale,
  translatedLocaleOptions as localeOptions,
  quasarLangPackByLocale,
}
