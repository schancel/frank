import { MonadIdentity } from '@frank/wallet/monad-identity'

import {
  commitValidatedSetupName,
  checkConfirmationAnswers,
  commitValidatedSetupSeed,
  cryptoRandomInt,
  ensureConfirmationChallenge,
  initialSetupSeed,
  pickConfirmationPositions,
} from './setup-account'

const VALID_MNEMONIC =
  'test test test test test test test test test test test junk'

describe('setup account seed commitment', () => {
  it('rejects invalid input without changing the authoritative seed', () => {
    const persistSeed = jest.fn()

    expect(() =>
      commitValidatedSetupSeed('not a recovery phrase', persistSeed),
    ).toThrow(/invalid bip-39 mnemonic/i)
    expect(persistSeed).not.toHaveBeenCalled()
  })

  it('persists the exact normalized import used to recover its known identity', () => {
    let persistedSeed = 'unrelated eager seed'

    const committedSeed = commitValidatedSetupSeed(
      `  ${VALID_MNEMONIC.toUpperCase()}  `,
      seed => {
        persistedSeed = seed
      },
    )

    expect(committedSeed).toBe(VALID_MNEMONIC)
    expect(persistedSeed).toBe(VALID_MNEMONIC)
    expect(
      MonadIdentity.fromSeed({ mnemonic: persistedSeed }).address.raw,
    ).toBe('0x8C8d35429F74ec245F8Ef2f4Fd1e551cFF97d650')
  })
})

describe('setup account display name commitment', () => {
  it('persists and returns exactly the normalized name', () => {
    const persistName = jest.fn()

    const committedName = commitValidatedSetupName(
      '\u00a0Alice  Bob\u2003',
      true,
      persistName,
    )

    expect(committedName).toBe('Alice  Bob')
    expect(persistName).toHaveBeenCalledWith(committedName)
  })

  it('rejects invalid input without persisting it', () => {
    const persistName = jest.fn()

    expect(() => commitValidatedSetupName('   ', true, persistName)).toThrow(
      /invalid profile display name/i,
    )
    expect(persistName).not.toHaveBeenCalled()
  })
})

describe('setup name commitment fails closed', () => {
  it('treats an undefined nameRequired as required', () => {
    expect(() => commitValidatedSetupName('   ', undefined, jest.fn())).toThrow(
      /invalid profile display name/i,
    )
  })

  it('only an explicit false skips validation', () => {
    expect(commitValidatedSetupName('', false, jest.fn())).toBe('Frank User')
  })
})

describe('setup draft seed (#267)', () => {
  it('generates an in-memory draft for a fresh profile', () => {
    const generate = jest.fn(() => VALID_MNEMONIC)
    expect(initialSetupSeed(null, generate)).toBe(VALID_MNEMONIC)
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it('returns an existing stored seed untouched without generating', () => {
    const generate = jest.fn(() => VALID_MNEMONIC)
    expect(initialSetupSeed('existing stored seed', generate)).toBe(
      'existing stored seed',
    )
    expect(generate).not.toHaveBeenCalled()
  })

  it('committing persists exactly once and only at commit time, not on draft creation', () => {
    const persistSeed = jest.fn()
    const draft = initialSetupSeed(null, () => 'draft seed')
    expect(persistSeed).not.toHaveBeenCalled()
    commitValidatedSetupSeed(VALID_MNEMONIC, persistSeed)
    expect(draft).toBe('draft seed')
    expect(persistSeed).toHaveBeenCalledTimes(1)
    expect(persistSeed).toHaveBeenCalledWith(VALID_MNEMONIC, null)
  })

  it('an imported phrase is what gets persisted, not the draft', () => {
    const persistSeed = jest.fn()
    initialSetupSeed(null, () => 'draft seed')
    commitValidatedSetupSeed(VALID_MNEMONIC, persistSeed)
    expect(persistSeed).toHaveBeenCalledWith(VALID_MNEMONIC, null)
    expect(persistSeed).not.toHaveBeenCalledWith('draft seed')
  })
})

describe('recovery phrase confirmation challenge', () => {
  const seed = VALID_MNEMONIC.replace('junk', 'zoo')

  it('picks 3 distinct ascending 1-based positions using the injected RNG', () => {
    const picks = [11, 0, 5]
    const positions = pickConfirmationPositions(12, 3, () => picks.shift() ?? 0)
    expect(positions).toEqual([1, 7, 12])
  })

  it('uses the platform CSPRNG by default and always yields valid positions', () => {
    for (let i = 0; i < 200; i++) {
      const p = pickConfirmationPositions(12)
      expect(p).toHaveLength(3)
      expect(new Set(p).size).toBe(3)
      expect(p.every(n => n >= 1 && n <= 12)).toBe(true)
      expect([...p].sort((a, b) => a - b)).toEqual(p)
    }
  })

  it('refuses to fall back to Math.random when no CSPRNG exists', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
    Object.defineProperty(globalThis, 'crypto', {
      value: undefined,
      configurable: true,
    })
    const random = jest.spyOn(Math, 'random')
    try {
      expect(() => cryptoRandomInt(12)).toThrow(/secure random/i)
      expect(random).not.toHaveBeenCalled()
    } finally {
      random.mockRestore()
      if (original) Object.defineProperty(globalThis, 'crypto', original)
    }
  })

  it('reuses the challenge for the same phrase and redraws for a different one', () => {
    const first = ensureConfirmationChallenge(null, seed)
    expect(ensureConfirmationChallenge(first, `  ${seed.toUpperCase()} `)).toBe(
      first,
    )
    const other = ensureConfirmationChallenge(first, VALID_MNEMONIC)
    expect(other).not.toBe(first)
    expect(other.seed).toBe(VALID_MNEMONIC)
  })

  it('accepts only the exact words at the asked positions', () => {
    const positions = [1, 6, 12]
    expect(
      checkConfirmationAnswers(seed, positions, ['test', 'test', 'zoo']),
    ).toBe(true)
    expect(
      checkConfirmationAnswers(seed, positions, [' TEST ', 'Test', 'zoo']),
    ).toBe(true)
    expect(
      checkConfirmationAnswers(seed, positions, ['test', 'test', 'junk']),
    ).toBe(false)
    expect(
      checkConfirmationAnswers(seed, positions, ['test', 'test', '']),
    ).toBe(false)
    expect(checkConfirmationAnswers(seed, [], [])).toBe(false)
  })

  it('commitValidatedSetupSeed hands the marker to the store write', () => {
    const persistSeed = jest.fn()
    commitValidatedSetupSeed(VALID_MNEMONIC, persistSeed, 1234)
    expect(persistSeed).toHaveBeenCalledWith(VALID_MNEMONIC, 1234)
    commitValidatedSetupSeed(VALID_MNEMONIC, persistSeed)
    expect(persistSeed).toHaveBeenLastCalledWith(VALID_MNEMONIC, null)
  })
})
