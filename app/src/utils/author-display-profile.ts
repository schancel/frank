/** Display fields only: this projection does not authenticate or normalize stored profiles. */
export interface AuthorDisplayProfile {
  name?: string
  username?: string
  accountType?: number
  botRole?: number
  isBot?: boolean
}

export function authorDisplayProfile(profile: unknown): AuthorDisplayProfile {
  const fields: AuthorDisplayProfile = {}
  if (profile === null || typeof profile !== 'object') return fields
  if ('name' in profile && typeof profile.name === 'string')
    fields.name = profile.name
  if ('username' in profile && typeof profile.username === 'string')
    fields.username = profile.username
  if ('accountType' in profile && typeof profile.accountType === 'number')
    fields.accountType = profile.accountType
  if ('botRole' in profile && typeof profile.botRole === 'number')
    fields.botRole = profile.botRole
  if ('isBot' in profile && typeof profile.isBot === 'boolean')
    fields.isBot = profile.isBot
  return fields
}
