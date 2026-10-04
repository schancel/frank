import {
  SigningKey,
  computeHmac,
  concat,
  getBytes,
  hexlify,
  computeAddress,
} from 'ethers'
import { MonadHdKeyring } from './monad-hd-keyring'

const mnemonic = 'test test test test test test test test test test test junk'
describe('public actual branch descriptor', () => {
  it('reconstructs actual child addresses without secret/signing authority and owns returned bytes', () => {
    const keyring = MonadHdKeyring.fromMnemonic(mnemonic)
    const descriptor = keyring.publicBranchDescriptor()
    expect(Object.keys(descriptor).sort()).toEqual([
      'chainCode',
      'path',
      'publicKey',
    ])
    for (const index of [0, 1, 17, 255]) {
      const suffix = Uint8Array.of(
        index >>> 24,
        index >>> 16,
        index >>> 8,
        index,
      )
      const digest = getBytes(
        computeHmac(
          'sha512',
          descriptor.chainCode,
          concat([descriptor.publicKey, suffix]),
        ),
      )
      const tweakPoint = SigningKey.computePublicKey(digest.slice(0, 32), true)
      const child = SigningKey.addPoints(
        hexlify(descriptor.publicKey),
        tweakPoint,
        true,
      )
      expect(computeAddress(child)).toBe(
        keyring.deriveSubAccount(index).address,
      )
    }
    const original = keyring.publicBranchDescriptor()
    descriptor.publicKey.fill(0)
    descriptor.chainCode.fill(0)
    expect(keyring.publicBranchDescriptor()).toEqual(original)
    expect('privateKey' in descriptor).toBe(false)
    expect('sign' in descriptor).toBe(false)
    expect('masterNode' in descriptor).toBe(false)
    expect('seed' in descriptor).toBe(false)
    expect('root' in descriptor).toBe(false)
    expect('extendedKey' in descriptor).toBe(false)
    expect('signTransaction' in descriptor).toBe(false)
    expect('connect' in descriptor).toBe(false)
    expect('provider' in descriptor).toBe(false)
    expect('wallet' in descriptor).toBe(false)
    expect('fingerprint' in descriptor).toBe(false)
  })
})
