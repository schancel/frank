/**
 * The swap HTLC preimage (`frank/swap-htlc-preimage/v1`, `swap-preimage.ts`): pinned vectors from
 * the public domain-root test vectors, the same on every handle of one account and different for
 * another swap, another policy or another account. The roots here are published test data, not
 * any account's keys.
 */
import { Mnemonic, getBytes, sha256 } from 'ethers'
import vectors from '../domain-roots/vectors/domain-roots-v1.json'
import { BIP39_DERIVATION } from '../domain-roots/src'
import type { DomainPurpose, DomainRoot } from '../domain-roots/src'
import {
  createMonadWalletMaterial,
  type MonadRootBundle,
} from './evm-wallet-material'
import {
  SWAP_PREIMAGE_LABEL,
  deriveSwapPreimage,
  swapPreimageInfo,
} from './swap-preimage'

function roots(index: number): MonadRootBundle {
  const root = <P extends DomainPurpose>(purpose: P): DomainRoot<P> => ({
    registry: 'frank-domain-roots-v1',
    purpose,
    bytes: new Uint8Array(
      Buffer.from(vectors.vectors[index]!.outputs[purpose], 'hex'),
    ),
  })
  return {
    evm: root('evm-wallet'),
    authentication: root('identity-authentication'),
    messaging: root('messaging-encryption'),
  }
}
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')
const swapA = Uint8Array.from({ length: 32 }, (_, i) => i)
const swapB = Uint8Array.from({ length: 32 }, (_, i) => 0xff - i)
const POLICY = 'xec-monad-testnet-v2'
const REGTEST = 'xec-monad-regtest-proof-v2'

/** Pinned: changing any of these is a new derivation version (AGENTS.md §6). */
const PINNED = {
  account0: {
    testnetSwapA:
      'ff6fa27c3dc34988e8a5a24b9f6f4fa349fdfbde2078c4e1f67cf0fe127b9c55',
    testnetSwapB:
      '44021171799b0f1fafc14e15cb16afd09c9dd2cdf61a25ade5e2a4afac2bdc13',
    regtestSwapA:
      'c4ac822ae1a15ca76e637613bc5bf89e021d130e95cf861090ddcffe9820f762',
  },
  account1TestnetSwapA:
    '74b73fb2249e9a30f1ffc04ce21ae62ee91a8fbde6c283c3a1e797fad0cdcd6d',
  historicalTestnetSwapA:
    '2ed365ef4689a664728e41fb3a156f2c7544f8f6be156326de55df263edd163f',
}

describe('swap HTLC preimage derivation (frank/swap-htlc-preimage/v1)', () => {
  it('is the pinned value, the same on two handles of one account', () => {
    const one = createMonadWalletMaterial(roots(0))
    const two = createMonadWalletMaterial(roots(0))
    try {
      const a = one.canonicalRoles!.swapPreimage({
        policyName: POLICY,
        swapId: swapA,
      })
      expect(a).toHaveLength(32)
      expect(hex(a)).toBe(PINNED.account0.testnetSwapA)
      expect(
        hex(
          two.canonicalRoles!.swapPreimage({
            policyName: POLICY,
            swapId: swapA,
          }),
        ),
      ).toBe(PINNED.account0.testnetSwapA)
      // The hash lock both sides of a swap see.
      expect(sha256(a)).toMatch(/^0x[0-9a-f]{64}$/)
      // A fresh copy each time: wiping one does not change the next.
      a.fill(0)
      expect(
        hex(
          one.canonicalRoles!.swapPreimage({
            policyName: POLICY,
            swapId: swapA,
          }),
        ),
      ).toBe(PINNED.account0.testnetSwapA)
    } finally {
      one.dispose()
      two.dispose()
    }
  })

  it('differs by swap id, by policy name and by account', () => {
    const zero = createMonadWalletMaterial(roots(0))
    const one = createMonadWalletMaterial(roots(1))
    try {
      const p = (m: typeof zero, policyName: string, swapId: Uint8Array) =>
        hex(m.canonicalRoles!.swapPreimage({ policyName, swapId }))
      expect(p(zero, POLICY, swapB)).toBe(PINNED.account0.testnetSwapB)
      expect(p(zero, REGTEST, swapA)).toBe(PINNED.account0.regtestSwapA)
      expect(p(one, POLICY, swapA)).toBe(PINNED.account1TestnetSwapA)
      const all = [
        p(zero, POLICY, swapA),
        p(zero, POLICY, swapB),
        p(zero, REGTEST, swapA),
        p(one, POLICY, swapA),
      ]
      expect(new Set(all).size).toBe(all.length)
    } finally {
      zero.dispose()
      one.dispose()
    }
  })

  it('a historical BIP39 account derives from its whole seed, the same on every handle', () => {
    const phrase = 'test test test test test test test test test test test junk'
    const seed = () => getBytes(Mnemonic.fromPhrase(phrase).computeSeed())
    const one = createMonadWalletMaterial({
      derivation: BIP39_DERIVATION,
      seed: seed(),
    })
    const two = createMonadWalletMaterial({
      derivation: BIP39_DERIVATION,
      seed: seed(),
    })
    try {
      const value = hex(
        one.canonicalRoles!.swapPreimage({ policyName: POLICY, swapId: swapA }),
      )
      expect(value).toBe(PINNED.historicalTestnetSwapA)
      expect(
        hex(
          two.canonicalRoles!.swapPreimage({
            policyName: POLICY,
            swapId: swapA,
          }),
        ),
      ).toBe(value)
      expect(hex(deriveSwapPreimage(seed(), POLICY, swapA))).toBe(value)
    } finally {
      one.dispose()
      two.dispose()
    }
  })

  it('is HKDF-SHA256 under the label, with a length-prefixed policy name', () => {
    expect(SWAP_PREIMAGE_LABEL).toBe('frank/swap-htlc-preimage/v1')
    expect(hex(swapPreimageInfo('ab', swapA))).toBe('02' + '6162' + hex(swapA))
    // "a" ‖ "b…" and "ab" ‖ "…" cannot meet: the prefix separates them.
    expect(
      hex(swapPreimageInfo('a', Uint8Array.of(0x62, ...swapA.slice(0, 31)))),
    ).not.toBe(hex(swapPreimageInfo('ab', swapA)))
    const material = createMonadWalletMaterial(roots(0))
    try {
      expect(
        hex(deriveSwapPreimage(roots(0).messaging.bytes, POLICY, swapA)),
      ).toBe(PINNED.account0.testnetSwapA)
    } finally {
      material.dispose()
    }
  })

  it('refuses a bad swap id or policy name, and a disposed account', () => {
    const material = createMonadWalletMaterial(roots(0))
    const roles = material.canonicalRoles!
    for (const swapId of [
      new Uint8Array(31),
      new Uint8Array(33),
      'ab' as never,
    ])
      expect(() => roles.swapPreimage({ policyName: POLICY, swapId })).toThrow(
        'Swap id',
      )
    for (const policyName of ['', 'x'.repeat(256), 7 as never])
      expect(() => roles.swapPreimage({ policyName, swapId: swapA })).toThrow(
        'policy name',
      )
    expect(() => deriveSwapPreimage(new Uint8Array(16), POLICY, swapA)).toThrow(
      RangeError,
    )
    material.dispose()
    expect(() =>
      roles.swapPreimage({ policyName: POLICY, swapId: swapA }),
    ).toThrow('disposed')
  })
})
