import * as fs from 'fs'
import * as path from 'path'
import { parse } from '@vue/compiler-sfc'

/**
 * Back on a phone closes the Quasar overlay on top by sending it Escape (`utils/navigation`,
 * `dismissTopOverlay`). A `persistent` QMenu is left out of Quasar's Escape handling altogether,
 * so the Escape would go past it and close the overlay underneath; a `no-esc-dismiss` QMenu
 * ignores it, so Back could never close it. The app therefore has no such menu: use a dialog
 * (`persistent` is fine there: Back leaves it open and does nothing, by design).
 */
const SRC = path.join(__dirname, '..')
const RULE =
  'Back cannot close a persistent or no-esc-dismiss q-menu (utils/navigation dismissTopOverlay ' +
  'sends Escape to the top overlay; a persistent menu lets it through to the overlay below, a ' +
  'no-esc-dismiss menu ignores it). Use a dismissible menu, or a dialog.'
const FORBIDDEN = new Set(['persistent', 'no-esc-dismiss', 'noescdismiss'])

function files(dir: string, into: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files(full, into)
    else if (
      /\.(vue|ts|tsx|js)$/.test(entry.name) &&
      !/\.test\./.test(entry.name)
    )
      into.push(full)
  }
  return into
}

interface TemplateNode {
  type: number
  tag?: string
  props?: { type: number; name: string; arg?: { content?: string } }[]
  children?: TemplateNode[]
  loc?: { start: { line: number } }
}

/** `persistent` / `no-esc-dismiss` (plain or bound) on any `q-menu` in a template. */
function templateOffences(file: string, source: string): string[] {
  const template = parse(source, { filename: file }).descriptor.template
  if (!template?.ast) return []
  const found: string[] = []
  const visit = (node: TemplateNode) => {
    if (node.type === 1 && /^(q-menu|QMenu)$/.test(node.tag ?? '')) {
      for (const prop of node.props ?? []) {
        const name = (prop.type === 6 ? prop.name : prop.arg?.content) ?? ''
        if (FORBIDDEN.has(name.toLowerCase()))
          found.push(`${file}:${node.loc?.start.line ?? '?'} q-menu ${name}`)
      }
    }
    for (const child of node.children ?? []) visit(child)
  }
  visit(template.ast as unknown as TemplateNode)
  return found
}

/** A render function's `h(QMenu, { persistent ... })`. */
function scriptOffences(file: string, source: string): string[] {
  const found: string[] = []
  const call = /h\(\s*QMenu\s*,\s*\{([^}]*)\}/g
  for (const match of source.matchAll(call)) {
    if (/\b(persistent|noEscDismiss|'no-esc-dismiss')\b/.test(match[1] ?? ''))
      found.push(`${file}: h(QMenu, { ... }) ${match[0].slice(0, 60)}`)
  }
  return found
}

describe('no q-menu that Back cannot close', () => {
  it('no q-menu in app/src is persistent or no-esc-dismiss', () => {
    const offences: string[] = []
    for (const file of files(SRC)) {
      const source = fs.readFileSync(file, 'utf8')
      const relative = path.relative(SRC, file)
      if (file.endsWith('.vue'))
        offences.push(...templateOffences(relative, source))
      offences.push(...scriptOffences(relative, source))
    }
    expect({ rule: RULE, offences }).toEqual({ rule: RULE, offences: [] })
  })

  it('finds them in templates and render functions', () => {
    const vue = (attrs: string) =>
      `<template><div><q-btn><q-menu ${attrs}><div /></q-menu></q-btn></div></template>`
    expect(templateOffences('A.vue', vue('persistent'))).toHaveLength(1)
    expect(templateOffences('A.vue', vue(':persistent="true"'))).toHaveLength(1)
    expect(templateOffences('A.vue', vue('no-esc-dismiss'))).toHaveLength(1)
    expect(templateOffences('A.vue', vue('auto-close'))).toHaveLength(0)
    expect(
      scriptOffences('a.ts', 'h(QMenu, { persistent: true })'),
    ).toHaveLength(1)
    expect(
      scriptOffences('a.ts', 'h(QMenu, { autoClose: true })'),
    ).toHaveLength(0)
  })
})
