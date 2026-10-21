/** @jest-environment node */
// Safari draws a greyscale toolbar icon as a mask (accent-tinted on a highlight square while the
// extension is active on the page), so its toolbar icon carries real colour; Chrome and Firefox
// keep the transparent ink mark. These pin the manifest choice, that the brands publish every
// icon a manifest names, and that the committed Safari icons are the generator's current output.
import fs from 'fs'
import path from 'path'

import { buildExtensionManifest } from './manifests'

/* eslint-disable @typescript-eslint/no-var-requires */
const generator = require('../scripts/generate-safari-toolbar-icons.cjs')
const brands = require('../config/brands.json')

const ASSETS = path.join(__dirname, '..', 'src', 'assets')

const manifestIconPaths = (manifest: Record<string, any>) => [
  ...Object.values(manifest.icons ?? {}),
  ...Object.values(manifest.action?.default_icon ?? {}),
  ...Object.values(manifest.sidebar_action?.default_icon ?? {}),
]

it('Safari names the coloured toolbar icons; Chrome and Firefox the transparent ink mark', () => {
  const safari = buildExtensionManifest('safari')
  expect(safari.action.default_icon['32']).toBe(
    'icons/extension-safari-32x32.png',
  )
  expect(safari.icons).toEqual(safari.action.default_icon)
  expect(safari.action.default_popup).toBe('index.html')
  for (const target of ['chrome', 'firefox'] as const) {
    for (const icon of manifestIconPaths(buildExtensionManifest(target))) {
      expect(icon).toMatch(/^icons\/extension-\d+x\d+\.png$/)
    }
  }
})

it.each(['frank', 'plainspoken'])(
  'brand %s publishes every icon each extension manifest names',
  brand => {
    const published = brands[brand].publicIcons as Record<string, string>
    for (const target of ['chrome', 'firefox', 'safari'] as const) {
      for (const icon of manifestIconPaths(buildExtensionManifest(target))) {
        expect([target, icon, icon in published]).toEqual([target, icon, true])
        expect(fs.existsSync(path.join(ASSETS, published[icon]))).toBe(true)
      }
    }
  },
)

it.each(generator.SIZES as number[])(
  'the committed %ipx Safari icon is the generator output: coloured, with the mark’s alpha',
  size => {
    const source = fs.readFileSync(generator.sourcePath(size))
    const committed = fs.readFileSync(generator.outputPath(size))
    expect(
      committed.equals(
        generator.tintPng(source, generator.SAFARI_TOOLBAR_COLOR),
      ),
    ).toBe(true)

    const tinted = generator.decodeRgbaPng(committed)
    const ink = generator.decodeRgbaPng(source)
    let coloured = 0
    for (let i = 0; i < tinted.rgba.length; i += 4) {
      expect(tinted.rgba[i + 3]).toBe(ink.rgba[i + 3])
      if (tinted.rgba[i + 3] === 0) continue
      const [r, g, b] = tinted.rgba.subarray(i, i + 3)
      // Far from grey: the channels differ by a wide margin, not a rounding error.
      expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeGreaterThan(100)
      coloured++
    }
    expect(coloured).toBeGreaterThan(0)
  },
)
