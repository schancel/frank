import 'quasar'
import 'vue-i18n'
import 'vue-router'
import type { ComponentPublicInstance } from 'vue'

declare const component: ComponentPublicInstance

const translated: string = component.$t('app.title')
const locale: string = component.$i18n.locale
const loaded: boolean = component.$status.loaded
component.$q.notify({ message: translated })
void component.$router.push({ path: '/' })
const path: string = component.$route.path
component.openURL?.('https://example.test')

void [locale, loaded, path]
