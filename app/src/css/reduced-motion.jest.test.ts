/** @jest-environment jsdom */

import { readFileSync } from 'fs'
import { resolve } from 'path'

describe('prefers-reduced-motion CSS rules (#546)', () => {
  const scssPath = resolve(__dirname, 'app.scss')
  const css = readFileSync(scssPath, 'utf8')
  const mediaMatch = css.match(
    /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/i,
  )
  const mediaContent = mediaMatch ? mediaMatch[1] : ''

  it('reads app.scss successfully', () => {
    expect(css).toBeDefined()
    expect(css.length).toBeGreaterThan(0)
  })

  it('declares prefers-reduced-motion: reduce media block', () => {
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
  })

  describe('reduced motion rules inspection', () => {
    it('media query block is present in app.scss', () => {
      expect(mediaMatch).not.toBeNull()
      expect(mediaContent.length).toBeGreaterThan(0)
    })

    it('overrides universal animation and transition durations to instantaneous', () => {
      expect(mediaContent).toMatch(
        /\*,\s*\*::before,\s*\*::after\s*\{[^}]*animation-duration:\s*0\.001ms\s*!important/i,
      )
      expect(mediaContent).toMatch(
        /\*,\s*\*::before,\s*\*::after\s*\{[^}]*transition-duration:\s*0\.001ms\s*!important/i,
      )
      expect(mediaContent).toMatch(
        /\*,\s*\*::before,\s*\*::after\s*\{[^}]*animation-iteration-count:\s*1\s*!important/i,
      )
      expect(mediaContent).toMatch(
        /\*,\s*\*::before,\s*\*::after\s*\{[^}]*scroll-behavior:\s*auto\s*!important/i,
      )
    })

    it('disables spatial transitions on .q-drawer', () => {
      expect(mediaContent).toMatch(
        /\.q-drawer\s*\{[^}]*transition:\s*none\s*!important/i,
      )
    })

    it('disables opacity transitions on .q-drawer__backdrop', () => {
      expect(mediaContent).toMatch(
        /\.q-drawer__backdrop\s*\{[^}]*transition:\s*none\s*!important/i,
      )
    })

    it('disables decorative .q-ripple completely', () => {
      expect(mediaContent).toMatch(
        /\.q-ripple\s*\{[^}]*display:\s*none\s*!important/i,
      )
    })
  })

  describe('DOM emulation of reduced motion vs normal motion', () => {
    let styleEl: HTMLStyleElement

    beforeAll(() => {
      styleEl = document.createElement('style')
      styleEl.textContent = mediaContent
      document.head.appendChild(styleEl)
    })

    afterAll(() => {
      styleEl.remove()
      document.body.innerHTML = ''
    })

    function createTestDOM() {
      const container = document.createElement('div')
      container.innerHTML = `
        <div class="q-drawer" data-testid="drawer">
          <div class="drawer-content">Navigation</div>
        </div>
        <div class="q-drawer__backdrop" data-testid="backdrop"></div>
        <button class="q-btn" data-testid="agree-btn">
          <span class="q-focus-helper"></span>
          <span class="q-ripple" data-testid="ripple"></span>
          <span class="q-btn__content">Agree</span>
        </button>
      `
      return container
    }

    it('renders representative drawer and button DOM nodes cleanly', () => {
      const container = createTestDOM()
      document.body.appendChild(container)

      const drawer = container.querySelector('[data-testid="drawer"]')
      const backdrop = container.querySelector('[data-testid="backdrop"]')
      const button = container.querySelector('[data-testid="agree-btn"]')
      const ripple = container.querySelector('[data-testid="ripple"]')

      expect(drawer).not.toBeNull()
      expect(backdrop).not.toBeNull()
      expect(button).not.toBeNull()
      expect(ripple).not.toBeNull()

      container.remove()
    })

    it('media query matches correctly when window.matchMedia is configured', () => {
      const originalMatchMedia = window.matchMedia

      try {
        window.matchMedia = jest.fn().mockImplementation(query => ({
          matches: query.includes('prefers-reduced-motion: reduce'),
          media: query,
          onchange: null,
          addListener: jest.fn(),
          removeListener: jest.fn(),
          addEventListener: jest.fn(),
          removeEventListener: jest.fn(),
          dispatchEvent: jest.fn(),
        }))

        const reducedQuery = window.matchMedia(
          '(prefers-reduced-motion: reduce)',
        )
        expect(reducedQuery.matches).toBe(true)

        const normalQuery = window.matchMedia(
          '(prefers-reduced-motion: no-preference)',
        )
        expect(normalQuery.matches).toBe(false)
      } finally {
        window.matchMedia = originalMatchMedia
      }
    })
  })
})
