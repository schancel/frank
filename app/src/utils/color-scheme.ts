import { ref, readonly } from 'vue'

/** The owner's choice: follow the operating system, or always light, or always dark. */
export type ColorScheme = 'system' | 'light' | 'dark'

export const COLOR_SCHEMES: readonly ColorScheme[] = ['system', 'light', 'dark']

export function isColorScheme(value: unknown): value is ColorScheme {
  return value === 'system' || value === 'light' || value === 'dark'
}

const prefersDark = ref(false)
let watching = false

/**
 * Whether the operating system asks for dark (`prefers-color-scheme: dark`), kept current as
 * the system setting changes. False where the browser cannot say.
 */
export function systemPrefersDark(): Readonly<typeof prefersDark> {
  if (
    !watching &&
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function'
  ) {
    watching = true
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    prefersDark.value = query.matches
    const update = (event: { matches: boolean }) => {
      prefersDark.value = event.matches
    }
    if (typeof query.addEventListener === 'function')
      query.addEventListener('change', update)
    else if (typeof query.addListener === 'function') query.addListener(update)
  }
  return readonly(prefersDark)
}

/** Whether `scheme` shows dark now. */
export function schemeIsDark(scheme: ColorScheme): boolean {
  return scheme === 'dark' || (scheme === 'system' && systemPrefersDark().value)
}
