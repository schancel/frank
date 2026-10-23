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
      $q: { platform: { is: { mobile: false } } },
      myDrawerOpen: true,
      screenWidth: 1280,
      drawerWidth: 325,
    }),
  ).toEqual({
    '--frank-drawer-offset': '325px',
    '--frank-bottom-nav-inset': '0px',
  })
  expect(
    layoutVars.call({
      $q: { platform: { is: { mobile: false } } },
      myDrawerOpen: false,
      screenWidth: 1280,
      drawerWidth: 325,
    }),
  ).toEqual({
    '--frank-drawer-offset': '0px',
    '--frank-bottom-nav-inset': '0px',
  })
  expect(
    layoutVars.call({
      $q: { platform: { is: { mobile: true } } },
      myDrawerOpen: true,
      screenWidth: 375,
      drawerWidth: 325,
    }),
  ).toEqual({
    '--frank-drawer-offset': '0px',
    '--frank-bottom-nav-inset': 'max(8px, env(safe-area-inset-bottom, 0px))',
  })
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

/** (ids, classes/attributes/pseudo-classes, types) of a plain compound selector chain. */
function specificity(selector: string): [number, number, number] {
  const ids = (selector.match(/#[\w-]+/g) ?? []).length
  const classes = (selector.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) ?? [])
    .length
  const types = (
    selector.replace(/[#.:][\w-]+|\[[^\]]+\]/g, ' ').match(/[a-z][\w-]*/gi) ??
    []
  ).length
  return [ids, classes, types]
}
const outranks = (a: number[], b: number[]) => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return false
}

/** Selectors (as compiled) of the rules that set `bottom` on a footer with !important. */
function footerBottomSelectors(css: string): string[] {
  const out: string[] = []
  for (const [, selectors, body] of css.matchAll(/([^{};]+)\{([^{}]*)\}/g)) {
    if (!/(^|;)\s*bottom:[^;]*!important/.test(body)) continue
    for (const s of selectors.split(',')) {
      if (/\.(q-footer|chat-footer|chat-input-bar)$/.test(s.trim()))
        out.push(s.trim())
    }
  }
  return out
}

it('the composer rule outranks the global keyboard `bottom` on .q-layout .q-footer', () => {
  // A scoped rule gains the component's [data-v-…] attribute on its last compound selector.
  const own = footerBottomSelectors(scopedCss(path.join(SRC, 'pages/Chat.vue')))
    .filter(s => /\.chat-footer$/.test(s))
    .map(s => `${s}[data-v-x]`)
  expect(own.length).toBeGreaterThan(0)

  const appScss = fs.readFileSync(path.join(SRC, 'css/app.scss'), 'utf8')
  const globals = [
    ...footerBottomSelectors(
      sass.compileString(appScss, {
        syntax: 'scss',
        loadPaths: [path.join(SRC, 'css')],
      }).css,
    ),
    ...footerBottomSelectors(
      scopedCss(path.join(SRC, 'layouts/MainLayout.vue')),
    ),
  ].filter(s => /\.q-footer$/.test(s))
  expect(globals).toContain('.q-layout .q-footer')

  expect(specificity('.q-layout .q-footer')).toEqual([0, 2, 0])
  for (const ours of own) {
    for (const theirs of globals) {
      expect([ours, outranks(specificity(ours), specificity(theirs))]).toEqual([
        ours,
        true,
      ])
    }
  }
})
