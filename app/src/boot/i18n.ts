import { messages, defaultLocale } from 'src/i18n'
import { defineBoot as boot } from '@quasar/app-vite'
import { createI18n } from 'vue-i18n'
// you'll need to create the src/i18n/index.js file too

// Active locale strings may fall back; the default catalog owns the message schema.
const i18n = createI18n<[(typeof messages)[typeof defaultLocale]], string>({
  locale: defaultLocale,
  fallbackLocale: defaultLocale,
  globalInjection: true,
  messages,
})

export default boot(({ app }) => {
  // Set i18n instance on app
  app.use(i18n)
})

export { i18n }
