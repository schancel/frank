import { inspect } from 'node:util'
import { deriveDomainRoot } from '@frank/domain-roots'
import * as hd from '@frank/nakamoto/hd'
import * as keys from '@frank/nakamoto/keys'
import vectors from '../../../docs/protocol/proposals/message-stamp-derivation/vectors.json'
import {
  deriveRoleLeaves,
  matchLocalRolePoints,
  RoleKeyError,
  type RoleDerivation,
  type ExpectedRolePoints,
  type RoleLeaf,
} from './index.js'

function bytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../g) ?? [], pair => parseInt(pair, 16))
}
function hex(value: Uint8Array): string {
  return Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('')
}
function request(account = vectors.accounts[0], g = 0n): RoleDerivation {
  const root = bytes(account.account_root)
  return {
    authRoot: deriveDomainRoot(root, 'identity-authentication'),
    messageRoot: deriveDomainRoot(root, 'messaging-encryption'),
    stampRoot: deriveDomainRoot(root, 'evm-wallet'),
    messageGeneration: g,
    stampGeneration: g,
  }
}
function expected(input: RoleDerivation): ExpectedRolePoints {
  const leaves = deriveRoleLeaves(input)
  try {
    return {
      auth: leaves.auth.public.compressedPoint,
      message: leaves.message.public.compressedPoint,
      stamp: leaves.stamp.public.compressedPoint,
      ...(leaves.previousStamp
        ? { previousStamp: leaves.previousStamp.public.compressedPoint }
        : {}),
    }
  } finally {
    leaves.dispose()
  }
}

afterEach(() => jest.restoreAllMocks())

describe('frozen D1–D11 public synthetic vectors', () => {
  for (const [accountIndex, account] of vectors.accounts.entries()) {
    test.each([0n, 1n, 2n, 2147483647n])(
      'account ' + accountIndex + ', generation %s',
      g => {
        const derive = hd.deriveHdPrivate
        const chains: string[] = []
        jest.spyOn(hd, 'deriveHdPrivate').mockImplementation((node, index) => {
          const result = derive(node, index)
          if (result.ok && result.value.depth === 5)
            chains.push(hex(result.value.chainCode))
          return result
        })
        const input = request(account, g)
        const before = JSON.stringify(input, (_key, value) =>
          typeof value === 'bigint' ? value.toString() : value,
        )
        const leaves = deriveRoleLeaves(input)
        try {
          for (const [i, role] of (
            ['auth', 'message', 'stamp'] as const
          ).entries()) {
            const leaf = leaves[role]
            const vector = account.leaves.find(
              v =>
                v.role === role &&
                v.generation === String(role === 'auth' ? 0n : g),
            )!
            expect(leaf.public.role).toBe(role)
            expect(leaf.public.purpose).toBe(vector.purpose)
            expect(leaf.public.path).toBe(vector.path)
            expect(leaf.public.generation).toBe(Number(vector.generation))
            expect(hex(leaf.public.compressedPoint)).toBe(vector.public_hex)
            expect(leaf.useSecret(hex)).toBe(vector.private_hex)
            expect(chains[i]).toBe(vector.chain_hex)
          }
          expect(
            JSON.stringify(input, (_key, value) =>
              typeof value === 'bigint' ? value.toString() : value,
            ),
          ).toBe(before)
        } finally {
          leaves.dispose()
        }
      },
    )
  }
})

describe('strict boundary and local comparison', () => {
  test.each([
    -1n,
    2147483648n,
    18446744073709551615n,
    1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    NaN,
    Infinity,
    '1',
    null,
    undefined,
  ])('rejects nonexact or unsupported generation %s', g => {
    for (const field of ['messageGeneration', 'stampGeneration'] as const) {
      expect(() =>
        deriveRoleLeaves({ ...request(), [field]: g } as RoleDerivation),
      ).toThrow(new RoleKeyError('unsupported-generation'))
    }
  })

  test.each([
    { registry: 'foreign-registry' },
    { purpose: 'evm-wallet' },
    { bytes: new Uint8Array(31) },
    { bytes: new Uint8Array(33) },
    { bytes: '00'.repeat(32) },
    { bytes: new Array(32).fill(0) },
  ])('rejects malformed auth root %j', patch => {
    const input = request()
    expect(() =>
      deriveRoleLeaves({
        ...input,
        authRoot: { ...input.authRoot, ...patch },
      } as RoleDerivation),
    ).toThrow(new RoleKeyError('invalid-root'))
  })

  test('each role requires its own purpose, and relabelled roots cannot match', () => {
    const input = request()
    const tuple = expected(input)
    expect(() =>
      deriveRoleLeaves({
        ...input,
        messageRoot: input.authRoot,
      } as unknown as RoleDerivation),
    ).toThrow('invalid-root')
    expect(() =>
      deriveRoleLeaves({
        ...input,
        stampRoot: input.messageRoot,
      } as unknown as RoleDerivation),
    ).toThrow('invalid-root')
    const relabelled = { ...input.messageRoot, bytes: input.authRoot.bytes }
    expect(
      matchLocalRolePoints({ ...input, messageRoot: relabelled }, tuple)
        .matches,
    ).toBe(false)
  })

  test('independent explicit generations match; previous remains absent unless supplied', () => {
    const input = { ...request(vectors.accounts[1], 2n), messageGeneration: 0n }
    const tuple = expected(input)
    expect(matchLocalRolePoints(input, tuple)).toEqual({
      kind: 'local-point-comparison',
      matches: true,
    })
    const leaves = deriveRoleLeaves(input)
    expect(Object.prototype.hasOwnProperty.call(leaves, 'previousStamp')).toBe(
      false,
    )
    leaves.dispose()
    expect(
      matchLocalRolePoints({ ...input, messageGeneration: 1n }, tuple).matches,
    ).toBe(false)
    expect(
      matchLocalRolePoints({ ...input, stampGeneration: 1n }, tuple).matches,
    ).toBe(false)
    const withPrevious = { ...input, previousStampGeneration: 1n }
    const previousTuple = expected(withPrevious)
    expect(matchLocalRolePoints(withPrevious, previousTuple).matches).toBe(true)
    expect(matchLocalRolePoints(input, previousTuple).matches).toBe(false)
    expect(matchLocalRolePoints(withPrevious, tuple).matches).toBe(false)
    expect(() =>
      deriveRoleLeaves({ ...input, previousStampGeneration: 0n }),
    ).toThrow('invalid-previous-generation')
    expect(() =>
      deriveRoleLeaves({ ...request(), previousStampGeneration: 0n }),
    ).toThrow('invalid-previous-generation')
  })

  test('wrong, negated, reused and invalid supplied points fail closed', () => {
    const input = request()
    const tuple = expected(input)
    const negated = new Uint8Array(tuple.message)
    negated[0] ^= 1
    expect(
      matchLocalRolePoints(input, { ...tuple, message: negated }).matches,
    ).toBe(false)
    expect(
      matchLocalRolePoints(input, { ...tuple, stamp: tuple.message }).matches,
    ).toBe(false)
    expect(matchLocalRolePoints(input, tuple, [tuple.message]).matches).toBe(
      false,
    )
    expect(matchLocalRolePoints(input, tuple, [negated]).matches).toBe(false)
    expect(
      matchLocalRolePoints(input, tuple, [
        expected(request(vectors.accounts[1])).stamp,
      ]).matches,
    ).toBe(true)
    for (const invalid of [
      new Uint8Array(32),
      bytes('02' + 'ff'.repeat(32)),
      new Uint8Array(33),
      [],
    ]) {
      expect(() =>
        matchLocalRolePoints(input, {
          ...tuple,
          stamp: invalid,
        } as ExpectedRolePoints),
      ).toThrow('invalid-point')
    }
  })
})

describe('ownership, snapshots and atomic failure', () => {
  test('later failure disposes already-created leaves before returning an error', () => {
    const probe = deriveRoleLeaves(request())
    const prototype = Object.getPrototypeOf(probe.auth) as RoleLeaf
    probe.dispose()
    const dispose = prototype.dispose
    const disposed: RoleLeaf[] = []
    jest
      .spyOn(prototype, 'dispose')
      .mockImplementation(function (this: RoleLeaf) {
        disposed.push(this)
        dispose.call(this)
      })
    const master = hd.hdPrivateFromSeed
    let calls = 0
    jest.spyOn(hd, 'hdPrivateFromSeed').mockImplementation(seed => {
      if (++calls === 3)
        return { ok: false, error: { code: 'scalar-out-of-range' } }
      return master(seed)
    })
    expect(() => deriveRoleLeaves(request())).toThrow('derivation-failed')
    expect(disposed.map(leaf => leaf.public.role)).toEqual(['auth', 'message'])
    for (const leaf of disposed)
      expect(() => leaf.useSecret(hex)).toThrow('disposed')
  })

  test('a malformed root wipes its copy without wiping caller storage', () => {
    const input = request()
    const fill = Uint8Array.prototype.fill
    const wiped: Uint8Array[] = []
    const sentinel = hex(input.authRoot.bytes)
    jest
      .spyOn(Uint8Array.prototype, 'fill')
      .mockImplementation(function (this: Uint8Array, value, start, end) {
        if (hex(this) === sentinel) wiped.push(this)
        return fill.call(this, value, start, end)
      })
    expect(() =>
      deriveRoleLeaves({
        ...input,
        authRoot: { ...input.authRoot, registry: 'wrong' },
      } as unknown as RoleDerivation),
    ).toThrow('invalid-root')
    expect(wiped).toHaveLength(1)
    expect(wiped[0]).not.toBe(input.authRoot.bytes)
    expect(wiped[0]).toEqual(new Uint8Array(32))
    expect(hex(input.authRoot.bytes)).toBe(sentinel)
  })

  test('public state/logs contain no secrets; buffers are borrowed and disposal is final', () => {
    const input = request()
    const leaves = deriveRoleLeaves(input)
    const publicText =
      JSON.stringify(leaves) + inspect(leaves, { depth: 8, showHidden: true })
    for (const vector of vectors.accounts[0].leaves) {
      expect(publicText).not.toContain(vector.private_hex)
      expect(publicText).not.toContain(vector.chain_hex)
    }
    for (const root of [input.authRoot, input.messageRoot, input.stampRoot]) {
      expect(publicText).not.toContain(hex(root.bytes))
    }
    expect(Object.keys(leaves.message)).toEqual(['public'])
    let borrowed: Uint8Array | undefined
    const secret = leaves.message.useSecret(value => {
      borrowed = value
      return hex(value)
    })
    expect(borrowed).toEqual(new Uint8Array(32))
    expect(leaves.message.useSecret(hex)).toBe(secret)
    expect(() =>
      leaves.message.useSecret(value => {
        borrowed = value
        throw new Error('consumer failure')
      }),
    ).toThrow('consumer failure')
    expect(borrowed).toEqual(new Uint8Array(32))
    const point = leaves.message.public.compressedPoint
    point.fill(0)
    expect(leaves.message.public.compressedPoint).not.toEqual(point)
    leaves.dispose()
    leaves.dispose()
    for (const leaf of [leaves.auth, leaves.message, leaves.stamp]) {
      expect(() => leaf.useSecret(hex)).toThrow('disposed')
    }
    expect(hex(input.messageRoot.bytes)).toBe(
      vectors.accounts[0].roots[3].output_hex,
    )
  })

  test('snapshots byte contents before later getters mutate caller buffers', () => {
    const input = request()
    const tuple = expected(input)
    let reads = 0
    const hostileRoot = {
      get bytes() {
        reads++
        return input.authRoot.bytes
      },
      get registry() {
        input.authRoot.bytes.fill(7)
        return input.authRoot.registry
      },
      purpose: input.authRoot.purpose,
    }
    expect(
      matchLocalRolePoints({ ...input, authRoot: hostileRoot }, tuple).matches,
    ).toBe(true)
    expect(reads).toBe(1)
    const tuple2 = expected(input)
    const saved = new Uint8Array(tuple2.auth)
    const hostileTuple = {
      auth: tuple2.auth,
      get message() {
        tuple2.auth.fill(0)
        return tuple2.message
      },
      stamp: tuple2.stamp,
    }
    expect(matchLocalRolePoints(input, hostileTuple).matches).toBe(true)
    expect(saved).not.toEqual(tuple2.auth)
  })

  test('custom byte iterators cannot replace the snapshotted root', () => {
    const input = request()
    const tuple = expected(input)
    input.messageRoot.bytes[Symbol.iterator] = () => new Uint8Array(32).values()
    expect(matchLocalRolePoints(input, tuple).matches).toBe(true)
  })

  test.each([
    'success',
    'master',
    'child',
    'point',
    'getter',
    'collision',
  ] as const)('owned nodes and roots are wiped on %s', failure => {
    const input = request()
    const originals = [
      input.authRoot.bytes,
      input.messageRoot.bytes,
      input.stampRoot.bytes,
    ].map(hex)
    const nodes: hd.HdPrivateNode[] = []
    const seeds: Uint8Array[] = []
    const master = hd.hdPrivateFromSeed
    const child = hd.deriveHdPrivate
    const pub = keys.publicFromPrivate
    let children = 0
    jest.spyOn(hd, 'hdPrivateFromSeed').mockImplementation(seed => {
      seeds.push(seed)
      if (failure === 'master' && seeds.length === 3)
        return { ok: false, error: { code: 'scalar-out-of-range' } }
      const result = master(seed)
      if (result.ok) nodes.push(result.value)
      return result
    })
    jest.spyOn(hd, 'deriveHdPrivate').mockImplementation((node, index) => {
      children++
      if (failure === 'child' && children === 11)
        return { ok: false, error: { code: 'hd-invalid-child' } }
      const result = child(node, index)
      if (result.ok) nodes.push(result.value)
      return result
    })
    const authPoint = bytes(vectors.accounts[0].leaves[0].public_hex)
    jest.spyOn(keys, 'publicFromPrivate').mockImplementation(key => {
      if (failure === 'point' && children === 15)
        return { ok: false, error: { code: 'public-key-invalid' } }
      const result = pub(key)
      if (failure === 'collision' && children === 15 && result.ok) {
        const negated = new Uint8Array(authPoint)
        negated[0] ^= 1
        result.value.compressed.set(negated)
      }
      return result
    })
    const attempted =
      failure === 'getter'
        ? {
            ...input,
            get stampGeneration(): bigint {
              throw new Error('hostile getter')
            },
          }
        : input
    if (failure === 'success') deriveRoleLeaves(attempted).dispose()
    else expect(() => deriveRoleLeaves(attempted)).toThrow()
    for (const node of nodes) {
      expect(node.privateKey.bytes).toEqual(new Uint8Array(32))
      expect(node.chainCode).toEqual(new Uint8Array(32))
    }
    for (const seed of seeds) expect(seed).toEqual(new Uint8Array(32))
    expect(
      [
        input.authRoot.bytes,
        input.messageRoot.bytes,
        input.stampRoot.bytes,
      ].map(hex),
    ).toEqual(originals)
    if (failure === 'child') expect(children).toBe(11)
  })
})
