import * as codex32 from '@frank/codex32'
import * as domainRoots from '@frank/domain-roots'
import * as hashes from '@noble/hashes/sha256.js'
import { encodeBech32, decodeBech32 } from '@frank/nakamoto/bech32'
import { convertBits } from '@frank/nakamoto/convert-bits'
import vectors from '../vectors/public-recovery-v1.json'
import {
  AccountRecoveryError,
  beginCodex32Signup,
  beginCodex32Restore,
  decodeRecoveryDescriptor,
  decodeRecoveryFingerprint,
  deriveRecoveryPublicMetadata,
  destroyAccountDomainRoots,
  encodeRecoveryDescriptor,
  encodeRecoveryFingerprint,
  type PublicRecoveryDescriptor,
} from './index.js'

const bytes = (hex: string): Uint8Array =>
  Uint8Array.from(Buffer.from(hex, 'hex'))
const hex = (value: Uint8Array): string => Buffer.from(value).toString('hex')
const ok = <T>(result: { ok: true; value: T } | { ok: false }): T => {
  if (!result.ok) throw new Error('fixture failed')
  return result.value
}
const errorCode = (
  action: () => unknown,
  code: AccountRecoveryError['code'],
): void => {
  try {
    action()
    throw new Error('expected failure')
  } catch (error) {
    expect(error).toBeInstanceOf(AccountRecoveryError)
    expect(error).toMatchObject({
      name: 'AccountRecoveryError',
      code,
      message: `Frank account recovery failed: ${code}`,
    })
    expect(Object.keys(error as object).sort()).toEqual(['code', 'name'])
  }
}
const encodePayload = (
  payload: Uint8Array,
  hrp = 'frankdesc',
  spec: 'bech32' | 'bech32m' = 'bech32m',
) => ok(encodeBech32(hrp, ok(convertBits(Array.from(payload), 8, 5)), spec))
const sharesFor = (master: Uint8Array, identifier = 'frnk') =>
  ok(
    codex32.splitCodex32({
      threshold: 2,
      identifier,
      indices: ['q', 'p', 'z'],
      secret: master,
      randomBytes: length => new Uint8Array(length).fill(7),
    }),
  )
const signup = () => {
  let first = true
  return beginCodex32Signup({
    threshold: 2,
    identifier: 'frnk',
    indices: ['q', 'p', 'z'],
    randomBytes: length => {
      const result = new Uint8Array(length).fill(first ? 0 : 7)
      first = false
      return result
    },
  })
}

afterEach(() => jest.restoreAllMocks())

describe('frozen public recovery vectors', () => {
  it.each(vectors)(
    '$name: exact preimages, full digests and canonical encodings',
    vector => {
      const preimages: string[] = []
      const references: Uint8Array[] = []
      const hash = hashes.sha256
      jest.spyOn(hashes, 'sha256').mockImplementation(value => {
        if (value instanceof Uint8Array) {
          preimages.push(hex(value))
          references.push(value)
        }
        return hash(value)
      })
      const master = bytes(vector.master)
      const metadata = deriveRecoveryPublicMetadata(master)
      expect(hex(master)).toBe(vector.master)
      expect(preimages).toEqual([
        vector.validationPreimage,
        vector.fingerprintPreimage,
        vector.retirementPreimage,
        vector.identityPreimage,
      ])
      expect(references.every(value => value.every(byte => byte === 0))).toBe(
        true,
      )
      expect(hex(metadata.descriptor.publicRecoveryFingerprint)).toBe(
        vector.fingerprint,
      )
      expect(hex(metadata.masterRetirementId)).toBe(vector.masterRetirementId)
      expect(hex(metadata.recoveryIdentityCommitment)).toBe(
        vector.recoveryIdentityCommitment,
      )
      expect(encodeRecoveryDescriptor(metadata.descriptor)).toBe(
        vector.frankdesc,
      )
      expect(
        encodeRecoveryFingerprint(
          metadata.descriptor.publicRecoveryFingerprint,
        ),
      ).toBe(vector.frankrec)
      expect(vector.frankdesc).toHaveLength(76)
      expect(vector.frankrec).toHaveLength(67)
      for (const text of [vector.frankdesc, vector.frankdesc.toUpperCase()]) {
        const decoded = decodeRecoveryDescriptor(text)
        expect(hex(decoded.publicRecoveryFingerprint)).toBe(vector.fingerprint)
        expect(encodeRecoveryDescriptor(decoded)).toBe(vector.frankdesc)
      }
      for (const text of [vector.frankrec, vector.frankrec.toUpperCase()]) {
        expect(hex(decodeRecoveryFingerprint(text))).toBe(vector.fingerprint)
      }
      expect(
        hex(
          Uint8Array.from(
            ok(
              convertBits(ok(decodeBech32(vector.frankdesc)).data, 5, 8, true),
            ),
          ),
        ),
      ).toBe(vector.descriptorPayload)
      expect(
        new Set([
          vector.fingerprint,
          vector.changedFormatFingerprint,
          vector.changedRegistryFingerprint,
        ]).size,
      ).toBe(3)
      expect(
        new Set([
          vector.recoveryIdentityCommitment,
          vector.changedFormatIdentity,
          vector.changedRegistryIdentity,
        ]).size,
      ).toBe(3)
    },
  )

  it('returns immutable public objects with fresh bytes and no family authority or secret fields', () => {
    const metadata = deriveRecoveryPublicMetadata(bytes(vectors[0]!.master))
    expect(Object.keys(metadata).sort()).toEqual([
      'descriptor',
      'masterRetirementId',
      'recoveryIdentityCommitment',
    ])
    expect(Object.keys(metadata.descriptor).sort()).toEqual([
      'publicRecoveryFingerprint',
      'recoveryFormat',
      'recoveryFormatCode',
      'registry',
      'registryCode',
    ])
    expect(Object.isFrozen(metadata)).toBe(true)
    expect(Object.isFrozen(metadata.descriptor)).toBe(true)
    metadata.descriptor.publicRecoveryFingerprint.fill(0)
    metadata.masterRetirementId.fill(0)
    metadata.recoveryIdentityCommitment.fill(0)
    expect(encodeRecoveryDescriptor(metadata.descriptor)).toBe(
      vectors[0]!.frankdesc,
    )
    expect(hex(metadata.masterRetirementId)).toBe(
      vectors[0]!.masterRetirementId,
    )
    expect(hex(metadata.recoveryIdentityCommitment)).toBe(
      vectors[0]!.recoveryIdentityCommitment,
    )
    const one = decodeRecoveryFingerprint(vectors[0]!.frankrec)
    one.fill(0)
    expect(hex(decodeRecoveryFingerprint(vectors[0]!.frankrec))).toBe(
      vectors[0]!.fingerprint,
    )
  })
})

describe('strict public codecs', () => {
  const vector = vectors[0]!
  it.each([
    ['recoveryFormat', 'codex32-master-v2', 'wrong-recovery-format'],
    ['recoveryFormatCode', 2, 'wrong-recovery-format'],
    ['registry', 'frank-domain-roots-v2', 'wrong-registry'],
    ['registryCode', 2, 'wrong-registry'],
  ] as const)(
    'rejects unallocated descriptor field %s at public boundaries',
    (field, value, code) => {
      const input = {
        ...decodeRecoveryDescriptor(vector.frankdesc),
        [field]: value,
      }
      errorCode(
        () => encodeRecoveryDescriptor(input as PublicRecoveryDescriptor),
        code,
      )
      errorCode(
        () => beginCodex32Restore(input as PublicRecoveryDescriptor),
        code,
      )
    },
  )
  it.each([
    ['version', 0, 0, 'invalid-descriptor'],
    ['version', 0, 2, 'invalid-descriptor'],
    ['format-high', 1, 1, 'wrong-recovery-format'],
    ['format-zero', 2, 0, 'wrong-recovery-format'],
    ['format-unknown', 2, 2, 'wrong-recovery-format'],
    ['registry-high', 3, 1, 'wrong-registry'],
    ['registry-zero', 4, 0, 'wrong-registry'],
    ['registry-unknown', 4, 2, 'wrong-registry'],
  ] as const)(
    'rejects valid-checksum %s substitution %i/%i',
    (_, index, value, code) => {
      const payload = bytes(vector.descriptorPayload)
      payload[index] = value
      errorCode(() => decodeRecoveryDescriptor(encodePayload(payload)), code)
    },
  )

  it.each([
    [
      vector.frankdesc,
      'frankdesc',
      bytes(vector.descriptorPayload),
      decodeRecoveryDescriptor,
      'invalid-descriptor',
    ],
    [
      vector.frankrec,
      'frankrec',
      bytes(vector.fingerprint),
      decodeRecoveryFingerprint,
      'invalid-fingerprint',
    ],
  ] as const)(
    'rejects case, checksum, framing, padding and oversized input: %s',
    (text, hrp, payload, decode, code) => {
      const words = [...ok(decodeBech32(text)).data]
      const badPadding = [...words]
      badPadding[badPadding.length - 1] = badPadding[badPadding.length - 1]! | 1
      const malformed: unknown[] = [
        null,
        {},
        new String(text),
        5,
        'x'.repeat(1000000),
        '',
        ` ${text}`,
        `${text}\n`,
        text.slice(0, -1),
        `${text}q`,
        `${text[0]!.toUpperCase()}${text.slice(1)}`,
        text.toUpperCase().replace('K', '\u212a'),
        text.replace('k', '\u0000'),
        `${text.slice(0, -1)}${text.endsWith('q') ? 'p' : 'q'}`,
        encodePayload(payload, `${hrp.slice(0, -1)}x`),
        encodePayload(payload, hrp, 'bech32'),
        encodePayload(payload.subarray(1), hrp),
        encodePayload(Uint8Array.from([...payload, 0]), hrp),
        ok(encodeBech32(hrp, badPadding, 'bech32m')),
        ok(encodeBech32(hrp, [...words, 0], 'bech32m')),
        ok(encodeBech32(hrp, words.slice(0, -1), 'bech32m')),
      ]
      for (const input of malformed)
        errorCode(() => decode(input as string), code)
    },
  )

  it('rejects stale checksums but permits structurally valid wrong fingerprints', () => {
    const payload = bytes(vector.descriptorPayload)
    payload[36] ^= 1
    const changed = encodePayload(payload)
    expect(decodeRecoveryDescriptor(changed).publicRecoveryFingerprint).toEqual(
      payload.subarray(5),
    )
    errorCode(
      () =>
        decodeRecoveryDescriptor(
          changed.slice(0, -6) + vector.frankdesc.slice(-6),
        ),
      'invalid-descriptor',
    )
  })
})

describe('signup and pinned descriptor restore boundary', () => {
  it('confirms and restores identical metadata and roots through the public facade', () => {
    const pending = signup()
    const shares = pending.shares
    const descriptor = decodeRecoveryDescriptor(
      encodeRecoveryDescriptor(pending.publicDescriptor),
    )
    expect(pending.familyMetadata).toBe(pending.descriptor)
    errorCode(
      () =>
        beginCodex32Restore(
          pending.familyMetadata as unknown as PublicRecoveryDescriptor,
        ),
      'invalid-descriptor',
    )
    const restore = beginCodex32Restore(descriptor)
    const created = pending.confirmWithMetadata(shares.slice(0, 2))
    const recovered = restore.recover(shares.slice(1))
    expect(recovered).toEqual(created)
    expect(encodeRecoveryDescriptor(created.metadata.descriptor)).toBe(
      vectors[0]!.frankdesc,
    )
    expect(hex(created.metadata.masterRetirementId)).toBe(
      vectors[0]!.masterRetirementId,
    )
    for (const purpose of domainRoots.DOMAIN_PURPOSES) {
      expect(created.roots[purpose].bytes).not.toBe(
        recovered.roots[purpose].bytes,
      )
    }
    expect(pending.shares).toEqual([])
    errorCode(
      () => pending.confirmWithMetadata(shares.slice(0, 2)),
      'ceremony-consumed',
    )
    errorCode(() => restore.recover(shares.slice(0, 2)), 'ceremony-consumed')
    destroyAccountDomainRoots(created.roots)
    destroyAccountDomainRoots(recovered.roots)
  })

  it.each(Array.from({ length: 32 }, (_, index) => index))(
    'compares fingerprint byte %i before deriving roots; mismatch is terminal',
    index => {
      const descriptor = decodeRecoveryDescriptor(vectors[0]!.frankdesc)
      const fingerprint = descriptor.publicRecoveryFingerprint
      fingerprint[index] ^= 1
      const wrong = decodeRecoveryDescriptor(
        encodeRecoveryDescriptor({
          ...descriptor,
          publicRecoveryFingerprint: fingerprint,
        }),
      )
      const restore = beginCodex32Restore(wrong)
      const derive = jest.spyOn(domainRoots, 'deriveDomainRoot')
      const shares = sharesFor(bytes(vectors[0]!.master)).slice(0, 2)
      errorCode(() => restore.recover(shares), 'descriptor-mismatch')
      expect(derive).not.toHaveBeenCalled()
      errorCode(() => restore.recover(shares), 'ceremony-consumed')
    },
  )

  it('rejects invalid M before hashing identity or deriving, then permits another family for the pinned descriptor', () => {
    const descriptor = decodeRecoveryDescriptor(vectors[0]!.frankdesc)
    const restore = beginCodex32Restore(descriptor)
    const invalid = sharesFor(new Uint8Array(64)).slice(0, 2)
    const preimages: Uint8Array[] = []
    const hash = hashes.sha256
    const spy = jest.spyOn(hashes, 'sha256').mockImplementation(value => {
      if (value instanceof Uint8Array) preimages.push(new Uint8Array(value))
      return hash(value)
    })
    const derive = jest.spyOn(domainRoots, 'deriveDomainRoot')
    errorCode(() => restore.recover(invalid), 'not-account-backup')
    expect(derive).not.toHaveBeenCalled()
    expect(preimages.map(hex)).toEqual([vectors[0]!.validationPreimage])
    spy.mockRestore()
    expect(restore.descriptor).not.toBe(descriptor)
    expect(encodeRecoveryDescriptor(restore.descriptor)).toBe(
      vectors[0]!.frankdesc,
    )
    const valid = sharesFor(bytes(vectors[0]!.master), 'cash').slice(0, 2)
    destroyAccountDomainRoots(restore.recover(valid).roots)
  })

  it('rejects malformed share sets without releasing any roots', () => {
    const pending = signup()
    const restore = beginCodex32Restore(pending.publicDescriptor)
    const shares = pending.shares
    const other = sharesFor(bytes(vectors[0]!.master), 'cash')
    const derive = jest.spyOn(domainRoots, 'deriveDomainRoot')
    for (const [entered, code] of [
      [[], 'insufficient-shares'],
      [[shares[0]!], 'wrong-share-count'],
      [shares, 'wrong-share-count'],
      [[shares[0]!, shares[0]!], 'duplicate-share'],
      [[shares[0]!, other[1]!], 'inconsistent-share'],
    ] as const) {
      errorCode(() => restore.recover(entered), code)
    }
    expect(derive).not.toHaveBeenCalled()
    restore.cancel()
    errorCode(() => restore.recover(shares.slice(0, 2)), 'ceremony-consumed')
    pending.cancel()
  })
})
