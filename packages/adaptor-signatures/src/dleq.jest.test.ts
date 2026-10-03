import { dleqProve, dleqVerify } from './dleq'
import { G, randomScalar, modAdd } from './curve'

describe('DLEQ proof', () => {
  it('proves and verifies X = x*G, Z = x*Y for a real witness', () => {
    const x = randomScalar()
    const y = randomScalar()
    const X = G.multiply(x)
    const Y = G.multiply(y)
    const Z = Y.multiply(x)

    const proof = dleqProve(x, X, Y, Z)
    expect(dleqVerify(X, Y, Z, proof)).toBe(true)
  })

  it("rejects a proof when Z does not actually share X's discrete log", () => {
    const x = randomScalar()
    const y = randomScalar()
    const X = G.multiply(x)
    const Y = G.multiply(y)
    const wrongZ = Y.multiply(randomScalar())

    const proof = dleqProve(x, X, Y, wrongZ)
    expect(dleqVerify(X, Y, wrongZ, proof)).toBe(false)
  })

  it('rejects a proof checked against a different X', () => {
    const x = randomScalar()
    const y = randomScalar()
    const X = G.multiply(x)
    const Y = G.multiply(y)
    const Z = Y.multiply(x)
    const proof = dleqProve(x, X, Y, Z)

    const otherX = G.multiply(randomScalar())
    expect(dleqVerify(otherX, Y, Z, proof)).toBe(false)
  })

  it('rejects a tampered proof', () => {
    const x = randomScalar()
    const y = randomScalar()
    const X = G.multiply(x)
    const Y = G.multiply(y)
    const Z = Y.multiply(x)
    const proof = dleqProve(x, X, Y, Z)

    const tampered = { ...proof, c: modAdd(proof.c, 1n) }
    expect(dleqVerify(X, Y, Z, tampered)).toBe(false)
  })
})
