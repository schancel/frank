import { legacyLotusModeForFlag } from './legacy-mode'

describe('runtime mode', () => {
  it('defaults to Monad without constructing the legacy Lotus stack', () => {
    expect(legacyLotusModeForFlag(undefined)).toBe(false)
  })

  it('only enables Lotus compatibility when explicitly requested', () => {
    expect(legacyLotusModeForFlag('false')).toBe(true)
    expect(legacyLotusModeForFlag('true')).toBe(false)
  })
})
