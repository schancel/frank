<template>
  <section
    v-if="validArticle"
    ref="readerRoot"
    class="article-reader-pane column full-height"
    tabindex="-1"
    dir="auto"
    :aria-label="readerAriaLabel"
    data-testid="article-reader-pane"
    @keydown.esc.stop.prevent="emitClose"
  >
    <header
      class="article-reader-header row items-center justify-between q-px-md q-py-sm"
      data-testid="article-reader-header"
    >
      <div class="row items-center q-gutter-sm">
        <q-btn
          flat
          dense
          no-caps
          icon="arrow_back"
          color="primary"
          :label="backButtonLabel"
          :aria-label="backButtonAriaLabel"
          data-testid="article-reader-back"
          @click="emitClose"
        />
        <q-badge
          color="primary"
          text-color="white"
          data-testid="article-reader-badge"
        >
          {{ badgeLabel }}
        </q-badge>
      </div>
      <div
        class="row items-center q-gutter-xs text-caption article-reader-meta"
        data-testid="article-reader-meta"
      >
        <span v-if="formattedDate" data-testid="article-reader-date">
          {{ formattedDate }}
        </span>
        <span v-if="readingTimeText" data-testid="article-reader-reading-time">
          {{ readingTimeText }}
        </span>
      </div>
    </header>

    <q-separator />

    <div
      class="article-reader-scroll col q-pa-lg"
      data-testid="article-reader-scroll"
    >
      <article class="article-reader-content">
        <h1
          class="text-h4 text-weight-bold q-mt-none q-mb-sm"
          dir="auto"
          data-testid="article-reader-title"
        >
          {{ validArticle.title }}
        </h1>

        <div
          v-if="authorByline"
          class="text-subtitle2 q-mb-md article-reader-author"
          dir="auto"
          data-testid="article-reader-author"
        >
          {{ authorByline }}
        </div>

        <p
          v-if="validArticle.summary"
          class="text-subtitle1 q-mb-md article-reader-summary"
          dir="auto"
          data-testid="article-reader-summary"
        >
          {{ validArticle.summary }}
        </p>

        <div
          v-if="validArticle.tags && validArticle.tags.length > 0"
          class="row q-gutter-xs q-mb-md"
          data-testid="article-reader-tags"
        >
          <q-badge
            v-for="tag in validArticle.tags"
            :key="tag"
            class="article-reader-tag-pill"
          >
            {{ formatTag(tag) }}
          </q-badge>
        </div>

        <q-separator class="q-mb-md" />

        <div
          class="article-markdown-body"
          dir="auto"
          data-testid="article-reader-body"
        >
          <template v-for="(block, blockIdx) in blocks" :key="blockIdx">
            <component
              :is="headingTag(block.level)"
              v-if="block.type === 'heading'"
              :id="block.id"
              class="article-md-heading text-weight-bold q-mt-lg q-mb-sm"
              dir="auto"
              data-testid="article-md-heading"
            >
              <template v-for="(node, nodeIdx) in block.inlines" :key="nodeIdx">
                <a
                  v-if="node.type === 'link'"
                  :href="node.href"
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid="article-md-link"
                >
                  {{ flattenInlineText(node.children) }}
                </a>
                <code v-else-if="node.type === 'code'">{{ node.code }}</code>
                <strong v-else-if="node.type === 'strong'">
                  {{ flattenInlineText(node.children) }}
                </strong>
                <em v-else-if="node.type === 'em'">
                  {{ flattenInlineText(node.children) }}
                </em>
                <del v-else-if="node.type === 'del'">
                  {{ flattenInlineText(node.children) }}
                </del>
                <span v-else>{{ node.text }}</span>
              </template>
            </component>

            <p
              v-else-if="block.type === 'paragraph'"
              class="article-md-paragraph q-mb-md"
              dir="auto"
              data-testid="article-md-paragraph"
            >
              <template v-for="(node, nodeIdx) in block.inlines" :key="nodeIdx">
                <a
                  v-if="node.type === 'link'"
                  :href="node.href"
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid="article-md-link"
                >
                  {{ flattenInlineText(node.children) }}
                </a>
                <code v-else-if="node.type === 'code'">{{ node.code }}</code>
                <strong v-else-if="node.type === 'strong'">
                  {{ flattenInlineText(node.children) }}
                </strong>
                <em v-else-if="node.type === 'em'">
                  {{ flattenInlineText(node.children) }}
                </em>
                <del v-else-if="node.type === 'del'">
                  {{ flattenInlineText(node.children) }}
                </del>
                <span v-else>{{ node.text }}</span>
              </template>
            </p>

            <pre
              v-else-if="block.type === 'code-block'"
              class="article-md-code-block q-pa-md q-mb-md rounded-borders"
              :data-language="block.language"
              data-testid="article-md-code-block"
            ><code>{{ block.code }}</code></pre>

            <blockquote
              v-else-if="block.type === 'blockquote'"
              class="article-md-blockquote q-pl-md q-my-md"
              dir="auto"
              data-testid="article-md-blockquote"
            >
              <template v-for="(node, nodeIdx) in block.inlines" :key="nodeIdx">
                <a
                  v-if="node.type === 'link'"
                  :href="node.href"
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid="article-md-link"
                >
                  {{ flattenInlineText(node.children) }}
                </a>
                <code v-else-if="node.type === 'code'">{{ node.code }}</code>
                <strong v-else-if="node.type === 'strong'">
                  {{ flattenInlineText(node.children) }}
                </strong>
                <em v-else-if="node.type === 'em'">
                  {{ flattenInlineText(node.children) }}
                </em>
                <del v-else-if="node.type === 'del'">
                  {{ flattenInlineText(node.children) }}
                </del>
                <span v-else>{{ node.text }}</span>
              </template>
            </blockquote>

            <component
              :is="block.ordered ? 'ol' : 'ul'"
              v-else-if="block.type === 'list'"
              :start="block.ordered ? block.start : undefined"
              class="article-md-list q-mb-md"
              dir="auto"
              data-testid="article-md-list"
            >
              <li
                v-for="(listItem, itemIdx) in block.items"
                :key="itemIdx"
                class="q-mb-xs"
                :data-testid="
                  listItem.checked !== null
                    ? 'article-md-task-item'
                    : 'article-md-list-item'
                "
              >
                <input
                  v-if="listItem.checked !== null"
                  type="checkbox"
                  disabled
                  :checked="listItem.checked"
                  class="q-mr-xs"
                  data-testid="article-md-task-checkbox"
                />
                <template
                  v-for="(node, nodeIdx) in listItem.inlines"
                  :key="nodeIdx"
                >
                  <a
                    v-if="node.type === 'link'"
                    :href="node.href"
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid="article-md-link"
                  >
                    {{ flattenInlineText(node.children) }}
                  </a>
                  <code v-else-if="node.type === 'code'">{{ node.code }}</code>
                  <strong v-else-if="node.type === 'strong'">
                    {{ flattenInlineText(node.children) }}
                  </strong>
                  <em v-else-if="node.type === 'em'">
                    {{ flattenInlineText(node.children) }}
                  </em>
                  <del v-else-if="node.type === 'del'">
                    {{ flattenInlineText(node.children) }}
                  </del>
                  <span v-else>{{ node.text }}</span>
                </template>
              </li>
            </component>

            <div
              v-else-if="block.type === 'table'"
              class="article-md-table-wrap q-mb-md"
            >
              <table
                class="article-md-table full-width"
                data-testid="article-md-table"
              >
                <thead>
                  <tr>
                    <th
                      v-for="(headerCell, colIdx) in block.headers"
                      :key="colIdx"
                      :style="cellAlignStyle(block.alignments[colIdx])"
                    >
                      {{ flattenInlineText(headerCell) }}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(row, rowIdx) in block.rows" :key="rowIdx">
                    <td
                      v-for="(cell, colIdx) in row"
                      :key="colIdx"
                      :style="cellAlignStyle(block.alignments[colIdx])"
                    >
                      {{ flattenInlineText(cell) }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <hr
              v-else-if="block.type === 'hr'"
              class="q-my-md"
              data-testid="article-md-hr"
            />
          </template>
        </div>
      </article>
    </div>
  </section>
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue'
import {
  estimateArticleReadingMinutes,
  parseArticleApplicationItem,
  parseArticleMarkdown,
  type ArticleInlineNode,
  type ArticleMarkdownBlock,
  type ArticlePayload,
  type ArticleTableAlignment,
} from '@frank/wallet/message-item-plugins/article'

export default defineComponent({
  name: 'ArticleReaderPane',
  props: {
    article: {
      type: Object as PropType<ArticlePayload | Record<string, unknown>>,
      required: true,
    },
  },
  emits: ['close'],
  mounted() {
    window.addEventListener('keydown', this.onWindowKeydown)
  },
  beforeUnmount() {
    window.removeEventListener('keydown', this.onWindowKeydown)
  },
  computed: {
    validArticle(): ArticlePayload | null {
      return parseArticleApplicationItem(this.article)
    },
    blocks(): ArticleMarkdownBlock[] {
      if (!this.validArticle) return []
      return parseArticleMarkdown(this.validArticle.markdownBody)
    },
    formattedDate(): string {
      if (!this.validArticle) return ''
      const parsed = new Date(this.validArticle.publishedAtIso)
      if (Number.isNaN(parsed.getTime())) return ''
      return parsed.toISOString().slice(0, 10)
    },
    readingMinutes(): number {
      if (!this.validArticle) return 1
      return estimateArticleReadingMinutes(this.validArticle.markdownBody)
    },
    readingTimeText(): string {
      return this.translate(
        'article.readingTimeMinutes',
        `${this.readingMinutes} min read`,
        { minutes: this.readingMinutes },
      )
    },
    authorByline(): string {
      if (!this.validArticle?.authorName) return ''
      return this.translate(
        'article.byAuthor',
        `By ${this.validArticle.authorName}`,
        { author: this.validArticle.authorName },
      )
    },
    badgeLabel(): string {
      return this.translate('article.badge', 'Article')
    },
    backButtonLabel(): string {
      return this.translate('article.backToChat', 'Back to conversation')
    },
    backButtonAriaLabel(): string {
      return this.translate(
        'article.closeReaderAria',
        'Close article reader and return to conversation',
      )
    },
    readerAriaLabel(): string {
      return this.validArticle?.title || this.badgeLabel
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
    emitClose() {
      this.$emit('close')
    },
    onWindowKeydown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation()
        this.emitClose()
      }
    },
    headingTag(level: number): string {
      const clamped = Math.min(6, Math.max(1, level))
      return `h${clamped}`
    },
    flattenInlineText(nodes: readonly ArticleInlineNode[]): string {
      return nodes
        .map(node => {
          switch (node.type) {
            case 'text':
              return node.text
            case 'code':
              return node.code
            case 'strong':
            case 'em':
            case 'del':
            case 'link':
              return this.flattenInlineText(node.children)
          }
        })
        .join('')
    },
    cellAlignStyle(
      alignment: ArticleTableAlignment | undefined,
    ): Record<string, string> | undefined {
      if (!alignment) return undefined
      return { textAlign: alignment }
    },
    formatTag(tag: string): string {
      return `#${tag.replace(/^#+/, '')}`
    },
  },
})
</script>

<style lang="scss" scoped>
.article-reader-pane {
  width: 100%;
  height: 100%;
  background: #fcfbf9;
  color: #18181b;
  overflow: hidden;
  border-radius: 12px;
}

.article-reader-header {
  position: sticky;
  top: 0;
  z-index: 2;
  background: rgba(252, 251, 249, 0.92);
  border-bottom: 1px solid rgba(24, 24, 27, 0.08);
  backdrop-filter: blur(8px);
}

.article-reader-scroll {
  overflow-y: auto;
}

.article-reader-content {
  max-width: 740px;
  margin: 0 auto;
  word-break: break-word;
  overflow-wrap: anywhere;
  color: inherit;
}

.article-reader-author,
.article-reader-meta {
  color: #52525b;
  font-weight: 500;
}

.article-reader-summary {
  color: #3f3f46;
  line-height: 1.55;
}

.article-reader-tag-pill {
  background: rgba(234, 88, 12, 0.12) !important;
  color: #c2410c !important;
  border: 1px solid rgba(234, 88, 12, 0.24);
  border-radius: 999px;
  padding: 4px 10px;
  font-weight: 600;
  font-size: 0.75rem;
}

.article-markdown-body {
  color: #27272a;
  line-height: 1.75;

  :deep(a),
  a {
    color: #ea580c;
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  :deep(code),
  code {
    background: rgba(24, 24, 27, 0.06);
    padding: 2px 5px;
    border-radius: 4px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
      monospace;
    font-size: 0.9em;
  }
}

.article-md-heading {
  color: #18181b;
  line-height: 1.3;
}

.article-md-code-block {
  overflow-x: auto;
  background: #f4f4f5;
  color: #18181b;
  border: 1px solid rgba(24, 24, 27, 0.08);
  border-radius: 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;

  code {
    background: transparent;
    padding: 0;
  }
}

.article-md-blockquote {
  border-left: 3px solid #ea580c;
  background: rgba(234, 88, 12, 0.05);
  color: #3f3f46;
  padding: 8px 14px;
  border-radius: 0 8px 8px 0;
}

.article-md-table-wrap {
  overflow-x: auto;
}

.article-md-table {
  border-collapse: collapse;

  th,
  td {
    padding: 8px 12px;
    border: 1px solid rgba(24, 24, 27, 0.14);
  }

  th {
    background: rgba(24, 24, 27, 0.04);
    font-weight: 600;
  }
}

.body--dark .article-reader-pane {
  background: #0f172a;
  color: #f8fafc;

  .article-reader-header {
    background: rgba(15, 23, 42, 0.92);
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  }

  .article-reader-author,
  .article-reader-meta {
    color: #94a3b8;
  }

  .article-reader-summary {
    color: #cbd5e1;
  }

  .article-reader-tag-pill {
    background: rgba(249, 115, 22, 0.18) !important;
    color: #fdba74 !important;
    border-color: rgba(249, 115, 22, 0.32);
  }

  .article-markdown-body {
    color: #e2e8f0;

    a {
      color: #fb923c;
    }

    code {
      background: rgba(255, 255, 255, 0.1);
    }
  }

  .article-md-heading {
    color: #f8fafc;
  }

  .article-md-code-block {
    background: #1e293b;
    color: #f8fafc;
    border-color: rgba(255, 255, 255, 0.1);

    code {
      background: transparent;
    }
  }

  .article-md-blockquote {
    border-left-color: #f97316;
    background: rgba(249, 115, 22, 0.08);
    color: #cbd5e1;
  }

  .article-md-table {
    th,
    td {
      border-color: rgba(255, 255, 255, 0.14);
    }

    th {
      background: rgba(255, 255, 255, 0.05);
    }
  }
}
</style>
