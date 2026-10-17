/** @jest-environment jsdom */

import {
  BUILTIN_BRANDS,
  applyBrandToLocaleMessages,
  resolveAppBrand,
} from './brand'
import { rawEnUS } from '../i18n/en-us'
import { rawFrFR } from '../i18n/fr-fr'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const cjsBrand = require('../../config/brand.cjs')

describe('Multi-brand whitebox configuration', () => {
  it('defaults to Frank when no brand environment variable is set', () => {
    const brand = resolveAppBrand({})
    expect(brand.id).toBe('frank')
    expect(brand.productName).toBe('Frank')
    expect(brand.shortName).toBe('Frank')
    expect(applyBrandToLocaleMessages(rawEnUS, brand.productName)).toBe(rawEnUS)
  })

  it('resolves all built-in brand profiles identically in TS and CJS', () => {
    for (const slug of ['frank', 'plainspoken', 'signet', 'stamp', 'lotus']) {
      const tsResolved = resolveAppBrand({ APP_BRAND: slug })
      const cjsResolved = cjsBrand.resolveAppBrand({ APP_BRAND: slug })
      expect(tsResolved).toEqual(BUILTIN_BRANDS[slug])
      expect(cjsResolved).toEqual(tsResolved)
    }
  })

  it('synthesizes valid brand profiles for arbitrary custom project names', () => {
    const fromSlug = resolveAppBrand({ APP_BRAND: 'root-signature' })
    expect(fromSlug).toEqual({
      id: 'root-signature',
      productName: 'Root Signature',
      shortName: 'Root Signature',
      description: 'Encrypted messaging and a multichain wallet',
      appId: 'org.cashweb.rootsignature',
      themeColor: '#121218',
      backgroundColor: '#f7f7f2',
    })

    const withOverrides = resolveAppBrand({
      APP_BRAND: 'cipher',
      APP_BRAND_NAME: 'Cipher Dialogue',
      APP_BRAND_ID: 'xyz.cipher.app',
      APP_BRAND_THEME_COLOR: '#0f172a',
    })
    expect(withOverrides.id).toBe('cipher')
    expect(withOverrides.productName).toBe('Cipher Dialogue')
    expect(withOverrides.shortName).toBe('Cipher Dialogue')
    expect(withOverrides.appId).toBe('xyz.cipher.app')
    expect(withOverrides.themeColor).toBe('#0f172a')
  })

  it('rewrites English and French locale dictionaries for Plainspoken, Signet, and Stamp', () => {
    for (const brandName of ['Plainspoken', 'Signet', 'Stamp']) {
      const en = applyBrandToLocaleMessages(rawEnUS, brandName)
      const fr = applyBrandToLocaleMessages(rawFrFR, brandName)

      expect(en.about.appName).toBe(brandName)
      expect(en.about.frankTitle).toBe(`About ${brandName}`)
      expect(en.welcome.title).toBe(`Welcome to ${brandName}`)
      expect(en.welcome.howItWorks).toBe(`How ${brandName} Works`)
      expect(en.accountRecovery.frank_is_open_in_another_tab).toBe(
        `${brandName} is open in another tab`,
      )
      expect(en.accountRecovery.use_frank_here).toBe(`Use ${brandName} here`)

      expect(fr.about.appName).toBe(brandName)
      expect(fr.about.frankTitle).toBe(`À propos de ${brandName}`)
      expect(fr.welcome.title).toBe(`Bienvenue sur ${brandName}`)
      expect(fr.welcome.howItWorks).toBe(`Comment fonctionne ${brandName}`)
      expect(fr.accountRecovery.frank_is_open_in_another_tab).toBe(
        `${brandName} est ouvert dans un autre onglet`,
      )
    }
  })
})
