import * as fs from 'fs'
import * as path from 'path'
import { parse } from '@vue/compiler-sfc'

/**
 * Ratchet against user-visible English that bypasses the locale files (ticket #274).
 *
 * Every `.vue` template is scanned for literal text nodes and for literal values of the attributes
 * that reach the screen or a screen reader (label, aria-label, placeholder, title, hint, caption,
 * alt, ...). A literal counts when it holds a word (three letters in a row); `{{ }}` interpolations
 * and bound (`:label="$t(...)"`) attributes are not literals.
 *
 * BASELINE is the debt that existed when this test was written, per file. It can only shrink: a
 * file over its baseline fails (translate the new string with `$t`), and a file under it fails too
 * (lower the number here so the debt cannot creep back). A file not listed must have none.
 * EXEMPT files are content, not UI chrome, and stay English by design.
 */
const SRC = path.join(__dirname, '..')

const EXEMPT = new Set([
  // Release notes are authored content, one language.
  'pages/Changelog.vue',
])

const BASELINE: Record<string, number> = {
  'components/chat/messages/ChatMessageRaffle.vue': 9,
  'components/context_menus/ChatMessageMenu.vue': 6,
  'components/dialogs/RelayConnectDialog.vue': 3,
  'components/forum/ForumMessage.vue': 2,
  'components/forum/ForumPost.vue': 1,
  'components/panels/ForumDrawer.vue': 6,
  'components/panels/LeftDrawer.vue': 0,
  'components/StatusFooter.vue': 1,
  'components/SubscribeDialog.vue': 9,
  'components/topic/TopicDrawer.vue': 2,
  'components/topic/TopicList.vue': 1,
  'components/topic/TopicMessage.vue': 0,
  'layouts/ForumLayout.vue': 0,
  'pages/AddContact.vue': 2,
  'pages/Chat.vue': 1,
  'components/chat/messages/ChatMessageChannel.vue': 28,
  'components/chat/messages/ChatMessageDice.vue': 16,
  'components/chat/messages/ChatMessageLiarsDice.vue': 21,
  'components/chat/messages/ChatMessagePoker.vue': 16,
  'components/chat/messages/ChatMessageRps.vue': 17,
  'pages/CreatePost.vue': 10,
  'pages/Settings.vue': 1,
  'pages/Topic.vue': 1,
  'components/topic/GameAnnouncementCard.vue': 4,
}

const VISIBLE_ATTRS = new Set([
  'label',
  'aria-label',
  'placeholder',
  'title',
  'hint',
  'caption',
  'alt',
  'message',
  'stack-label',
])
const hasWord = (text: string) => /[A-Za-z]{3,}/.test(text)

interface TemplateNode {
  type: number
  content?: string
  props?: Array<{ type: number; name: string; value?: { content: string } }>
  children?: TemplateNode[]
}

function literalsIn(node: TemplateNode, found: string[]) {
  if (node.type === 2 && node.content !== undefined) {
    const text = node.content.trim()
    if (hasWord(text)) found.push(`text: ${text}`)
  }
  if (node.type === 1) {
    for (const prop of node.props ?? []) {
      // type 6 = a plain attribute (a `:bound` one is a directive, type 7)
      if (
        prop.type === 6 &&
        VISIBLE_ATTRS.has(prop.name) &&
        prop.value &&
        hasWord(prop.value.content)
      ) {
        found.push(`${prop.name}: ${prop.value.content}`)
      }
    }
  }
  for (const child of node.children ?? []) literalsIn(child, found)
}

function walk(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap(entry =>
      entry.isDirectory()
        ? walk(path.join(dir, entry.name))
        : [path.join(dir, entry.name)],
    )
}

const literalsByFile: Record<string, string[]> = {}
for (const file of walk(SRC).filter(f => f.endsWith('.vue'))) {
  const rel = path.relative(SRC, file).split(path.sep).join('/')
  if (EXEMPT.has(rel)) continue
  const { descriptor } = parse(fs.readFileSync(file, 'utf8'))
  const found: string[] = []
  if (descriptor.template) {
    literalsIn(descriptor.template.ast as unknown as TemplateNode, found)
  }
  if (found.length > 0) literalsByFile[rel] = found
}

describe('hard-coded user-visible strings in templates (ticket #274)', () => {
  it('scans real templates (sanity check)', () => {
    expect(Object.keys(literalsByFile).length).toBeGreaterThan(10)
  })

  it('the strings ticket #274 named are gone from their components', () => {
    const all = Object.values(literalsByFile).flat()
    for (const gone of [
      'No posts yet.',
      'No forums discovered yet.',
      'Failed to send',
      'Show message actions',
      'Stamp payment',
    ]) {
      expect(all).not.toContain(`text: ${gone}`)
      expect(all).not.toContain(`aria-label: ${gone}`)
      expect(all).not.toContain(`label: ${gone}`)
    }
  })

  it.each(Object.keys({ ...BASELINE, ...literalsByFile }).sort())(
    '%s has no more literals than its baseline, and none it could drop',
    rel => {
      const found = literalsByFile[rel] ?? []
      const allowed = BASELINE[rel] ?? 0
      if (found.length > allowed) {
        throw new Error(
          `${rel} has ${found.length} hard-coded string(s), baseline ${allowed}. ` +
            `Use $t() with en-us and fr-fr keys instead of:\n  ${found.join(
              '\n  ',
            )}`,
        )
      }
      if (found.length < allowed) {
        throw new Error(
          `${rel} now has ${found.length} hard-coded string(s); lower its BASELINE entry from ${allowed}.`,
        )
      }
    },
  )
})
