<template>
  <q-card class="article-compose-card" data-testid="article-compose-form">
    <q-card-section
      class="row items-center justify-between q-pb-sm article-compose-header"
    >
      <div
        class="text-h6 text-weight-bold"
        data-testid="article-compose-heading"
      >
        {{ headingText }}
      </div>
      <q-btn
        flat
        dense
        no-caps
        color="primary"
        class="article-compose-preview-btn"
        :label="previewToggleLabel"
        :aria-label="previewToggleLabel"
        data-testid="article-compose-preview-toggle"
        @click="showPreview = !showPreview"
      />
    </q-card-section>

    <q-separator />

    <q-card-section
      v-if="!showPreview"
      class="q-gutter-sm article-compose-fields"
    >
      <q-input
        v-model="title"
        outlined
        dense
        class="article-compose-field"
        :maxlength="200"
        :label="titleLabel"
        :placeholder="titlePlaceholder"
        data-testid="article-compose-title"
      />

      <div class="row q-col-gutter-sm">
        <div class="col-12 col-sm-7">
          <q-input
            v-model="summary"
            outlined
            dense
            class="article-compose-field"
            :maxlength="500"
            :label="summaryLabel"
            :placeholder="summaryPlaceholder"
            data-testid="article-compose-summary"
          />
        </div>
        <div class="col-12 col-sm-5">
          <q-input
            v-model="authorName"
            outlined
            dense
            class="article-compose-field"
            :maxlength="120"
            :label="authorLabel"
            :placeholder="authorPlaceholder"
            data-testid="article-compose-author"
          />
        </div>
      </div>

      <div class="article-editor-box">
        <div
          class="article-format-toolbar row items-center q-gutter-xs"
          role="toolbar"
          :aria-label="toolbarAriaLabel"
          data-testid="article-compose-toolbar"
        >
          <q-btn
            v-for="tool in toolbarActions"
            :key="tool.id"
            flat
            dense
            no-caps
            size="sm"
            :icon="tool.icon"
            :label="tool.shortLabel"
            :aria-label="tool.ariaLabel"
            :data-testid="tool.testId"
            class="article-toolbar-btn"
            @click="applyMarkdownFormat(tool.id)"
          />
        </div>

        <q-input
          ref="bodyInput"
          v-model="markdownBody"
          outlined
          type="textarea"
          autogrow
          class="article-compose-field article-compose-body-field"
          :input-style="{ minHeight: '180px', lineHeight: '1.6' }"
          :label="bodyLabel"
          :placeholder="bodyPlaceholder"
          data-testid="article-compose-body"
        />
      </div>

      <q-input
        v-model="tagsInput"
        outlined
        dense
        class="article-compose-field"
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

    <q-card-section
      v-else
      class="article-compose-preview-section"
      data-testid="article-compose-preview"
    >
      <article-reader-pane
        v-if="previewPayload"
        :article="previewPayload"
        @close="showPreview = false"
      />
      <div
        v-else
        class="text-caption text-grey"
        data-testid="article-compose-preview-empty"
      >
        {{ emptyPreviewText }}
      </div>
    </q-card-section>

    <q-separator />

    <q-card-actions align="right" class="q-px-md q-py-sm">
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
        class="article-compose-submit-btn"
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

type MarkdownFormatAction =
  | 'bold'
  | 'italic'
  | 'heading'
  | 'quote'
  | 'code'
  | 'list'
  | 'link'

interface ToolbarButtonDescriptor {
  id: MarkdownFormatAction
  icon: string
  shortLabel: string
  ariaLabel: string
  testId: string
}

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
        .map(tag => tag.trim().replace(/^#+/, '').trim())
        .filter(tag => tag.length > 0)
    },
    canSubmit(): boolean {
      return this.title.trim().length > 0 && this.markdownBody.trim().length > 0
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
    toolbarAriaLabel(): string {
      return this.translate('article.formattingToolbar', 'Formatting toolbar')
    },
    toolbarActions(): ToolbarButtonDescriptor[] {
      return [
        {
          id: 'bold',
          icon: 'format_bold',
          shortLabel: this.translate('article.formatBoldShort', 'Bold'),
          ariaLabel: this.translate(
            'article.formatBoldAria',
            'Insert bold text',
          ),
          testId: 'article-toolbar-bold',
        },
        {
          id: 'italic',
          icon: 'format_italic',
          shortLabel: this.translate('article.formatItalicShort', 'Italic'),
          ariaLabel: this.translate(
            'article.formatItalicAria',
            'Insert italic text',
          ),
          testId: 'article-toolbar-italic',
        },
        {
          id: 'heading',
          icon: 'title',
          shortLabel: this.translate('article.formatHeadingShort', 'Heading'),
          ariaLabel: this.translate(
            'article.formatHeadingAria',
            'Insert heading',
          ),
          testId: 'article-toolbar-heading',
        },
        {
          id: 'quote',
          icon: 'format_quote',
          shortLabel: this.translate('article.formatQuoteShort', 'Quote'),
          ariaLabel: this.translate('article.formatQuoteAria', 'Insert quote'),
          testId: 'article-toolbar-quote',
        },
        {
          id: 'code',
          icon: 'code',
          shortLabel: this.translate('article.formatCodeShort', 'Code'),
          ariaLabel: this.translate('article.formatCodeAria', 'Insert code'),
          testId: 'article-toolbar-code',
        },
        {
          id: 'list',
          icon: 'format_list_bulleted',
          shortLabel: this.translate('article.formatListShort', 'List'),
          ariaLabel: this.translate(
            'article.formatListAria',
            'Insert bullet list',
          ),
          testId: 'article-toolbar-list',
        },
        {
          id: 'link',
          icon: 'link',
          shortLabel: this.translate('article.formatLinkShort', 'Link'),
          ariaLabel: this.translate('article.formatLinkAria', 'Insert link'),
          testId: 'article-toolbar-link',
        },
      ]
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
          $?: {
            appContext?: {
              config?: { globalProperties?: Record<string, unknown> }
            }
          }
        }
      ).$
      const gp = internal?.appContext?.config?.globalProperties
      const t = gp?.$t as
        | ((k: string, v?: Record<string, unknown>) => string)
        | undefined
      if (typeof t === 'function') {
        try {
          const result = t.call(this, key, values)
          if (
            typeof result === 'string' &&
            result !== key &&
            result.length > 0
          ) {
            return result
          }
        } catch {
          return fallback
        }
      }
      return fallback
    },
    resolveTextareaElement(): HTMLTextAreaElement | null {
      const refObj = this.$refs.bodyInput as
        | HTMLTextAreaElement
        | { $el?: HTMLElement; getNativeElement?: () => HTMLElement }
        | undefined
      if (!refObj) return null
      if (
        typeof HTMLTextAreaElement !== 'undefined' &&
        refObj instanceof HTMLTextAreaElement
      ) {
        return refObj
      }
      if (
        'getNativeElement' in refObj &&
        typeof refObj.getNativeElement === 'function'
      ) {
        const el = refObj.getNativeElement()
        if (el && el.tagName === 'TEXTAREA') return el as HTMLTextAreaElement
      }
      if ('$el' in refObj && refObj.$el) {
        if (refObj.$el.tagName === 'TEXTAREA') {
          return refObj.$el as HTMLTextAreaElement
        }
        const nested = refObj.$el.querySelector?.('textarea')
        if (nested) return nested
      }
      return null
    },
    applyMarkdownFormat(action: MarkdownFormatAction) {
      const textarea = this.resolveTextareaElement()
      const current = this.markdownBody
      const start =
        textarea && typeof textarea.selectionStart === 'number'
          ? textarea.selectionStart
          : current.length
      const end =
        textarea && typeof textarea.selectionEnd === 'number'
          ? textarea.selectionEnd
          : current.length
      const selected = current.slice(start, end)
      const before = current.slice(0, start)
      const after = current.slice(end)
      const needsLeadingNewline =
        before.length > 0 && !before.endsWith('\n') ? '\n' : ''

      let insertion = ''
      switch (action) {
        case 'bold':
          insertion = `**${
            selected || this.translate('article.sampleBold', 'bold text')
          }**`
          break
        case 'italic':
          insertion = `*${
            selected || this.translate('article.sampleItalic', 'italic text')
          }*`
          break
        case 'heading':
          insertion = `${needsLeadingNewline}## ${
            selected ||
            this.translate('article.sampleHeading', 'Section heading')
          }\n`
          break
        case 'quote':
          insertion = `${needsLeadingNewline}> ${
            selected || this.translate('article.sampleQuote', 'Quoted insight')
          }\n`
          break
        case 'code':
          if (selected.includes('\n')) {
            insertion = `${needsLeadingNewline}\`\`\`\n${selected}\n\`\`\`\n`
          } else {
            insertion = `\`${
              selected || this.translate('article.sampleCode', 'code')
            }\``
          }
          break
        case 'list':
          insertion = `${needsLeadingNewline}- ${
            selected || this.translate('article.sampleListItem', 'List item')
          }\n`
          break
        case 'link':
          insertion = `[${
            selected || this.translate('article.sampleLinkText', 'link text')
          }](https://example.com)`
          break
      }

      this.markdownBody = `${before}${insertion}${after}`
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
          throw new RangeError(`At most ${ARTICLE_MAX_TAGS} tags are allowed`)
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
  width: min(720px, 94vw);
  max-width: 720px;
  border-radius: 18px;
  background: #ffffff;
  color: #0f172a;
  box-shadow: 0 18px 48px rgba(15, 23, 42, 0.18);

  :deep(.q-field--outlined .q-field__control) {
    border-radius: 10px !important;
  }

  :deep(.q-field--outlined.article-compose-body-field .q-field__control) {
    border-top-left-radius: 0 !important;
    border-top-right-radius: 0 !important;
  }
}

.article-editor-box {
  border-radius: 10px;
}

.article-format-toolbar {
  padding: 6px 8px;
  background: #f8fafc;
  border: 1px solid rgba(15, 23, 42, 0.18);
  border-bottom: none;
  border-radius: 10px 10px 0 0;
}

.article-toolbar-btn {
  border-radius: 6px;
  color: #334155;
  font-weight: 600;
}

.article-compose-preview-section {
  min-height: 280px;
  max-height: 68vh;
  overflow-y: auto;
}

.article-compose-submit-btn {
  border-radius: 999px;
  padding: 4px 16px;
  font-weight: 600;
}

:global(.body--dark) .article-compose-card,
.body--dark .article-compose-card {
  background: #0f172a;
  color: #f8fafc;
  border: 1px solid rgba(255, 255, 255, 0.12);

  .article-format-toolbar {
    background: #1e293b;
    border-color: rgba(255, 255, 255, 0.18);
  }

  .article-toolbar-btn {
    color: #e2e8f0;
  }
}
</style>
