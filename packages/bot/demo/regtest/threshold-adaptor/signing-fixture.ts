import { randomBytes, createHash } from 'node:crypto'
import {
  startKeygen,
  keygenStep,
  describeKeyShare,
  startSign,
  signStep,
  createPointLock,
  type Step,
  type ThresholdResult,
} from '@frank/threshold-ecdsa'
import {
  completeAdaptorSignature,
  extractAdaptorSecret,
  verifyAdaptorSignature,
  compactEcdsaSignatureFromBytes,
} from '@frank/adaptor-signatures'
import { secp256k1 } from '@noble/curves/secp256k1.js'

export const hex = (value: Uint8Array) => Buffer.from(value).toString('hex')
export function must<T>(
  result: { ok: true; value: T } | { ok: false; error: unknown }
): T {
  if (!result.ok) throw new Error('cryptographic operation rejected')
  return result.value
}
const rng = (length: number) => new Uint8Array(randomBytes(length))
function drive<S, R>(
  a: ThresholdResult<Step<S, R>>,
  b: ThresholdResult<Step<S, R>>,
  step: (s: S, m: Uint8Array) => ThresholdResult<Step<S, R>>
) {
  let left = must(a),
    right = must(b),
    message = left.outgoing,
    turn = true
  const hashes: string[] = []
  for (let rounds = 0; message !== null; rounds++) {
    if (rounds > 32) throw new Error('round limit')
    hashes.push(createHash('sha256').update(message).digest('hex'))
    const next = must(step(turn ? right.session : left.session, message))
    if (turn) right = next
    else left = next
    message = next.outgoing
    turn = !turn
  }
  if (left.result === null || right.result === null)
    throw new Error('incomplete session')
  return { a: left.result, b: right.result, hashes }
}

/** Disposable in-process parties: only public transcript hashes leave this fixture. */
export function freshJointKey() {
  const sessionId = rng(32),
    alice = rng(32),
    bob = rng(32)
  const keys = drive(
    startKeygen({
      role: 'initiator',
      sessionId,
      localId: alice,
      peerId: bob,
      randomBytes: rng,
    }),
    startKeygen({
      role: 'responder',
      sessionId,
      localId: bob,
      peerId: alice,
      randomBytes: rng,
    }),
    keygenStep
  )
  const info = must(describeKeyShare(keys.a))
  return {
    publicKey: info.publicKey,
    address: `0x${hex(info.address)}`,
    sign: (digest: Uint8Array, binding: string) =>
      runTwoPartyAdaptorSession(keys.a, keys.b, digest, binding, keys.hashes),
  }
}

export function runTwoPartyAdaptorSession(
  a: Parameters<typeof describeKeyShare>[0],
  b: Parameters<typeof describeKeyShare>[0],
  digest: Uint8Array,
  binding: string,
  keygenHashes: string[]
) {
  const made = must(createPointLock({ keyShare: b, randomBytes: rng }))
  if (!binding) throw new Error('application binding required')
  const bindingHash = createHash('sha256').update(binding).digest('hex')
  const sessionId = new Uint8Array(
    createHash('sha256')
      .update('frank-native-adaptor-packet-a')
      .update(bindingHash)
      .update(digest)
      .update(rng(32))
      .digest()
  )
  const common = { sessionId, digest, lock: made.lock, randomBytes: rng }
  const signed = drive(
    startSign({ ...common, keyShare: a }),
    startSign({ ...common, keyShare: b, lockOpening: made.opening }),
    signStep
  )
  if (
    signed.a.kind !== 'adaptor-signature' ||
    signed.b.kind !== 'adaptor-signature'
  )
    throw new Error('wrong result kind')
  if (
    hex(signed.a.adaptorSignature) !== hex(signed.b.adaptorSignature) ||
    hex(signed.a.publicKey) !== hex(signed.b.publicKey)
  )
    throw new Error('party result disagreement')
  const context = {
    publicKey: signed.a.publicKey,
    adaptorPoint: made.lock.point,
    adaptorProof: made.lock.proof,
    digest,
    signature: signed.a.adaptorSignature,
  }
  if (!must(verifyAdaptorSignature(context)))
    throw new Error('invalid adaptor proof')
  const completed = must(
    completeAdaptorSignature({ ...context, secret: made.secret })
  )
  return {
    completed,
    context,
    bindingHash,
    transcriptHashes: [...keygenHashes, ...signed.hashes],
    observe: (observedDigest: Uint8Array, observed: Uint8Array) => {
      if (
        hex(observedDigest) !== hex(digest) ||
        !secp256k1.verify(observed, digest, context.publicKey, {
          prehash: false,
          lowS: true,
        })
      )
        throw new Error('observation binding rejected')
      const extracted = must(
        extractAdaptorSecret({
          ...context,
          completedSignature: must(
            compactEcdsaSignatureFromBytes(new Uint8Array(observed))
          ),
        })
      )
      if (hex(extracted) !== hex(made.secret))
        throw new Error('secret extraction mismatch')
      return { extractionVerified: true as const }
    },
  }
}
