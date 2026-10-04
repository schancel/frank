import { webcrypto } from 'crypto'
import vectors from '../domain-roots/vectors/domain-roots-v1.json'
import type { DomainPurpose, DomainRoot } from '../domain-roots/src'
import { deriveRoleLeaves } from '../role-keys/src'
import type { Current } from '../directory-admission/src'
import {
  cborMap,
  contentHash,
  directorySignatureDigest,
  encodeCanonical,
  encodeFrame,
  previewDirectoryContext,
  parseFrame,
} from '@frank/codec'
import {
  createMonadWalletMaterial,
  type MonadRootBundle,
} from './monad-wallet-material'

function roots(index = 0): MonadRootBundle {
  const root = <P extends DomainPurpose>(purpose: P): DomainRoot<P> => ({
    registry: 'frank-domain-roots-v1',
    purpose,
    bytes: new Uint8Array(
      Buffer.from(vectors.vectors[index].outputs[purpose], 'hex'),
    ),
  })
  return {
    evm: root('evm-wallet'),
    authentication: root('identity-authentication'),
    messaging: root('messaging-encryption'),
  }
}

// Signed offline fixture only. This does not test or replace directory admission.
function fixture(
  input = roots(),
  generation = 0n,
  previous = false,
  wireGeneration = generation,
) {
  const material = createMonadWalletMaterial(input)
  const leaves = deriveRoleLeaves({
    authRoot: input.authentication,
    messageRoot: input.messaging,
    stampRoot: input.evm,
    messageGeneration: generation,
    stampGeneration: generation,
    ...(previous ? { previousStampGeneration: generation - 1n } : {}),
  })
  const account = (point: Uint8Array) =>
    cborMap([
      [0, 1],
      [1, point],
    ])
  const timestamp = (seconds: bigint) =>
    cborMap([
      [0, seconds],
      [1, 0],
    ])
  const statement = encodeFrame(
    { typeId: 4, schemaVersion: 4, minReaderVersion: 4 },
    cborMap([
      [0, 'monad'],
      [1, account(leaves.auth.public.compressedPoint)],
      [2, wireGeneration],
      [3, timestamp(100n)],
      [
        4,
        [
          cborMap([
            [0, new Uint8Array(16).fill(8)],
            [1, 'https://relay.example'],
            [2, account(leaves.auth.public.compressedPoint)],
            [3, timestamp(4000n)],
          ]),
        ],
      ],
      [6, timestamp(3000n)],
      [8, account(leaves.stamp.public.compressedPoint)],
      [10, account(leaves.message.public.compressedPoint)],
      [11, wireGeneration],
      [12, wireGeneration],
      [13, wireGeneration === 0n ? null : new Uint8Array(32).fill(7)],
    ]),
  )
  const attestation = encodeFrame(
    { typeId: 2, schemaVersion: 1, minReaderVersion: 1 },
    cborMap([
      [0, statement],
      [
        1,
        [
          cborMap([
            [0, 1],
            [1, account(leaves.auth.public.compressedPoint)],
            [
              2,
              new Uint8Array(
                material.identity.signHash(
                  Buffer.from(directorySignatureDigest('monad', statement)),
                ),
              ),
            ],
          ]),
        ],
      ],
    ]),
  )
  const parsed = parseFrame(statement, previewDirectoryContext())
  if (parsed.kind !== 'parsed') throw new Error('fixture')
  const current = {
    kind: 'current',
    evidence: {
      kind: 'historical-evidence',
      statement,
      attestation,
      hash: contentHash(parsed),
    },
    messageKey: { keyType: 1, keyBytes: leaves.message.public.compressedPoint },
    stampKey: { keyType: 1, keyBytes: leaves.stamp.public.compressedPoint },
    previousStamp: leaves.previousStamp
      ? { keyType: 1, keyBytes: leaves.previousStamp.public.compressedPoint }
      : null,
    revision: wireGeneration,
    generations: [wireGeneration, wireGeneration],
    status: { forked: false },
  } as Current
  leaves.dispose()
  return { material, current, input }
}

beforeAll(() =>
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: webcrypto,
  }),
)

test('typed roots own separate roles, scoped seal/open, and caller mutations cannot change custody', () => {
  const a = fixture()
  const b = fixture(roots(1))
  try {
    for (const value of Object.values(a.input)) value.bytes.fill(0)
    const sender = a.material.canonicalRoles!.create('monad', a.current)
    const recipient = b.material.canonicalRoles!.create('monad', b.current)
    expect(sender.auth.compressedPoint).toEqual(
      new Uint8Array(a.material.identity.compressedPubKey),
    )
    expect(sender.message.compressedPoint).not.toEqual(
      sender.auth.compressedPoint,
    )
    expect(sender.stamp.compressedPoint).not.toEqual(
      sender.message.compressedPoint,
    )
    const point = sender.message.compressedPoint
    point.fill(0)
    expect(sender.message.compressedPoint.some(byte => byte !== 0)).toBe(true)
    const plain = new Uint8Array([1, 2, 3])
    const context = new Uint8Array([9, 8])
    const sealed = sender.sealMessage({
      recipientPublicKey: recipient.message.compressedPoint,
      plaintext: plain,
      context,
    })
    expect(sealed.ok).toBe(true)
    if (!sealed.ok) throw new Error('seal')
    const opened = recipient.openMessage({
      envelope: sealed.value,
      senderPublicKey: sender.message.compressedPoint,
      context,
    })
    expect(opened).toEqual({ ok: true, value: plain })
    expect(
      recipient.openMessage({
        envelope: sealed.value,
        senderPublicKey: sender.auth.compressedPoint,
        context,
      }).ok,
    ).toBe(false)
    expect(
      recipient.openMessage({
        envelope: sealed.value,
        senderPublicKey: sender.message.compressedPoint,
        context: new Uint8Array([0]),
      }).ok,
    ).toBe(false)
    sender.dispose()
    expect(() =>
      sender.sealMessage({
        recipientPublicKey: recipient.message.compressedPoint,
        plaintext: plain,
        context,
      }),
    ).toThrow('disposed')
    b.material.dispose()
    expect(() =>
      recipient.openMessage({
        envelope: sealed.value,
        senderPublicKey: sender.message.compressedPoint,
        context,
      }),
    ).toThrow('disposed')
    expect(() => b.material.canonicalRoles!.create('monad', b.current)).toThrow(
      'disposed',
    )
  } finally {
    a.material.dispose()
    b.material.dispose()
  }
})

test('local match is required, current cannot be replaced with history, and no legacy suite opens', () => {
  const a = fixture()
  const b = fixture(roots(1))
  try {
    expect(() => a.material.canonicalRoles!.create('monad', b.current)).toThrow(
      'mismatch',
    )
    expect(() =>
      a.material.canonicalRoles!.create('other', a.current),
    ).toThrow()
    expect(() =>
      a.material.canonicalRoles!.create('monad', {
        ...a.current,
        kind: 'historical-evidence',
      } as unknown as Current),
    ).toThrow('current-required')
    expect(() =>
      a.material.canonicalRoles!.create('monad', {
        ...a.current,
        messageKey: b.current.messageKey,
      }),
    ).toThrow('mismatch')
    expect(() =>
      a.material.canonicalRoles!.create('monad', {
        ...a.current,
        generations: [1n, 0n],
      }),
    ).toThrow('mismatch')
    const roles = a.material.canonicalRoles!.create('monad', a.current)
    expect(roles.previousStamp).toBeUndefined()
    expect(
      roles.openMessage({
        envelope: encodeCanonical(
          cborMap([
            [0, 2],
            [1, 0xfe03],
          ]),
        ),
        senderPublicKey: b.current.messageKey.keyBytes,
        context: new Uint8Array(),
      }).ok,
    ).toBe(false)
  } finally {
    a.material.dispose()
    b.material.dispose()
  }
})

test('an explicitly admitted adjacent previous stamp is matched, never invented', () => {
  const a = fixture(roots(), 1n, true)
  try {
    const roles = a.material.canonicalRoles!.create('monad', a.current)
    expect(roles.previousStamp?.compressedPoint).toEqual(
      a.current.previousStamp?.keyBytes,
    )
    expect(() =>
      a.material.canonicalRoles!.create('monad', {
        ...a.current,
        previousStamp: a.current.stampKey,
      }),
    ).toThrow('local-mismatch')
  } finally {
    a.material.dispose()
  }
})

test('legacy mnemonic material has no canonical capability', () => {
  const material = createMonadWalletMaterial({
    mnemonic:
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  })
  try {
    expect(material.canonicalRoles).toBeUndefined()
  } finally {
    material.dispose()
  }
})

test('valid remote uint64 generations do not truncate into local derivation indices', () => {
  const a = fixture(roots(), 0n, false, 2147483648n)
  try {
    expect(() => a.material.canonicalRoles!.create('monad', a.current)).toThrow(
      'unsupported-generation',
    )
  } finally {
    a.material.dispose()
  }
})

import { verifyPreviewDirectoryEvidence, toHex } from '@frank/codec'
import { canonicalWalletPublicBinding } from './monad-wallet-material'
import type { PublicRevisionZeroInput } from './monad-wallet-handle'

function revisionZeroInput(
  material: ReturnType<typeof createMonadWalletMaterial>,
): PublicRevisionZeroInput {
  const point = material.canonicalRoles!.publicGenerationZeroPoints().auth
  const process = (label: string) => ({
    processId: label,
    origin: `https://${label}.example`,
    tuple: {
      relayId: new Uint8Array(16).fill(label === 'a' ? 1 : 2),
      endpoint: `https://${label}.example`,
      identity: { keyType: 1, keyBytes: point },
      expiry: { seconds: 3700n, nanoseconds: 0 },
      unknownFields: new Map(),
    },
  })
  return {
    networkTag: 'MONT',
    network: 'monad-testnet',
    chainId: 10143n,
    issuedAt: { seconds: 100n, nanoseconds: 1 },
    expiresAt: { seconds: 3700n, nanoseconds: 1 },
    now: { seconds: 100n, nanoseconds: 1 },
    relayA: process('a'),
    relayB: process('b'),
    subjectBinding: 'A',
  }
}

describe('effect-free typed public preparation', () => {
  it('exports exact deterministic schema4 evidence and generation-zero public role points without Current', () => {
    const material = createMonadWalletMaterial(roots())
    const input = revisionZeroInput(material)
    // Tuple coverage uses exact nanosecond timestamp, not rounded seconds.
    input.relayA.tuple.expiry.nanoseconds = 1
    input.relayB.tuple.expiry.nanoseconds = 1
    try {
      const exported = material.canonicalRoles!.prepareRevisionZero(input)
      const repeat = material.canonicalRoles!.prepareRevisionZero(input)
      expect(repeat.statement).toEqual(exported.statement)
      expect(repeat.attestation).toEqual(exported.attestation)
      const verified = verifyPreviewDirectoryEvidence(
        exported.attestation,
        input.network,
      )
      expect(verified.statementFrame.frame).toEqual(exported.statement)
      expect(verified.statementHash).toEqual(exported.t1)
      expect(verified.statement.revision).toBe(0n)
      expect(verified.statement.preview.mailboxKeyGeneration).toBe(0n)
      expect(verified.statement.preview.stampKeyGeneration).toBe(0n)
      expect(verified.statement.preview.predecessor).toBeNull()
      expect(verified.statement.relays).toHaveLength(1)
      expect(verified.statement.relays[0].endpoint).toBe('https://a.example')
      expect(toHex(verified.statement.subject.keyBytes)).toBe(
        toHex(exported.auth.compressedPoint),
      )
      expect(toHex(verified.statement.preview.messageDhKey.keyBytes)).toBe(
        toHex(exported.message.compressedPoint),
      )
      expect(toHex(verified.statement.stampKey.keyBytes)).toBe(
        toHex(exported.stamp.compressedPoint),
      )
      expect(Object.keys(exported)).not.toContain('current')
      expect(Object.keys(exported)).not.toContain('root')
      expect(Object.keys(exported)).not.toContain('fingerprint')
      const bytes = exported.statement
      bytes.fill(0)
      exported.configuration.relayA.tuple.identity.keyBytes.fill(0)
      exported.auth.compressedPoint.fill(0)
      expect(exported.statement).toEqual(repeat.statement)
      expect(exported.configuration.relayA.tuple.identity.keyBytes).toEqual(
        input.relayA.tuple.identity.keyBytes,
      )
      const recovered = createMonadWalletMaterial(roots())
      try {
        expect(
          recovered.canonicalRoles!.prepareRevisionZero(input).attestation,
        ).toEqual(exported.attestation)
      } finally {
        recovered.dispose()
      }
    } finally {
      material.dispose()
    }
    expect(() => material.canonicalRoles!.prepareRevisionZero(input)).toThrow(
      'disposed',
    )
  })
  it('binds all actual public roots and pool branches without serializing the secret fingerprint', () => {
    const one = createMonadWalletMaterial(roots()),
      same = createMonadWalletMaterial(roots())
    const changed = { ...roots(), messaging: roots(1).messaging }
    const other = createMonadWalletMaterial(changed)
    try {
      const binding = canonicalWalletPublicBinding(one, 'monad-testnet', 10143n)
      expect(binding).toEqual(
        canonicalWalletPublicBinding(same, 'monad-testnet', 10143n),
      )
      expect(binding.id).not.toBe(
        canonicalWalletPublicBinding(other, 'monad-testnet', 10143n).id,
      )
      expect(binding.tuple).not.toContain(one.fingerprint)
      expect(JSON.parse(binding.tuple).accounts.path).toBe("m/44'/60'/0'/0")
      expect(JSON.parse(binding.tuple).change.path).toBe("m/44'/60'/0'/1")
      expect(() =>
        canonicalWalletPublicBinding(one, 'monad-mainnet', 10143n),
      ).toThrow('typed-network')
    } finally {
      one.dispose()
      same.dispose()
      other.dispose()
    }
  })
  it('rejects expiry, tuple coverage and mismatched descriptor before producing signed evidence', () => {
    const material = createMonadWalletMaterial(roots()),
      input = revisionZeroInput(material)
    try {
      expect(() => material.canonicalRoles!.prepareRevisionZero(input)).toThrow(
        'tuple-expiry',
      )
      const covered = revisionZeroInput(material)
      covered.relayA.tuple.expiry.nanoseconds = 1
      covered.relayB.tuple.expiry.nanoseconds = 1
      expect(() =>
        material.canonicalRoles!.prepareRevisionZero({
          ...covered,
          networkTag: 'MON1',
        }),
      ).toThrow('network')
      expect(() =>
        material.canonicalRoles!.prepareRevisionZero({
          ...covered,
          now: covered.expiresAt,
        }),
      ).toThrow('validity')
      expect(() =>
        material.canonicalRoles!.prepareRevisionZero({
          ...covered,
          expiresAt: { seconds: 3701n, nanoseconds: 1 },
        }),
      ).toThrow('validity')
    } finally {
      material.dispose()
    }
  })
})
