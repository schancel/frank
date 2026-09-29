import { MonadIdentity } from '@frank/wallet/monad-identity'

import { commitValidatedSetupSeed } from './setup-account'

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
