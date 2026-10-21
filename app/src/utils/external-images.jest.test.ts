/**
 * @jest-environment jsdom
 *
 * External pictures on every surface that shows someone else's content: the HTML each surface
 * renders has no fetchable source, its placeholder loads the one picture on a click, and every
 * `v-html` in the app is either wired for that click or holds no content that could be a picture.
 */
import * as fs from 'fs'
import * as path from 'path'
import { parse } from '@vue/compiler-sfc'
import { defineComponent, h, withDirectives } from 'vue'
import { mount } from '@vue/test-utils'
import enUS from 'src/i18n/en-us'
import {
  EXTERNAL_IMAGE_ATTRIBUTE,
  clearMarkdownCache,
  renderMarkdown,
} from './markdown'
import { bindExternalImages, vExternalImages } from './external-images'
import ForumMessage from 'src/components/forum/ForumMessage.vue'
import ForumPost from 'src/components/forum/ForumPost.vue'
import TopicMessage from 'src/components/topic/TopicMessage.vue'
import CreatePost from 'src/pages/CreatePost.vue'
import ChatMessageText from 'src/components/chat/messages/ChatMessageText.vue'
import EmailThreadView from 'src/components/chat/email/EmailThreadView.vue'
import type { EmailItem } from '@frank/cashweb/types/messages'

jest.mock('quasar', () => ({
  ...jest.requireActual('quasar'),
  colors: { getPaletteColor: (name: string) => `mock-color(${name})` },
}))
jest.mock('@frank/wallet/chain', () => ({
  ...jest.requireActual('@frank/wallet/chain'),
  getActiveChain: () => ({ parseAddress: () => undefined }),
  onActiveChainChange: () => () => undefined,
}))

/** The real en-us messages, as `$t` resolves them. */
const translate = (key: string) =>
  key
    .split('.')
    .reduce<unknown>(
      (node, part) => (node as Record<string, unknown>)[part],
      enUS,
    ) as string

const TRACKER = 'https://tracker.example/open.gif?id=you'

/** Every attribute or style sheet in the HTML that could make the browser load something. */
function fetchable(html: string): string[] {
  const box = document.createElement('div')
  box.innerHTML = html
  return Array.from(box.querySelectorAll('*')).flatMap(el => [
    ...['src', 'srcset', 'poster', 'background', 'data', 'href']
      .filter(name => el.hasAttribute(name))
      // A link is followed only when clicked; a picture carried inline loads nothing.
      .filter(name => !(name === 'href' && el.tagName === 'A'))
      .map(name => `${el.tagName} ${name}=${el.getAttribute(name)}`)
      .filter(found => !/^IMG src=data:image\//.test(found)),
    ...[
      el.getAttribute('style') ?? '',
      el.tagName === 'STYLE' ? el.textContent ?? '' : '',
    ].filter(css => /url\s*\(|@import|image-set/i.test(css)),
  ])
}

function placeholderUrls(html: string): string[] {
  const box = document.createElement('div')
  box.innerHTML = html
  return Array.from(
    box.querySelectorAll<HTMLElement>(`[${EXTERNAL_IMAGE_ATTRIBUTE}]`),
  ).map(p => p.dataset.externalImage ?? '')
}

const dark = { $q: { dark: { isActive: false } } }
const call = (
  component: unknown,
  kind: 'methods' | 'computed',
  name: string,
  self: object,
  ...args: unknown[]
) =>
  (component as Record<string, Record<string, (...a: unknown[]) => string>>)[
    kind
  ][name].call({ ...dark, ...self }, ...args)

const email = (
  htmlBody: string,
  attachments: EmailItem['attachments'] = [],
): EmailItem => ({
  type: 'email',
  messageId: '<m@example.com>',
  from: { address: 'a@example.com' },
  to: [{ address: 'b@example.com' }],
  subject: 's',
  textBody: 't',
  htmlBody,
  attachments,
})

describe('each surface renders a tracking picture as a placeholder', () => {
  beforeEach(() => clearMarkdownCache())

  const markdown = `hi ![](${TRACKER}) <img src="${TRACKER}&raw=1">`
  const surfaces: Array<[string, () => string]> = [
    [
      'a direct message',
      () =>
        call(ChatMessageText, 'computed', 'markedMessage', {
          text: markdown,
          isReply: false,
          attachments: [],
          mentionNames: {},
        }),
    ],
    [
      'a forum message',
      () => call(ForumMessage, 'methods', 'markedMessage', {}, markdown, ''),
    ],
    [
      'a forum post',
      () => call(ForumPost, 'methods', 'markedMessage', {}, markdown, ''),
    ],
    [
      'a topic message',
      () => call(TopicMessage, 'methods', 'markedMessage', {}, markdown),
    ],
    [
      'the CreatePost preview',
      () =>
        call(CreatePost, 'computed', 'markedMessage', {
          message: markdown,
          attachments: [],
        }),
    ],
    [
      'an email body in Markdown',
      () => call(EmailThreadView, 'methods', 'formatMessageBody', {}, markdown),
    ],
    [
      'the email reply preview',
      () =>
        call(EmailThreadView, 'computed', 'renderedPreviewText', {
          replyText: markdown,
        }),
    ],
    [
      'an HTML email',
      () =>
        call(
          EmailThreadView,
          'methods',
          'sanitizedHtml',
          {},
          email(
            `<p>hi</p><img src="${TRACKER}" width="1" height="1"><img src="${TRACKER}&raw=1">`,
          ),
        ),
    ],
  ]

  it.each(surfaces)('%s', (_name, render) => {
    const html = render()
    expect(fetchable(html)).toEqual([])
    expect(placeholderUrls(html)).toEqual([TRACKER, `${TRACKER}&raw=1`])
  })

  it('an HTML email still shows its own cid: and data: pictures', () => {
    const html = call(
      EmailThreadView,
      'methods',
      'sanitizedHtml',
      {},
      email(
        '<img src="cid:logo@example.com"><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">',
        [
          {
            filename: 'logo.png',
            contentType: 'image/png',
            content: new Uint8Array([137, 80, 78, 71]),
            contentId: '<logo@example.com>',
          },
          {
            filename: 'notes.txt',
            contentType: 'text/plain',
            content: new Uint8Array([104, 105]),
            contentId: '<notes@example.com>',
          },
        ],
      ),
    )
    const box = document.createElement('div')
    box.innerHTML = html
    expect(
      Array.from(box.querySelectorAll('img')).map(i => i.getAttribute('src')),
    ).toEqual([
      'data:image/png;base64,iVBORw==',
      'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
    ])
  })
})

describe('the click-to-load placeholder', () => {
  beforeEach(() => clearMarkdownCache())

  function mountHost(markdown: string) {
    const html = renderMarkdown(markdown, false)
    return mount(
      defineComponent({
        render: () =>
          withDirectives(h('div', { innerHTML: html }), [[vExternalImages]]),
      }),
      { global: { mocks: { $t: translate } } },
    )
  }

  it('says what it is and what loading it reveals, in the reader’s language', () => {
    const wrapper = mountHost(`![](${TRACKER})`)
    const placeholder = wrapper.get(`[${EXTERNAL_IMAGE_ATTRIBUTE}]`)
    expect(placeholder.text()).toContain(enUS.chatImage.externalLabel)
    expect(placeholder.text()).toContain('tracker.example')
    expect(placeholder.attributes('title')).toBe(enUS.chatImage.externalWarning)
    expect(wrapper.find('img').exists()).toBe(false)
  })

  it('loads that one picture, in its place, when clicked', async () => {
    const wrapper = mountHost(
      `![a](${TRACKER}) ![b](https://other.example/b.png)`,
    )
    await wrapper.findAll(`[${EXTERNAL_IMAGE_ATTRIBUTE}]`)[0].trigger('click')
    const images = wrapper.findAll('img')
    expect(images.map(i => i.attributes('src'))).toEqual([TRACKER])
    expect(images[0].attributes('alt')).toBe('a')
    expect(wrapper.findAll(`[${EXTERNAL_IMAGE_ATTRIBUTE}]`)).toHaveLength(1)
  })

  it('loads on Enter for a keyboard reader', async () => {
    const wrapper = mountHost(`![](${TRACKER})`)
    await wrapper
      .get(`[${EXTERNAL_IMAGE_ATTRIBUTE}]`)
      .trigger('keydown', { key: 'Enter' })
    expect(wrapper.get('img').attributes('src')).toBe(TRACKER)
  })

  it('loads a picture in a direct message', async () => {
    const wrapper = mount(ChatMessageText, {
      props: { text: `look ![](${TRACKER})`, attachments: [] },
      global: {
        mocks: { ...dark, $t: translate, $router: { push: jest.fn() } },
      },
    })
    expect(fetchable(wrapper.html())).toEqual([])
    await wrapper.get(`[${EXTERNAL_IMAGE_ATTRIBUTE}]`).trigger('click')
    expect(wrapper.get('img').attributes('src')).toBe(TRACKER)
  })

  it('loads a picture in an email frame, whose document runs no script of its own', () => {
    const frame = document.implementation.createHTMLDocument('')
    frame.body.innerHTML = call(
      EmailThreadView,
      'methods',
      'sanitizedHtml',
      {},
      email(`<img src="${TRACKER}">`),
    )
    bindExternalImages(frame.body, translate)
    const placeholder = frame.querySelector<HTMLElement>(
      `[${EXTERNAL_IMAGE_ATTRIBUTE}]`,
    )!
    expect(placeholder.title).toBe(enUS.chatImage.externalWarning)
    placeholder.click()
    expect(frame.querySelector('img')?.getAttribute('src')).toBe(TRACKER)
  })
})

describe('every v-html in the app', () => {
  const SRC = path.join(__dirname, '..')
  // Escaped text with <mark> highlights only: nothing in it can be a picture.
  const NO_PICTURES = new Set(['components/chat/ChatList.vue'])

  interface TemplateNode {
    type: number
    props?: Array<{ type: number; name: string }>
    children?: TemplateNode[]
  }
  function unwired(node: TemplateNode, found: number[]) {
    const names = (node.props ?? []).filter(p => p.type === 7).map(p => p.name)
    if (names.includes('html') && !names.includes('external-images'))
      found.push(1)
    for (const child of node.children ?? []) unwired(child, found)
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

  it('loads external pictures only on a click (v-external-images)', () => {
    const offenders: string[] = []
    let checked = 0
    for (const file of walk(SRC).filter(f => f.endsWith('.vue'))) {
      const rel = path.relative(SRC, file).split(path.sep).join('/')
      const { descriptor } = parse(fs.readFileSync(file, 'utf8'))
      if (!descriptor.template || NO_PICTURES.has(rel)) continue
      const found: number[] = []
      unwired(descriptor.template.ast as unknown as TemplateNode, found)
      if (found.length) offenders.push(`${rel} (${found.length})`)
      if (descriptor.template.content.includes('v-html')) checked++
    }
    expect(checked).toBeGreaterThanOrEqual(6)
    expect(offenders).toEqual([])
  })
})
