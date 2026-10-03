import {
  DERIVATION_REGISTRY_CODE,
  DERIVATION_REGISTRY_ID,
  DOMAIN_PURPOSES,
  RECOVERY_FORMAT_CODE,
  RECOVERY_FORMAT_ID,
} from '@frank/domain-roots'
import * as codex32 from '@frank/codex32'
import {
  AccountRecoveryError,
  beginCodex32Signup,
  destroyAccountDomainRoots,
  recoverCodex32Account,
  type RecoveryDescriptor,
} from './index.js'

const ZERO_ROOT_OUTPUTS = {
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
} as const

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

function deterministicRandom(rootByte: number, shareByte = 7) {
  let calls = 0
  return (length: number): Uint8Array => {
    calls += 1
    return new Uint8Array(length).fill(calls === 1 ? rootByte : shareByte)
  }
}

function expectRecoveryError(
  action: () => unknown,
  code: AccountRecoveryError['code'],
): void {
  try {
    action()
    throw new Error('expected account recovery to fail')
  } catch (error) {
    expect(error).toBeInstanceOf(AccountRecoveryError)
    expect((error as AccountRecoveryError).code).toBe(code)
    expect((error as Error).message).toBe(
      `Frank account recovery failed: ${code}`,
    )
  }
}

describe('Codex32 account ceremony', () => {
  it('rejects a residual-symbol mismatch without consuming the ceremony', () => {
    const pending = beginCodex32Signup({
      threshold: 2,
      identifier: 'frnk',
      indices: ['q', 'p'],
      randomBytes: deterministicRandom(0),
    })
    const recover = codex32.recoverCodex32Exact
    const spy = jest.spyOn(codex32, 'recoverCodex32Exact')
    spy.mockImplementationOnce(shares => {
      const result = recover(shares)
      if (result.ok) {
        result.value.payloadSymbols[102] = result.value.payloadSymbols[102]! ^ 1
      }
      return result
    })
    try {
      expectRecoveryError(
        () => pending.confirm(pending.shares),
        'confirmation-mismatch',
      )
    } finally {
      spy.mockRestore()
    }
    destroyAccountDomainRoots(pending.confirm(pending.shares))
  })

  it('confirms exact signup shares before deriving every typed root', () => {
    const pending = beginCodex32Signup({
      threshold: 2,
      identifier: 'frnk',
      indices: ['q', 'p', 'z'],
      randomBytes: deterministicRandom(0),
    })

    expect(pending.descriptor).toEqual({
      recoveryFormat: RECOVERY_FORMAT_ID,
      recoveryFormatCode: RECOVERY_FORMAT_CODE,
      registry: DERIVATION_REGISTRY_ID,
      registryCode: DERIVATION_REGISTRY_CODE,
      threshold: 2,
      identifier: 'frnk',
    })
    expect(pending.shares).toHaveLength(3)
    expect(pending.shares.every(share => share.length === 127)).toBe(true)

    const shares = pending.shares
    const roots = pending.confirm(shares.slice(0, 2))
    for (const purpose of DOMAIN_PURPOSES) {
      expect(roots[purpose]).toMatchObject({
        registry: DERIVATION_REGISTRY_ID,
        purpose,
      })
      expect(hex(roots[purpose].bytes)).toBe(ZERO_ROOT_OUTPUTS[purpose])
    }
    expectRecoveryError(
      () => pending.confirm(pending.shares.slice(1)),
      'ceremony-consumed',
    )
    expect(pending.shares).toEqual([])
    destroyAccountDomainRoots(roots)
    for (const purpose of DOMAIN_PURPOSES) {
      expect(roots[purpose].bytes).toEqual(new Uint8Array(32))
    }
  })

  it('restores the same domain roots from another valid threshold subset', () => {
    const pending = beginCodex32Signup({
      threshold: 2,
      identifier: 'cash',
      indices: ['q', 'p', 'z'],
      randomBytes: deterministicRandom(11, 29),
    })
    const shares = pending.shares
    const created = pending.confirm(shares.slice(0, 2))
    const restored = recoverCodex32Account({
      descriptor: pending.descriptor,
      shares: shares.slice(1, 3),
    })
    for (const purpose of DOMAIN_PURPOSES) {
      expect(restored[purpose].bytes).toEqual(created[purpose].bytes)
      expect(restored[purpose].bytes).not.toBe(created[purpose].bytes)
    }
    destroyAccountDomainRoots(created)
    destroyAccountDomainRoots(restored)
  })

  it('rejects another master without consuming the pending ceremony', () => {
    const pending = beginCodex32Signup({
      threshold: 2,
      identifier: 'same',
      indices: ['q', 'p'],
      randomBytes: deterministicRandom(1),
    })
    const other = beginCodex32Signup({
      threshold: 2,
      identifier: 'same',
      indices: ['q', 'p'],
      randomBytes: deterministicRandom(2),
    })
    expectRecoveryError(
      () => pending.confirm(other.shares),
      'confirmation-mismatch',
    )
    other.cancel()
    const roots = pending.confirm(pending.shares)
    destroyAccountDomainRoots(roots)
  })

  it('binds confirmation and restore to the public ceremony metadata', () => {
    const pending = beginCodex32Signup({
      threshold: 2,
      identifier: 'name',
      indices: ['q', 'p'],
      randomBytes: deterministicRandom(3),
    })
    const wrongFamily = beginCodex32Signup({
      threshold: 2,
      identifier: 'seed',
      indices: ['q', 'p'],
      randomBytes: deterministicRandom(3),
    })
    expectRecoveryError(
      () => pending.confirm(wrongFamily.shares),
      'wrong-ceremony-family',
    )

    const wrongFormat = {
      ...pending.descriptor,
      recoveryFormatCode: 2,
    } as unknown as RecoveryDescriptor
    expectRecoveryError(
      () =>
        recoverCodex32Account({
          descriptor: wrongFormat,
          shares: pending.shares,
        }),
      'wrong-recovery-format',
    )
    const wrongRegistry = {
      ...pending.descriptor,
      registry: 'frank-domain-roots-v2',
    } as unknown as RecoveryDescriptor
    expectRecoveryError(
      () =>
        recoverCodex32Account({
          descriptor: wrongRegistry,
          shares: pending.shares,
        }),
      'wrong-registry',
    )
    const wrongRegistryCode = {
      ...pending.descriptor,
      registryCode: 2,
    } as unknown as RecoveryDescriptor
    expectRecoveryError(
      () =>
        recoverCodex32Account({
          descriptor: wrongRegistryCode,
          shares: pending.shares,
        }),
      'wrong-registry',
    )
    pending.cancel()
    wrongFamily.cancel()
  })

  it('fails closed for malformed counts, duplicate shares, cancellation, and RNG failure', () => {
    const pending = beginCodex32Signup({
      threshold: 2,
      identifier: 'cash',
      indices: ['q', 'p'],
      randomBytes: deterministicRandom(4),
    })
    expectRecoveryError(() => pending.confirm([]), 'insufficient-shares')
    expectRecoveryError(
      () => pending.confirm([pending.shares[0]!, pending.shares[0]!]),
      'duplicate-share',
    )
    expectRecoveryError(
      () => pending.confirm([pending.shares[0]!]),
      'wrong-share-count',
    )
    pending.cancel()
    expect(pending.shares).toEqual([])
    expectRecoveryError(
      () => pending.confirm(pending.shares),
      'ceremony-consumed',
    )
    expect(() => pending.cancel()).not.toThrow()

    expectRecoveryError(
      () =>
        beginCodex32Signup({
          threshold: 2,
          identifier: 'cash',
          indices: ['q', 'p'],
          randomBytes: () => new Uint8Array(31),
        }),
      'rng-failed',
    )
    expectRecoveryError(
      () =>
        beginCodex32Signup({
          threshold: 2,
          identifier: 'cash',
          indices: ['q', 'p'],
          randomBytes: () => {
            throw new Error('platform RNG unavailable')
          },
        }),
      'rng-failed',
    )
  })

  it('reports only non-secret error codes', () => {
    const error = new AccountRecoveryError('bad-checksum')
    expect(error.message).toBe('Frank account recovery failed: bad-checksum')
    expect(JSON.stringify(error)).not.toContain('ms1')
  })

  it('normalizes every caller-controlled exception to a fresh canonical error', () => {
    const callerError = new AccountRecoveryError('bad-format')
    callerError.message = 'caller-controlled marker'
    const expectFreshError = (
      action: () => unknown,
      code: AccountRecoveryError['code'],
    ) => {
      try {
        action()
        throw new Error('expected account recovery to fail')
      } catch (error) {
        expect(error).toBeInstanceOf(AccountRecoveryError)
        expect(error).not.toBe(callerError)
        expect((error as AccountRecoveryError).code).toBe(code)
        expect((error as Error).message).toBe(
          `Frank account recovery failed: ${code}`,
        )
      }
    }

    expectFreshError(() => recoverCodex32Account(null as never), 'bad-format')
    expectFreshError(
      () =>
        recoverCodex32Account({
          get descriptor(): RecoveryDescriptor {
            throw callerError
          },
          shares: [],
        }),
      'bad-format',
    )
    expectFreshError(
      () =>
        beginCodex32Signup({
          get threshold(): 2 {
            throw callerError
          },
          identifier: 'frnk',
          indices: ['q', 'p'],
          randomBytes: deterministicRandom(0),
        }),
      'bad-format',
    )
    expectFreshError(
      () =>
        beginCodex32Signup({
          threshold: 2,
          identifier: 'frnk',
          indices: ['q', 'p'],
          randomBytes: () => {
            throw callerError
          },
        }),
      'rng-failed',
    )

    const pending = beginCodex32Signup({
      threshold: 2,
      identifier: 'frnk',
      indices: ['q', 'p'],
      randomBytes: deterministicRandom(0),
    })
    const entered = [pending.shares[0]!, pending.shares[1]!]
    Object.defineProperty(entered, 0, {
      get() {
        throw callerError
      },
    })
    expectFreshError(() => pending.confirm(entered), 'bad-format')
    const revoked = Proxy.revocable(
      [pending.shares[0]!, pending.shares[1]!],
      {},
    )
    revoked.revoke()
    expectFreshError(
      () => pending.confirm(revoked.proxy as unknown as string[]),
      'bad-format',
    )
    pending.cancel()
  })

  it('reads each caller-owned array length once at every public boundary', () => {
    const reads = { indices: 0, confirm: 0, recover: 0 }
    const trackLength = (values: string[], key: keyof typeof reads): string[] =>
      new Proxy(values, {
        get(target, property, receiver) {
          if (property === 'length') reads[key] += 1
          return Reflect.get(target, property, receiver)
        },
      })

    const pending = beginCodex32Signup({
      threshold: 2,
      identifier: 'frnk',
      indices: trackLength(['q', 'p', 'z'], 'indices'),
      randomBytes: deterministicRandom(0),
    })
    const shares = pending.shares
    const roots = pending.confirm(trackLength(shares.slice(0, 2), 'confirm'))
    const restored = recoverCodex32Account({
      descriptor: pending.descriptor,
      shares: trackLength(shares.slice(1, 3), 'recover'),
    })
    expect(reads).toEqual({ indices: 1, confirm: 1, recover: 1 })
    destroyAccountDomainRoots(roots)
    destroyAccountDomainRoots(restored)
  })

  it('reports cancellation during share copying as a consumed ceremony', () => {
    const pending = beginCodex32Signup({
      threshold: 2,
      identifier: 'frnk',
      indices: ['q', 'p'],
      randomBytes: deterministicRandom(0),
    })
    const shares = pending.shares
    const entered = [shares[0]!, shares[1]!]
    Object.defineProperty(entered, 0, {
      get() {
        pending.cancel()
        return shares[0]!
      },
    })
    expectRecoveryError(() => pending.confirm(entered), 'ceremony-consumed')
    expect(pending.shares).toEqual([])
  })

  it('rejects threshold shares whose master validation half is invalid', () => {
    const split = codex32.splitCodex32({
      threshold: 2,
      identifier: 'frnk',
      indices: ['q', 'p'],
      secret: new Uint8Array(64),
      randomBytes: length => new Uint8Array(length).fill(5),
    })
    expect(split.ok).toBe(true)
    if (!split.ok) return
    expectRecoveryError(
      () =>
        recoverCodex32Account({
          descriptor: {
            recoveryFormat: RECOVERY_FORMAT_ID,
            recoveryFormatCode: RECOVERY_FORMAT_CODE,
            registry: DERIVATION_REGISTRY_ID,
            registryCode: DERIVATION_REGISTRY_CODE,
            threshold: 2,
            identifier: 'frnk',
          },
          shares: split.value,
        }),
      'bad-format',
    )
  })

  it('snapshots ceremony inputs and entered shares exactly once', () => {
    const baseRandom = deterministicRandom(0)
    const reads = {
      threshold: 0,
      identifier: 0,
      indices: 0,
      randomBytes: 0,
      share: 0,
    }
    const pending = beginCodex32Signup({
      get threshold() {
        reads.threshold += 1
        return 2 as const
      },
      get identifier() {
        reads.identifier += 1
        return 'frnk'
      },
      get indices() {
        reads.indices += 1
        return ['q', 'p']
      },
      get randomBytes() {
        reads.randomBytes += 1
        return baseRandom
      },
    })
    const entered = [pending.shares[0]!, pending.shares[1]!]
    Object.defineProperty(entered, 0, {
      configurable: true,
      get() {
        reads.share += 1
        return pending.shares[0]!
      },
    })
    const roots = pending.confirm(entered)
    expect(reads).toEqual({
      threshold: 1,
      identifier: 1,
      indices: 1,
      randomBytes: 1,
      share: 1,
    })
    destroyAccountDomainRoots(roots)
  })
})
