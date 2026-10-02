import { getCurrentInstance } from 'vue'
import { translateMessage } from 'src/i18n'

export type TranslateFunction = (
  key: string,
  params?: Record<string, unknown>,
) => string

/**
 * Returns a translation function `$t` that delegates to the active Vue component instance
 * ($t from vue-i18n or test mocks), or falls back to translateMessage from src/i18n.
 */
export function useTranslate(): TranslateFunction {
  const instance = getCurrentInstance()
  return (key: string, params?: Record<string, unknown>): string => {
    if (instance?.proxy?.$t) {
      return (instance.proxy.$t as (k: string, p?: unknown) => string)(
        key,
        params,
      )
    }
    return translateMessage(key)
  }
}
