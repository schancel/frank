/**
 * @jest-environment jsdom
 */
import {
  applyTheme,
  DEFAULT_SIGNET_THEME,
  SIGNET_THEMES,
  SignetStone,
} from './theme'

describe('Signet Stone Themes', () => {
  beforeEach(() => {
    document.body.removeAttribute('data-signet-theme')
    document.body.removeAttribute('style')
  })

  it('defaults to carnelian', () => {
    expect(DEFAULT_SIGNET_THEME).toBe('carnelian')
    expect(SIGNET_THEMES.carnelian.primary).toBe('#c8431e')
  })

  it('defines all 5 classical stones plus classic', () => {
    const expected: SignetStone[] = [
      'carnelian',
      'lapis',
      'bloodstone',
      'onyx',
      'sardonyx',
      'classic',
    ]
    for (const key of expected) {
      expect(SIGNET_THEMES[key]).toBeDefined()
      expect(SIGNET_THEMES[key].primary).toBeTruthy()
      expect(SIGNET_THEMES[key].dark.background).toBeTruthy()
      expect(SIGNET_THEMES[key].light.background).toBeTruthy()
    }
  })

  it('applies theme attributes and custom properties to document.body', () => {
    applyTheme('lapis', true)
    expect(document.body.getAttribute('data-signet-theme')).toBe('lapis')
    expect(document.body.style.getPropertyValue('--q-color-background')).toBe(
      SIGNET_THEMES.lapis.dark.background,
    )
    expect(document.body.style.getPropertyValue('--q-message-color-sent')).toBe(
      SIGNET_THEMES.lapis.dark.messageSent,
    )
  })

  it('falls back to default carnelian on unknown theme name', () => {
    applyTheme('unknown-stone' as any, false)
    expect(document.body.getAttribute('data-signet-theme')).toBe('carnelian')
    expect(document.body.style.getPropertyValue('--q-color-background')).toBe(
      SIGNET_THEMES.carnelian.light.background,
    )
  })

  it('switches between light and dark palettes', () => {
    applyTheme('bloodstone', false)
    expect(document.body.style.getPropertyValue('--q-color-background')).toBe(
      SIGNET_THEMES.bloodstone.light.background,
    )

    applyTheme('bloodstone', true)
    expect(document.body.style.getPropertyValue('--q-color-background')).toBe(
      SIGNET_THEMES.bloodstone.dark.background,
    )
  })
})
