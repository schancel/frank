/**
 * EXPERIMENT, NOT PRODUCT CODE. Not part of the package, not in its test run.
 *
 * Question: can an adaptor pre-signature in the `@frank/adaptor-signatures`
 * format be produced from a DKLs23 joint key using the UNMODIFIED Silence
 * Laboratories wasm?
 *
 * Answer shown here: not through its public API, but yes by reading each
 * party's secret round-3 values out of the wasm's serialised session (an
 * undocumented CBOR layout) and doing the last, linear step ourselves:
 *
 *   wasm, unchanged:  rounds 1-3 -> each party i holds r_i, phi_i, s0_i, s1_i
 *                     with  sum(s1_i) = k*phi,  sum(s0_i) = r*x*phi,
 *                     k = r_0 + r_1,  R_a = k*G,  r = x-coordinate of R_a
 *   ours:             R  = r_0*T + r_1*T = k*T,  r' = x-coordinate of R
 *                     partial_i = m*phi_i + s0_i * r' / r
 *                     s_a = sum(partial_i) / sum(s1_i) = (m + r'*x) / k
 *                     plus a two-party proof that R_a and R share the log k
 *
 * That is new, unreviewed cryptography around an audited library, it depends
 * on a serialisation that may change in any release, and it bypasses the
 * library's own final check. The proof nonces below are exchanged without the
 * commit-then-reveal a real protocol needs. Do not ship this.
 *
 * Run (from packages/joint-signer):
 *   jest --runInBand --testMatch '**\/experiments/*.experiment.ts'
 */
import { randomBytes as nodeRandomBytes } from 'crypto'
import { Signature, Transaction } from 'ethers'
import * as dkls from '@silencelaboratories/dkls-wasm-ll-node'
import {
  completeAdaptorSignature,
  extractAdaptorSecret,
  generateAdaptorSecret,
  verifyAdaptorSignature,
} from '@frank/adaptor-signatures'
import {
  G,
  hashToScalar,
  mod,
  modAdd,
  modInv,
  modMul,
  pointBytes,
  pointFromBytes,
  scalarBytes,
  taggedHash,
  type Point,
} from '@frank/adaptor-signatures/src/curve.js'

const rng = (length: number): Uint8Array =>
  new Uint8Array(nodeRandomBytes(length))

/** Minimal CBOR reader: enough for the wasm's serde output. */
function decodeCbor(bytes: Uint8Array): unknown {
  let offset = 0
  const BREAK = Symbol('break')
  const argument = (info: number): number => {
    if (info < 24) return info
    if (info === 31) return -1
    const size = 1 << (info - 24)
    let value = 0
    for (let index = 0; index < size; index += 1) {
      value = value * 256 + (bytes[offset++] ?? 0)
    }
    return value
  }
  const item = (): unknown => {
    const head = bytes[offset++] ?? 0
    const major = head >> 5
    const info = head & 31
    if (major === 7) {
      if (info === 31) return BREAK
      return info === 21 ? true : info === 20 ? false : null
    }
    const n = argument(info)
    if (major === 0) return n
    if (major === 1) return -1 - n
    if (major === 2 || major === 3) {
      const slice = bytes.slice(offset, offset + n)
      offset += n
      return major === 2 ? slice : String.fromCharCode(...slice)
    }
    if (major === 4) {
      const out: unknown[] = []
      for (let index = 0; n < 0 || index < n; index += 1) {
        const value = item()
        if (value === BREAK) break
        out.push(value)
      }
      return out
    }
    const out: Record<string, unknown> = {}
    for (let index = 0; n < 0 || index < n; index += 1) {
      const key = item()
      if (key === BREAK) break
      out[String(key)] = item()
    }
    return out
  }
  return item()
}

type Fields = Record<string, unknown>
const bytesOf = (value: unknown): Uint8Array =>
  Uint8Array.from(value as number[])
const scalarOf = (value: unknown): bigint =>
  BigInt(
    '0x' +
      Array.from(bytesOf(value), byte =>
        byte.toString(16).padStart(2, '0'),
      ).join(''),
  )
const hex = (bytes: Uint8Array): string =>
  '0x' + Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')

function keygen(): dkls.Keyshare[] {
  const parties = [0, 1].map(id => new dkls.KeygenSession(2, 2, id))
  const m1 = parties.map(party => party.createFirstMessage())
  const m2 = parties.map((party, i) => party.handleMessages([m1[1 - i]!]))
  const commitments = parties.map(party => party.calculateChainCodeCommitment())
  const m3 = parties.map((party, i) => party.handleMessages(m2[1 - i]!))
  const m4 = parties.map((party, i) =>
    party.handleMessages(m3[1 - i]!, commitments),
  )
  parties.forEach((party, i) => party.handleMessages(m4[1 - i]!))
  return parties.map(party => party.keyshare())
}

describe('experiment: adaptor pre-signature from unmodified DKLs23 wasm', () => {
  it('builds one that @frank/adaptor-signatures verifies, completes and extracts', () => {
    const shares = keygen()
    const publicKey = Uint8Array.from(shares[0]!.publicKey)

    // The lock: T = t*G with its proof of knowledge.
    const material = generateAdaptorSecret(rng)
    if (!material.ok) throw new Error(material.error.code)
    const T = pointFromBytes(material.value.point)

    const tx = Transaction.from({
      type: 2,
      chainId: 10143,
      nonce: 0,
      to: '0x000000000000000000000000000000000000dEaD',
      value: 1n,
      gasLimit: 21_000n,
      maxFeePerGas: 100_000_000_000n,
      maxPriorityFeePerGas: 2_000_000_000n,
    })
    const digest = bytesOf(
      Array.from({ length: 32 }, (_, index) =>
        Number.parseInt(
          tx.unsignedHash.slice(2 + index * 2, 4 + index * 2),
          16,
        ),
      ),
    )
    const m = hashToScalar(digest)

    // Rounds 1-3 in the unmodified wasm, through its public API.
    const sessions = shares.map(share => new dkls.SignSession(share, 'm'))
    const m1 = sessions.map(session => session.createFirstMessage())
    const m2 = sessions.map((session, i) =>
      session.handleMessages([m1[1 - i]!]),
    )
    const m3 = sessions.map((session, i) => session.handleMessages(m2[1 - i]!))
    sessions.forEach((session, i) => session.handleMessages(m3[1 - i]!))

    // Each party reads ITS OWN secret values from its serialised session.
    const local = sessions.map(session => {
      const decoded = decodeCbor(session.toBytes()) as Fields
      const state = decoded.state as Fields
      const pre = (decoded.round as Fields).Pre as Fields
      const nonceShare = scalarOf(state.r_i)
      const noncePoint = pointFromBytes(bytesOf(state.big_r_i))
      // The layout guess is right only if r_i*G is the stored R_i.
      expect(G.multiply(nonceShare).equals(noncePoint)).toBe(true)
      return {
        nonceShare,
        noncePoint,
        phi: scalarOf(pre.phi_i),
        s0: scalarOf(pre.s_0),
        s1: scalarOf(pre.s_1),
        Ra: pointFromBytes(bytesOf(pre.r)),
      }
    })
    const [a, b] = local as [(typeof local)[0], (typeof local)[0]]
    expect(a.Ra.equals(b.Ra)).toBe(true)
    expect(a.noncePoint.add(b.noncePoint).equals(a.Ra)).toBe(true)

    // Each party publishes r_i*T; together R = k*T.
    const R = T.multiply(a.nonceShare).add(T.multiply(b.nonceShare))
    const rOriginal = mod(a.Ra.toAffine().x)
    const rLocked = mod(R.toAffine().x)
    const swap = modMul(rLocked, modInv(rOriginal))

    // The last, linear step, with r replaced by r'.
    const partial = (party: typeof a): bigint =>
      modAdd(modMul(m, party.phi), modMul(party.s0, swap))
    const sa = modMul(
      modAdd(partial(a), partial(b)),
      modInv(modAdd(a.s1, b.s1)),
    )

    // Two-party proof that log_G(R_a) = log_T(R) = k = r_0 + r_1.
    const nonces = [hashToScalar(rng(32)), hashToScalar(rng(32))] as const
    const AG = G.multiply(nonces[0]).add(G.multiply(nonces[1]))
    const AT = T.multiply(nonces[0]).add(T.multiply(nonces[1]))
    const challenge = hashToScalar(
      taggedHash(
        'DLEQ',
        pointBytes(a.Ra),
        pointBytes(T),
        pointBytes(R),
        pointBytes(AG),
        pointBytes(AT),
      ),
    )
    const response = modAdd(
      modAdd(nonces[0], modMul(challenge, a.nonceShare)),
      modAdd(nonces[1], modMul(challenge, b.nonceShare)),
    )

    const encode = (point: Point): Uint8Array => pointBytes(point)
    const adaptorSignature = Uint8Array.from([
      ...encode(R),
      ...encode(a.Ra),
      ...scalarBytes(sa),
      ...scalarBytes(challenge),
      ...scalarBytes(response),
    ])
    expect(adaptorSignature).toHaveLength(162)

    const common = {
      publicKey,
      adaptorPoint: material.value.point,
      adaptorProof: material.value.proof,
      digest,
      signature: adaptorSignature as never,
    }
    // Verifiable without the secret.
    const verified = verifyAdaptorSignature(common)
    expect(verified).toEqual({ ok: true, value: true })

    // Completable by whoever knows t; the result is an ordinary signature
    // that ethers recovers to the joint address.
    const completed = completeAdaptorSignature({
      ...common,
      secret: material.value.secret,
    })
    if (!completed.ok) throw new Error(completed.error.code)
    const compact = completed.value as unknown as Uint8Array
    const recovered = [0, 1].map(yParity => {
      const signed = tx.clone()
      signed.signature = Signature.from({
        r: hex(compact.subarray(0, 32)),
        s: hex(compact.subarray(32, 64)),
        yParity: yParity as 0 | 1,
      })
      return Transaction.from(signed.serialized).fromPublicKey
    })
    const uncompressed = hex(pointFromBytes(publicKey).toRawBytes(false))
    expect(recovered).toContain(uncompressed)

    // t is extractable from the completed signature.
    const extracted = extractAdaptorSecret({
      ...common,
      completedSignature: completed.value,
    })
    if (!extracted.ok) throw new Error(extracted.error.code)
    expect(hex(extracted.value as unknown as Uint8Array)).toBe(
      hex(material.value.secret as unknown as Uint8Array),
    )
  })
})
