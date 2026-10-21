import fs from 'fs'
import path from 'path'
import * as sass from 'sass'
import { parse } from '@vue/compiler-sfc'

/**
 * In a scoped <style>, Vue compiles `:global(A) B` to just `A`: everything after the `:global()`
 * is dropped. `:global(body.body--dark) .forum-vote-pill { background: ... }` therefore set the
 * background of <body> itself, and every dark page turned a light, translucent colour once the
 * forum or chat had been opened. A theme-dependent descendant rule in scoped CSS is written as a
 * plain `body.body--dark .x` (the scope attribute lands on `.x`).
 *
 * SCSS nesting is flattened first, so `:global(x) { .y {} }` is caught as `:global(x) .y`.
 */
const SRC = path.join(__dirname, '..')

function vueFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) vueFiles(full, out)
    else if (entry.name.endsWith('.vue')) out.push(full)
  }
  return out
}

it('no scoped style puts selectors after :global(...)', () => {
  const offenders: string[] = []
  for (const file of vueFiles(SRC)) {
    const { descriptor } = parse(fs.readFileSync(file, 'utf8'), {
      filename: file,
    })
    for (const style of descriptor.styles) {
      if (!style.scoped || !style.content.includes(':global(')) continue
      const css =
        style.lang === 'scss'
          ? sass.compileString(style.content, { syntax: 'scss' }).css
          : style.content
      for (const match of css.matchAll(
        /:global\([^)]*\)[ \t]*[^\s,{][^,{]*/g,
      )) {
        offenders.push(`${path.relative(SRC, file)}: ${match[0].trim()}`)
      }
    }
  }
  expect(offenders).toEqual([])
})
