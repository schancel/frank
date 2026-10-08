import { defaultAvatars } from './constants'

export * from './avatar-resize'

const MAX_CACHE_ENTRIES = 2000
const avatarCache = new Map<string, string>()

export function clearAvatarCache(): void {
  avatarCache.clear()
}

/** Return a stable bundled avatar when a profile has not published one yet. */
export function profileAvatar(avatar?: string | null, identity = ''): string {
  if (avatar) return avatar

  const key = identity.toLowerCase()
  const cached = avatarCache.get(key)
  if (cached !== undefined) {
    return cached
  }

  let hash = 0
  for (const char of key) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  }
  const name = defaultAvatars[hash % defaultAvatars.length]
  const url = new URL(`../assets/avatars/${name}`, import.meta.url).href

  if (avatarCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = avatarCache.keys().next().value
    if (oldestKey !== undefined) {
      avatarCache.delete(oldestKey)
    }
  }
  avatarCache.set(key, url)

  return url
}
