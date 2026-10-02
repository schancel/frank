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
})
