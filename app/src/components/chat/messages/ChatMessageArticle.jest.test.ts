/** @jest-environment jsdom */

import { mount } from '@vue/test-utils'
import type { ApplicationMessageItem } from '@frank/cashweb/types/messages'
import {
  ARTICLE_PLUGIN_ID,
  toArticleApplicationItem,
  type ArticlePayload,
} from '@frank/wallet/message-item-plugins/article'
import ArticleComposeForm from '../ArticleComposeForm.vue'
import ArticleReaderPane from '../ArticleReaderPane.vue'
import ChatMessageArticle from './ChatMessageArticle.vue'

const sampleArticle: ArticlePayload = {
  schemaVersion: 1,
  articleId: 'article-001',
  title: 'Immersive Encrypted Markdown Articles',
  summary:
    'Compact stream cards open a full-pane Markdown reader without external network leaks.',
  markdownBody: [
    '# Overview',
    '',
    'This article demonstrates **bold**, *italic*, `code`, and ~~strikethrough~~.',
    '',
    '## Checklist',
    '',
    '- [x] Safe AST rendering',
    '- [ ] Remote image blocking',
    '',
    '> Encrypted end-to-end.',
    '',
    '| Key | Value |',
    '| :--- | ---: |',
    '| Schema | v1 |',
    '',
    '```ts',
    'const ok = true;',
    '```',
    '',
    'Visit [Frank Docs](https://frank.cash/docs) or [Evil](javascript:alert(1)).',
  ].join('\n'),
  authorName: 'Grace Hopper',
  publishedAtIso: '2026-10-17T12:30:00.000Z',
  tags: ['markdown', 'privacy'],
}

const quasarStubs = {
  QBadge: {
    template: '<span class="q-badge-stub"><slot /></span>',
  },
  QBtn: {
    props: ['label', 'icon', 'disable', 'ariaLabel'],
    emits: ['click'],
    template:
      '<button type="button" :disabled="disable" :aria-label="ariaLabel" @click="$emit(\'click\', $event)">{{ label }}<slot /></button>',
  },
  QCard: {
    template: '<div class="q-card-stub"><slot /></div>',
  },
  QCardSection: {
    template: '<div class="q-card-section-stub"><slot /></div>',
  },
  QCardActions: {
    template: '<div class="q-card-actions-stub"><slot /></div>',
  },
  QSeparator: {
    template: '<hr />',
  },
  QInput: {
    props: ['modelValue', 'label', 'placeholder', 'type', 'maxlength'],
    emits: ['update:modelValue'],
    template:
      '<textarea v-if="type === \'textarea\'" :value="modelValue" :placeholder="placeholder" :aria-label="label" @input="$emit(\'update:modelValue\', $event.target.value)" /><input v-else :value="modelValue" :placeholder="placeholder" :aria-label="label" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
}

function mountCard(
  item: ApplicationMessageItem = toArticleApplicationItem(sampleArticle),
) {
  return mount(ChatMessageArticle, {
    props: { item },
    global: {
      stubs: quasarStubs,
    },
  })
}

describe('ChatMessageArticle, ArticleReaderPane, and ArticleComposeForm', () => {
  it('renders compact article card in chat stream with badge, title, author, date, reading time, summary, tags, and Open in Reader button', () => {
    const wrapper = mountCard()
    expect(
      wrapper.find('[data-testid="chat-message-article-card"]').exists(),
    ).toBe(true)
    expect(wrapper.find('[data-testid="article-card-badge"]').text()).toBe(
      'Article',
    )
    expect(wrapper.find('[data-testid="article-card-title"]').text()).toBe(
      sampleArticle.title,
    )
    expect(wrapper.find('[data-testid="article-card-author"]').text()).toContain(
      'Grace Hopper',
    )
    expect(wrapper.find('[data-testid="article-card-date"]').text()).toBe(
      '2026-10-17',
    )
    expect(
      wrapper.find('[data-testid="article-card-reading-time"]').text(),
    ).toContain('1 min read')
    expect(wrapper.find('[data-testid="article-card-summary"]').text()).toBe(
      sampleArticle.summary,
    )
    expect(wrapper.find('[data-testid="article-card-tags"]').text()).toContain(
      '#markdown',
    )
    expect(
      wrapper.find('[data-testid="article-open-reader"]').text(),
    ).toContain('Open in Reader')
  })

  it('emits openReader with article payload and opens the immersive reader pane on click, restoring state on Back or Escape', async () => {
    const wrapper = mountCard()

    const openBtn = wrapper.find('[data-testid="article-open-reader"]')
    await openBtn.trigger('click')

    expect(wrapper.emitted('openReader')?.[0]).toEqual([sampleArticle])
    expect(
      wrapper.find('[data-testid="article-reader-pane"]').exists(),
    ).toBe(true)
    expect(
      wrapper.find('[data-testid="article-reader-title"]').text(),
    ).toBe(sampleArticle.title)
    expect(
      wrapper.findAll('[data-testid="article-md-heading"]'),
    ).toHaveLength(2)
    expect(
      wrapper.find('[data-testid="article-md-code-block"]').text(),
    ).toContain('const ok = true;')
    expect(
      wrapper.find('[data-testid="article-md-table"]').exists(),
    ).toBe(true)
    expect(
      wrapper.findAll('[data-testid="article-md-task-checkbox"]'),
    ).toHaveLength(2)

    // Safe link rendered, dangerous javascript: link stripped to text
    const links = wrapper.findAll('[data-testid="article-md-link"]')
    expect(links).toHaveLength(1)
    expect(links[0]?.attributes('href')).toBe('https://frank.cash/docs')
    expect(links[0]?.attributes('rel')).toBe('noopener noreferrer')
    expect(links[0]?.attributes('target')).toBe('_blank')

    // Close via Back button
    await wrapper.find('[data-testid="article-reader-back"]').trigger('click')
    expect(
      wrapper.find('[data-testid="article-reader-pane"]').exists(),
    ).toBe(false)

    // Re-open and close via Escape key
    await openBtn.trigger('click')
    expect(
      wrapper.find('[data-testid="article-reader-pane"]').exists(),
    ).toBe(true)
    await wrapper
      .find('[data-testid="article-reader-pane"]')
      .trigger('keydown.esc')
    expect(
      wrapper.find('[data-testid="article-reader-pane"]').exists(),
    ).toBe(false)
  })

  it('supports standalone ArticleReaderPane close via window Escape key', async () => {
    const reader = mount(ArticleReaderPane, {
      props: { article: sampleArticle },
      global: { stubs: quasarStubs },
    })
    expect(reader.find('[data-testid="article-reader-pane"]').exists()).toBe(
      true,
    )
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await reader.vm.$nextTick()
    expect(reader.emitted('close')).toHaveLength(1)
    reader.unmount()
  })

  it('composes, previews, validates, and emits send(payload) in ArticleComposeForm', async () => {
    const compose = mount(ArticleComposeForm, {
      props: {
        initialArticleId: 'compose-test-01',
        initialAuthorName: 'Satoshi',
      },
      global: { stubs: quasarStubs },
    })

    expect(compose.find('[data-testid="article-compose-form"]').exists()).toBe(
      true,
    )

    await compose
      .find('[data-testid="article-compose-title"]')
      .setValue('New Protocol Proposal')
    await compose
      .find('[data-testid="article-compose-summary"]')
      .setValue('Short summary for the card')
    await compose
      .find('[data-testid="article-compose-body"]')
      .setValue('# Section 1\n\nBody text with **bold**.')
    await compose
      .find('[data-testid="article-compose-tags"]')
      .setValue('protocol, spec')

    // Toggle live preview on and off
    await compose
      .find('[data-testid="article-compose-preview-toggle"]')
      .trigger('click')
    expect(
      compose.find('[data-testid="article-compose-preview"]').exists(),
    ).toBe(true)
    expect(
      compose.find('[data-testid="article-reader-pane"]').exists(),
    ).toBe(true)
    await compose
      .find('[data-testid="article-compose-preview-toggle"]')
      .trigger('click')

    // Submit form
    await compose
      .find('[data-testid="article-compose-submit"]')
      .trigger('click')

    const emitted = compose.emitted('send')?.[0]?.[0] as
      | ArticlePayload
      | undefined
    expect(emitted).toBeDefined()
    expect(emitted).toMatchObject({
      schemaVersion: 1,
      articleId: 'compose-test-01',
      title: 'New Protocol Proposal',
      summary: 'Short summary for the card',
      authorName: 'Satoshi',
      markdownBody: '# Section 1\n\nBody text with **bold**.',
      tags: ['protocol', 'spec'],
    })
    expect(toArticleApplicationItem(emitted!).itemType).toBe(ARTICLE_PLUGIN_ID)
  })
})
