import { HDNodeWallet } from 'ethers'
import vectors from '../domain-roots/vectors/domain-roots-v1.json'
import type { DomainPurpose, DomainRoot } from '../domain-roots/src'
import {
  bip32MasterFromDomainRoot,
  type Bip32DomainRoot,
} from './bip32-domain-root'
import { EvmHdKeyring, EvmChangeKeyring } from './secp256k1-hd-keyring'
import { MonadIdentity } from './monad-identity'
import { createMonadWalletMaterial } from './monad-wallet-material'

// Public predecessor outputs captured at 9b1c9605 from the repository's domain-root vectors.
// These literals pin interpretation and real consumer paths independently of the renamed helper.
const expectedOutputs = [
  {
    evmMaster:
      'xpub661MyMwAqRbcGmGJJjrNPgTgtcjNVMs8JDCWHrcmjnaJzxovac31WxbMmDGzCdEbA89qU9zDAn67wWpoPym8UCVad5WLiEgN17kx9NKVGcv',
    authMaster:
      'xpub661MyMwAqRbcH1db2kWLWZAGR8zPmaDnGBiBDNg9KonBNpCeAnkoCZ2gaXijoEUQsafG3VKAjH2Uj8dvqMujcf8HsBFFa9SG32PennTwf5F',
    spend: '0x5b2657B0E7A5b7582beDc9Ae1724ba61BeC67724',
    change: '0x3912fB0cE7495829590C67914166ecB586D8F598',
    identity: '0xa3b72b83A95d61352E969D9f09DB4276295B4175',
    mainAccount: '0x4669EFf913A3c595CeA5FA92a600201e8e9E75d8',
  },
  {
    evmMaster:
      'xpub661MyMwAqRbcFCrEWXiermWPfX51JnVaYEoHHSQ3YwccVp1Pi8hF5HCzqFZxV5dajh5bUYRoTfQ6H5FrkXDqJLrZuY8KmRcBsCjgD8TZnFU',
    authMaster:
      'xpub661MyMwAqRbcGbhaWZJvFifos9YgihjcScN1LNqB2wpw62eaiT2Vr3tdoRUubnBjQaoxoCvWeukdnaGjMeBYEf9Y83kS6fhjjsAp2ndxXKa',
    spend: '0xBcF19B8C0495b9436c99d720b0A1fdcd587C3fB2',
    change: '0x7cf72fC477c43cA1aEAD13F92a3Ed0F32b33b280',
    identity: '0x8dc3750A7789544eB239029B1Eb0EaaDdEbdfe9d',
    mainAccount: '0x44403a53EbB81056E865Fd706fE9B64E0B780390',
  },
] as const

const boundaryMasters = [
  {
    length: 16,
    master:
      'xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8',
  },
  {
    length: 64,
    master:
      'xpub661MyMwAqRbcGfcWxtZ8qv7JZur9jJJDG5FK8kquLBusvP8srTPJJF42ztmYTTap3YWc6FPxAn1U2dPvxPyZ1G5zDiXpaUnG7MB5UEasuGu',
  },
] as const

function root<P extends DomainPurpose>(
  index: number,
  purpose: P,
): DomainRoot<P> {
  return {
    registry: 'frank-domain-roots-v1',
    purpose,
    bytes: new Uint8Array(
      Buffer.from(vectors.vectors[index].outputs[purpose], 'hex'),
    ),
  }
}

describe('BIP-32 domain-root interpretation', () => {
  it.each(expectedOutputs.map((expected, index) => ({ expected, index })))(
    'preserves vector $index public masters and all existing consumer branches',
    ({ expected, index }) => {
      const evm = root(index, 'evm-wallet')
      const authentication = root(index, 'identity-authentication')
      const evmBefore = Uint8Array.from(evm.bytes)
      const authBefore = Uint8Array.from(authentication.bytes)
      const material = createMonadWalletMaterial({
        evm,
        authentication,
        messaging: root(index, 'messaging-encryption'),
      })
      try {
        expect({
          evmMaster: bip32MasterFromDomainRoot(evm, 'evm-wallet').neuter()
            .extendedKey,
          authMaster: bip32MasterFromDomainRoot(
            authentication,
            'identity-authentication',
          ).neuter().extendedKey,
          spend: EvmHdKeyring.fromDomainRoot(evm).deriveSubAccount(0).address,
          change:
            EvmChangeKeyring.fromDomainRoot(evm).deriveSubAccount(0).address,
          identity: MonadIdentity.fromDomainRoot(authentication).address.raw,
          mainAccount: material.mainAccount.address,
        }).toEqual(expected)
        expect(evm.bytes).toEqual(evmBefore)
        expect(authentication.bytes).toEqual(authBefore)
      } finally {
        material.dispose()
      }
    },
  )

  describe.each(['evm-wallet', 'identity-authentication'] as const)(
    '%s purpose',
    purpose => {
      it.each(boundaryMasters)(
        'preserves the valid $length-byte boundary',
        ({ length, master }) => {
          const bytes = Uint8Array.from({ length }, (_, index) => index)
          const before = Uint8Array.from(bytes)
          expect(
            bip32MasterFromDomainRoot({ purpose, bytes }, purpose).neuter()
              .extendedKey,
          ).toBe(master)
          expect(bytes).toEqual(before)
        },
      )

      it.each([15, 65])(
        'rejects %s-byte input before construction and preserves caller bytes',
        length => {
          const bytes = new Uint8Array(length).fill(0x63)
          const before = Uint8Array.from(bytes)
          const constructor = jest.spyOn(HDNodeWallet, 'fromSeed')
          try {
            expect(() =>
              bip32MasterFromDomainRoot({ purpose, bytes }, purpose),
            ).toThrow(
              new Error('BIP-32 domain root must contain 16 to 64 bytes'),
            )
            expect(constructor).not.toHaveBeenCalled()
            expect(bytes).toEqual(before)
          } finally {
            constructor.mockRestore()
          }
        },
      )
    },
  )

  it.each([
    undefined,
    null,
    17,
    'bytes',
    {},
    { purpose: 'evm-wallet', bytes: [1, 2] },
    { purpose: 'evm-wallet', bytes: new Uint16Array(32) },
  ])('rejects malformed bytes before purpose validation (%#)', input => {
    expect(() =>
      bip32MasterFromDomainRoot(
        input as unknown as Bip32DomainRoot,
        'evm-wallet',
      ),
    ).toThrow(new Error('BIP-32 domain root must be bytes'))
  })

  it.each(['identity-authentication', 'messaging-encryption'])(
    'rejects the wrong %s purpose before seed-length validation',
    purpose => {
      const input = { purpose, bytes: new Uint8Array(15).fill(7) }
      const before = Uint8Array.from(input.bytes)
      expect(() =>
        bip32MasterFromDomainRoot(
          input as unknown as Bip32DomainRoot,
          'evm-wallet',
        ),
      ).toThrow(new Error('Expected evm-wallet BIP-32 domain root'))
      expect(input.bytes).toEqual(before)
    },
  )

  it.each([false, true])(
    'wipes only its distinct constructor snapshot (constructor throws: %s)',
    throws => {
      const bytes = new Uint8Array(32).fill(0x63)
      const before = Uint8Array.from(bytes)
      const failure = new Error('constructor failed')
      const constructor = jest.spyOn(HDNodeWallet, 'fromSeed')
      if (throws)
        constructor.mockImplementation(() => {
          throw failure
        })
      try {
        const construct = () =>
          bip32MasterFromDomainRoot(
            { purpose: 'evm-wallet', bytes },
            'evm-wallet',
          )
        if (throws) expect(construct).toThrow(failure)
        else construct()
        const snapshot = constructor.mock.calls[0][0]
        expect(snapshot).toBeInstanceOf(Uint8Array)
        expect(snapshot).not.toBe(bytes)
        expect(snapshot).toEqual(new Uint8Array(bytes.length))
        expect(bytes).toEqual(before)
      } finally {
        constructor.mockRestore()
      }
    },
  )
})
