/** @jest-environment jsdom */

import { readFileSync } from 'fs'
import { resolve } from 'path'

describe('privacy font self-hosting and third-party isolation (#486)', () => {
  const indexHtmlPath = resolve(__dirname, '../../index.html')
  const indexHtml = readFileSync(indexHtmlPath, 'utf8')
  const scssPath = resolve(__dirname, 'quasar.variables.scss')
  const scssContent = readFileSync(scssPath, 'utf8')

  it('reads index.html successfully', () => {
    expect(indexHtml).toBeDefined()
    expect(indexHtml.length).toBeGreaterThan(0)
  })

  it('contains no preconnect or dns-prefetch to Google Fonts or third-party origins', () => {
    expect(indexHtml).not.toContain('fonts.googleapis.com')
    expect(indexHtml).not.toContain('fonts.gstatic.com')
    expect(indexHtml).not.toMatch(
      /<link[^>]*rel=["']preconnect["'][^>]*href=["']https?:\/\//i,
    )
    expect(indexHtml).not.toMatch(
      /<link[^>]*rel=["']dns-prefetch["'][^>]*href=["']https?:\/\//i,
    )
  })

  it('contains no remote stylesheet link tags', () => {
    expect(indexHtml).not.toMatch(
      /<link[^>]*rel=["']stylesheet["'][^>]*href=["']https?:\/\//i,
    )
  })

  it('only references local relative resources in link tags', () => {
    const linkHrefMatches = [
      ...indexHtml.matchAll(/<link[^>]*href=["']([^"']+)["']/gi),
    ]
    expect(linkHrefMatches.length).toBeGreaterThan(0)
    for (const match of linkHrefMatches) {
      const href = match[1]
      expect(href).not.toMatch(/^https?:\/\//i)
      expect(href).not.toMatch(/^\/\//)
    }
  })

  it('defines typography-font-family with system fallbacks in quasar.variables.scss', () => {
    expect(scssContent).toMatch(
      /\$typography-font-family:\s*[^;]+-apple-system/i,
    )
    expect(scssContent).toMatch(/\$typography-font-family:\s*[^;]+sans-serif/i)
  })
})
