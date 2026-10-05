import { defaultAvatars } from './constants'

export * from './avatar-resize'

/** Return a stable bundled avatar when a profile has not published one yet. Node/Jest-safe. */
export function profileAvatar(avatar?: string | null, identity = ''): string {
  if (avatar) return avatar

  let hash = 0
  for (const char of identity.toLowerCase()) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  }
  const name = defaultAvatars[hash % defaultAvatars.length]
  return `assets/avatars/${name}`
}
