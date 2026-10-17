<template>
  <div
    v-if="article"
    class="newsletter-article-card q-pa-sm rounded-borders"
    data-testid="newsletter-article-card"
  >
    <div class="row items-center justify-between q-gutter-xs q-mb-xs">
      <q-badge
        color="primary"
        text-color="white"
        data-testid="newsletter-article-source"
      >
        {{ article.source }}
      </q-badge>
      <span
        class="text-caption newsletter-article-date"
        data-testid="newsletter-article-date"
      >
        {{ formattedDate }}
      </span>
    </div>

    <div
      class="text-subtitle2 text-weight-bold q-mb-xs"
      data-testid="newsletter-article-title"
    >
      {{ article.title }}
    </div>

    <div
      v-if="article.author"
      class="text-caption q-mb-xs newsletter-article-author"
      data-testid="newsletter-article-author"
    >
      By {{ article.author }}
    </div>

    <div
      class="text-body2 q-mb-sm newsletter-article-summary"
      data-testid="newsletter-article-summary"
    >
      {{ excerpt }}
    </div>

    <div
      v-if="article.tags && article.tags.length > 0"
      class="row q-gutter-xs q-mb-sm"
      data-testid="newsletter-article-tags"
    >
      <q-badge
        v-for="tag in article.tags"
        :key="tag"
        outline
        color="grey-7"
        class="text-caption"
      >
        #{{ tag }}
      </q-badge>
    </div>

    <div class="row items-center justify-end">
      <q-btn
        dense
        no-caps
        unelevated
        color="primary"
        icon="menu_book"
        :label="readArticleLabel"
        data-testid="newsletter-read-btn"
        @click="readerOpen = true"
      />
    </div>

    <q-dialog v-model="readerOpen" data-testid="newsletter-reader-dialog">
      <q-card class="newsletter-reader-card">
        <q-card-section class="row items-start justify-between q-pb-sm">
          <div class="col">
            <div class="row items-center q-gutter-xs q-mb-xs">
              <q-badge color="primary" text-color="white">
                {{ article.source }}
              </q-badge>
              <span class="text-caption text-grey">
                {{ formattedDate }}
              </span>
            </div>
            <div
              class="text-h6 text-weight-bold"
              data-testid="newsletter-reader-title"
            >
              {{ article.title }}
            </div>
            <div
              v-if="article.author"
              class="text-caption text-grey-7 q-mt-xs"
              data-testid="newsletter-reader-author"
            >
              {{ authorByline }}
            </div>
          </div>
          <q-btn
            flat
            round
            dense
            icon="close"
            :aria-label="closeReaderLabel"
            data-testid="newsletter-reader-close-btn"
            @click="readerOpen = false"
          />
        </q-card-section>

        <q-separator />

        <q-card-section class="newsletter-reader-scroll">
          <img
            v-if="article.imageUrl"
            :src="article.imageUrl"
            :alt="article.title"
            class="newsletter-reader-image q-mb-md rounded-borders"
            data-testid="newsletter-reader-image"
          />

          <div
            class="newsletter-reader-body text-body1"
            data-testid="newsletter-reader-body"
          >
            <p
              v-for="(paragraph, idx) in bodyParagraphs"
              :key="idx"
              class="q-mb-md"
            >
              {{ paragraph }}
            </p>
          </div>

          <div
            v-if="article.tags && article.tags.length > 0"
            class="row q-gutter-xs q-mt-md"
            data-testid="newsletter-reader-tags"
          >
            <q-badge
              v-for="tag in article.tags"
              :key="tag"
              outline
              color="primary"
            >
              #{{ tag }}
            </q-badge>
          </div>

          <div v-if="article.url" class="q-mt-md text-caption">
            <a
              :href="article.url"
              target="_blank"
              rel="noopener noreferrer"
              data-testid="newsletter-reader-url"
            >
              {{ article.url }}
            </a>
          </div>
        </q-card-section>

        <q-separator />

        <q-card-actions align="right">
          <q-btn
            flat
            no-caps
            :label="closeLabel"
            color="primary"
            data-testid="newsletter-reader-footer-close-btn"
            @click="readerOpen = false"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </div>
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue'
import type { ApplicationMessageItem } from '@frank/cashweb/types/messages'
import {
  readNewsletterArticle,
  type NewsletterArticleValue,
} from '@frank/wallet/message-item-plugins/newsletter'

const EXCERPT_MAX_CHARS = 180

export default defineComponent({
  name: 'ChatMessageNewsletterArticle',
  props: {
    item: {
      type: Object as PropType<ApplicationMessageItem>,
      required: true,
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
  data() {
    return {
      readerOpen: false,
    }
  },
  computed: {
    article(): NewsletterArticleValue | null {
      try {
        return readNewsletterArticle(this.item?.value)
      } catch {
        return null
      }
    },
    formattedDate(): string {
      if (!this.article) return ''
      const date = new Date(this.article.publishedAt)
      if (Number.isNaN(date.getTime())) return ''
      return date.toISOString().slice(0, 10)
    },
    excerpt(): string {
      if (!this.article) return ''
      if (this.article.summary) return this.article.summary
      const singleLine = this.article.body.replace(/\s+/g, ' ').trim()
      if (singleLine.length <= EXCERPT_MAX_CHARS) return singleLine
      return `${singleLine.slice(0, EXCERPT_MAX_CHARS).trimEnd()}…`
    },
    bodyParagraphs(): string[] {
      if (!this.article) return []
      return this.article.body
        .split(/\n\s*\n/)
        .map(paragraph => paragraph.trim())
        .filter(Boolean)
    },
    authorByline(): string {
      return this.article?.author ? `By ${this.article.author}` : ''
    },
    readArticleLabel(): string {
      return 'Read Article'
    },
    closeReaderLabel(): string {
      return 'Close reader'
    },
    closeLabel(): string {
      return 'Close'
    },
  },
})
</script>

<style lang="scss" scoped>
.newsletter-article-card {
  min-width: 240px;
  max-width: 440px;
  border: 1px solid rgba(128, 128, 128, 0.28);
  background: rgba(255, 255, 255, 0.06);
}

.newsletter-article-date,
.newsletter-article-author {
  opacity: 0.8;
}

.newsletter-article-summary {
  line-height: 1.4;
  opacity: 0.92;
}

.newsletter-reader-card {
  width: 100%;
  max-width: 680px;
}

.newsletter-reader-scroll {
  max-height: 70vh;
  overflow-y: auto;
}

.newsletter-reader-image {
  display: block;
  max-width: 100%;
  height: auto;
}

.newsletter-reader-body {
  line-height: 1.65;
  white-space: pre-line;
}
</style>
