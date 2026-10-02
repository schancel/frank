import {
  privateKeyFromSecretBytes,
  publicFromPrivate,
} from '@frank/nakamoto/keys'

import {
  adaptorPointFromBytes,
  adaptorSecretFromBytes,
  adaptorSecretProofFromBytes,
  adaptorSign,
  adaptorSignatureFromBytes,
  compactEcdsaSignatureFromBytes,
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

function fromHex(hex: string): Uint8Array {
  return Uint8Array.from({ length: hex.length / 2 }, (_, index) =>
    Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16),
  )
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
      adaptorProof: generated.value.proof,
      digest,
    })
    expect(signed.ok).toBe(true)
    if (!signed.ok) return
    expect(
      verifyAdaptorSignature({
        publicKey: publicKey.value.compressed,
        adaptorPoint: generated.value.point,
        adaptorProof: generated.value.proof,
        digest,
        signature: signed.value,
      }),
    ).toEqual({ ok: true, value: true })

    const completed = completeAdaptorSignature({
      publicKey: publicKey.value.compressed,
      adaptorPoint: generated.value.point,
      adaptorProof: generated.value.proof,
      digest,
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

  it('binds mandatory proof-of-knowledge to the exact adaptor point', () => {
    const signer = privateKeyFromSecretBytes(bytes(7), true)
    const first = generateAdaptorSecret(() => bytes(9))
    const second = generateAdaptorSecret(() => bytes(10))
    expect(signer.ok && first.ok && second.ok).toBe(true)
    if (!signer.ok || !first.ok || !second.ok) return
    const publicKey = publicFromPrivate(signer.value)
    if (!publicKey.ok) return
    const digest = bytes(11)

    expect(
      adaptorSign({
        privateKey: signer.value.bytes,
        adaptorPoint: first.value.point,
        adaptorProof: second.value.proof,
        digest,
      }),
    ).toEqual({ ok: false, error: { code: 'invalid-proof' } })

    const signed = adaptorSign({
      privateKey: signer.value.bytes,
      adaptorPoint: first.value.point,
      adaptorProof: first.value.proof,
      digest,
    })
    expect(signed.ok).toBe(true)
    if (!signed.ok) return
    expect(
      verifyAdaptorSignature({
        publicKey: publicKey.value.compressed,
        adaptorPoint: first.value.point,
        adaptorProof: second.value.proof,
        digest,
        signature: signed.value,
      }),
    ).toEqual({ ok: false, error: { code: 'invalid-proof' } })
  })

  it('rejects completion with a wrong but structurally valid secret', () => {
    const signer = privateKeyFromSecretBytes(bytes(7), true)
    const material = generateAdaptorSecret(() => bytes(9))
    const wrong = adaptorSecretFromBytes(bytes(10))
    expect(signer.ok && material.ok && wrong.ok).toBe(true)
    if (!signer.ok || !material.ok || !wrong.ok) return
    const publicKey = publicFromPrivate(signer.value)
    if (!publicKey.ok) return
    const digest = bytes(11)
    const signed = adaptorSign({
      privateKey: signer.value.bytes,
      adaptorPoint: material.value.point,
      adaptorProof: material.value.proof,
      digest,
    })
    if (!signed.ok) return
    const completed = completeAdaptorSignature({
      publicKey: publicKey.value.compressed,
      adaptorPoint: material.value.point,
      adaptorProof: material.value.proof,
      digest,
      signature: signed.value,
      secret: wrong.value,
    })
    expect(completed).toEqual({
      ok: false,
      error: { code: 'secret-point-mismatch' },
    })
  })

  it('reports noncanonical completion secrets as invalid scalars', () => {
    const signer = privateKeyFromSecretBytes(bytes(7), true)
    const material = generateAdaptorSecret(() => bytes(9))
    expect(signer.ok && material.ok).toBe(true)
    if (!signer.ok || !material.ok) return
    const publicKey = publicFromPrivate(signer.value)
    if (!publicKey.ok) return
    const digest = bytes(11)
    const signed = adaptorSign({
      privateKey: signer.value.bytes,
      adaptorPoint: material.value.point,
      adaptorProof: material.value.proof,
      digest,
    })
    if (!signed.ok) return
    const invalidSecrets = [
      new Uint8Array(32),
      fromHex(
        'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141',
      ),
    ]
    for (const secret of invalidSecrets) {
      expect(
        completeAdaptorSignature({
          publicKey: publicKey.value.compressed,
          adaptorPoint: material.value.point,
          adaptorProof: material.value.proof,
          digest,
          signature: signed.value,
          secret: secret as typeof material.value.secret,
        }),
      ).toEqual({ ok: false, error: { code: 'invalid-scalar' } })
    }
  })

  it('rejects a structurally parseable forged adaptor signature at completion', () => {
    const signer = privateKeyFromSecretBytes(bytes(7), true)
    const material = generateAdaptorSecret(() => bytes(9))
    expect(signer.ok && material.ok).toBe(true)
    if (!signer.ok || !material.ok) return
    const publicKey = publicFromPrivate(signer.value)
    if (!publicKey.ok) return
    const forgedBytes = new Uint8Array(162)
    forgedBytes.set(material.value.point, 0)
    forgedBytes.set(material.value.point, 33)
    forgedBytes.set(bytes(1), 66)
    const forged = adaptorSignatureFromBytes(forgedBytes)
    expect(forged.ok).toBe(true)
    if (!forged.ok) return
    expect(
      completeAdaptorSignature({
        publicKey: publicKey.value.compressed,
        adaptorPoint: material.value.point,
        adaptorProof: material.value.proof,
        digest: bytes(11),
        signature: forged.value,
        secret: material.value.secret,
      }),
    ).toEqual({ ok: false, error: { code: 'invalid-signature' } })
    expect(
      completeAdaptorSignature({
        publicKey: publicKey.value.compressed,
        adaptorPoint: material.value.point,
        adaptorProof: material.value.proof,
        digest: bytes(11),
        signature: forged.value,
        secret: new Uint8Array(32) as typeof material.value.secret,
      }),
    ).toEqual({ ok: false, error: { code: 'invalid-signature' } })
  })

  it('accepts valid Buffer inputs and contains malformed subclasses', () => {
    const signer = privateKeyFromSecretBytes(bytes(7), true)
    const material = generateAdaptorSecret(() => bytes(9))
    expect(signer.ok && material.ok).toBe(true)
    if (!signer.ok || !material.ok) return
    const valid = adaptorSign({
      privateKey: Buffer.from(signer.value.bytes),
      adaptorPoint: Buffer.from(
        material.value.point,
      ) as typeof material.value.point,
      adaptorProof: Buffer.from(
        material.value.proof,
      ) as typeof material.value.proof,
      digest: Buffer.from(bytes(11)),
    })
    expect(valid.ok).toBe(true)
    expect(() =>
      adaptorSign({
        privateKey: Buffer.alloc(31),
        adaptorPoint: material.value.point,
        adaptorProof: material.value.proof,
        digest: Buffer.from(bytes(11)),
      }),
    ).not.toThrow()
    expect(
      adaptorSign({
        privateKey: Buffer.alloc(31),
        adaptorPoint: material.value.point,
        adaptorProof: material.value.proof,
        digest: Buffer.from(bytes(11)),
      }),
    ).toEqual({ ok: false, error: { code: 'bad-length' } })
  })

  it('uses intrinsic Uint8Array size before copying parser inputs', () => {
    const parsers: ReadonlyArray<
      readonly [number, (value: Uint8Array) => { readonly ok: boolean }]
    > = [
      [32, adaptorSecretFromBytes],
      [33, adaptorPointFromBytes],
      [64, compactEcdsaSignatureFromBytes],
      [65, adaptorSecretProofFromBytes],
      [162, adaptorSignatureFromBytes],
    ]
    for (const [spoofedLength, parse] of parsers) {
      const oversized = new Uint8Array(1024 * 1024)
      Object.defineProperty(oversized, 'length', { value: spoofedLength })
      expect(oversized.length).toBe(spoofedLength)
      expect(parse(oversized)).toEqual({
        ok: false,
        error: { code: 'bad-length' },
      })
    }
  })

  it('rejects non-Uint8Array views and proxies without iterator access', () => {
    expect(
      adaptorSecretFromBytes(
        new Uint8ClampedArray(32) as unknown as Uint8Array,
      ),
    ).toEqual({ ok: false, error: { code: 'bad-length' } })

    let iteratorReads = 0
    const proxied = new Proxy(bytes(3), {
      get(target, property, receiver) {
        if (property === Symbol.iterator) {
          iteratorReads += 1
          throw new Error('iterator must not be consulted')
        }
        return Reflect.get(target, property, receiver)
      },
    })
    expect(adaptorSecretFromBytes(proxied)).toEqual({
      ok: false,
      error: { code: 'bad-length' },
    })
    expect(iteratorReads).toBe(0)
  })

  it('rejects oversized composite inputs before reading later fields', () => {
    const material = generateAdaptorSecret(() => bytes(9))
    if (!material.ok) return
    const oversized = new Uint8Array(1024 * 1024)
    Object.defineProperty(oversized, 'length', { value: 32 })
    let adaptorPointReads = 0
    expect(
      adaptorSign({
        privateKey: oversized,
        get adaptorPoint() {
          adaptorPointReads += 1
          return material.value.point
        },
        adaptorProof: material.value.proof,
        digest: bytes(11),
      }),
    ).toEqual({ ok: false, error: { code: 'bad-length' } })
    expect(adaptorPointReads).toBe(0)
    expect(generateAdaptorSecret(() => oversized)).toEqual({
      ok: false,
      error: { code: 'rng-failed' },
    })
  })

  it('verifies the frozen Frank PoK v1 wire/transcript vector', () => {
    const point = adaptorPointFromBytes(
      fromHex(
        '03acd484e2f0c7f65309ad178a9f559abde09796974c57e714c35f110dfc27ccbe',
      ),
    )
    const proof = adaptorSecretProofFromBytes(
      fromHex(
        '038094126a4a9cf7e9945a7b152a55a5ee90a61013df9dfface9f935e6d8ec88ee3b5b7372c6bf2ef36cde2e8ea8cfdfa8a3100b548c3cff5f57fe12c891d2652b',
      ),
    )
    expect(point.ok && proof.ok).toBe(true)
    if (!point.ok || !proof.ok) return
    expect(verifyAdaptorSecret(point.value, proof.value)).toEqual({
      ok: true,
      value: true,
    })
  })

  it('snapshots alternating adaptor-point getters once for sign and verify', () => {
    const signer = privateKeyFromSecretBytes(bytes(7), true)
    const first = generateAdaptorSecret(() => bytes(9))
    const second = generateAdaptorSecret(() => bytes(10))
    expect(signer.ok && first.ok && second.ok).toBe(true)
    if (!signer.ok || !first.ok || !second.ok) return
    const publicKey = publicFromPrivate(signer.value)
    if (!publicKey.ok) return
    let signReads = 0
    const signed = adaptorSign({
      privateKey: signer.value.bytes,
      get adaptorPoint() {
        signReads += 1
        return signReads === 1 ? first.value.point : second.value.point
      },
      adaptorProof: first.value.proof,
      digest: bytes(11),
    })
    expect(signReads).toBe(1)
    expect(signed.ok).toBe(true)
    if (!signed.ok) return

    let verifyReads = 0
    expect(
      verifyAdaptorSignature({
        publicKey: publicKey.value.compressed,
        get adaptorPoint() {
          verifyReads += 1
          return verifyReads === 1 ? first.value.point : second.value.point
        },
        adaptorProof: first.value.proof,
        digest: bytes(11),
        signature: signed.value,
      }),
    ).toEqual({ ok: true, value: true })
    expect(verifyReads).toBe(1)
  })

  it('snapshots completion and extraction signatures exactly once', () => {
    const signer = privateKeyFromSecretBytes(bytes(7), true)
    const material = generateAdaptorSecret(() => bytes(9))
    expect(signer.ok && material.ok).toBe(true)
    if (!signer.ok || !material.ok) return
    const publicKey = publicFromPrivate(signer.value)
    if (!publicKey.ok) return
    const digest = bytes(11)
    const signed = adaptorSign({
      privateKey: signer.value.bytes,
      adaptorPoint: material.value.point,
      adaptorProof: material.value.proof,
      digest,
    })
    if (!signed.ok) return
    const forgedBytes = new Uint8Array(signed.value)
    forgedBytes.fill(0, 98)
    const forged = adaptorSignatureFromBytes(forgedBytes)
    expect(forged.ok).toBe(true)
    if (!forged.ok) return

    let completionReads = 0
    const completed = completeAdaptorSignature({
      publicKey: publicKey.value.compressed,
      adaptorPoint: material.value.point,
      adaptorProof: material.value.proof,
      digest,
      get signature() {
        completionReads += 1
        return completionReads === 1 ? signed.value : forged.value
      },
      secret: material.value.secret,
    })
    expect(completionReads).toBe(1)
    expect(completed.ok).toBe(true)
    if (!completed.ok) return

    let extractionReads = 0
    expect(
      extractAdaptorSecret({
        adaptorPoint: material.value.point,
        get signature() {
          extractionReads += 1
          return extractionReads === 1 ? signed.value : forged.value
        },
        completedSignature: completed.value,
      }),
    ).toEqual({ ok: true, value: material.value.secret })
    expect(extractionReads).toBe(1)
  })

  it('copies earlier key buffers before later getters can mutate them', () => {
    const signer = privateKeyFromSecretBytes(bytes(7), true)
    const material = generateAdaptorSecret(() => bytes(9))
    expect(signer.ok && material.ok).toBe(true)
    if (!signer.ok || !material.ok) return
    const keyBuffer = Buffer.from(signer.value.bytes)
    const signed = adaptorSign({
      privateKey: keyBuffer,
      get adaptorPoint() {
        keyBuffer.fill(0)
        return material.value.point
      },
      adaptorProof: material.value.proof,
      digest: bytes(11),
    })
    expect(signed.ok).toBe(true)
    expect(keyBuffer.every(byte => byte === 0)).toBe(true)
  })

  it('contains throwing object getters inside typed failures', () => {
    const material = generateAdaptorSecret(() => bytes(9))
    if (!material.ok) return
    expect(() =>
      adaptorSign({
        get privateKey(): Uint8Array {
          throw new Error('hostile getter')
        },
        adaptorPoint: material.value.point,
        adaptorProof: material.value.proof,
        digest: bytes(11),
      }),
    ).not.toThrow()
    expect(
      adaptorSign({
        get privateKey(): Uint8Array {
          throw new Error('hostile getter')
        },
        adaptorPoint: material.value.point,
        adaptorProof: material.value.proof,
        digest: bytes(11),
      }),
    ).toEqual({ ok: false, error: { code: 'invalid-signature' } })
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
