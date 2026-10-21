/**
 * The Settings list: which rows it shows, in which groups, and where each row goes.
 *
 * A row either opens one of the Settings page's own sections (`/settings/<section>`, shown as its
 * own page on a phone and beside the list on a wide layout) or another page of the app.
 */
export const SETTINGS_SECTIONS = [
  { id: 'networking', icon: 'cloud', labelKey: 'settings.networking' },
  { id: 'appearance', icon: 'color_lens', labelKey: 'settings.appearance' },
  {
    id: 'notifications',
    icon: 'notifications',
    labelKey: 'notificationPermission.title',
  },
  { id: 'storage', icon: 'save', labelKey: 'persistentStorage.tab' },
  { id: 'gateways', icon: 'alt_route', labelKey: 'settings.gateways' },
] as const

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id']

export interface SettingsRow {
  id: string
  icon: string
  labelKey: string
  /** A section of the Settings page itself. */
  section?: SettingsSectionId
  /** Another page of the app. */
  route?: string
}

export const SETTINGS_ROW_GROUPS: readonly (readonly SettingsRow[])[] = [
  SETTINGS_SECTIONS.map(s => ({ ...s, section: s.id })),
  [
    {
      id: 'backup',
      icon: 'security',
      labelKey: 'accountRecovery.backup_account_codex32',
      route: '/backup',
    },
    {
      id: 'dapp-bridge',
      icon: 'extension',
      labelKey: 'leftDrawer.dappBridge',
      route: '/dapp-bridge',
    },
  ],
  [
    { id: 'docs', icon: 'menu_book', labelKey: 'docs.title', route: '/docs' },
    {
      id: 'changelog',
      icon: 'change_history',
      labelKey: 'SettingPanel.changeLog',
      route: '/changelog',
    },
    { id: 'about', icon: 'info', labelKey: 'about.menu', route: '/about' },
  ],
]

/** The section a `/settings/:section` route parameter names, or null for none or an unknown one. */
export function settingsSectionFromParam(
  param: unknown,
): SettingsSectionId | null {
  if (typeof param !== 'string') return null
  return SETTINGS_SECTIONS.find(s => s.id === param)?.id ?? null
}

/**
 * A typed settings field that applies itself: `schedule()` on every keystroke commits once typing
 * pauses, `commitNow()` on blur commits straight away, and `flush()` commits only an edit still
 * waiting (leaving the page). `commit` validates and writes nothing for an invalid value.
 */
export function debouncedField(commit: () => void, delayMs = 600) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const cancel = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  return {
    schedule() {
      cancel()
      timer = setTimeout(() => {
        timer = undefined
        commit()
      }, delayMs)
    },
    commitNow() {
      cancel()
      commit()
    },
    flush() {
      if (timer === undefined) return
      cancel()
      commit()
    },
    cancel,
  }
}
