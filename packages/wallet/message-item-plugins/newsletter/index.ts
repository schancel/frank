import { encodeCanonical, type Encodable, type FrankValue } from '@frank/codec'
import type { ApplicationMessageItem } from '@frank/cashweb/types/messages'
import type {
  ApplicationItemPlugin,
  MessageItemDecodeContext,
} from '@frank/cashweb/message-items/registry'

export const NEWSLETTER_ARTICLE_ITEM_TYPE = 'newsletter-article-v1'

export interface NewsletterArticleValue {
  articleId: string
  title: string
  source: string
  author?: string
  summary?: string
  body: string
  url?: string
  imageUrl?: string
  publishedAt: number
  tags?: string[]
}

const ALLOWED_KEYS = new Set<string>([
  'articleId',
  'title',
  'source',
  'author',
  'summary',
  'body',
  'url',
  'imageUrl',
  'publishedAt',
  'tags',
])

const CBOR_KEY_ARTICLE_ID = 0
const CBOR_KEY_TITLE = 1
const CBOR_KEY_SOURCE = 2
const CBOR_KEY_BODY = 3
const CBOR_KEY_PUBLISHED_AT = 4
const CBOR_KEY_AUTHOR = 5
const CBOR_KEY_SUMMARY = 6
const CBOR_KEY_URL = 7
const CBOR_KEY_IMAGE_URL = 8
const CBOR_KEY_TAGS = 9

function assertBoundedString(
  value: unknown,
  field: string,
  minChars: number,
  maxChars: number,
): string {
  if (typeof value !== 'string') {
    throw new TypeError(`newsletter article ${field} must be a string`)
  }
  if (value.length < minChars || value.length > maxChars) {
    throw new TypeError(
      `newsletter article ${field} must be ${minChars}..${maxChars} chars`,
    )
  }
  return value
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value)
}

function isImageUrlOrDataUri(value: string): boolean {
  return isHttpUrl(value) || /^data:image\/[^\s]+$/i.test(value)
}

export function readNewsletterArticle(value: unknown): NewsletterArticleValue {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new TypeError('Expected newsletter article object')
  }

  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !ALLOWED_KEYS.has(key)) {
      throw new TypeError(
        `Unexpected newsletter article property: ${String(key)}`,
      )
    }
    const desc = Object.getOwnPropertyDescriptor(value, key)
    if (!desc || !desc.enumerable || !('value' in desc)) {
      throw new TypeError(
        `Newsletter article property ${key} must be an enumerable data property`,
      )
    }
  }

  const raw = value as Record<string, unknown>

  const articleId = assertBoundedString(raw.articleId, 'articleId', 1, 128)
  const title = assertBoundedString(raw.title, 'title', 1, 256)
  const source = assertBoundedString(raw.source, 'source', 1, 128)
  const body = assertBoundedString(raw.body, 'body', 1, 65536)

  if (
    typeof raw.publishedAt !== 'number' ||
    !Number.isFinite(raw.publishedAt) ||
    !Number.isSafeInteger(raw.publishedAt) ||
    raw.publishedAt < 0 ||
    Object.is(raw.publishedAt, -0)
  ) {
    throw new TypeError(
      'newsletter article publishedAt must be a non-negative safe integer timestamp',
    )
  }
  const publishedAt = raw.publishedAt

  const result: NewsletterArticleValue = {
    articleId,
    title,
    source,
    body,
    publishedAt,
  }

  if (raw.author !== undefined) {
    result.author = assertBoundedString(raw.author, 'author', 1, 128)
  }

  if (raw.summary !== undefined) {
    result.summary = assertBoundedString(raw.summary, 'summary', 1, 1024)
  }

  if (raw.url !== undefined) {
    const url = assertBoundedString(raw.url, 'url', 1, 1024)
    if (!isHttpUrl(url)) {
      throw new TypeError(
        'newsletter article url must be an http:// or https:// link',
      )
    }
    result.url = url
  }

  if (raw.imageUrl !== undefined) {
    const imageUrl = assertBoundedString(raw.imageUrl, 'imageUrl', 1, 65536)
    if (!isImageUrlOrDataUri(imageUrl)) {
      throw new TypeError(
        'newsletter article imageUrl must be an http(s) URL or data:image/... URI',
      )
    }
    result.imageUrl = imageUrl
  }

  if (raw.tags !== undefined) {
    if (
      !Array.isArray(raw.tags) ||
      Object.getPrototypeOf(raw.tags) !== Array.prototype
    ) {
      throw new TypeError('newsletter article tags must be a plain array')
    }
    if (raw.tags.length > 16) {
      throw new TypeError('newsletter article tags may have at most 16 items')
    }
    if (Object.keys(raw.tags).length !== raw.tags.length) {
      throw new TypeError('newsletter article tags must be a dense array')
    }
    result.tags = raw.tags.map((tag, idx) =>
      assertBoundedString(tag, `tags[${idx}]`, 1, 48),
    )
  }

  return result
}

function encodeArticleMap(
  article: NewsletterArticleValue,
): Map<number, Encodable> {
  const map = new Map<number, Encodable>([
    [CBOR_KEY_ARTICLE_ID, article.articleId],
    [CBOR_KEY_TITLE, article.title],
    [CBOR_KEY_SOURCE, article.source],
    [CBOR_KEY_BODY, article.body],
    [CBOR_KEY_PUBLISHED_AT, article.publishedAt],
  ])
  if (article.author !== undefined) {
    map.set(CBOR_KEY_AUTHOR, article.author)
  }
  if (article.summary !== undefined) {
    map.set(CBOR_KEY_SUMMARY, article.summary)
  }
  if (article.url !== undefined) {
    map.set(CBOR_KEY_URL, article.url)
  }
  if (article.imageUrl !== undefined) {
    map.set(CBOR_KEY_IMAGE_URL, article.imageUrl)
  }
  if (article.tags !== undefined) {
    map.set(CBOR_KEY_TAGS, article.tags)
  }
  return map
}

function decodeArticleMap(decoded: FrankValue): NewsletterArticleValue {
  if (!(decoded instanceof Map)) {
    throw new TypeError('Expected canonical CBOR map for newsletter article')
  }
  for (const key of decoded.keys()) {
    if (typeof key !== 'bigint' || key < 0n || key > 9n) {
      throw new TypeError(
        `Unexpected CBOR key in newsletter article: ${String(key)}`,
      )
    }
  }
  const rawPublishedAt = decoded.get(BigInt(CBOR_KEY_PUBLISHED_AT))
  if (
    typeof rawPublishedAt !== 'bigint' ||
    rawPublishedAt < 0n ||
    rawPublishedAt > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new TypeError(
      'newsletter article publishedAt must be a non-negative safe integer',
    )
  }

  const candidate: Record<string, unknown> = {
    articleId: decoded.get(BigInt(CBOR_KEY_ARTICLE_ID)),
    title: decoded.get(BigInt(CBOR_KEY_TITLE)),
    source: decoded.get(BigInt(CBOR_KEY_SOURCE)),
    body: decoded.get(BigInt(CBOR_KEY_BODY)),
    publishedAt: Number(rawPublishedAt),
  }

  if (decoded.has(BigInt(CBOR_KEY_AUTHOR))) {
    candidate.author = decoded.get(BigInt(CBOR_KEY_AUTHOR))
  }
  if (decoded.has(BigInt(CBOR_KEY_SUMMARY))) {
    candidate.summary = decoded.get(BigInt(CBOR_KEY_SUMMARY))
  }
  if (decoded.has(BigInt(CBOR_KEY_URL))) {
    candidate.url = decoded.get(BigInt(CBOR_KEY_URL))
  }
  if (decoded.has(BigInt(CBOR_KEY_IMAGE_URL))) {
    candidate.imageUrl = decoded.get(BigInt(CBOR_KEY_IMAGE_URL))
  }
  if (decoded.has(BigInt(CBOR_KEY_TAGS))) {
    candidate.tags = decoded.get(BigInt(CBOR_KEY_TAGS))
  }

  return readNewsletterArticle(candidate)
}

export function createNewsletterArticlePlugin(): ApplicationItemPlugin<NewsletterArticleValue> {
  return {
    itemType: NEWSLETTER_ARTICLE_ITEM_TYPE,
    read: readNewsletterArticle,
    encode(value: NewsletterArticleValue): Uint8Array {
      const validated = readNewsletterArticle(value)
      return encodeCanonical(encodeArticleMap(validated))
    },
    decode(
      bytes: Uint8Array,
      context: MessageItemDecodeContext,
    ): NewsletterArticleValue {
      const decoded = context.budget.decodeCbor(
        bytes,
        NEWSLETTER_ARTICLE_ITEM_TYPE,
      )
      return decodeArticleMap(decoded)
    },
    previewText(article: NewsletterArticleValue): string {
      const validated = readNewsletterArticle(article)
      return `📰 ${validated.title} — ${validated.source}`
    },
  }
}

export function createNewsletterArticleItem(
  article: NewsletterArticleValue,
): ApplicationMessageItem {
  return {
    type: 'application',
    itemType: NEWSLETTER_ARTICLE_ITEM_TYPE,
    value: readNewsletterArticle(article),
  }
}
