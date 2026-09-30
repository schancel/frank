import { readFileSync } from 'fs'
import { resolve } from 'path'

import { normalizedProfileName, profileNameRule } from './profile-name'

// Echoes the key and parameters so the assertions see exactly which message was chosen.
const t = (key: string, params?: Record<string, unknown>) =>
  params ? `${key}:${JSON.stringify(params)}` : key

describe('profile editor name rule', () => {
  it.each([
    ['', 'profile.nameBlank'],
    ['   ', 'profile.nameBlank'],
    ['\u00a0', 'profile.nameBlank'],
    ['A\u0000B', 'profile.nameForbiddenCharacters'],
    ['a\u2028b', 'profile.nameForbiddenCharacters'],
    ['a'.repeat(129), 'profile.nameTooLong:{"max":128}'],
    ['a\ud800b', 'profile.nameInvalidUnicode'],
  ])('rejects %j with %s', (name, message) =>
    expect(profileNameRule(name, t)).toBe(message),
  )

  it('accepts a valid name and normalizes edges only', () => {
    expect(profileNameRule('  Alice  Bob  ', t)).toBe(true)
    expect(normalizedProfileName('  Alice  Bob  ')).toBe('Alice  Bob')
  })

  it('is what the Profile component uses for its rule and emit', () => {
    const source = readFileSync(
      resolve(__dirname, '../components/Profile.vue'),
      'utf8',
    )
    expect(source).toContain(':rules="[nameRule]"')
    expect(source).toContain('profileNameRule(val,')
    expect(source).toContain(
      "this.$emit('update:name', normalizedProfileName(value))",
    )
  })
})
