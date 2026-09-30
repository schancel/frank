import { readFileSync } from 'fs'
import { resolve } from 'path'

import { normalizedProfileName, profileNameRule } from './profile-name'

describe('profile editor name rule', () => {
  it.each(['', '   ', '\u00a0', 'A\u0000B', 'a'.repeat(129)])(
    'rejects %#',
    name => expect(profileNameRule(name, 'MSG')).toBe('MSG'),
  )

  it('accepts a valid name and normalizes edges only', () => {
    expect(profileNameRule('  Alice  Bob  ', 'MSG')).toBe(true)
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
