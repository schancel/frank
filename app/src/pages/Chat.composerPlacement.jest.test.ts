/** @jest-environment node */
// Where the chat composer sits on a wide screen. Since #1714 the composer (`<q-footer
// class="chat-footer">`) is in the chat column's flow rather than fixed by Quasar, so the iOS
// keyboard lifts it with the column; that also drops Quasar's own `left` offset past the open
// conversation-list drawer. The composer must still start where the conversation pane starts: a
// full-width footer with only its content padded over spanned the whole window bottom, its top
// border and background running across (and covering the foot of) the conversation list.
//
// jsdom cannot lay out, so this pins the two halves of the placement: MainLayout publishes the
// open drawer's width as `--frank-drawer-offset` on wide screens (0 on phones, where the drawer
// overlays), and the composer's own box is moved past it by a margin, never widened under it.
import fs from 'fs'
import path from 'path'
import * as sass from 'sass'
import { parse } from '@vue/compiler-sfc'

// Only MainLayout's computed is exercised; nothing is mounted.
jest.mock('vue-router', () => ({ useRoute: jest.fn(), useRouter: jest.fn() }))
jest.mock('../components/panels/LeftDrawer.vue', () => ({}))

import MainLayout from '../layouts/MainLayout.vue'

const SRC = path.join(__dirname, '..')

function scopedCss(file: string): string {
  const { descriptor } = parse(fs.readFileSync(file, 'utf8'), {
    filename: file,
  })
  return descriptor.styles
    .map(style =>
      style.lang === 'scss'
        ? sass.compileString(style.content, { syntax: 'scss' }).css
        : style.content,
    )
    .join('\n')
}

/** Declarations of every rule whose selector list targets the composer footer box itself
 * (`sass` output is flat: `selectors { decls }`). */
function composerFooterDecls(css: string): Record<string, string> {
  const decls: Record<string, string> = {}
  for (const [, selectors, body] of css.matchAll(/([^{};]+)\{([^{}]*)\}/g)) {
    const own = selectors.split(',').some(s => /\.chat-footer$/.test(s.trim()))
    if (!own) continue
    for (const decl of body.split(';')) {
      const colon = decl.indexOf(':')
      if (colon < 0) continue
      decls[decl.slice(0, colon).trim()] = decl.slice(colon + 1).trim()
    }
  }
  return decls
}

const layoutVars = (MainLayout as any).computed.layoutVarsStyle as (
  this: Record<string, unknown>,
) => Record<string, string>

it('wide screens publish the open drawer width as the composer offset; phones publish none', () => {
  expect(
    layoutVars.call({
      myDrawerOpen: true,
      screenWidth: 1280,
      drawerWidth: 325,
    }),
  ).toEqual({ '--frank-drawer-offset': '325px' })
  expect(
    layoutVars.call({
      myDrawerOpen: false,
      screenWidth: 1280,
      drawerWidth: 325,
    }),
  ).toEqual({ '--frank-drawer-offset': '0px' })
  expect(
    layoutVars.call({ myDrawerOpen: true, screenWidth: 375, drawerWidth: 325 }),
  ).toEqual({ '--frank-drawer-offset': '0px' })
})

it('the composer box starts after the drawer (margin), not under it (full width + padding)', () => {
  const decls = composerFooterDecls(scopedCss(path.join(SRC, 'pages/Chat.vue')))
  expect(decls.position).toMatch(/^relative/)
  expect(decls['margin-left']).toBe('var(--frank-drawer-offset, 0px)')
  expect(decls.width).not.toMatch(/100%|100vw/)
  expect(decls['padding-left'] ?? '').not.toMatch(/frank-drawer-offset/)
})

it('no global stylesheet re-places the composer footer', () => {
  const appScss = fs.readFileSync(path.join(SRC, 'css/app.scss'), 'utf8')
  const css = sass.compileString(appScss, {
    syntax: 'scss',
    loadPaths: [path.join(SRC, 'css')],
  }).css
  expect(composerFooterDecls(css)).toEqual({})
})
