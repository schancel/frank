/** @jest-environment jsdom */

import { mount } from '@vue/test-utils'
import type { ApplicationMessageItem } from '@frank/cashweb/types/messages'
import {
  NEWSLETTER_ARTICLE_ITEM_TYPE,
  type NewsletterArticleValue,
} from '@frank/wallet/message-item-plugins/newsletter'
import { applicationRenderer } from '../../../utils/application-renderers'
import ChatMessageNewsletterArticle from './ChatMessageNewsletterArticle.vue'

const sampleArticle: NewsletterArticleValue = {
  articleId: 'dispatch-003',
  title: 'Zero-Leakage Reader Views for Encrypted Messaging',
  source: 'Stamped Dispatch',
  author: 'Elena Vance',
  summary:
    'Why self-contained CBOR article payloads eliminate web-beacon tracking.',
  body: 'First paragraph of the full dispatch.\n\nSecond paragraph with deeper technical analysis.',
  url: 'https://frank.cash/dispatch/zero-leakage-reader-views',
  imageUrl:
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  publishedAt: 1760659200000,
  tags: ['privacy', 'cbor'],
}

function makeItem(value: unknown = sampleArticle): ApplicationMessageItem {
  return {
    type: 'application',
    itemType: NEWSLETTER_ARTICLE_ITEM_TYPE,
    value,
  }
}

function mountArticle(item: ApplicationMessageItem = makeItem()) {
  return mount(ChatMessageNewsletterArticle, {
    props: { item },
    global: {
      stubs: {
        QBadge: {
          template: '<span class="q-badge-stub"><slot /></span>',
        },
        QBtn: {
          props: ['label', 'icon'],
          emits: ['click'],
          template:
            '<button type="button" @click="$emit(\'click\', $event)">{{ label }}<slot /></button>',
        },
        QDialog: {
          props: ['modelValue'],
          emits: ['update:modelValue'],
          template: '<div v-if="modelValue" class="q-dialog-stub"><slot /></div>',
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
      },
    },
  })
}

describe('ChatMessageNewsletterArticle', () => {
  it('is registered in applicationRenderer under newsletter-article-v1', () => {
    expect(applicationRenderer(NEWSLETTER_ARTICLE_ITEM_TYPE)).toBe(
      ChatMessageNewsletterArticle,
    )
  })

  it('renders compact card with source badge, date, headline, summary, and Read Article button', () => {
    const wrapper = mountArticle()
    expect(
      wrapper.find('[data-testid="newsletter-article-card"]').exists(),
    ).toBe(true)
    expect(
      wrapper.find('[data-testid="newsletter-article-source"]').text(),
    ).toBe('Stamped Dispatch')
    expect(
      wrapper.find('[data-testid="newsletter-article-date"]').text(),
    ).toBe('2025-10-17')
    expect(
      wrapper.find('[data-testid="newsletter-article-title"]').text(),
    ).toBe('Zero-Leakage Reader Views for Encrypted Messaging')
    expect(
      wrapper.find('[data-testid="newsletter-article-summary"]').text(),
    ).toBe(
      'Why self-contained CBOR article payloads eliminate web-beacon tracking.',
    )
    expect(wrapper.find('[data-testid="newsletter-read-btn"]').text()).toContain(
      'Read Article',
    )
    expect(
      wrapper.find('[data-testid="newsletter-reader-dialog"]').exists(),
    ).toBe(false)
  })

  it('falls back to a truncated body excerpt when summary is omitted', () => {
    const noSummary: NewsletterArticleValue = {
      articleId: 'dispatch-no-summary',
      title: 'Body Excerpt Test',
      source: 'Wire',
      body: 'A'.repeat(220),
      publishedAt: 1760659200000,
    }
    const wrapper = mountArticle(makeItem(noSummary))
    const summaryText = wrapper
      .find('[data-testid="newsletter-article-summary"]')
      .text()
    expect(summaryText.endsWith('…')).toBe(true)
    expect(summaryText.length).toBe(181)
  })

  it('opens the reader view modal on clicking Read Article and shows full body, author, image, tags, and closes', async () => {
    const wrapper = mountArticle()

    await wrapper.find('[data-testid="newsletter-read-btn"]').trigger('click')

    const dialog = wrapper.find('[data-testid="newsletter-reader-dialog"]')
    expect(dialog.exists()).toBe(true)
    expect(
      wrapper.find('[data-testid="newsletter-reader-title"]').text(),
    ).toBe(sampleArticle.title)
    expect(
      wrapper.find('[data-testid="newsletter-reader-author"]').text(),
    ).toContain('Elena Vance')
    expect(
      wrapper.find('[data-testid="newsletter-reader-image"]').attributes('src'),
    ).toBe(sampleArticle.imageUrl)

    const bodyEl = wrapper.find('[data-testid="newsletter-reader-body"]')
    expect(bodyEl.exists()).toBe(true)
    const paragraphs = bodyEl.findAll('p')
    expect(paragraphs).toHaveLength(2)
    expect(paragraphs[0].text()).toBe('First paragraph of the full dispatch.')
    expect(paragraphs[1].text()).toBe(
      'Second paragraph with deeper technical analysis.',
    )

    expect(wrapper.find('[data-testid="newsletter-reader-tags"]').text()).toContain(
      '#privacy',
    )
    expect(
      wrapper.find('[data-testid="newsletter-reader-url"]').attributes('href'),
    ).toBe(sampleArticle.url)

    await wrapper
      .find('[data-testid="newsletter-reader-close-btn"]')
      .trigger('click')
    expect(
      wrapper.find('[data-testid="newsletter-reader-dialog"]').exists(),
    ).toBe(false)
  })

  it('renders nothing when item.value fails validation', () => {
    const wrapper = mountArticle(makeItem({ invalid: true }))
    expect(
      wrapper.find('[data-testid="newsletter-article-card"]').exists(),
    ).toBe(false)
  })
})
