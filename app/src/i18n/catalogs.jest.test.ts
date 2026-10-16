import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { baseCompile } from '@intlify/message-compiler'
import { messages, defaultLocale } from './index'
import { localeOptions } from './locale'

function flatten(value: unknown, prefix = ''): Record<string, string> {
  if (typeof value === 'string') return { [prefix]: value }
  if (!value || typeof value !== 'object')
    throw new Error(`Invalid catalog leaf: ${prefix}`)
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) =>
      Object.entries(flatten(item, prefix ? `${prefix}.${key}` : key)),
    ),
  )
}

const source = flatten(messages[defaultLocale])
const tokens = (value: string, pattern: RegExp) =>
  (value.match(pattern) ?? []).sort()

describe.each(localeOptions)(
  '$value bundled translation catalog',
  ({ value }) => {
    const catalog = flatten(messages[value])

    it('has exactly the complete English keys, including composed recovery and signed UI', () => {
      expect(Object.keys(catalog).sort()).toEqual(Object.keys(source).sort())
    })

    it('preserves interpolation, linked messages, plural alternatives, HTML and URLs', () => {
      const drift: string[] = []
      for (const [key, text] of Object.entries(catalog)) {
        if (!(key in source)) continue
        for (const pattern of [
          /\{[^{}]+\}/g,
          /@(?:\.[a-z]+)?:[\w.]+/g,
          /\|/g,
          /<\/?[^>]+>/g,
          /https?:\/\/[^\s<>"'{}]+/g,
        ]) {
          if (
            JSON.stringify(tokens(text, pattern)) !==
            JSON.stringify(tokens(source[key], pattern))
          ) {
            drift.push(key)
            break
          }
        }
      }
      expect(drift).toEqual([])
    })

    it('compiles every message with the installed Vue i18n compiler', () => {
      const errors: string[] = []
      for (const [key, text] of Object.entries(catalog)) {
        baseCompile(text, {
          onError: error => errors.push(`${key}: ${error.message}`),
        })
      }
      expect(errors).toEqual([])
    })

    if (value !== 'en-us' && value !== 'fr-fr') {
      it('contains translated values rather than fallback scaffolding', () => {
        const file = readFileSync(resolve(__dirname, value, 'index.ts'), 'utf8')
        expect(file).not.toMatch(
          /from\s+['"][^'"]*(?:en-us|account-recovery)[^'"]*['"]|\.\.\.\s*(?:enUS|english|accountRecovery)/i,
        )
        const translated = Object.entries(catalog).filter(
          ([key, text]) => text !== source[key],
        )
        expect(translated.length / Object.keys(source).length).toBeGreaterThan(
          0.8,
        )
      })
    }
  },
)
