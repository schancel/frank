<template>
  <q-card class="article-compose-card" data-testid="article-compose-form">
    <q-card-section class="row items-center justify-between q-pb-sm">
      <div class="text-h6 text-weight-bold" data-testid="article-compose-heading">
        {{ headingText }}
      </div>
      <q-btn
        flat
        dense
        no-caps
        color="primary"
        :label="previewToggleLabel"
        :aria-label="previewToggleLabel"
        data-testid="article-compose-preview-toggle"
        @click="showPreview = !showPreview"
      />
    </q-card-section>

    <q-separator />

    <q-card-section v-if="!showPreview" class="q-gutter-sm">
      <q-input
        v-model="title"
        outlined
        dense
        :maxlength="200"
        :label="titleLabel"
        :placeholder="titlePlaceholder"
        data-testid="article-compose-title"
      />

      <q-input
        v-model="summary"
        outlined
        dense
        :maxlength="500"
        :label="summaryLabel"
        :placeholder="summaryPlaceholder"
        data-testid="article-compose-summary"
      />

      <q-input
        v-model="authorName"
        outlined
        dense
        :maxlength="120"
        :label="authorLabel"
        :placeholder="authorPlaceholder"
        data-testid="article-compose-author"
      />

      <q-input
        v-model="markdownBody"
        outlined
        type="textarea"
        autogrow
        :label="bodyLabel"
        :placeholder="bodyPlaceholder"
        data-testid="article-compose-body"
      />

      <q-input
        v-model="tagsInput"
        outlined
        dense
        :label="tagsLabel"
        :placeholder="tagsPlaceholder"
        data-testid="article-compose-tags"
      />

      <div
        v-if="validationError"
        class="text-negative text-caption"
        role="alert"
        data-testid="article-compose-error"
      >
        {{ validationError }}
      </div>
    </q-card-section>

    <q-card-section v-else data-testid="article-compose-preview">
      <article-reader-pane
        v-if="previewPayload"
        :article="previewPayload"
        @close="showPreview = false"
      />
      <div v-else class="text-caption text-grey" data-testid="article-compose-preview-empty">
        {{ emptyPreviewText }}
      </div>
    </q-card-section>

    <q-separator />

    <q-card-actions align="right">
      <q-btn
        flat
        no-caps
        :label="cancelLabel"
        :aria-label="cancelLabel"
        data-testid="article-compose-cancel"
        @click="onCancel"
      />
      <q-btn
        unelevated
        no-caps
        color="primary"
        :disable="!canSubmit"
        :label="sendLabel"
        :aria-label="sendLabel"
        data-testid="article-compose-submit"
        @click="onSubmit"
      />
    </q-card-actions>
  </q-card>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import {
  ARTICLE_MAX_BODY_UTF8_BYTES,
  ARTICLE_MAX_TAGS,
  ARTICLE_MAX_TAG_CHARS,
  readArticlePayload,
  type ArticlePayload,
} from '@frank/wallet/message-item-plugins/article'
import ArticleReaderPane from './ArticleReaderPane.vue'

export default defineComponent({
  name: 'ArticleComposeForm',
  components: {
    ArticleReaderPane,
  },
  props: {
    initialAuthorName: {
      type: String,
      default: '',
    },
    initialArticleId: {
      type: String,
      default: '',
    },
  },
  emits: ['send', 'cancel'],
  data() {
    return {
      title: '',
      summary: '',
      authorName: this.initialAuthorName,
      markdownBody: '',
      tagsInput: '',
      showPreview: false,
      validationError: '',
    }
  },
  computed: {
    parsedTags(): string[] {
      return this.tagsInput
        .split(',')
        .map(tag => tag.trim())
        .filter(tag => tag.length > 0)
    },
    canSubmit(): boolean {
      return (
        this.title.trim().length > 0 && this.markdownBody.trim().length > 0
      )
    },
    previewPayload(): ArticlePayload | null {
      try {
        return this.buildPayload()
      } catch {
        return null
      }
    },
    headingText(): string {
      return this.translate('article.composeHeading', 'Compose Article')
    },
    previewToggleLabel(): string {
      return this.showPreview
        ? this.translate('article.editMarkdown', 'Edit Markdown')
        : this.translate('article.previewArticle', 'Preview')
    },
    titleLabel(): string {
      return this.translate('article.titleLabel', 'Title')
    },
    titlePlaceholder(): string {
      return this.translate('article.titlePlaceholder', 'Article headline')
    },
    summaryLabel(): string {
      return this.translate('article.summaryLabel', 'Summary (optional)')
    },
    summaryPlaceholder(): string {
      return this.translate(
        'article.summaryPlaceholder',
        'Short preview shown in the conversation',
      )
    },
    authorLabel(): string {
      return this.translate('article.authorLabel', 'Author (optional)')
    },
    authorPlaceholder(): string {
      return this.translate('article.authorPlaceholder', 'Author or pen name')
    },
    bodyLabel(): string {
      return this.translate('article.bodyLabel', 'Markdown Body')
    },
    bodyPlaceholder(): string {
      return this.translate(
        'article.bodyPlaceholder',
        '# Heading\n\nWrite your article in Markdown…',
      )
    },
    tagsLabel(): string {
      return this.translate(
        'article.tagsLabel',
        'Tags (optional, comma-separated)',
      )
    },
    tagsPlaceholder(): string {
      return this.translate('article.tagsPlaceholder', 'privacy, protocol')
    },
    emptyPreviewText(): string {
      return this.translate(
        'article.emptyPreview',
        'Enter a title and Markdown body to preview the article.',
      )
    },
    cancelLabel(): string {
      return this.translate('article.cancel', 'Cancel')
    },
    sendLabel(): string {
      return this.translate('article.sendArticle', 'Send Article')
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
    generateArticleId(): string {
      if (this.initialArticleId && this.initialArticleId.trim().length > 0) {
        return this.initialArticleId.trim().slice(0, 64)
      }
      const rand = Math.random().toString(36).slice(2, 10)
      return `art-${Date.now().toString(36)}-${rand}`.slice(0, 64)
    },
    buildPayload(): ArticlePayload {
      const candidate: ArticlePayload = {
        schemaVersion: 1,
        articleId: this.generateArticleId(),
        title: this.title.trim(),
        markdownBody: this.markdownBody,
        publishedAtIso: new Date().toISOString(),
      }
      if (this.summary.trim().length > 0) {
        candidate.summary = this.summary.trim()
      }
      if (this.authorName.trim().length > 0) {
        candidate.authorName = this.authorName.trim()
      }
      if (this.parsedTags.length > 0) {
        if (this.parsedTags.length > ARTICLE_MAX_TAGS) {
          throw new RangeError(
            `At most ${ARTICLE_MAX_TAGS} tags are allowed`,
          )
        }
        for (const tag of this.parsedTags) {
          if (tag.length > ARTICLE_MAX_TAG_CHARS) {
            throw new RangeError(
              `Each tag must be at most ${ARTICLE_MAX_TAG_CHARS} characters`,
            )
          }
        }
        candidate.tags = this.parsedTags
      }
      const bodyBytes = new TextEncoder().encode(this.markdownBody).byteLength
      if (bodyBytes > ARTICLE_MAX_BODY_UTF8_BYTES) {
        throw new RangeError(
          `Markdown body exceeds ${ARTICLE_MAX_BODY_UTF8_BYTES} bytes`,
        )
      }
      return readArticlePayload(candidate)
    },
    onSubmit() {
      this.validationError = ''
      try {
        const payload = this.buildPayload()
        this.$emit('send', payload)
      } catch (err) {
        this.validationError =
          err instanceof Error
            ? err.message
            : this.translate('article.invalidPayload', 'Invalid article fields')
      }
    },
    onCancel() {
      this.$emit('cancel')
    },
  },
})
</script>

<style lang="scss" scoped>
.article-compose-card {
  width: 100%;
  max-width: 640px;
}
</style>
