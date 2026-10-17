/** @jest-environment jsdom */

import fs from 'fs'
import path from 'path'
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
    expect(brand.heroLogo).toBe(
      'brand-plainspoken/raster/plainspoken-paper-512.png',
    )
    expect(brand.sidebarLogo).toBe(
      'brand-plainspoken/raster/plainspoken-transparent-512.png',
    )
    expect(applyBrandToLocaleMessages(rawEnUS, brand.productName)).toBe(rawEnUS)
  })

  it('resolves all built-in brand profiles from brands.json identically in TS and CJS', () => {
    const slugs = Object.keys(BUILTIN_BRANDS)
    expect(slugs).toEqual(
      expect.arrayContaining([
        'frank',
        'plainspoken',
        'stamp',
        'signet',
        'lotus',
        'frank-v2',
        'cipher-dialogue',
        'root-signature',
        'open-passage',
        'exchange-seal',
      ]),
    )
    for (const slug of slugs) {
      const tsResolved = resolveAppBrand({ APP_BRAND: slug })
      const cjsResolved = cjsBrand.resolveAppBrand({ APP_BRAND: slug })
      expect(tsResolved).toEqual(BUILTIN_BRANDS[slug])
      expect(cjsResolved).toEqual(tsResolved)
    }
  })

  it('has existing asset files on disk for every heroLogo, sidebarLogo, and publicIcons entry in brands.json', () => {
    const assetsRoot = path.resolve(__dirname, '../assets')
    for (const [slug, profile] of Object.entries(BUILTIN_BRANDS)) {
      const heroPath = path.resolve(assetsRoot, profile.heroLogo)
      const sidebarPath = path.resolve(assetsRoot, profile.sidebarLogo)
      expect({ slug, file: profile.heroLogo, exists: fs.existsSync(heroPath) }).toEqual({
        slug,
        file: profile.heroLogo,
        exists: true,
      })
      expect({
        slug,
        file: profile.sidebarLogo,
        exists: fs.existsSync(sidebarPath),
      }).toEqual({
        slug,
        file: profile.sidebarLogo,
        exists: true,
      })
      for (const [destRelPath, srcRelPath] of Object.entries(
        profile.publicIcons,
      )) {
        const iconPath = path.resolve(assetsRoot, srcRelPath)
        expect({
          slug,
          destRelPath,
          file: srcRelPath,
          exists: fs.existsSync(iconPath),
        }).toEqual({
          slug,
          destRelPath,
          file: srcRelPath,
          exists: true,
        })
      }
    }
  })

  it('synthesizes valid brand profiles for arbitrary custom project names', () => {
    const fromSlug = resolveAppBrand({ APP_BRAND: 'custom-project' })
    expect(fromSlug).toEqual({
      id: 'custom-project',
      productName: 'Custom Project',
      shortName: 'Custom Project',
      description: 'Encrypted messaging and a multichain wallet',
      appId: 'org.cashweb.customproject',
      themeColor: '#121218',
      backgroundColor: '#f7f7f2',
      heroLogo: BUILTIN_BRANDS.frank.heroLogo,
      sidebarLogo: BUILTIN_BRANDS.frank.sidebarLogo,
      publicIcons: BUILTIN_BRANDS.frank.publicIcons,
    })

    const withOverrides = resolveAppBrand({
      APP_BRAND: 'cipher',
      APP_BRAND_NAME: 'Cipher Dialogue',
      APP_BRAND_ID: 'xyz.cipher.app',
      APP_BRAND_THEME_COLOR: '#0f172a',
      APP_BRAND_HERO_LOGO: 'brand-signet/raster/icon-512x512.png',
    })
    expect(withOverrides.id).toBe('cipher')
    expect(withOverrides.productName).toBe('Cipher Dialogue')
    expect(withOverrides.shortName).toBe('Cipher Dialogue')
    expect(withOverrides.appId).toBe('xyz.cipher.app')
    expect(withOverrides.themeColor).toBe('#0f172a')
    expect(withOverrides.heroLogo).toBe('brand-signet/raster/icon-512x512.png')
  })

  it('rewrites English and French locale dictionaries for Plainspoken, Signet, Stamp, and Lotus', () => {
    for (const brandName of ['Plainspoken', 'Signet', 'Stamp', 'Lotus']) {
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

