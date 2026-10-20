import type { PostAttachment } from './post-editor'

const CHAT_DRAFT_PREFIX = 'frank:draft:chat:'
const FORUM_DRAFT_PREFIX = 'frank:draft:forum:'
const TOPIC_DRAFT_PREFIX = 'frank:draft:topic:'

export interface ChatDraftRecord {
  message: string
  attachments: PostAttachment[]
  replyDigest: string | null
  updatedAt: number
}

export interface ForumPostDraftRecord {
  title: string
  url: string | null
  topic: string
  topLevelTopicWasEdited?: boolean
  offering?: string
  message: string
  attachments: PostAttachment[]
  updatedAt: number
}

function getStorage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage
    }
  } catch {
    // Ignore storage access errors in restricted contexts
  }
  return null
}

function normalizeKey(rawKey: string | null | undefined): string {
  return String(rawKey ?? '')
    .trim()
    .toLowerCase()
}

function sanitizeAttachments(raw: unknown): PostAttachment[] {
  if (!Array.isArray(raw)) return []
  const result: PostAttachment[] = []
  for (const item of raw) {
    if (
      item &&
      typeof item === 'object' &&
      typeof (item as PostAttachment).id === 'string' &&
      typeof (item as PostAttachment).name === 'string' &&
      typeof (item as PostAttachment).dataUrl === 'string'
    ) {
      result.push({
        id: (item as PostAttachment).id,
        name: (item as PostAttachment).name,
        dataUrl: (item as PostAttachment).dataUrl,
        sizeBytes:
          typeof (item as PostAttachment).sizeBytes === 'number'
            ? (item as PostAttachment).sizeBytes
            : 0,
      })
    }
  }
  return result
}

export function loadChatDraft(
  conversationKey: string | null | undefined,
): ChatDraftRecord | null {
  const key = normalizeKey(conversationKey)
  if (!key) return null
  const storage = getStorage()
  if (!storage) return null
  try {
    const raw = storage.getItem(`${CHAT_DRAFT_PREFIX}${key}`)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<ChatDraftRecord>
    const message = typeof parsed.message === 'string' ? parsed.message : ''
    const attachments = sanitizeAttachments(parsed.attachments)
    const replyDigest =
      typeof parsed.replyDigest === 'string' && parsed.replyDigest
        ? parsed.replyDigest
        : null
    if (!message && attachments.length === 0 && !replyDigest) {
      return null
    }
    return {
      message,
      attachments,
      replyDigest,
      updatedAt:
        typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
    }
  } catch {
    return null
  }
}

export function saveChatDraft(
  conversationKey: string | null | undefined,
  draft: {
    message: string
    attachments?: PostAttachment[]
    replyDigest?: string | null
  },
): void {
  const key = normalizeKey(conversationKey)
  if (!key) return
  const storage = getStorage()
  if (!storage) return
  const message = draft.message ?? ''
  const attachments = draft.attachments ?? []
  const replyDigest = draft.replyDigest ?? null
  try {
    if (!message && attachments.length === 0 && !replyDigest) {
      storage.removeItem(`${CHAT_DRAFT_PREFIX}${key}`)
      return
    }
    const record: ChatDraftRecord = {
      message,
      attachments,
      replyDigest,
      updatedAt: Date.now(),
    }
    storage.setItem(`${CHAT_DRAFT_PREFIX}${key}`, JSON.stringify(record))
  } catch {
    // Ignore quota or serialization errors
  }
}

export function clearChatDraft(
  conversationKey: string | null | undefined,
): void {
  const key = normalizeKey(conversationKey)
  if (!key) return
  const storage = getStorage()
  if (!storage) return
  try {
    storage.removeItem(`${CHAT_DRAFT_PREFIX}${key}`)
  } catch {
    // Ignore
  }
}

export function loadForumPostDraft(
  destinationKey: string | null | undefined,
): ForumPostDraftRecord | null {
  const key = normalizeKey(destinationKey)
  if (!key) return null
  const storage = getStorage()
  if (!storage) return null
  try {
    const raw = storage.getItem(`${FORUM_DRAFT_PREFIX}${key}`)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<ForumPostDraftRecord>
    const title = typeof parsed.title === 'string' ? parsed.title : ''
    const url = typeof parsed.url === 'string' && parsed.url ? parsed.url : null
    const topic = typeof parsed.topic === 'string' ? parsed.topic : ''
    const topLevelTopicWasEdited = Boolean(parsed.topLevelTopicWasEdited)
    const offering =
      typeof parsed.offering === 'string' ? parsed.offering : undefined
    const message = typeof parsed.message === 'string' ? parsed.message : ''
    const attachments = sanitizeAttachments(parsed.attachments)
    if (
      !title &&
      !url &&
      !message &&
      attachments.length === 0 &&
      !topLevelTopicWasEdited
    ) {
      return null
    }
    return {
      title,
      url,
      topic,
      topLevelTopicWasEdited,
      offering,
      message,
      attachments,
      updatedAt:
        typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
    }
  } catch {
    return null
  }
}

export function saveForumPostDraft(
  destinationKey: string | null | undefined,
  draft: {
    title: string
    url: string | null
    topic: string
    topLevelTopicWasEdited?: boolean
    offering?: string
    message: string
    attachments?: PostAttachment[]
  },
): void {
  const key = normalizeKey(destinationKey)
  if (!key) return
  const storage = getStorage()
  if (!storage) return
  const title = draft.title ?? ''
  const url = draft.url ?? null
  const topic = draft.topic ?? ''
  const topLevelTopicWasEdited = Boolean(draft.topLevelTopicWasEdited)
  const offering = draft.offering
  const message = draft.message ?? ''
  const attachments = draft.attachments ?? []
  try {
    if (
      !title &&
      !url &&
      !message &&
      attachments.length === 0 &&
      !topLevelTopicWasEdited
    ) {
      storage.removeItem(`${FORUM_DRAFT_PREFIX}${key}`)
      return
    }
    const record: ForumPostDraftRecord = {
      title,
      url,
      topic,
      topLevelTopicWasEdited,
      offering,
      message,
      attachments,
      updatedAt: Date.now(),
    }
    storage.setItem(`${FORUM_DRAFT_PREFIX}${key}`, JSON.stringify(record))
  } catch {
    // Ignore quota or serialization errors
  }
}

export function clearForumPostDraft(
  destinationKey: string | null | undefined,
): void {
  const key = normalizeKey(destinationKey)
  if (!key) return
  const storage = getStorage()
  if (!storage) return
  try {
    storage.removeItem(`${FORUM_DRAFT_PREFIX}${key}`)
  } catch {
    // Ignore
  }
}

export function loadTopicDraft(topic: string | null | undefined): string {
  const key = normalizeKey(topic)
  if (!key) return ''
  const storage = getStorage()
  if (!storage) return ''
  try {
    return storage.getItem(`${TOPIC_DRAFT_PREFIX}${key}`) ?? ''
  } catch {
    return ''
  }
}

export function saveTopicDraft(
  topic: string | null | undefined,
  message: string,
): void {
  const key = normalizeKey(topic)
  if (!key) return
  const storage = getStorage()
  if (!storage) return
  try {
    if (!message) {
      storage.removeItem(`${TOPIC_DRAFT_PREFIX}${key}`)
      return
    }
    storage.setItem(`${TOPIC_DRAFT_PREFIX}${key}`, message)
  } catch {
    // Ignore
  }
}
