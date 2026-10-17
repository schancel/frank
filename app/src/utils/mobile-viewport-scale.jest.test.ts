/**
 * @jest-environment jsdom
 */
import {
  DEFAULT_UI_SCALE,
  UI_SCALE_STORAGE_KEY,
  applyViewportScaleAndMetrics,
  computeEffectiveUiScale,
  computeMobileAutoScale,
  getEffectiveScreenWidth,
  getSavedUiScaleSetting,
  normalizeUiScaleSetting,
  saveUiScaleSetting,
} from './mobile-viewport-scale'
import { isNarrowWidth } from './layout'

describe('mobile-viewport-scale', () => {
  beforeEach(() => {
    localStorage.removeItem(UI_SCALE_STORAGE_KEY)
    document.documentElement.style.removeProperty('zoom')
    document.documentElement.style.removeProperty('--frank-ui-zoom')
    document.documentElement.style.removeProperty('--frank-vw')
    document.documentElement.style.removeProperty('--frank-vh')
  })

  it('normalizes and persists UiScaleSetting values safely', () => {
    expect(normalizeUiScaleSetting('auto')).toBe('auto')
    expect(normalizeUiScaleSetting(115)).toBe(115)
    expect(normalizeUiScaleSetting('130')).toBe(130)
    expect(normalizeUiScaleSetting('invalid')).toBe(DEFAULT_UI_SCALE)
    expect(normalizeUiScaleSetting(999)).toBe(DEFAULT_UI_SCALE)

    expect(getSavedUiScaleSetting()).toBe('auto')
    saveUiScaleSetting(130)
    expect(getSavedUiScaleSetting()).toBe(130)
  })

  it('detects forced 980px desktop viewport on Galaxy S24 (Brave Android) and computes compensating scale', () => {
    // Galaxy S24 physical CSS screen ~384x832, Brave "Desktop site" forces 980x2126 layout viewport
    const s24ForcedDesktopMetrics = {
      innerWidth: 980,
      innerHeight: 2126,
      visualWidth: 980,
      visualHeight: 2126,
      screenWidth: 384,
      screenHeight: 832,
      maxTouchPoints: 5,
    }

    const autoScale = computeMobileAutoScale(s24ForcedDesktopMetrics)
    expect(autoScale).toBeCloseTo(980 / 384, 3)

    const effective = computeEffectiveUiScale('auto', s24ForcedDesktopMetrics)
    expect(effective.isForcedDesktopCompensated).toBe(true)
    expect(effective.scale).toBeCloseTo(2.552, 3)
    expect(effective.effectiveWidth).toBe(384)
    expect(effective.effectiveHeight).toBe(833)
    expect(isNarrowWidth(effective.effectiveWidth)).toBe(true)
  })

  it('keeps scale at 1 on normal mobile viewport and desktop monitors', () => {
    const normalMobile = {
      innerWidth: 384,
      innerHeight: 780,
      screenWidth: 384,
      screenHeight: 832,
      maxTouchPoints: 5,
    }
    expect(computeMobileAutoScale(normalMobile)).toBe(1)
    expect(computeEffectiveUiScale('auto', normalMobile)).toEqual({
      scale: 1,
      isForcedDesktopCompensated: false,
      effectiveWidth: 384,
      effectiveHeight: 780,
    })

    const desktopMonitor = {
      innerWidth: 1440,
      innerHeight: 900,
      screenWidth: 2560,
      screenHeight: 1440,
      maxTouchPoints: 0,
    }
    expect(computeMobileAutoScale(desktopMonitor)).toBe(1)
    expect(computeEffectiveUiScale('auto', desktopMonitor)).toEqual({
      scale: 1,
      isForcedDesktopCompensated: false,
      effectiveWidth: 1440,
      effectiveHeight: 900,
    })
  })

  it('applies user UI zoom override on top of auto-scale and updates root CSS variables', () => {
    const fakeWin = {
      innerWidth: 980,
      innerHeight: 2126,
      visualViewport: {
        width: 980,
        height: 1180, // Soft keyboard open!
      },
      screen: {
        width: 384,
        height: 832,
      },
      navigator: {
        maxTouchPoints: 5,
      },
      document,
    } as unknown as Window

    const origMaxTouchPoints = Object.getOwnPropertyDescriptor(
      navigator,
      'maxTouchPoints',
    )
    Object.defineProperty(navigator, 'maxTouchPoints', {
      value: 5,
      configurable: true,
    })

    try {
      const result = applyViewportScaleAndMetrics('auto', fakeWin)
      expect(result.isForcedDesktopCompensated).toBe(true)
      expect(result.effectiveWidth).toBe(384)
      expect(result.effectiveHeight).toBe(Math.round(1180 / result.scale))
      expect(
        document.documentElement.style.getPropertyValue('--frank-ui-zoom'),
      ).toBe(String(result.scale))
      expect(
        (document.documentElement.style as unknown as Record<string, string>)
          .zoom,
      ).toBe(String(result.scale))
      expect(
        document.documentElement.style.getPropertyValue('--frank-vw'),
      ).toBe('384px')
      expect(
        document.documentElement.style.getPropertyValue('--frank-vh'),
      ).toBe(`${result.effectiveHeight}px`)
      expect(getEffectiveScreenWidth(980, 'auto', fakeWin)).toBe(384)
    } finally {
      if (origMaxTouchPoints) {
        Object.defineProperty(navigator, 'maxTouchPoints', origMaxTouchPoints)
      }
    }
  })

  it('updates --frank-vh when soft keyboard shrinks visualViewport on normal mobile scale', () => {
    const fakeWin = {
      innerWidth: 384,
      innerHeight: 832,
      visualViewport: {
        width: 384,
        height: 480,
      },
      screen: {
        width: 384,
        height: 832,
      },
      navigator: {
        maxTouchPoints: 5,
      },
      document,
    } as unknown as Window

    const result = applyViewportScaleAndMetrics(100, fakeWin)
    expect(result.scale).toBe(1)
    expect(result.effectiveHeight).toBe(480)
    expect(document.documentElement.style.getPropertyValue('--frank-vh')).toBe(
      '480px',
    )
  })
})
