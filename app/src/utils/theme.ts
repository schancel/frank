import { setCssVar } from 'quasar'

export type SignetStone =
  | 'carnelian'
  | 'lapis'
  | 'bloodstone'
  | 'onyx'
  | 'sardonyx'
  | 'classic'

export interface ThemeColors {
  background: string
  text: string
  bgActive: string
  messageSent: string
  messageReceived: string
  messageMetaSent: string
  chatBg1: string
  chatBg2: string
}

export interface SignetThemeDefinition {
  id: SignetStone
  label: string
  tagline: string
  stoneColor: string
  primary: string
  secondary: string
  accent: string
  dark: ThemeColors
  light: ThemeColors
}

export const DEFAULT_SIGNET_THEME: SignetStone = 'carnelian'

export const SIGNET_THEMES: Record<SignetStone, SignetThemeDefinition> = {
  carnelian: {
    id: 'carnelian',
    label: 'Carnelian',
    tagline: 'Warm Roman seal wax & terracotta amber',
    stoneColor: '#c8431e',
    primary: '#c8431e',
    secondary: '#9c2e14',
    accent: '#d97706',
    dark: {
      background: '#130f0e',
      text: '#f4ede8',
      bgActive: '#2a201c',
      messageSent: '#e25732',
      messageReceived: '#221a17',
      messageMetaSent: 'rgba(255, 255, 255, 0.85)',
      chatBg1: 'rgba(226, 87, 50, 0.16)',
      chatBg2: 'rgba(217, 119, 6, 0.10)',
    },
    light: {
      background: '#faf6f3',
      text: '#1f1612',
      bgActive: '#f0e6e0',
      messageSent: '#c8431e',
      messageReceived: '#ffffff',
      messageMetaSent: 'rgba(255, 255, 255, 0.85)',
      chatBg1: 'rgba(200, 67, 30, 0.09)',
      chatBg2: 'rgba(217, 119, 6, 0.06)',
    },
  },
  lapis: {
    id: 'lapis',
    label: 'Lapis Lazuli',
    tagline: 'Deep celestial ultramarine & golden pyrite',
    stoneColor: '#2563eb',
    primary: '#2563eb',
    secondary: '#1d4ed8',
    accent: '#eab308',
    dark: {
      background: '#0b1120',
      text: '#e2e8f0',
      bgActive: '#1e293b',
      messageSent: '#3b82f6',
      messageReceived: '#151f32',
      messageMetaSent: 'rgba(255, 255, 255, 0.85)',
      chatBg1: 'rgba(37, 99, 235, 0.18)',
      chatBg2: 'rgba(234, 179, 8, 0.10)',
    },
    light: {
      background: '#f4f7fb',
      text: '#0f172a',
      bgActive: '#e2e8f0',
      messageSent: '#2563eb',
      messageReceived: '#ffffff',
      messageMetaSent: 'rgba(255, 255, 255, 0.85)',
      chatBg1: 'rgba(37, 99, 235, 0.08)',
      chatBg2: 'rgba(234, 179, 8, 0.06)',
    },
  },
  bloodstone: {
    id: 'bloodstone',
    label: 'Bloodstone',
    tagline: 'Jasper dark green & iron-oxide crimson',
    stoneColor: '#15803d',
    primary: '#15803d',
    secondary: '#166534',
    accent: '#b91c1c',
    dark: {
      background: '#09140c',
      text: '#e2ece4',
      bgActive: '#182c1e',
      messageSent: '#16a34a',
      messageReceived: '#132217',
      messageMetaSent: 'rgba(255, 255, 255, 0.85)',
      chatBg1: 'rgba(22, 163, 74, 0.16)',
      chatBg2: 'rgba(185, 28, 28, 0.09)',
    },
    light: {
      background: '#f3f8f4',
      text: '#102014',
      bgActive: '#e2eee5',
      messageSent: '#15803d',
      messageReceived: '#ffffff',
      messageMetaSent: 'rgba(255, 255, 255, 0.85)',
      chatBg1: 'rgba(21, 128, 61, 0.08)',
      chatBg2: 'rgba(185, 28, 28, 0.05)',
    },
  },
  onyx: {
    id: 'onyx',
    label: 'Onyx',
    tagline: 'High-contrast pitch black & polished silver',
    stoneColor: '#475569',
    primary: '#475569',
    secondary: '#334155',
    accent: '#94a3b8',
    dark: {
      background: '#0a0a0c',
      text: '#f1f5f9',
      bgActive: '#1e2024',
      messageSent: '#64748b',
      messageReceived: '#16171b',
      messageMetaSent: 'rgba(255, 255, 255, 0.85)',
      chatBg1: 'rgba(148, 163, 184, 0.12)',
      chatBg2: 'rgba(255, 255, 255, 0.05)',
    },
    light: {
      background: '#f8fafc',
      text: '#0f172a',
      bgActive: '#e2e8f0',
      messageSent: '#334155',
      messageReceived: '#ffffff',
      messageMetaSent: 'rgba(255, 255, 255, 0.85)',
      chatBg1: 'rgba(51, 65, 85, 0.08)',
      chatBg2: 'rgba(0, 0, 0, 0.04)',
    },
  },
  sardonyx: {
    id: 'sardonyx',
    label: 'Sardonyx',
    tagline: 'Banded cameo layers: mahogany & desert cream',
    stoneColor: '#b45309',
    primary: '#b45309',
    secondary: '#78350f',
    accent: '#d97706',
    dark: {
      background: '#130f0a',
      text: '#fef3c7',
      bgActive: '#2a2015',
      messageSent: '#d97706',
      messageReceived: '#201811',
      messageMetaSent: 'rgba(255, 255, 255, 0.85)',
      chatBg1: 'rgba(217, 119, 6, 0.16)',
      chatBg2: 'rgba(180, 83, 9, 0.10)',
    },
    light: {
      background: '#faf6ee',
      text: '#241808',
      bgActive: '#f3e9d8',
      messageSent: '#b45309',
      messageReceived: '#ffffff',
      messageMetaSent: 'rgba(255, 255, 255, 0.85)',
      chatBg1: 'rgba(180, 83, 9, 0.09)',
      chatBg2: 'rgba(217, 119, 6, 0.06)',
    },
  },
  classic: {
    id: 'classic',
    label: 'Classic',
    tagline: 'Original Orchid Violet & Mint',
    stoneColor: '#9d5cff',
    primary: '#9d5cff',
    secondary: '#7c3aed',
    accent: '#00d9a3',
    dark: {
      background: '#121218',
      text: '#ececf2',
      bgActive: '#26262f',
      messageSent: '#b37dff',
      messageReceived: '#242430',
      messageMetaSent: '#000000',
      chatBg1: 'rgba(157, 92, 255, 0.22)',
      chatBg2: 'rgba(0, 217, 163, 0.13)',
    },
    light: {
      background: '#f7f7fb',
      text: '#1a1a22',
      bgActive: '#ebebf5',
      messageSent: '#9d5cff',
      messageReceived: '#ffffff',
      messageMetaSent: '#000000',
      chatBg1: 'rgba(157, 92, 255, 0.11)',
      chatBg2: 'rgba(0, 217, 163, 0.09)',
    },
  },
}

export function applyTheme(
  themeName: SignetStone = DEFAULT_SIGNET_THEME,
  isDark = false,
): void {
  const def = SIGNET_THEMES[themeName] || SIGNET_THEMES[DEFAULT_SIGNET_THEME]
  if (typeof document === 'undefined') return

  if (typeof setCssVar === 'function') {
    try {
      setCssVar('primary', def.primary)
      setCssVar('secondary', def.secondary)
      setCssVar('accent', def.accent)
    } catch {
      // safe fallback if element check fails
    }
  }

  const mode = isDark ? def.dark : def.light
  const body = document.body
  const root = document.documentElement
  if (body) {
    body.setAttribute('data-signet-theme', def.id)
    body.style.setProperty('--q-primary', def.primary)
    body.style.setProperty('--q-secondary', def.secondary)
    body.style.setProperty('--q-accent', def.accent)
    body.style.setProperty('--q-color-background', mode.background)
    body.style.setProperty('--q-color-text', mode.text)
    body.style.setProperty('--q-color-bg-active', mode.bgActive)
    body.style.setProperty('--q-message-color-sent', mode.messageSent)
    body.style.setProperty('--q-message-color', mode.messageReceived)
    body.style.setProperty('--q-message-meta-sent', mode.messageMetaSent)
    body.style.setProperty(
      '--q-chat-background',
      `radial-gradient(ellipse 900px 700px at 12% -10%, ${mode.chatBg1}, transparent 60%), radial-gradient(ellipse 900px 700px at 100% 115%, ${mode.chatBg2}, transparent 60%), ${mode.background}`,
    )
  }
  if (root) {
    root.style.setProperty('--q-primary', def.primary)
    root.style.setProperty('--q-secondary', def.secondary)
    root.style.setProperty('--q-accent', def.accent)
  }
}
