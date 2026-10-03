import * as codex32 from '@frank/codex32'
import * as domainRoots from '@frank/domain-roots'
import vectors from '../vectors/public-recovery-v1.json'
import {
  AccountRecoveryError,
  beginCodex32Restore,
  beginCodex32Signup,
  decodeRecoveryDescriptor,
  deriveRecoveryPublicMetadata,
  destroyAccountDomainRoots,
  encodeRecoveryDescriptor,
  encodeRecoveryFingerprint,
  type PublicRecoveryDescriptor,
} from './index.js'

const vector = vectors[0]!
const bytes = (hex: string): Uint8Array =>
  Uint8Array.from(Buffer.from(hex, 'hex'))
const descriptor = () => decodeRecoveryDescriptor(vector.frankdesc)
const sharesFor = (master = bytes(vector.master)): readonly string[] => {
  const result = codex32.splitCodex32({
    threshold: 2,
    identifier: 'frnk',
    indices: ['q', 'p'],
    secret: master,
    randomBytes: length => new Uint8Array(length).fill(7),
  })
  if (!result.ok) throw new Error('fixture failed')
  return result.value
}
const expectCode = (
  action: () => unknown,
  code: AccountRecoveryError['code'],
) => {
  try {
    action()
    throw new Error('expected failure')
  } catch (error) {
    expect(error).toBeInstanceOf(AccountRecoveryError)
    expect(error).toMatchObject({
      code,
      message: `Frank account recovery failed: ${code}`,
    })
    expect(JSON.stringify(error)).not.toContain('caller secret')
    expect((error as Error).message).not.toContain('caller secret')
  }
}

afterEach(() => jest.restoreAllMocks())

it('snapshots each descriptor property once and pins all bytes independently of later mutations', () => {
  const original = descriptor()
  const fingerprint = original.publicRecoveryFingerprint
  const mutable = { ...original, publicRecoveryFingerprint: fingerprint }
  const reads = new Map<PropertyKey, number>()
  const tracked = new Proxy(mutable, {
    get(target, key, receiver) {
      reads.set(key, (reads.get(key) ?? 0) + 1)
      return Reflect.get(target, key, receiver)
    },
  })
  const restore = beginCodex32Restore(tracked)
  expect(Object.fromEntries(reads)).toEqual({
    recoveryFormat: 1,
    recoveryFormatCode: 1,
    registry: 1,
    registryCode: 1,
    publicRecoveryFingerprint: 1,
  })
  fingerprint.fill(0)
  mutable.publicRecoveryFingerprint = new Uint8Array(32).fill(255)
  restore.descriptor.publicRecoveryFingerprint.fill(0)
  expect(encodeRecoveryDescriptor(restore.descriptor)).toBe(vector.frankdesc)
  destroyAccountDomainRoots(restore.recover(sharesFor()).roots)
  expect([...reads.values()].every(count => count === 1)).toBe(true)
})

it('snapshots share array length and entries once before recovery', () => {
  const shares = sharesFor()
  const reads: string[] = []
  const tracked = new Proxy(shares, {
    get(target, key, receiver) {
      reads.push(String(key))
      return Reflect.get(target, key, receiver)
    },
  })
  const recovered = beginCodex32Restore(descriptor()).recover(tracked)
  expect(reads).toEqual(['length', '0', '1'])
  destroyAccountDomainRoots(recovered.roots)
})

it('uses intrinsic fixed-length byte snapshots without caller length, iterator or species execution', () => {
  class HostileBytes extends Uint8Array {
    get length(): number {
      throw new Error('caller secret length')
    }
    [Symbol.iterator](): ArrayIterator<number> {
      throw new Error('caller secret iterator')
    }
    static get [Symbol.species](): Uint8ArrayConstructor {
      throw new Error('caller secret species')
    }
  }
  const master = new HostileBytes(bytes(vector.master))
  const metadata = deriveRecoveryPublicMetadata(master)
  expect(encodeRecoveryDescriptor(metadata.descriptor)).toBe(vector.frankdesc)
  expect(
    encodeRecoveryFingerprint(new HostileBytes(bytes(vector.fingerprint))),
  ).toBe(vector.frankrec)
  let first = true
  const pending = beginCodex32Signup({
    threshold: 2,
    identifier: 'frnk',
    indices: ['q', 'p'],
    randomBytes: length => {
      const result = first ? new HostileBytes(length) : new Uint8Array(length)
      first = false
      return result
    },
  })
  expect(encodeRecoveryDescriptor(pending.publicDescriptor)).toBe(
    vector.frankdesc,
  )
  pending.cancel()
})

it('bounds byte inputs before allocation and rejects proxies, impostors and detached buffers safely', () => {
  const revoked = Proxy.revocable(new Uint8Array(32), {})
  revoked.revoke()
  const detached = new Uint8Array(32)
  structuredClone(detached.buffer, { transfer: [detached.buffer] })
  const invalid: unknown[] = [
    null,
    undefined,
    'caller secret',
    [],
    new Uint16Array(32),
    new Uint8Array(31),
    new Uint8Array(33),
    new Uint8Array(1_000_000),
    new Proxy(new Uint8Array(32), {}),
    revoked.proxy,
    detached,
    {
      get length() {
        throw new Error('caller secret')
      },
    },
  ]
  for (const value of invalid) {
    expectCode(
      () => encodeRecoveryFingerprint(value as Uint8Array),
      'invalid-fingerprint',
    )
    expectCode(
      () =>
        beginCodex32Restore({
          ...descriptor(),
          publicRecoveryFingerprint: value as Uint8Array,
        }),
      'invalid-descriptor',
    )
  }
  for (const value of [
    null,
    {},
    new Uint8Array(63),
    new Uint8Array(65),
    new Uint8Array(1_000_000),
    new Proxy(bytes(vector.master), {}),
  ]) {
    expectCode(
      () => deriveRecoveryPublicMetadata(value as Uint8Array),
      'bad-format',
    )
  }
})

it('normalizes thrown descriptor and array getters/proxies to fresh non-secret errors', () => {
  const callerError = new AccountRecoveryError('invalid-descriptor')
  callerError.message = 'caller secret'
  const malicious = new Proxy(descriptor(), {
    get() {
      throw callerError
    },
  })
  const revoked = Proxy.revocable(descriptor(), {})
  revoked.revoke()
  for (const value of [null, malicious, revoked.proxy]) {
    expectCode(
      () => beginCodex32Restore(value as PublicRecoveryDescriptor),
      'invalid-descriptor',
    )
    expectCode(
      () => encodeRecoveryDescriptor(value as PublicRecoveryDescriptor),
      'invalid-descriptor',
    )
  }
  const restore = beginCodex32Restore(descriptor())
  const revokedArray = Proxy.revocable(sharesFor(), {})
  revokedArray.revoke()
  const throwing = new Proxy(sharesFor(), {
    get() {
      throw callerError
    },
  })
  for (const value of [null, revokedArray.proxy, throwing]) {
    expectCode(() => restore.recover(value as string[]), 'bad-format')
  }
  const oversized = new Proxy([], {
    get(_, property) {
      if (property === 'length') return Number.MAX_SAFE_INTEGER
      throw new Error('must not read entries')
    },
  })
  expectCode(() => restore.recover(oversized), 'insufficient-shares')
  destroyAccountDomainRoots(restore.recover(sharesFor()).roots)
})

it.each(['cancel', 'reenter'] as const)(
  'fences %s during caller-controlled share copying',
  operation => {
    const restore = beginCodex32Restore(descriptor())
    const valid = sharesFor()
    const entered = [...valid]
    Object.defineProperty(entered, 0, {
      get() {
        if (operation === 'cancel') restore.cancel()
        else destroyAccountDomainRoots(restore.recover(valid).roots)
        return valid[0]
      },
    })
    expectCode(() => restore.recover(entered), 'ceremony-consumed')
  },
)

it.each(['success', 'invalid-master', 'mismatch'] as const)(
  'wipes owned reconstruction and validated root buffers on %s',
  outcome => {
    const recoveredBuffers: Uint8Array[] = []
    const validatedRoots: Uint8Array[] = []
    const recover = codex32.recoverCodex32Exact
    const validate = codex32.validateMasterPayload
    jest.spyOn(codex32, 'recoverCodex32Exact').mockImplementation(shares => {
      const result = recover(shares)
      if (result.ok)
        recoveredBuffers.push(result.value.secret, result.value.payloadSymbols)
      return result
    })
    jest.spyOn(codex32, 'validateMasterPayload').mockImplementation(master => {
      const result = validate(master)
      if (result.ok) validatedRoots.push(result.value)
      return result
    })
    const expected =
      outcome === 'mismatch'
        ? decodeRecoveryDescriptor(vectors[1]!.frankdesc)
        : descriptor()
    const restore = beginCodex32Restore(expected)
    const shares = sharesFor(
      outcome === 'invalid-master' ? new Uint8Array(64) : bytes(vector.master),
    )
    if (outcome === 'success')
      destroyAccountDomainRoots(restore.recover(shares).roots)
    else
      expectCode(
        () => restore.recover(shares),
        outcome === 'mismatch' ? 'descriptor-mismatch' : 'bad-format',
      )
    expect(recoveredBuffers).toHaveLength(2)
    expect(
      [...recoveredBuffers, ...validatedRoots].every(value =>
        value.every(byte => byte === 0),
      ),
    ).toBe(true)
  },
)

it('wipes partial domain output and transient roots if derivation fails', () => {
  const returned: Uint8Array[] = []
  const inputs: Uint8Array[] = []
  const derive = domainRoots.deriveDomainRoot
  jest
    .spyOn(domainRoots, 'deriveDomainRoot')
    .mockImplementation((root, purpose) => {
      inputs.push(root)
      if (inputs.length === 2) throw new Error('injected derivation failure')
      const output = derive(root, purpose)
      returned.push(output.bytes)
      return output
    })
  const restore = beginCodex32Restore(descriptor())
  expect(() => restore.recover(sharesFor())).toThrow(
    'injected derivation failure',
  )
  expect(returned).toHaveLength(1)
  expect(
    [...inputs, ...returned].every(value => value.every(byte => byte === 0)),
  ).toBe(true)
  expectCode(() => restore.recover(sharesFor()), 'ceremony-consumed')
})

it.each(['confirm', 'cancel', 'split-failure'] as const)(
  'wipes signup-owned M/R/symbols on %s without taking caller RNG ownership',
  exit => {
    const owned: Uint8Array[] = []
    const supplied: Uint8Array[] = []
    const create = codex32.createMasterPayload
    const symbols = codex32.codex32SecretPayloadSymbols
    jest.spyOn(codex32, 'createMasterPayload').mockImplementation(root => {
      owned.push(root)
      const result = create(root)
      if (result.ok) owned.push(result.value)
      return result
    })
    jest
      .spyOn(codex32, 'codex32SecretPayloadSymbols')
      .mockImplementation(master => {
        const result = symbols(master)
        if (result.ok) owned.push(result.value)
        return result
      })
    const begin = () =>
      beginCodex32Signup({
        threshold: 2,
        identifier: 'frnk',
        indices: ['q', 'p'],
        randomBytes: length => {
          const result = new Uint8Array(
            exit === 'split-failure' && supplied.length > 0 ? 1 : length,
          ).fill(7)
          supplied.push(result)
          return result
        },
      })
    if (exit === 'split-failure') expectCode(begin, 'rng-failed')
    else {
      const pending = begin()
      if (exit === 'confirm')
        destroyAccountDomainRoots(
          pending.confirmWithMetadata(pending.shares).roots,
        )
      else pending.cancel()
    }
    expect(owned.length).toBeGreaterThanOrEqual(2)
    expect(owned.every(value => value.every(byte => byte === 0))).toBe(true)
    expect(supplied.every(value => value.every(byte => byte === 7))).toBe(true)
  },
)
