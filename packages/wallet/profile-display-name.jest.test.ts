import { readFileSync } from 'fs'
import { resolve } from 'path'

import {
  requireValidProfileDisplayName,
  validateProfileDisplayName,
} from './profile-display-name'

interface FixtureCase {
  id: string
  input?: string
  inputRepeat?: { value: string; count: number; suffix?: string }
  valid: boolean
  normalized?: string
}

const fixture = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../fixtures/profile-display-name-v1.json'),
    'utf8',
  ),
) as { version: number; cases: FixtureCase[] }

function fixtureInput(testCase: FixtureCase): string {
  if (testCase.input !== undefined) return testCase.input
  const repeated = testCase.inputRepeat
  if (!repeated) throw new Error(`Fixture ${testCase.id} has no input`)
  return repeated.value.repeat(repeated.count) + (repeated.suffix ?? '')
}

describe('Decision #189 profile display name fixtures', () => {
  it('uses the versioned fixture contract', () => {
    expect(fixture.version).toBe(1)
  })

  it.each(fixture.cases)('$id', testCase => {
    const input = fixtureInput(testCase)
    const result = validateProfileDisplayName(input)

    expect(result.valid).toBe(testCase.valid)
    expect(result.normalized).toBe(testCase.normalized ?? input)
    if (testCase.valid) {
      expect(requireValidProfileDisplayName(input)).toBe(result.normalized)
    } else {
      expect(() => requireValidProfileDisplayName(input)).toThrow(
        /invalid profile display name/i,
      )
    }
  })

  it('does not apply Unicode normalization', () => {
    const decomposed = 'e\u0301'
    expect(requireValidProfileDisplayName(decomposed)).toBe(decomposed)
    expect(requireValidProfileDisplayName(decomposed)).not.toBe(
      decomposed.normalize('NFC'),
    )
  })
})
