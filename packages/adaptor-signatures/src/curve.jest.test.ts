import {
  CURVE_ORDER,
  mod,
  modAdd,
  modSub,
  modMul,
  modInv,
  modNeg,
  negateIfGreaterThan,
  randomScalar,
  scalarBytes,
} from './curve'
import { bytesToNumberBE } from '@noble/curves/abstract/utils.js'

const n = CURVE_ORDER

describe('curve.ts hardened arithmetic primitives', () => {
  it('mod() matches naive sign-correction for a range of positive, negative, and huge values', () => {
    const samples = [
      0n,
      1n,
      n - 1n,
      n,
      n + 1n,
      -1n,
      -n,
      -n - 1n,
      n * 3n + 7n,
      -(n * 5n) - 3n,
    ]
    for (const x of samples) {
      const naive = ((x % n) + n) % n
      expect(mod(x)).toBe(naive)
    }
    for (let i = 0; i < 200; i++) {
      const a = randomScalar()
      const b = randomScalar()
      expect(mod(a - b - n * 2n)).toBe((((a - b - n * 2n) % n) + n) % n)
    }
  })

  it('modAdd/modSub/modMul stay within [0, n) and are internally consistent', () => {
    for (let i = 0; i < 100; i++) {
      const a = randomScalar()
      const b = randomScalar()
      const sum = modAdd(a, b)
      const diff = modSub(a, b)
      const prod = modMul(a, b)
      expect(sum >= 0n && sum < n).toBe(true)
      expect(diff >= 0n && diff < n).toBe(true)
      expect(prod >= 0n && prod < n).toBe(true)
      // sum - b == a (mod n), diff + b == a (mod n)
      expect(modSub(sum, b)).toBe(mod(a))
      expect(modAdd(diff, b)).toBe(mod(a))
    }
  })

  it('modInv (Fermat-based) produces a true multiplicative inverse for many random scalars', () => {
    for (let i = 0; i < 200; i++) {
      const x = randomScalar()
      const inv = modInv(x)
      expect(modMul(x, inv)).toBe(1n)
    }
  })

  it('modInv matches known small values worked out by hand mod a tiny stand-in prime is not applicable here (real n) -- spot check 1 and n-1', () => {
    expect(modInv(1n)).toBe(1n)
    // n-1 is its own inverse: (n-1)^2 = n^2 - 2n + 1 = 1 (mod n)
    expect(modInv(n - 1n)).toBe(n - 1n)
  })

  it('modInv throws on zero (rare/invalid-input guard, documented in curve.ts)', () => {
    expect(() => modInv(0n)).toThrow()
    expect(() => modInv(n)).toThrow() // reduces to 0
  })

  it('negateIfGreaterThan matches the naive ternary it replaces', () => {
    for (let i = 0; i < 200; i++) {
      const x = randomScalar()
      const threshold = randomScalar()
      const naive = x > threshold ? modNeg(x) : x
      expect(negateIfGreaterThan(x, threshold)).toBe(naive)
    }
    // Boundary: x === threshold must NOT be negated (strict '>' semantics).
    const x = randomScalar()
    expect(negateIfGreaterThan(x, x)).toBe(x)
  })

  it('scalarBytes is a fixed-length 32-byte big-endian encoding that round-trips through bytesToNumberBE', () => {
    const samples = [0n, 1n, 255n, 256n, n - 1n, randomScalar(), randomScalar()]
    for (const x of samples) {
      const bytes = scalarBytes(x)
      expect(bytes.length).toBe(32)
      expect(bytesToNumberBE(bytes)).toBe(mod(x))
    }
  })
})
