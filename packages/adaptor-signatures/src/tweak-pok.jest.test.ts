import { pokProve, pokVerify } from './tweak-pok'
import { G, randomScalar, modAdd } from './curve'

describe('tweak proof-of-knowledge', () => {
  it('proves and verifies knowledge of t for T = t*G', () => {
    const t = randomScalar()
    const T = G.multiply(t)
    const proof = pokProve(t, T)
    expect(pokVerify(T, proof)).toBe(true)
  })

  it('rejects a proof checked against a different T', () => {
    const t = randomScalar()
    const T = G.multiply(t)
    const proof = pokProve(t, T)

    const otherT = G.multiply(randomScalar())
    expect(pokVerify(otherT, proof)).toBe(false)
  })

  it('rejects a tampered proof (forged without knowing t)', () => {
    const t = randomScalar()
    const T = G.multiply(t)
    const proof = pokProve(t, T)

    const tampered = { ...proof, z: modAdd(proof.z, 1n) }
    expect(pokVerify(T, tampered)).toBe(false)
  })
})
