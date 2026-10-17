<template>
  <div
    v-if="articleData"
    class="chat-message-article-card q-pa-sm rounded-borders"
    dir="auto"
    data-testid="chat-message-article-card"
  >
    <div class="row items-center justify-between q-gutter-xs q-mb-xs">
      <q-badge
        color="primary"
        text-color="white"
        data-testid="article-card-badge"
      >
        {{ badgeLabel }}
      </q-badge>
      <div class="row items-center q-gutter-xs text-caption article-card-meta">
        <span v-if="formattedDate" data-testid="article-card-date">
          {{ formattedDate }}
        </span>
        <span data-testid="article-card-reading-time">
          {{ readingTimeLabel }}
        </span>
      </div>
    </div>

    <div
      class="text-subtitle1 text-weight-bold q-mb-xs"
      dir="auto"
      data-testid="article-card-title"
    >
      {{ articleData.title }}
    </div>

    <div
      v-if="authorByline"
      class="text-caption q-mb-xs article-card-author"
      dir="auto"
      data-testid="article-card-author"
    >
      {{ authorByline }}
    </div>

    <div
      class="text-body2 q-mb-sm article-card-summary"
      dir="auto"
      data-testid="article-card-summary"
    >
      {{ summaryExcerpt }}
    </div>

    <div
      v-if="articleData.tags && articleData.tags.length > 0"
      class="row q-gutter-xs q-mb-sm"
      data-testid="article-card-tags"
    >
      <q-badge
        v-for="tag in articleData.tags"
        :key="tag"
        outline
        color="grey-7"
        class="text-caption"
      >
        {{ formatTag(tag) }}
      </q-badge>
    </div>

    <div class="row items-center justify-end">
      <q-btn
        ref="openReaderBtn"
        dense
        no-caps
        unelevated
        color="primary"
        icon="menu_book"
        :label="openReaderLabel"
        :aria-label="openReaderAriaLabel"
        data-testid="article-open-reader"
        @click="onOpenReader"
      />
    </div>

    <div
      v-if="inlineReaderOpen"
      class="q-mt-sm"
      data-testid="article-inline-reader-wrapper"
    >
      <article-reader-pane
        :article="articleData"
        @close="onCloseInlineReader"
      />
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue'
import type { ApplicationMessageItem } from '@frank/cashweb/types/messages'
import {
  estimateArticleReadingMinutes,
  parseArticleApplicationItem,
  type ArticlePayload,
} from '@frank/wallet/message-item-plugins/article'
import ArticleReaderPane from '../ArticleReaderPane.vue'

const SUMMARY_EXCERPT_MAX_CHARS = 180

export default defineComponent({
  name: 'ChatMessageArticle',
  components: {
    ArticleReaderPane,
  },
  props: {
    item: {
      type: Object as PropType<ApplicationMessageItem | ArticlePayload>,
      default: undefined,
    },
    article: {
      type: Object as PropType<ArticlePayload>,
      default: undefined,
    },
    address: {
      type: String,
      default: '',
    },
    conversationId: {
      type: String,
      default: '',
    },
    deliveryStatus: {
      type: String,
      default: '',
    },
    senderAddress: {
      type: String,
      default: '',
    },
    outbound: {
      type: Boolean,
      default: false,
    },
  },
  emits: ['openReader', 'open-reader'],
  data() {
    return {
      inlineReaderOpen: false,
    }
  },
  computed: {
    articleData(): ArticlePayload | null {
      if (this.article) {
        return parseArticleApplicationItem(this.article)
      }
      if (this.item) {
        return parseArticleApplicationItem(this.item)
      }
      return null
    },
    formattedDate(): string {
      if (!this.articleData) return ''
      const date = new Date(this.articleData.publishedAtIso)
      if (Number.isNaN(date.getTime())) return ''
      return date.toISOString().slice(0, 10)
    },
    readingMinutes(): number {
      if (!this.articleData) return 1
      return estimateArticleReadingMinutes(this.articleData.markdownBody)
    },
    readingTimeLabel(): string {
      return this.translate(
        'article.readingTimeMinutes',
        `${this.readingMinutes} min read`,
        { minutes: this.readingMinutes },
      )
    },
    authorByline(): string {
      if (!this.articleData?.authorName) return ''
      return this.translate(
        'article.byAuthor',
        `By ${this.articleData.authorName}`,
        { author: this.articleData.authorName },
      )
    },
    summaryExcerpt(): string {
      if (!this.articleData) return ''
      if (this.articleData.summary) return this.articleData.summary
      const stripped = this.articleData.markdownBody
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/^[#>*\-\d.]+\s+/gm, '')
        .replace(/[*_`~[\]]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
      if (stripped.length <= SUMMARY_EXCERPT_MAX_CHARS) return stripped
      return `${stripped.slice(0, SUMMARY_EXCERPT_MAX_CHARS).trimEnd()}…`
    },
    badgeLabel(): string {
      return this.translate('article.badge', 'Article')
    },
    openReaderLabel(): string {
      return this.translate('article.openInReader', 'Open in Reader')
    },
    openReaderAriaLabel(): string {
      if (!this.articleData) return this.openReaderLabel
      return this.translate(
        'article.openInReaderAria',
        `Open in Reader: ${this.articleData.title}`,
        { title: this.articleData.title },
      )
    },
  },
  methods: {
    translate(
      key: string,
      fallback: string,
      values?: Record<string, unknown>,
    ): string {
      const internal = (
        this as unknown as {
          $?: { appContext?: { config?: { globalProperties?: Record<string, unknown> } } }
        }
      ).$
      const gp = internal?.appContext?.config?.globalProperties
      const t = gp?.$t as
        | ((k: string, v?: Record<string, unknown>) => string)
        | undefined
      if (typeof t === 'function') {
        try {
          const result = t.call(this, key, values)
          if (typeof result === 'string' && result !== key && result.length > 0) {
            return result
          }
        } catch {
          return fallback
        }
      }
      return fallback
    },
    formatTag(tag: string): string {
      return `#${tag}`
    },
    onOpenReader() {
      if (!this.articleData) return
      this.inlineReaderOpen = true
      this.$emit('openReader', this.articleData)
      this.$emit('open-reader', this.articleData)
    },
    onCloseInlineReader() {
      this.inlineReaderOpen = false
      const btnRef = this.$refs.openReaderBtn as
        | { $el?: HTMLElement; focus?: () => void }
        | HTMLElement
        | undefined
      if (btnRef && typeof (btnRef as { focus?: () => void }).focus === 'function') {
        ;(btnRef as { focus: () => void }).focus()
      } else if (
        btnRef &&
        '$el' in btnRef &&
        btnRef.$el &&
        typeof btnRef.$el.focus === 'function'
      ) {
        btnRef.$el.focus()
      }
    },
  },
})
</script>

<style lang="scss" scoped>
.chat-message-article-card {
  min-width: 240px;
  max-width: 460px;
  border: 1px solid rgba(128, 128, 128, 0.28);
  background: rgba(255, 255, 255, 0.06);
}

.article-card-meta,
.article-card-author {
  opacity: 0.8;
}

.article-card-summary {
  line-height: 1.45;
  opacity: 0.92;
}
</style>
