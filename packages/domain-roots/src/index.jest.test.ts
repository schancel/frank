import {
  DERIVATION_REGISTRY_CODE,
  DERIVATION_REGISTRY_ID,
  DOMAIN_PURPOSES,
  deriveDomainRoot,
  registryEntry,
} from './index.js'

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

describe('frank-domain-roots-v1', () => {
  it('freezes the registry identity and complete purpose allocation', () => {
    expect(DERIVATION_REGISTRY_ID).toBe('frank-domain-roots-v1')
    expect(DERIVATION_REGISTRY_CODE).toBe(1)
    expect(DOMAIN_PURPOSES).toEqual([
      'ecash-bch-wallet',
      'evm-wallet',
      'solana-wallet',
      'messaging-encryption',
      'identity-authentication',
    ])
    expect(
      new Set(DOMAIN_PURPOSES.map(purpose => registryEntry(purpose).code)).size,
    ).toBe(5)
    expect(
      new Set(DOMAIN_PURPOSES.map(purpose => registryEntry(purpose).label))
        .size,
    ).toBe(5)
  })

  it.each([
    {
      root: '00'.repeat(32),
      outputs: {
        'ecash-bch-wallet':
          'b69b4040177891a564acc8b7fc81ebb5da0b5e03e6b3f3913b2954f646afdcb7',
        'evm-wallet':
          'cee86a4b731c08858ad659009790516658141bb99e3be5bd144ab6ca657d19c4',
        'solana-wallet':
          '24df22e3939688ffdf2d622ff5f0f9d6ed6ebe3f988aa371f7d52cf21cc260aa',
        'messaging-encryption':
          '64e0df3a659dc4720f18753deff7586d9dcb2984cf2fbd602e53eae49d963c40',
        'identity-authentication':
          '5719945a0500eaeef2d0beee0de446e7ef65e9ff7c607681c0a7a7a95bb8914e',
      },
    },
    {
      root: Array.from({ length: 32 }, (_, index) =>
        index.toString(16).padStart(2, '0'),
      ).join(''),
      outputs: {
        'ecash-bch-wallet':
          '3f7e6601a459a8f3c4e2976d662578361ad7ec2f7b5e80f4daca5526d33ecc33',
        'evm-wallet':
          '07cbdd9e307849bda7312fa4144afbd78e05b710aa6241bca48e08f028b615b3',
        'solana-wallet':
          'fbd0a74f43c9e84e6f7920b234c20d59df0e850ae24063ac243b32bcf1eb154c',
        'messaging-encryption':
          '3785f5f436b651879055d71087b9ed3df7fb88054000ce520b4bd8ed11961331',
        'identity-authentication':
          '006831dc0753bd4020bf7ea41d98f27bb03142cc78e94d38b4199215aedbc0fc',
      },
    },
  ] as const)('matches every known-answer vector for root $root', vector => {
    const root = Uint8Array.from(
      vector.root.match(/../g)!.map(byte => Number.parseInt(byte, 16)),
    )
    for (const purpose of DOMAIN_PURPOSES) {
      expect(hex(deriveDomainRoot(root, purpose).bytes)).toBe(
        vector.outputs[purpose],
      )
    }
  })

  it('separates every purpose and root', () => {
    const zero = new Uint8Array(32)
    const one = new Uint8Array(32)
    one[31] = 1
    const outputs = DOMAIN_PURPOSES.flatMap(purpose => [
      hex(deriveDomainRoot(zero, purpose).bytes),
      hex(deriveDomainRoot(one, purpose).bytes),
    ])
    expect(new Set(outputs).size).toBe(outputs.length)
  })

  it('rejects malformed roots and unallocated purposes', () => {
    expect(() => deriveDomainRoot(new Uint8Array(31), 'evm-wallet')).toThrow(
      'exactly 32 bytes',
    )
    expect(() =>
      deriveDomainRoot(new Uint8Array(32), 'extension-root' as never),
    ).toThrow('Unknown domain-root purpose')
    expect(() =>
      deriveDomainRoot(new Uint8Array(32), 'toString' as never),
    ).toThrow('Unknown domain-root purpose')
  })

  it('does not alias input or prior outputs', () => {
    const root = new Uint8Array(32).fill(7)
    const first = deriveDomainRoot(root, 'evm-wallet')
    root.fill(9)
    const second = deriveDomainRoot(new Uint8Array(32).fill(7), 'evm-wallet')
    expect(first.bytes).toEqual(second.bytes)
    first.bytes.fill(0)
    expect(hex(second.bytes)).not.toBe('00'.repeat(32))
  })
})
