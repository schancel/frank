import { secp256k1 } from '@noble/curves/secp256k1.js'
import { randomBytes } from 'crypto'

import {
  bitLength,
  gcd,
  generatePrime,
  hasSmallPrimeFactor,
  isProbablePrime,
  modInverse,
  modPow,
  SMALL_PRIMES,
} from './bigint.js'
import {
  bytesToInt,
  intToBytes,
  Reader,
  snapshot,
  snapshotBounded,
} from './bytes.js'
import {
  commit,
  CURVE_ORDER,
  G,
  hedgedScalar,
  multiply,
  parsePoint,
  parseScalar,
  pointBytes,
  proveDleq,
  proveDlog,
  requireDleqProof,
  requireDlogProof,
  requireOpening,
  SHARE_HIGH,
  SHARE_LOW,
  transcript,
} from './group.js'
import {
  addCiphertexts,
  ciphertextBytes,
  decrypt,
  drawUnit,
  encrypt,
  encryptAsOwner,
  generatePaillierKey,
  modulusBytes,
  paillierPublicKey,
  paillierSecretKey,
  parseCiphertext,
  parseModulus,
  parseUnit,
  scaleCiphertext,
  subtractConstant,
  type PaillierSecretKey,
} from './paillier.js'
import {
  MODULUS_PROOF_BYTES,
  proveModulus,
  rangeCommit,
  rangeRespond,
  requireModulusProof,
  requireRangeProof,
  RANGE_ROUNDS,
} from './paillier-proofs.js'
import { deterministicStream, draw, drawBelow, drawInRange } from './rng.js'
import { Failure } from './result.js'
import { ascii, flip, hex, seededRandom } from './test-support.js'

const rng = (length: number): Uint8Array => new Uint8Array(randomBytes(length))

function code(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    if (error instanceof Failure) return error.code
    throw error
  }
  return 'no-failure'
}

describe('bytes and randomness', () => {
  it('copies only real Uint8Arrays of the right length', () => {
    const source = Uint8Array.of(1, 2, 3)
    const copied = snapshot(source, 3)
    expect(copied).toEqual(source)
    expect(copied).not.toBe(source)
    expect(snapshot(source, 4)).toBeNull()
    expect(snapshot([1, 2, 3], 3)).toBeNull()
    expect(snapshot(null, 3)).toBeNull()
    expect(snapshot(new Uint16Array(3), 3)).toBeNull()
    expect(snapshot({ length: 3 }, 3)).toBeNull()
    expect(snapshotBounded(source, 1, 2)).toBeNull()
  })

  it('encodes integers at fixed width and reads strictly', () => {
    expect(hex(intToBytes(0x1234n, 4))).toBe('00001234')
    expect(code(() => intToBytes(0x10000n, 2))).toBe('internal-error')
    expect(bytesToInt(Uint8Array.of(1, 0))).toBe(256n)
    const reader = new Reader(Uint8Array.of(1, 2, 3))
    expect(reader.take(2)).toEqual(Uint8Array.of(1, 2))
    expect(code(() => reader.take(2))).toBe('malformed-message')
    expect(code(() => reader.finish())).toBe('malformed-message')
    reader.take(1)
    reader.finish()
  })

  it('validates the caller CSPRNG and never substitutes its own', () => {
    expect(code(() => draw(() => new Uint8Array(2), 3))).toBe('rng-failed')
    expect(
      code(() =>
        draw(() => {
          throw new Error('boom')
        }, 3),
      ),
    ).toBe('rng-failed')
    expect(code(() => draw((() => [1, 2, 3]) as never, 3))).toBe('rng-failed')
    const fixed = Uint8Array.of(9, 9, 9)
    const drawn = draw(() => fixed, 3)
    expect(drawn).toEqual(fixed)
    expect(drawn).not.toBe(fixed)
  })

  it('draws within bounds', () => {
    for (let round = 0; round < 200; round += 1) {
      expect(drawBelow(rng, 7n)).toBeLessThan(7n)
      const value = drawInRange(rng, SHARE_LOW, SHARE_HIGH)
      expect(value >= SHARE_LOW && value < SHARE_HIGH).toBe(true)
    }
  })

  it('has a deterministic stream that does not depend on call boundaries', () => {
    const seed = new Uint8Array(32).fill(4)
    const one = deterministicStream('d', seed)
    const two = deterministicStream('d', seed)
    const whole = one(100)
    const parts = new Uint8Array([...two(1), ...two(63), ...two(36)])
    expect(hex(parts)).toBe(hex(whole))
    expect(hex(deterministicStream('e', seed)(32))).not.toBe(
      hex(whole.subarray(0, 32)),
    )
  })
})

describe('integer arithmetic', () => {
  it('matches known values', () => {
    expect(modPow(4n, 13n, 497n)).toBe(445n)
    expect(modPow(-2n, 3n, 7n)).toBe(6n)
    expect(gcd(48n, -18n)).toBe(6n)
    expect(modInverse(3n, 11n)).toBe(4n)
    expect(modInverse(6n, 9n)).toBeNull()
    expect(bitLength(255n)).toBe(8)
    expect(bitLength(256n)).toBe(9)
    expect(SMALL_PRIMES[0]).toBe(2n)
    expect(SMALL_PRIMES[SMALL_PRIMES.length - 1]).toBe(6367n)
    expect(SMALL_PRIMES).toHaveLength(830)
    expect(hasSmallPrimeFactor(6367n * 6373n)).toBe(true)
    expect(hasSmallPrimeFactor(6373n * 6379n)).toBe(false)
  })

  it('tells primes from composites, including Carmichael-style products', () => {
    // 2^521 - 1 is prime; 2^523 - 1 is not.
    expect(isProbablePrime((1n << 521n) - 1n, rng)).toBe(true)
    expect(isProbablePrime((1n << 523n) - 1n, rng)).toBe(false)
    const p = generatePrime(512, seededRandom('prime-a'))
    const q = generatePrime(512, seededRandom('prime-b'))
    expect(bitLength(p)).toBe(512)
    expect((p >> 510n) & 3n).toBe(3n)
    expect(isProbablePrime(p * q, rng)).toBe(false)
    // Same stream, same prime.
    expect(generatePrime(512, seededRandom('prime-a'))).toBe(p)
  })
})

describe('group helpers and sigma proofs', () => {
  const session = new Uint8Array(32).fill(1)
  const prover = ascii('alice')

  it('rejects every malformed point encoding', () => {
    const good = pointBytes(multiply(G, 5n))
    expect(parsePoint(good).equals(multiply(G, 5n))).toBe(true)
    const offCurve = new Uint8Array(33)
    offCurve[0] = 2
    offCurve[32] = 5
    const overField = new Uint8Array(33).fill(0xff)
    overField[0] = 2
    expect(code(() => parsePoint(offCurve))).toBe('invalid-point')
    expect(code(() => parsePoint(overField))).toBe('invalid-point')
    expect(code(() => parsePoint(new Uint8Array(33)))).toBe('invalid-point')
    expect(code(() => parsePoint(flip(good, 0).fill(4, 0, 1)))).toBe(
      'invalid-point',
    )
    expect(code(() => parsePoint(good.subarray(0, 32)))).toBe(
      'malformed-message',
    )
    expect(code(() => parsePoint(multiply(G, 5n).toRawBytes(false)))).toBe(
      'malformed-message',
    )
  })

  it('rejects out-of-range scalars', () => {
    expect(parseScalar(intToBytes(CURVE_ORDER - 1n, 32))).toBe(CURVE_ORDER - 1n)
    expect(code(() => parseScalar(intToBytes(CURVE_ORDER, 32)))).toBe(
      'out-of-range',
    )
    expect(code(() => parseScalar(new Uint8Array(32)))).toBe('out-of-range')
    expect(parseScalar(new Uint8Array(32), true)).toBe(0n)
    expect(code(() => multiply(G, 0n))).toBe('internal-error')
    expect(code(() => multiply(G, CURVE_ORDER))).toBe('internal-error')
  })

  it('frames transcript parts so that different splits never collide', () => {
    const one = transcript('t', ascii('ab'), ascii('c'))
    const two = transcript('t', ascii('a'), ascii('bc'))
    const three = transcript('u', ascii('ab'), ascii('c'))
    expect(hex(one)).not.toBe(hex(two))
    expect(hex(one)).not.toBe(hex(three))
  })

  it('opens commitments only to the committed value, session and committer', () => {
    const nonce = rng(32)
    const payload = ascii('payload')
    const commitment = commit('x', session, prover, payload, nonce)
    requireOpening(commitment, 'x', session, prover, payload, nonce)
    const bad = (run: () => void) =>
      expect(code(run)).toBe('invalid-commitment')
    bad(() => requireOpening(commitment, 'y', session, prover, payload, nonce))
    bad(() => requireOpening(commitment, 'x', rng(32), prover, payload, nonce))
    bad(() =>
      requireOpening(commitment, 'x', session, ascii('bob'), payload, nonce),
    )
    bad(() =>
      requireOpening(commitment, 'x', session, prover, ascii('other'), nonce),
    )
    bad(() =>
      requireOpening(commitment, 'x', session, prover, payload, rng(32)),
    )
  })

  it('proves knowledge of a discrete log, bound to session and prover', () => {
    const witness = 123456789n
    const statement = multiply(G, witness)
    const proof = proveDlog(rng, session, prover, witness, statement)
    expect(proof).toHaveLength(65)
    requireDlogProof(session, prover, statement, proof)
    const bad = (run: () => void) => expect(code(run)).toBe('invalid-proof')
    bad(() => requireDlogProof(rng(32), prover, statement, proof))
    bad(() => requireDlogProof(session, ascii('bob'), statement, proof))
    bad(() => requireDlogProof(session, prover, multiply(G, 5n), proof))
    bad(() => requireDlogProof(session, prover, statement, flip(proof, 64)))
    // A proof built with the wrong witness.
    bad(() =>
      requireDlogProof(
        session,
        prover,
        statement,
        proveDlog(rng, session, prover, witness + 1n, statement),
      ),
    )
  })

  it('proves equality of discrete logs, bound to session and prover', () => {
    const witness = 987654321n
    const base = multiply(G, 77n)
    const first = multiply(G, witness)
    const second = multiply(base, witness)
    const proof = proveDleq(rng, session, prover, witness, base, first, second)
    expect(proof).toHaveLength(64)
    requireDleqProof(session, prover, base, first, second, proof)
    const bad = (run: () => void) => expect(code(run)).toBe('invalid-proof')
    bad(() => requireDleqProof(rng(32), prover, base, first, second, proof))
    bad(() =>
      requireDleqProof(session, ascii('bob'), base, first, second, proof),
    )
    bad(() =>
      requireDleqProof(session, prover, base, first, multiply(base, 5n), proof),
    )
    bad(() =>
      requireDleqProof(session, prover, multiply(G, 78n), first, second, proof),
    )
    bad(() =>
      requireDleqProof(session, prover, base, first, second, flip(proof, 63)),
    )
    expect(
      code(() =>
        requireDleqProof(
          session,
          prover,
          base,
          first,
          second,
          new Uint8Array(64),
        ),
      ),
    ).toBe('out-of-range')
  })

  it('hedges nonces with the session and the secret, never repeating across sessions', () => {
    const secret = new Uint8Array(32).fill(8)
    const stuck = () => new Uint8Array(32).fill(1)
    const one = hedgedScalar(stuck, 'p', session, secret)
    expect(hedgedScalar(stuck, 'p', session, secret)).toBe(one)
    expect(hedgedScalar(stuck, 'p', rng(32), secret)).not.toBe(one)
    expect(hedgedScalar(stuck, 'q', session, secret)).not.toBe(one)
    expect(hedgedScalar(stuck, 'p', session, rng(32))).not.toBe(one)
    expect(hedgedScalar(rng, 'p', session, secret)).not.toBe(one)
    expect(one > 0n && one < CURVE_ORDER).toBe(true)
    expect(secp256k1.CURVE.n).toBe(CURVE_ORDER)
  })
})

describe('Paillier', () => {
  let key: PaillierSecretKey
  const session = new Uint8Array(32).fill(2)
  const prover = ascii('alice')

  beforeAll(() => {
    key = generatePaillierKey(seededRandom('paillier-test-key'))
  })

  it('generates a 2048-bit modulus deterministically from its byte stream', () => {
    expect(bitLength(key.n)).toBe(2048)
    expect(bitLength(key.p)).toBe(1024)
    expect(bitLength(key.q)).toBe(1024)
    expect(gcd(key.n, key.phi)).toBe(1n)
    expect(generatePaillierKey(seededRandom('paillier-test-key')).n).toBe(key.n)
  })

  it('encrypts, decrypts and is additively homomorphic', () => {
    const r1 = drawUnit(key, rng)
    const r2 = drawUnit(key, rng)
    const c1 = encrypt(key, 1234567n, r1)
    const c2 = encrypt(key, 7654321n, r2)
    expect(decrypt(key, c1)).toBe(1234567n)
    expect(decrypt(key, encrypt(key, 0n, r1))).toBe(0n)
    expect(decrypt(key, encrypt(key, key.n - 1n, r1))).toBe(key.n - 1n)
    expect(decrypt(key, addCiphertexts(key, c1, c2))).toBe(8888888n)
    expect(decrypt(key, scaleCiphertext(key, c1, 1000n))).toBe(1234567000n)
    expect(decrypt(key, subtractConstant(key, c1, 67n))).toBe(1234500n)
    expect(decrypt(key, subtractConstant(key, c1, 1234568n))).toBe(key.n - 1n)
    expect(encrypt(key, 5n, r1)).not.toBe(encrypt(key, 5n, r2))
  })

  it("the owner's CRT encryption equals ordinary encryption", () => {
    for (const message of [0n, 1n, 1234567n, key.n - 1n]) {
      const randomness = drawUnit(key, rng)
      expect(encryptAsOwner(key, message, randomness)).toBe(
        encrypt(key, message, randomness),
      )
    }
  })

  it('rejects out-of-range moduli, units and ciphertexts', () => {
    const modulus = modulusBytes(key)
    expect(parseModulus(modulus).n).toBe(key.n)
    const even = intToBytes(key.n + 1n, 256)
    const short = intToBytes(key.n >> 1n, 256)
    expect(code(() => parseModulus(even))).toBe('invalid-paillier')
    expect(code(() => parseModulus(short))).toBe('invalid-paillier')
    expect(code(() => parseModulus(new Uint8Array(256)))).toBe(
      'invalid-paillier',
    )
    expect(code(() => parseModulus(modulus.subarray(1)))).toBe(
      'malformed-message',
    )
    const bad = (run: () => unknown) =>
      expect(code(run)).toBe('invalid-paillier')
    bad(() => parseUnit(key, new Uint8Array(256)))
    bad(() => parseUnit(key, intToBytes(key.n, 256)))
    bad(() => parseUnit(key, intToBytes(key.p * 3n, 256)))
    bad(() => parseCiphertext(key, new Uint8Array(512)))
    bad(() => parseCiphertext(key, intToBytes(key.nn, 512)))
    bad(() => parseCiphertext(key, intToBytes(key.q * 5n, 512)))
    expect(parseCiphertext(key, ciphertextBytes(encrypt(key, 1n, 3n)))).toBe(
      encrypt(key, 1n, 3n),
    )
    bad(() => paillierSecretKey(key.p, key.p))
    bad(() => paillierSecretKey(key.p, key.q + 2n))
    bad(() => paillierSecretKey(key.p >> 8n, key.q))
  })

  it('proves gcd(N, phi(N)) = 1, bound to session and prover', () => {
    const proof = proveModulus(session, prover, key)
    expect(proof).toHaveLength(MODULUS_PROOF_BYTES)
    requireModulusProof(session, prover, key, proof)
    expect(code(() => requireModulusProof(rng(32), prover, key, proof))).toBe(
      'invalid-proof',
    )
    expect(
      code(() => requireModulusProof(session, ascii('bob'), key, proof)),
    ).toBe('invalid-proof')
    expect(
      code(() => requireModulusProof(session, prover, key, flip(proof, 300))),
    ).toBe('invalid-proof')
    // A proof for one modulus does not transfer to another.
    const other = generatePaillierKey(seededRandom('paillier-other-key'))
    expect(code(() => requireModulusProof(session, prover, other, proof))).toBe(
      'invalid-proof',
    )
  })

  it('rejects a modulus with a small prime factor', () => {
    // 2048 bits, odd, divisible by 6361.
    let candidate = (key.n / 6361n) * 6361n
    if ((candidate & 1n) === 0n) candidate -= 6361n
    expect(bitLength(candidate)).toBe(2048)
    const weak = paillierPublicKey(candidate)
    expect(
      code(() =>
        requireModulusProof(
          session,
          prover,
          weak,
          new Uint8Array(MODULUS_PROOF_BYTES).fill(1),
        ),
      ),
    ).toBe('invalid-paillier')
  })

  it('rejects a modulus N = p*q with p dividing q - 1, where encryption is not a bijection', () => {
    // BitForge-class key: gcd(N, phi(N)) = p. No small factors, right size.
    const stream = seededRandom('bad-modulus')
    const p = generatePrime(1016, stream)
    let q = 0n
    for (let k = 1n << 14n; q === 0n; k += 1n) {
      const candidate = 2n * k * p + 1n
      if (bitLength(candidate * p) > 2048) throw new Error('no candidate')
      if (
        bitLength(candidate * p) === 2048 &&
        isProbablePrime(candidate, stream)
      ) {
        q = candidate
      }
    }
    const n = p * q
    expect(gcd(n, (p - 1n) * (q - 1n))).toBe(p)
    const weak = parseModulus(intToBytes(n, 256))
    expect(hasSmallPrimeFactor(n)).toBe(false)
    // The honest prover cannot even build a proof...
    expect(
      code(() =>
        proveModulus(session, prover, {
          ...weak,
          p,
          q,
          phi: (p - 1n) * (q - 1n),
          phiInverse: 0n,
          pp: p * p,
          qq: q * q,
          ppInverse: 0n,
        }),
      ),
    ).toBe('invalid-paillier')
    // ...and "roots" computed as if N were invertible do not verify.
    const lambda = (p - 1n) * (q - 1n)
    const fake = new Uint8Array(MODULUS_PROOF_BYTES)
    const pseudoInverse = modInverse(q, lambda / p) ?? 1n
    for (let index = 0; index < 11; index += 1) {
      fake.set(
        intToBytes(modPow(BigInt(index + 2), pseudoInverse, n), 256),
        index * 256,
      )
    }
    expect(code(() => requireModulusProof(session, prover, weak, fake))).toBe(
      'invalid-proof',
    )
  })

  describe('range proof', () => {
    // The range proof does not depend on the modulus size, so these tests use
    // a 1024-bit key built by hand (the protocol itself only ever accepts
    // 2048-bit keys; see the key-generation suite for the proof at full size).
    let small: PaillierSecretKey
    const challenge = Uint8Array.of(
      0b10110010,
      0x0f,
      0xa5,
      0x00,
      0xff,
      0x3c,
      0x81,
      0x7e,
      0x55,
      0xaa,
    )

    beforeAll(() => {
      const stream = seededRandom('small-paillier')
      const p = generatePrime(512, stream)
      const q = generatePrime(512, stream)
      const n = p * q
      const phi = (p - 1n) * (q - 1n)
      small = {
        n,
        nn: n * n,
        p,
        q,
        phi,
        phiInverse: modInverse(phi, n)!,
        pp: p * p,
        qq: q * q,
        ppInverse: modInverse(p * p, q * q)!,
      }
      expect(RANGE_ROUNDS).toBe(80)
      expect(challenge).toHaveLength(RANGE_ROUNDS / 8)
    })

    function statementFor(witness: bigint): {
      statement: bigint
      randomness: bigint
    } {
      const randomness = drawUnit(small, rng)
      return { statement: encrypt(small, witness, randomness), randomness }
    }

    it('accepts an honest proof at both ends of the range, with a 32-byte commitment', () => {
      for (const witness of [0n, SHARE_LOW / 2n, SHARE_LOW - 1n]) {
        const { statement, randomness } = statementFor(witness)
        const commitment = rangeCommit(small, rng)
        expect(commitment.wire).toHaveLength(32)
        const response = rangeRespond(
          small,
          commitment.secret,
          witness,
          randomness,
          challenge,
        )
        requireRangeProof(
          small,
          statement,
          commitment.wire,
          challenge,
          response,
        )
      }
    })

    it('refuses to respond for a witness outside the range', () => {
      const commitment = rangeCommit(small, rng)
      for (const witness of [-1n, SHARE_LOW, CURVE_ORDER]) {
        expect(
          code(() =>
            rangeRespond(small, commitment.secret, witness, 3n, challenge),
          ),
        ).toBe('internal-error')
      }
    })

    it('rejects a response for another challenge, statement or commitment', () => {
      const witness = 424242n
      const { statement, randomness } = statementFor(witness)
      const commitment = rangeCommit(small, rng)
      const response = rangeRespond(
        small,
        commitment.secret,
        witness,
        randomness,
        challenge,
      )
      const bad = (run: () => void) =>
        expect(['invalid-proof', 'malformed-message']).toContain(code(run))
      bad(() =>
        requireRangeProof(
          small,
          statement,
          commitment.wire,
          flip(challenge, 2),
          response,
        ),
      )
      bad(() =>
        requireRangeProof(
          small,
          statementFor(witness).statement,
          commitment.wire,
          challenge,
          response,
        ),
      )
      bad(() =>
        requireRangeProof(
          small,
          statement,
          rangeCommit(small, rng).wire,
          challenge,
          response,
        ),
      )
      // A flipped bit anywhere: value, randomness, or the unopened leaf.
      for (const index of [3, 40, 300, response.length - 1]) {
        bad(() =>
          requireRangeProof(
            small,
            statement,
            commitment.wire,
            challenge,
            flip(response, index),
          ),
        )
      }
      bad(() =>
        requireRangeProof(
          small,
          statement,
          commitment.wire,
          challenge,
          response.subarray(0, response.length - 1),
        ),
      )
      bad(() =>
        requireRangeProof(
          small,
          statement,
          commitment.wire,
          challenge,
          new Uint8Array([...response, 0]),
        ),
      )
    })

    it('a prover whose value is out of range passes only by guessing the whole challenge', () => {
      // Encrypt n + 5: far outside [0, l). A cheating prover prepares, per
      // round, ciphertexts that answer exactly one challenge bit, chosen in
      // advance, and commits to their hashes. It is accepted if and only if
      // every guess was right, which has probability 2^-80 because the
      // verifier's challenge is committed before the prover's commitment.
      const { transcript } = jest.requireActual(
        './group',
      ) as typeof import('./group.js')
      const leaf = (ciphertext: bigint) =>
        transcript('proof/range/leaf', ciphertextBytes(ciphertext))
      const witness = CURVE_ORDER + 5n
      const randomness = drawUnit(small, rng)
      const statement = encrypt(small, witness, randomness)
      const guess = Uint8Array.of(
        0x5a,
        0xc3,
        0x0f,
        0x99,
        0x71,
        0x12,
        0xfe,
        0x08,
        0x64,
        0xb7,
      )
      const leaves: Uint8Array[] = []
      const responses: Uint8Array[] = []
      for (let round = 0; round < RANGE_ROUNDS; round += 1) {
        const bit = ((guess[round >> 3] ?? 0) >> (round & 7)) & 1
        const r1 = drawUnit(small, rng)
        const r2 = drawUnit(small, rng)
        if (bit === 0) {
          // An honest-looking pair, which can be opened.
          const upper = drawInRange(rng, SHARE_LOW, SHARE_HIGH)
          leaves.push(
            leaf(encrypt(small, upper, r1)),
            leaf(encrypt(small, upper - SHARE_LOW, r2)),
          )
          responses.push(
            Uint8Array.of(0),
            intToBytes(upper, 32),
            intToBytes(upper - SHARE_LOW, 32),
            intToBytes(r1, 256),
            intToBytes(r2, 256),
          )
        } else {
          // c1 encrypts (target - witness) mod N, so c + c1 opens in range.
          const target = SHARE_LOW + 1n
          const mask = (((target - witness) % small.n) + small.n) % small.n
          const other = leaf(encrypt(small, 0n, r2))
          leaves.push(leaf(encrypt(small, mask, r1)), other)
          responses.push(
            Uint8Array.of(1),
            intToBytes(target, 32),
            intToBytes((randomness * r1) % small.n, 256),
            other,
          )
        }
      }
      const wire = transcript('proof/range/commit', ...leaves)
      const response = new Uint8Array(responses.flatMap(part => [...part]))
      // Right guess: accepted (this is the 2^-80 event).
      requireRangeProof(small, statement, wire, guess, response)
      // Any other challenge: rejected, whichever single bit differs.
      for (let bit = 0; bit < RANGE_ROUNDS; bit += 11) {
        const other = guess.slice()
        other[bit >> 3] = (other[bit >> 3] ?? 0) ^ (1 << (bit & 7))
        expect([
          'invalid-proof',
          'malformed-message',
          'invalid-paillier',
        ]).toContain(
          code(() =>
            requireRangeProof(small, statement, wire, other, response),
          ),
        )
      }
    })
  })
})
