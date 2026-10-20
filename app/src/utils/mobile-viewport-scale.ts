export type UiScaleSetting = 'auto' | 85 | 100 | 115 | 130 | 150

export const DEFAULT_UI_SCALE: UiScaleSetting = 'auto'
export const UI_SCALE_STORAGE_KEY = 'frank:ui-scale'

export const VALID_UI_SCALES: readonly UiScaleSetting[] = [
  'auto',
  85,
  100,
  115,
  130,
  150,
]

export interface ViewportMetricsInput {
  innerWidth: number
  innerHeight: number
  visualWidth?: number
  visualHeight?: number
  screenWidth: number
  screenHeight: number
  maxTouchPoints: number
}

export interface EffectiveViewportScale {
  scale: number
  isForcedDesktopCompensated: boolean
  effectiveWidth: number
  effectiveHeight: number
}

export function normalizeUiScaleSetting(raw: unknown): UiScaleSetting {
  if (raw === 'auto') return 'auto'
  const num = typeof raw === 'string' ? Number(raw) : raw
  if (num === 85 || num === 100 || num === 115 || num === 130 || num === 150) {
    return num
  }
  return DEFAULT_UI_SCALE
}

export function getSavedUiScaleSetting(): UiScaleSetting {
  try {
    if (typeof localStorage === 'undefined') return DEFAULT_UI_SCALE
    const raw = localStorage.getItem(UI_SCALE_STORAGE_KEY)
    if (!raw) return DEFAULT_UI_SCALE
    return normalizeUiScaleSetting(raw)
  } catch {
    return DEFAULT_UI_SCALE
  }
}

export function saveUiScaleSetting(setting: UiScaleSetting): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(UI_SCALE_STORAGE_KEY, String(setting))
  } catch {
    // ignore storage errors
  }
}

/**
 * Detects when a mobile phone browser/PWA (such as Brave or Chrome on Android with
 * "Desktop site" active) forces a ~980px virtual desktop layout viewport onto a narrow
 * physical touch screen (e.g. 360px-412px CSS pixels on a Galaxy S24), and returns the
 * compensating zoom multiplier so the UI renders at 1:1 native mobile dimensions.
 */
export function computeMobileAutoScale(metrics: ViewportMetricsInput): number {
  if (!metrics || metrics.maxTouchPoints <= 0) return 1
  const sw = Number(metrics.screenWidth) || 0
  const sh = Number(metrics.screenHeight) || 0
  const shortSide = Math.min(sw, sh)
  // Phone physical CSS short-side is between 240px and 540px (tablets/desktops are >= 600px).
  if (shortSide < 240 || shortSide > 540) return 1

  const innerW = Number(metrics.innerWidth) || 0
  // Chromium Android "Desktop site" forces a 980px layout viewport width.
  if (innerW < 760 || innerW <= shortSide * 1.4) return 1

  const targetCssWidth = sw >= 240 && sw <= 920 ? sw : shortSide
  if (innerW <= targetCssWidth * 1.35) return 1

  const ratio = innerW / targetCssWidth
  return Math.min(3.5, Math.max(1, Number(ratio.toFixed(3))))
}

export function computeEffectiveUiScale(
  setting: UiScaleSetting,
  metrics: ViewportMetricsInput,
): EffectiveViewportScale {
  const normalized = normalizeUiScaleSetting(setting)
  const autoScale = computeMobileAutoScale(metrics)
  const userMultiplier = normalized === 'auto' ? 1 : normalized / 100
  const scale = Number((autoScale * userMultiplier).toFixed(3))

  const rawW =
    metrics.visualWidth && metrics.visualWidth > 0
      ? metrics.visualWidth
      : metrics.innerWidth || 1024
  const rawH =
    metrics.visualHeight && metrics.visualHeight > 0
      ? metrics.visualHeight
      : metrics.innerHeight || 768

  const effectiveWidth =
    scale > 0 && scale !== 1 ? Math.round(rawW / scale) : Math.round(rawW)
  const effectiveHeight =
    scale > 0 && scale !== 1 ? Math.round(rawH / scale) : Math.round(rawH)

  return {
    scale,
    isForcedDesktopCompensated: autoScale > 1,
    effectiveWidth,
    effectiveHeight,
  }
}

export function readWindowViewportMetrics(
  win?: Window,
): ViewportMetricsInput | null {
  const w = win ?? (typeof window !== 'undefined' ? window : undefined)
  if (!w) return null
  const nav =
    typeof navigator !== 'undefined'
      ? navigator
      : (w.navigator as Navigator | undefined)
  return {
    innerWidth: w.innerWidth || 0,
    innerHeight: w.innerHeight || 0,
    visualWidth: w.visualViewport?.width,
    visualHeight: w.visualViewport?.height,
    screenWidth: w.screen?.width || 0,
    screenHeight: w.screen?.height || 0,
    maxTouchPoints: nav?.maxTouchPoints || 0,
  }
}

export function applyViewportScaleAndMetrics(
  setting?: UiScaleSetting,
  win?: Window,
): EffectiveViewportScale {
  const resolvedSetting = normalizeUiScaleSetting(
    setting ?? getSavedUiScaleSetting(),
  )
  const metrics = readWindowViewportMetrics(win) ?? {
    innerWidth: 1024,
    innerHeight: 768,
    screenWidth: 1024,
    screenHeight: 768,
    maxTouchPoints: 0,
  }
  const result = computeEffectiveUiScale(resolvedSetting, metrics)

  const w = win ?? (typeof window !== 'undefined' ? window : undefined)
  const doc = w?.document ?? (typeof document !== 'undefined' ? document : null)
  const nav =
    (w?.navigator as Navigator | undefined) ??
    (typeof navigator !== 'undefined' ? navigator : undefined)
  const ua = typeof nav?.userAgent === 'string' ? nav.userAgent : ''
  const isChromiumBrowser =
    /(Chrome|Chromium|Edg|Brave)/i.test(ua) && !/CriOS|FxiOS/i.test(ua)
  const viewportMeta = doc?.querySelector?.(
    'meta[name="viewport"]',
  ) as HTMLMetaElement | null
  if (viewportMeta) {
    const currentContent = viewportMeta.getAttribute('content') || ''
    if (isChromiumBrowser) {
      if (!currentContent.includes('interactive-widget=')) {
        viewportMeta.setAttribute(
          'content',
          currentContent
            ? `${currentContent}, interactive-widget=resizes-content`
            : 'width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content',
        )
      }
    } else if (currentContent.includes('interactive-widget=')) {
      const cleaned = currentContent
        .split(',')
        .map(part => part.trim())
        .filter(part => part && !part.startsWith('interactive-widget='))
        .join(', ')
      viewportMeta.setAttribute('content', cleaned)
    }
  }

  const root = doc?.documentElement
  if (root?.style) {
    const keyboardShrunkViewport =
      metrics.visualHeight !== undefined &&
      metrics.visualHeight > 0 &&
      ((metrics.innerHeight > 0 &&
        metrics.innerHeight - metrics.visualHeight > 40) ||
        (metrics.maxTouchPoints > 0 &&
          metrics.screenHeight > 0 &&
          metrics.screenHeight - metrics.visualHeight > 220))
    if (result.scale !== 1) {
      root.style.setProperty('zoom', String(result.scale))
      ;(root.style as unknown as Record<string, string>).zoom = String(
        result.scale,
      )
      root.style.setProperty('--frank-ui-zoom', String(result.scale))
      root.style.setProperty('--frank-vw', `${result.effectiveWidth}px`)
      root.style.setProperty('--frank-vh', `${result.effectiveHeight}px`)
    } else {
      root.style.removeProperty('zoom')
      ;(root.style as unknown as Record<string, string>).zoom = ''
      root.style.setProperty('--frank-ui-zoom', '1')
      root.style.removeProperty('--frank-vw')
      if (keyboardShrunkViewport) {
        root.style.setProperty('--frank-vh', `${result.effectiveHeight}px`)
      } else {
        root.style.removeProperty('--frank-vh')
      }
    }
    if (keyboardShrunkViewport && metrics.visualHeight !== undefined) {
      const rawKbOffset = Math.max(0, metrics.innerHeight - metrics.visualHeight)
      const effectiveKbOffset =
        result.scale > 0 && result.scale !== 1
          ? Math.round(rawKbOffset / result.scale)
          : Math.round(rawKbOffset)
      root.style.setProperty('--frank-kb-offset', `${effectiveKbOffset}px`)
      root.classList?.add('frank-keyboard-open')
    } else {
      root.style.removeProperty('--frank-kb-offset')
      root.classList?.remove('frank-keyboard-open')
    }
  }

  return result
}

export function getEffectiveScreenWidth(
  rawWidth: number,
  setting?: UiScaleSetting,
  win?: Window,
): number {
  const metrics = readWindowViewportMetrics(win)
  if (!metrics) return rawWidth
  const effectiveMetrics: ViewportMetricsInput = {
    ...metrics,
    innerWidth: rawWidth || metrics.innerWidth,
  }
  const resolvedSetting = normalizeUiScaleSetting(
    setting ?? getSavedUiScaleSetting(),
  )
  const { scale } = computeEffectiveUiScale(resolvedSetting, effectiveMetrics)
  return scale > 0 && scale !== 1 ? Math.round(rawWidth / scale) : rawWidth
}
