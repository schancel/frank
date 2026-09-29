/**
 * Applies a committed locale to both halves of this app's translation state -- vue-i18n's own
 * locale (application strings) and Quasar's own lang pack (component-library strings, e.g. date
 * picker month names). The two are independent Vue plugins with no built-in link between them, so
 * every place that ever commits a locale change (app boot restoring a persisted setting, Settings'
 * own Save) must call this same function rather than reimplementing the pairing -- see ticket #156,
 * "Vue and Quasar language state can also diverge." Takes a plain setter callback (not a ref
 * directly) so it works the same from a Composition-API ref (`v => (i18nLocale.value = v)`) and
 * from Options-API's `this.$i18n.locale` property (`v => (this.$i18n.locale = v)`).
 */
import { quasarLangPackForLocale } from 'src/i18n'

export interface QuasarLangTarget {
  lang: { set: (pack: unknown) => void }
}

export async function applyLocale(params: {
  $q: QuasarLangTarget
  setI18nLocale: (locale: string) => void
  locale: string
}): Promise<void> {
  params.setI18nLocale(params.locale)
  params.$q.lang.set(quasarLangPackForLocale(params.locale))
}
