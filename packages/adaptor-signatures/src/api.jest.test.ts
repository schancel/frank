import {
  privateKeyFromSecretBytes,
  publicFromPrivate,
} from '@frank/nakamoto/keys'

import {
  adaptorPointFromBytes,
  adaptorSecretFromBytes,
  adaptorSign,
  adaptorSignatureFromBytes,
  completeAdaptorSignature,
  extractAdaptorSecret,
  generateAdaptorSecret,
  verifyAdaptorSecret,
  verifyAdaptorSignature,
} from './index.js'

function bytes(value: number): Uint8Array {
  const out = new Uint8Array(32)
  out[31] = value
  return out
}

describe('safe byte-oriented API', () => {
  it('signs, verifies, completes, and extracts without transaction coupling', () => {
    const signer = privateKeyFromSecretBytes(bytes(7), true)
    expect(signer.ok).toBe(true)
    if (!signer.ok) return
    const publicKey = publicFromPrivate(signer.value)
    expect(publicKey.ok).toBe(true)
    if (!publicKey.ok) return

    const generated = generateAdaptorSecret(() => bytes(9))
    expect(generated.ok).toBe(true)
    if (!generated.ok) return
    expect(
      verifyAdaptorSecret(generated.value.point, generated.value.proof),
    ).toEqual({ ok: true, value: true })

    const digest = new Uint8Array(32)
    digest.fill(0xa5)
    const signed = adaptorSign({
      privateKey: signer.value.bytes,
      adaptorPoint: generated.value.point,
      digest,
    })
    expect(signed.ok).toBe(true)
    if (!signed.ok) return
    expect(
      verifyAdaptorSignature({
        publicKey: publicKey.value.compressed,
        adaptorPoint: generated.value.point,
        digest,
        signature: signed.value,
      }),
    ).toEqual({ ok: true, value: true })

    const completed = completeAdaptorSignature({
      signature: signed.value,
      secret: generated.value.secret,
    })
    expect(completed.ok).toBe(true)
    if (!completed.ok) return
    const extracted = extractAdaptorSecret({
      adaptorPoint: generated.value.point,
      signature: signed.value,
      completedSignature: completed.value,
    })
    expect(extracted.ok && extracted.value).toEqual(generated.value.secret)
  })

  it('rejects malformed and noncanonical inputs without throwing', () => {
    expect(adaptorSecretFromBytes(new Uint8Array(31))).toEqual({
      ok: false,
      error: { code: 'bad-length' },
    })
    expect(adaptorSecretFromBytes(new Uint8Array(32))).toEqual({
      ok: false,
      error: { code: 'invalid-scalar' },
    })
    expect(adaptorPointFromBytes(new Uint8Array(33))).toEqual({
      ok: false,
      error: { code: 'invalid-point' },
    })
    expect(adaptorSignatureFromBytes(new Uint8Array(163))).toEqual({
      ok: false,
      error: { code: 'bad-length' },
    })
    expect(generateAdaptorSecret(() => new Uint8Array(31))).toEqual({
      ok: false,
      error: { code: 'rng-failed' },
    })
  })

  it('copies caller-owned secret bytes', () => {
    const source = bytes(3)
    const parsed = adaptorSecretFromBytes(source)
    expect(parsed.ok).toBe(true)
    source.fill(0)
    expect(parsed.ok && parsed.value[31]).toBe(3)
  })
})
