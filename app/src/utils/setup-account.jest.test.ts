import { MonadIdentity } from '@frank/wallet/monad-identity'

import {
  commitValidatedSetupName,
  commitValidatedSetupSeed,
  initialSetupSeed,
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
    expect(persistSeed).toHaveBeenCalledWith(VALID_MNEMONIC)
  })

  it('an imported phrase is what gets persisted, not the draft', () => {
    const persistSeed = jest.fn()
    initialSetupSeed(null, () => 'draft seed')
    commitValidatedSetupSeed(VALID_MNEMONIC, persistSeed)
    expect(persistSeed).toHaveBeenCalledWith(VALID_MNEMONIC)
    expect(persistSeed).not.toHaveBeenCalledWith('draft seed')
  })
})
