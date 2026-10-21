/** @jest-environment node */
// The composer's height while typing one line. The textarea is content-sized (Quasar autogrow uses
// CSS `field-sizing: content`). An ancestor of it that is a size container (`container-type:
// inline-size`) has no intrinsic width, and Chrome sizes the composer footer by laying its content
// out at that intrinsic width: every typed character wrapped onto its own line there, so the footer
// grew about a line a keystroke (to the textarea's 140px cap) while the field on screen stayed one
// line, leaving an empty band under the composer. Measured in Chromium on the built app and the
// extension window: footer 101px empty, 120/161/202/207px after 1-4 keystrokes; 103px after this fix.
//
// jsdom cannot lay out, so this pins the CSS that decides it: no size container wraps the textarea
// (the narrow-composer stamp-pill query uses the bottom bar beside it), and the empty field is as
// tall as one typed line, so the first keystroke does not move the composer.
import fs from 'fs'
import path from 'path'
import * as sass from 'sass'
import { parse } from '@vue/compiler-sfc'

const FILE = path.join(__dirname, 'ChatInput.vue')

function rules(): { selectors: string[]; decls: Record<string, string> }[] {
  const { descriptor } = parse(fs.readFileSync(FILE, 'utf8'), {
    filename: FILE,
  })
  const css = descriptor.styles
    .map(style =>
      style.lang === 'scss'
        ? sass.compileString(style.content, { syntax: 'scss' }).css
        : style.content,
    )
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
  const out: { selectors: string[]; decls: Record<string, string> }[] = []
  for (const [, selectors, body] of css.matchAll(/([^{};]+)\{([^{}]*)\}/g)) {
    const decls: Record<string, string> = {}
    for (const decl of body.split(';')) {
      const colon = decl.indexOf(':')
      if (colon < 0) continue
      decls[decl.slice(0, colon).trim()] = decl.slice(colon + 1).trim()
    }
    out.push({ selectors: selectors.split(',').map(s => s.trim()), decls })
  }
  return out
}

/** The textarea's ancestors inside ChatInput, by the class each one's rules select it with. */
const TEXTAREA_ANCESTORS = [
  'chat-input-toolbar',
  'chat-input-container',
  'chat-input-field',
]

it('no size container encloses the content-sized textarea; the bottom bar is the container', () => {
  const all = rules()
  for (const { selectors, decls } of all) {
    if (!decls['container-type'] || decls['container-type'] === 'normal')
      continue
    for (const sel of selectors) {
      const last = sel.split(/\s+/).pop() ?? ''
      for (const cls of TEXTAREA_ANCESTORS) {
        expect([sel, last.includes(`.${cls}`)]).toEqual([sel, false])
      }
    }
  }
  const bar = all.filter(r =>
    r.selectors.some(s => /\.chat-input-bottom-bar(\[[^\]]+\])?$/.test(s)),
  )
  expect(bar.some(r => r.decls['container-type'] === 'inline-size')).toBe(true)
})

it('the empty field is exactly one typed line tall (Quasar dense textarea minimum)', () => {
  const quasarCss = fs.readFileSync(
    path.join(
      path.dirname(require.resolve('quasar/package.json')),
      'dist/quasar.css',
    ),
    'utf8',
  )
  const dense = quasarCss.match(
    /\.q-textarea\.q-field--dense \.q-field__control, \.q-textarea\.q-field--dense \.q-field__native \{\s*min-height:\s*(\d+)px/,
  )
  expect(dense).not.toBeNull()
  const oneLine = `${dense?.[1]}px`

  const empty = rules().find(r =>
    r.selectors.some(
      s =>
        s.includes('.chat-input-field--empty') &&
        s.includes('.q-field__native'),
    ),
  )
  expect(empty).toBeDefined()
  for (const prop of ['height', 'min-height', 'max-height']) {
    expect([prop, empty?.decls[prop]]).toEqual([prop, `${oneLine} !important`])
  }
})
