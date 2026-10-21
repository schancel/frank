import {
  encodeCanonical,
  standaloneItemBudget,
  type Encodable,
  type FrankValue,
} from '@frank/codec'
import type { ApplicationMessageItem } from '@frank/cashweb/types/messages'
import type {
  ApplicationItemPlugin,
  MessageItemDecodeContext,
  MessageItemPlugin,
} from '@frank/cashweb/message-items/registry'

export * from './markdown'

export const ARTICLE_PLUGIN_ID = 'article-v1' as const
export const ARTICLE_ITEM_TYPE = ARTICLE_PLUGIN_ID
export const ARTICLE_SCHEMA_VERSION = 1 as const
export const ARTICLE_MAX_BODY_UTF8_BYTES = 65536
export const ARTICLE_MAX_TITLE_CHARS = 200
export const ARTICLE_MAX_SUMMARY_CHARS = 500
export const ARTICLE_MAX_AUTHOR_CHARS = 120
export const ARTICLE_MAX_ID_CHARS = 64
export const ARTICLE_MAX_TAGS = 8
export const ARTICLE_MAX_TAG_CHARS = 32

export interface ArticlePayload {
  schemaVersion: 1
  articleId: string
  title: string
  summary?: string
  markdownBody: string
  authorName?: string
  publishedAtIso: string
  tags?: string[]
}

const ALLOWED_KEYS = new Set<string>([
  'schemaVersion',
  'articleId',
  'title',
  'summary',
  'markdownBody',
  'authorName',
  'publishedAtIso',
  'tags',
])

const CBOR_KEY_SCHEMA_VERSION = 0
const CBOR_KEY_ARTICLE_ID = 1
const CBOR_KEY_TITLE = 2
const CBOR_KEY_MARKDOWN_BODY = 3
const CBOR_KEY_PUBLISHED_AT_ISO = 4
const CBOR_KEY_SUMMARY = 5
const CBOR_KEY_AUTHOR_NAME = 6
const CBOR_KEY_TAGS = 7

const utf8Encoder = new TextEncoder()

function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0
      if (next < 0xdc00 || next > 0xdfff) return true
      i += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

function assertCleanString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new TypeError(`article ${field} must be a string`)
  }
  if (hasLoneSurrogate(value)) {
    throw new TypeError(`article ${field} must be valid UTF-8 without lone surrogates`)
  }
  return value
}

function assertBoundedUtf8Chars(
  value: unknown,
  field: string,
  minChars: number,
  maxChars: number,
): string {
  const str = assertCleanString(value, field)
  if (str.length < minChars || str.length > maxChars) {
    throw new RangeError(
      `article ${field} must be ${minChars}..${maxChars} characters`,
    )
  }
  if (minChars > 0 && str.trim().length === 0) {
    throw new RangeError(`article ${field} must not be blank`)
  }
  return str
}

function assertAsciiArticleId(value: unknown): string {
  const id = assertCleanString(value, 'articleId')
  if (id.length < 1 || id.length > ARTICLE_MAX_ID_CHARS) {
    throw new RangeError(
      `article articleId must be 1..${ARTICLE_MAX_ID_CHARS} ASCII characters`,
    )
  }
  if (!/^[\x21-\x7e]{1,64}$/.test(id)) {
    throw new TypeError(
      'article articleId must contain only printable non-whitespace ASCII characters',
    )
  }
  return id
}

function assertIsoTimestamp(value: unknown): string {
  const iso = assertBoundedUtf8Chars(value, 'publishedAtIso', 1, 64)
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      iso,
    ) ||
    Number.isNaN(Date.parse(iso))
  ) {
    throw new TypeError(
      'article publishedAtIso must be a valid ISO-8601 timestamp',
    )
  }
  return iso
}

export function readArticlePayload(value: unknown): ArticlePayload {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new TypeError('Expected article payload object')
  }

  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !ALLOWED_KEYS.has(key)) {
      throw new TypeError(`Unexpected article property: ${String(key)}`)
    }
    const desc = Object.getOwnPropertyDescriptor(value, key)
    if (!desc || !desc.enumerable || !('value' in desc)) {
      throw new TypeError(
        `Article property ${key} must be an enumerable data property`,
      )
    }
  }

  const raw = value as Record<string, unknown>

  if (raw.schemaVersion !== ARTICLE_SCHEMA_VERSION) {
    throw new TypeError(
      `article schemaVersion must be ${ARTICLE_SCHEMA_VERSION}`,
    )
  }

  const articleId = assertAsciiArticleId(raw.articleId)
  const title = assertBoundedUtf8Chars(
    raw.title,
    'title',
    1,
    ARTICLE_MAX_TITLE_CHARS,
  )

  const markdownBody = assertCleanString(raw.markdownBody, 'markdownBody')
  const bodyByteLength = utf8Encoder.encode(markdownBody).byteLength
  if (
    bodyByteLength < 1 ||
    bodyByteLength > ARTICLE_MAX_BODY_UTF8_BYTES ||
    markdownBody.trim().length === 0
  ) {
    throw new RangeError(
      `article markdownBody must be 1..${ARTICLE_MAX_BODY_UTF8_BYTES} non-empty UTF-8 bytes`,
    )
  }

  const publishedAtIso = assertIsoTimestamp(raw.publishedAtIso)

  const result: ArticlePayload = {
    schemaVersion: ARTICLE_SCHEMA_VERSION,
    articleId,
    title,
    markdownBody,
    publishedAtIso,
  }

  if (raw.summary !== undefined) {
    const summary = assertBoundedUtf8Chars(
      raw.summary,
      'summary',
      0,
      ARTICLE_MAX_SUMMARY_CHARS,
    )
    if (summary.length > 0) {
      result.summary = summary
    }
  }

  if (raw.authorName !== undefined) {
    const authorName = assertBoundedUtf8Chars(
      raw.authorName,
      'authorName',
      0,
      ARTICLE_MAX_AUTHOR_CHARS,
    )
    if (authorName.length > 0) {
      result.authorName = authorName
    }
  }

  if (raw.tags !== undefined) {
    if (
      !Array.isArray(raw.tags) ||
      Object.getPrototypeOf(raw.tags) !== Array.prototype
    ) {
      throw new TypeError('article tags must be a plain array')
    }
    if (raw.tags.length > ARTICLE_MAX_TAGS) {
      throw new RangeError(
        `article tags may have at most ${ARTICLE_MAX_TAGS} items`,
      )
    }
    if (Object.keys(raw.tags).length !== raw.tags.length) {
      throw new TypeError('article tags must be a dense array')
    }
    result.tags = raw.tags.map((tag, index) =>
      assertBoundedUtf8Chars(
        tag,
        `tags[${index}]`,
        1,
        ARTICLE_MAX_TAG_CHARS,
      ),
    )
  }

  return result
}

function encodeArticleMap(payload: ArticlePayload): Map<number, Encodable> {
  const map = new Map<number, Encodable>([
    [CBOR_KEY_SCHEMA_VERSION, payload.schemaVersion],
    [CBOR_KEY_ARTICLE_ID, payload.articleId],
    [CBOR_KEY_TITLE, payload.title],
    [CBOR_KEY_MARKDOWN_BODY, payload.markdownBody],
    [CBOR_KEY_PUBLISHED_AT_ISO, payload.publishedAtIso],
  ])
  if (payload.summary !== undefined) {
    map.set(CBOR_KEY_SUMMARY, payload.summary)
  }
  if (payload.authorName !== undefined) {
    map.set(CBOR_KEY_AUTHOR_NAME, payload.authorName)
  }
  if (payload.tags !== undefined) {
    map.set(CBOR_KEY_TAGS, payload.tags)
  }
  return map
}

function decodeArticleMap(decoded: FrankValue): ArticlePayload {
  if (!(decoded instanceof Map)) {
    throw new TypeError('Expected canonical CBOR map for article-v1')
  }
  for (const key of decoded.keys()) {
    if (typeof key !== 'bigint' || key < 0n || key > 7n) {
      throw new TypeError(`Unexpected CBOR key in article-v1: ${String(key)}`)
    }
  }
  const rawSchemaVersion = decoded.get(BigInt(CBOR_KEY_SCHEMA_VERSION))
  if (rawSchemaVersion !== 1n) {
    throw new TypeError('article-v1 schemaVersion must be 1')
  }

  const candidate: Record<string, unknown> = {
    schemaVersion: 1,
    articleId: decoded.get(BigInt(CBOR_KEY_ARTICLE_ID)),
    title: decoded.get(BigInt(CBOR_KEY_TITLE)),
    markdownBody: decoded.get(BigInt(CBOR_KEY_MARKDOWN_BODY)),
    publishedAtIso: decoded.get(BigInt(CBOR_KEY_PUBLISHED_AT_ISO)),
  }

  if (decoded.has(BigInt(CBOR_KEY_SUMMARY))) {
    candidate.summary = decoded.get(BigInt(CBOR_KEY_SUMMARY))
  }
  if (decoded.has(BigInt(CBOR_KEY_AUTHOR_NAME))) {
    candidate.authorName = decoded.get(BigInt(CBOR_KEY_AUTHOR_NAME))
  }
  if (decoded.has(BigInt(CBOR_KEY_TAGS))) {
    candidate.tags = decoded.get(BigInt(CBOR_KEY_TAGS))
  }

  return readArticlePayload(candidate)
}

export function encodeArticlePayload(payload: ArticlePayload): Uint8Array {
  const validated = readArticlePayload(payload)
  return encodeCanonical(encodeArticleMap(validated))
}

export function decodeArticlePayload(
  bytes: Uint8Array,
  context?: MessageItemDecodeContext,
): ArticlePayload {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new TypeError('Expected non-empty Uint8Array for article-v1 payload')
  }
  const budget = context?.budget ?? standaloneItemBudget()
  const decoded = budget.decodeCbor(bytes, ARTICLE_PLUGIN_ID)
  return decodeArticleMap(decoded)
}

export function toArticleApplicationItem(
  payload: ArticlePayload,
): ApplicationMessageItem {
  return {
    type: 'application',
    itemType: ARTICLE_PLUGIN_ID,
    value: readArticlePayload(payload),
  }
}

export function parseArticleApplicationItem(
  item: unknown,
): ArticlePayload | null {
  if (typeof item !== 'object' || item === null) return null
  const candidate = item as {
    type?: unknown
    itemType?: unknown
    value?: unknown
  }
  if (candidate.type === 'application') {
    if (candidate.itemType !== ARTICLE_PLUGIN_ID) return null
    try {
      return readArticlePayload(candidate.value)
    } catch {
      return null
    }
  }
  try {
    return readArticlePayload(item)
  } catch {
    return null
  }
}

export function estimateArticleReadingMinutes(markdownBody: string): number {
  if (typeof markdownBody !== 'string') return 1
  const words = markdownBody
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*_`~[\]()|-]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length
  return Math.max(1, Math.ceil(words / 200))
}

export function buildArticleSummary(payload: ArticlePayload): string {
  const validated = readArticlePayload(payload)
  return `[Article] ${validated.title}`
}

export interface ArticleItemPluginContract
  extends ApplicationItemPlugin<ArticlePayload>,
    Omit<
      MessageItemPlugin<ApplicationMessageItem, ArticlePayload>,
      'encode' | 'decode' | 'previewText' | 'hydrate'
    > {
  readonly pluginId: typeof ARTICLE_PLUGIN_ID
  readonly type: typeof ARTICLE_PLUGIN_ID
  readonly itemType: typeof ARTICLE_PLUGIN_ID
  read(value: unknown): ArticlePayload
  buildSummary(payload: ArticlePayload | ApplicationMessageItem): string
  previewText(payload: ArticlePayload | ApplicationMessageItem): string
  encode(payload: ArticlePayload | ApplicationMessageItem): Uint8Array
  decode(bytes: Uint8Array, context?: MessageItemDecodeContext): ArticlePayload
  hydrate(raw: ApplicationMessageItem | ArticlePayload): ArticlePayload
}

function unwrapPayload(
  input: ArticlePayload | ApplicationMessageItem,
): ArticlePayload {
  if (
    typeof input === 'object' &&
    input !== null &&
    'type' in input &&
    input.type === 'application'
  ) {
    if (input.itemType !== ARTICLE_PLUGIN_ID) {
      throw new TypeError(`Expected ${ARTICLE_PLUGIN_ID} application item`)
    }
    return readArticlePayload(input.value)
  }
  return readArticlePayload(input)
}

export const articlePlugin: ArticleItemPluginContract = {
  pluginId: ARTICLE_PLUGIN_ID,
  type: ARTICLE_PLUGIN_ID,
  itemType: ARTICLE_PLUGIN_ID,
  read: readArticlePayload,
  hydrate(raw: ApplicationMessageItem | ArticlePayload): ArticlePayload {
    return unwrapPayload(raw)
  },
  buildSummary(input: ArticlePayload | ApplicationMessageItem): string {
    return buildArticleSummary(unwrapPayload(input))
  },
  previewText(input: ArticlePayload | ApplicationMessageItem): string {
    return buildArticleSummary(unwrapPayload(input))
  },
  encode(input: ArticlePayload | ApplicationMessageItem): Uint8Array {
    return encodeArticlePayload(unwrapPayload(input))
  },
  decode(
    bytes: Uint8Array,
    context?: MessageItemDecodeContext,
  ): ArticlePayload {
    return decodeArticlePayload(bytes, context)
  },
}

export function createArticlePlugin(): ApplicationItemPlugin<ArticlePayload> {
  return articlePlugin
}
