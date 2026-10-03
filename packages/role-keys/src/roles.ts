import { DERIVATION_REGISTRY_ID, type DomainRoot } from '@frank/domain-roots'
import { pointMultiply } from '@frank/nakamoto/curve'
import {
  deriveHdPrivate,
  hdPrivateFromSeed,
  type HdPrivateNode,
} from '@frank/nakamoto/hd'
import { publicFromPrivate } from '@frank/nakamoto/keys'

export type Role = 'auth' | 'message' | 'stamp'
type Purpose = {
  auth: 'identity-authentication'
  message: 'messaging-encryption'
  stamp: 'evm-wallet'
}

export interface RolePoint<R extends Role = Role> {
  readonly registry: typeof DERIVATION_REGISTRY_ID
  readonly role: R
  readonly purpose: Purpose[R]
  readonly path: string
  /** Exact safe integer after the bigint schedule bound has been checked. */
  readonly generation: number
  /** Each read returns a fresh copy. */
  readonly compressedPoint: Uint8Array
}

export interface RoleLeaf<R extends Role = Role> {
  readonly public: RolePoint<R>
  /** Synchronous borrow. The copy is wiped when the callback returns or throws. */
  useSecret<T>(consume: (secret: Uint8Array) => T): T
  dispose(): void
}

export interface RoleDerivation {
  readonly authRoot: DomainRoot<'identity-authentication'>
  readonly messageRoot: DomainRoot<'messaging-encryption'>
  readonly stampRoot: DomainRoot<'evm-wallet'>
  /** Exact wire integers, before any conversion to JavaScript number. */
  readonly messageGeneration: bigint
  readonly stampGeneration: bigint
  /** Optional explicit adjacent generation. Its presence does not grant grace. */
  readonly previousStampGeneration?: bigint
}

export interface RoleLeaves {
  readonly auth: RoleLeaf<'auth'>
  readonly message: RoleLeaf<'message'>
  readonly stamp: RoleLeaf<'stamp'>
  readonly previousStamp?: RoleLeaf<'stamp'>
  dispose(): void
}

export interface ExpectedRolePoints {
  readonly auth: Uint8Array
  readonly message: Uint8Array
  readonly stamp: Uint8Array
  readonly previousStamp?: Uint8Array
}

export interface LocalPointMatch {
  readonly kind: 'local-point-comparison'
  readonly matches: boolean
}

export type RoleKeyErrorCode =
  | 'invalid-root'
  | 'unsupported-generation'
  | 'invalid-previous-generation'
  | 'derivation-failed'
  | 'role-collision'
  | 'invalid-point'
  | 'disposed'

export class RoleKeyError extends Error {
  constructor(readonly code: RoleKeyErrorCode) {
    super(code)
    this.name = 'RoleKeyError'
  }
}

const HARDENED = 0x80000000
const ONE = new Uint8Array(32)
ONE[31] = 1

function generation(value: unknown): number {
  if (typeof value !== 'bigint' || value < 0n || value > 2147483647n) {
    throw new RoleKeyError('unsupported-generation')
  }
  return Number(value)
}

function rootSnapshot(value: DomainRoot, purpose: Purpose[Role]): Uint8Array {
  let copied: Uint8Array | undefined
  try {
    const input = value.bytes
    if (!(input instanceof Uint8Array)) throw new RoleKeyError('invalid-root')
    // The typed-array constructor copies internal bytes, ignoring custom iterators.
    copied = new Uint8Array(input)
    if (
      copied.length !== 32 ||
      value.registry !== DERIVATION_REGISTRY_ID ||
      value.purpose !== purpose
    ) {
      throw new RoleKeyError('invalid-root')
    }
    return copied
  } catch {
    copied?.fill(0)
    throw new RoleKeyError('invalid-root')
  }
}

function wipeNode(node: HdPrivateNode): void {
  node.privateKey.bytes.fill(0)
  node.chainCode.fill(0)
}

class Leaf<R extends Role> implements RoleLeaf<R> {
  #secret: Uint8Array | undefined
  readonly public: RolePoint<R>

  constructor(
    secret: Uint8Array,
    point: Uint8Array,
    descriptor: Omit<RolePoint<R>, 'compressedPoint'>,
  ) {
    this.#secret = new Uint8Array(secret)
    const ownedPoint = new Uint8Array(point)
    this.public = Object.freeze({
      ...descriptor,
      get compressedPoint() {
        return new Uint8Array(ownedPoint)
      },
    })
    Object.freeze(this)
  }

  useSecret<T>(consume: (secret: Uint8Array) => T): T {
    if (!this.#secret) throw new RoleKeyError('disposed')
    const borrowed = new Uint8Array(this.#secret)
    try {
      return consume(borrowed)
    } finally {
      borrowed.fill(0)
    }
  }

  dispose(): void {
    this.#secret?.fill(0)
    this.#secret = undefined
  }
}

function derive<R extends Role>(
  seed: Uint8Array,
  role: R,
  purpose: Purpose[R],
  g: number,
): RoleLeaf<R> {
  const indices =
    role === 'auth'
      ? [44 + HARDENED, 60 + HARDENED, 1 + HARDENED, 0, 0]
      : [
          44 + HARDENED,
          60 + HARDENED,
          (role === 'message' ? 4 : 2) + HARDENED,
          HARDENED,
          g + HARDENED,
        ]
  const path =
    'm/' +
    indices.map(i => (i >= HARDENED ? `${i - HARDENED}'` : `${i}`)).join('/')
  const master = hdPrivateFromSeed(seed)
  if (!master.ok) throw new RoleKeyError('derivation-failed')
  let current = master.value
  try {
    for (const index of indices) {
      const child = deriveHdPrivate(current, index)
      if (!child.ok) throw new RoleKeyError('derivation-failed')
      wipeNode(current)
      current = child.value
    }
    const point = publicFromPrivate(current.privateKey)
    if (!point.ok) throw new RoleKeyError('derivation-failed')
    return new Leaf(current.privateKey.bytes, point.value.compressed, {
      registry: DERIVATION_REGISTRY_ID,
      role,
      purpose,
      generation: g,
      path,
    })
  } finally {
    wipeNode(current)
  }
}

function same(left: Uint8Array, right: Uint8Array, start = 0): boolean {
  return (
    left.length === right.length &&
    left.every((byte, i) => i < start || byte === right[i])
  )
}

function distinct(points: readonly Uint8Array[]): boolean {
  return points.every((point, i) =>
    points.slice(0, i).every(prior => !same(point, prior, 1)),
  )
}

/** All-or-nothing local derivation. No directory, persistence or network input. */
export function deriveRoleLeaves(input: RoleDerivation): RoleLeaves {
  const seeds: Uint8Array[] = []
  const leaves: RoleLeaf[] = []
  try {
    const authSeed = rootSnapshot(input.authRoot, 'identity-authentication')
    seeds.push(authSeed)
    const messageSeed = rootSnapshot(input.messageRoot, 'messaging-encryption')
    seeds.push(messageSeed)
    const stampSeed = rootSnapshot(input.stampRoot, 'evm-wallet')
    seeds.push(stampSeed)
    const mg = generation(input.messageGeneration)
    const sg = generation(input.stampGeneration)
    const previous = input.previousStampGeneration
    const pg = previous === undefined ? undefined : generation(previous)
    if (pg !== undefined && (sg === 0 || pg !== sg - 1)) {
      throw new RoleKeyError('invalid-previous-generation')
    }
    const auth = derive(authSeed, 'auth', 'identity-authentication', 0)
    leaves.push(auth)
    const message = derive(messageSeed, 'message', 'messaging-encryption', mg)
    leaves.push(message)
    const stamp = derive(stampSeed, 'stamp', 'evm-wallet', sg)
    leaves.push(stamp)
    const previousStamp =
      pg === undefined
        ? undefined
        : derive(stampSeed, 'stamp', 'evm-wallet', pg)
    if (previousStamp) leaves.push(previousStamp)
    if (!distinct(leaves.map(leaf => leaf.public.compressedPoint))) {
      throw new RoleKeyError('role-collision')
    }
    return Object.freeze({
      auth,
      message,
      stamp,
      ...(previousStamp ? { previousStamp } : {}),
      dispose() {
        for (const leaf of leaves) leaf.dispose()
      },
    })
  } catch (error) {
    for (const leaf of leaves) leaf.dispose()
    throw error
  } finally {
    for (const seed of seeds) seed.fill(0)
  }
}

function pointSnapshot(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new RoleKeyError('invalid-point')
  const point = new Uint8Array(value)
  if (
    point.length !== 33 ||
    (point[0] !== 2 && point[0] !== 3) ||
    !pointMultiply(point, ONE).ok
  ) {
    throw new RoleKeyError('invalid-point')
  }
  return point
}

/**
 * Compares caller-supplied points only. A match authenticates no directory,
 * freshness, history, T1, anchor, generation membership or previous-key grace.
 * excludedPoints is an untrusted local denylist, not proof of complete history.
 */
export function matchLocalRolePoints(
  input: RoleDerivation,
  expected: ExpectedRolePoints,
  excludedPoints: readonly Uint8Array[] = [],
): LocalPointMatch {
  const points = [
    pointSnapshot(expected.auth),
    pointSnapshot(expected.message),
    pointSnapshot(expected.stamp),
  ]
  const previous = expected.previousStamp
  if (previous !== undefined) points.push(pointSnapshot(previous))
  const excluded = Array.from(excludedPoints, pointSnapshot)
  const derived = deriveRoleLeaves(input)
  try {
    const actual = [derived.auth, derived.message, derived.stamp]
    if (derived.previousStamp) actual.push(derived.previousStamp)
    const matches =
      actual.length === points.length &&
      distinct(points) &&
      actual.every((leaf, i) => {
        const point = leaf.public.compressedPoint
        return (
          same(point, points[i]) && excluded.every(old => !same(point, old, 1))
        )
      })
    return Object.freeze({ kind: 'local-point-comparison', matches })
  } finally {
    derived.dispose()
  }
}
