import { readFileSync } from 'fs'
import { resolve } from 'path'

import { parse } from '@vue/compiler-sfc'

const forumCards = ['ForumPost.vue', 'ForumMessage.vue']

describe('forum card width', () => {
  test.each(forumCards)('%s leaves width to the full block container', file => {
    const source = readFileSync(resolve(__dirname, file), 'utf8')
    const { descriptor } = parse(source)
    const rootCard = descriptor.template?.content.match(/<q-card\b[^>]*>/)?.[0]
    const scopedCss = descriptor.styles.map(style => style.content).join('\n')

    expect(rootCard).toBeDefined()
    expect(rootCard).not.toContain('max-w-720')
    expect(scopedCss).not.toMatch(/\.max-w-720\s*\{/)
  })
  test.each(forumCards)(
    '%s uses full-width post body and bottom vote/action pills without a left vote-column gutter',
    file => {
      const source = readFileSync(resolve(__dirname, file), 'utf8')
      const { descriptor } = parse(source)
      const template = descriptor.template?.content ?? ''
      const scopedCss = descriptor.styles.map(style => style.content).join('\n')

      expect(template).not.toContain('vote-column')
      expect(scopedCss).not.toMatch(/\.vote-column\s*\{/)
      expect(template).toContain('post-meta-header')
      expect(template).toContain('data-test="forum-vote-pill"')
      expect(template).toContain('forum-action-pill')
    },
  )
})

// The feed and the thread view both sit in ForumLayout's scroll area, which owns the
// content-pane width and side gutter. Neither page may narrow or recenter itself, so the
// list cards and the thread cards span the same width.
describe('forum page width', () => {
  const pagesDir = resolve(__dirname, '../../pages')
  const layout = parse(
    readFileSync(resolve(__dirname, '../../layouts/ForumLayout.vue'), 'utf8'),
  ).descriptor

  test('ForumLayout scroll area hosts the forum routes with the shared gutter', () => {
    const template = layout.template?.content ?? ''
    const scrollArea = template.match(/<q-scroll-area\b[^>]*>/)?.[0]
    expect(scrollArea).toContain('q-px-sm')
    expect(scrollArea).toContain('full-width')
    expect(template).toMatch(
      /<q-scroll-area[\s\S]*<router-view[\s\S]*<\/q-scroll-area>/,
    )
  })

  test.each(['Forum.vue', 'ForumPost.vue'])(
    '%s does not constrain, center or re-gutter its content',
    file => {
      const { descriptor } = parse(
        readFileSync(resolve(pagesDir, file), 'utf8'),
      )
      const css = descriptor.styles.map(style => style.content).join('\n')
      const rootTag =
        descriptor.template?.content.match(/<[a-z][\w-]*\b[^>]*>/)?.[0] ?? ''

      expect(css).not.toMatch(/max-width/)
      expect(css).not.toMatch(/margin:\s*0\s+auto/)
      expect(css).not.toMatch(/padding:\s*\S+\s+(?!0[\s;])\S+/)
      expect(rootTag).not.toMatch(/q-p[xa]-|q-m[xa]-|max-w|mx-auto/)
    },
  )
})
