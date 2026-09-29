/**
 * Conformance test against the upstream dlcspecs ECDSA adaptor signature test vectors.
 *
 * Vendored from:
 *   https://github.com/discreetlogcontracts/dlcspecs/blob/fcc9619f3505afbb5a3d2f7ba3896fc4910ae08e/test/ecdsa_adaptor.json
 * (pinned to that commit; last-modified 2021-05-07, the file has not changed since) into
 * ./test-vectors/ecdsa_adaptor.json, exactly as published -- this file is not hand-edited.
 *
 * Per ECDSA-adaptor.md's own "Specification tests" section, these vectors come in three kinds:
 *   - "verification": check `ecdsa_adaptor_verify`, then (if it's expected to pass)
 *     `ecdsa_adaptor_decrypt` yields the given `signature`, then `ecdsa_adaptor_recover` recovers
 *     the given `decryption_key`.
 *   - "recovery": check only `ecdsa_adaptor_recover`.
 *   - "serialization": check that `adaptor_sig` deserializes (or, if `error` is set, fails to).
 * "Tests should fail only when `error` is set in the test vector."
 *
 * This is the single most valuable correctness check available for this package: it's an
 * independent, spec-authored set of expected inputs/outputs, not just self-consistency checks
 * against our own encrypt/decrypt/recover round trip (the other test files in this package).
 */
import * as fs from 'fs'
import * as path from 'path'
import {
  type AdaptorSignature,
  type EcdsaSignature,
  verifyEncryptedSignature,
  decryptSignature,
  recoverTweak,
  decodeAdaptorSignature,
  encodeAdaptorSignature,
  decodeEcdsaSignature,
} from './ecdsa-adaptor'
import { pointFromBytes, scalarFromBytesCanonical, type Point } from './curve'

interface RawVector {
  kind: 'verification' | 'recovery' | 'serialization'
  adaptor_sig: string
  message_hash?: string
  public_signing_key?: string
  encryption_key?: string
  decryption_key?: string | null
  signature?: string
  error?: string | null
  comment?: string
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('odd-length hex string')
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

function pointFromHex(hex: string): Point {
  return pointFromBytes(hexToBytes(hex))
}

function scalarFromHex(hex: string): bigint {
  return scalarFromBytesCanonical(hexToBytes(hex), true)
}

const vectorsPath = path.join(__dirname, '..', 'test-vectors', 'ecdsa_adaptor.json')
const vectors: RawVector[] = JSON.parse(fs.readFileSync(vectorsPath, 'utf8'))

describe('dlcspecs ECDSA-adaptor.md upstream test vectors', () => {
  it('loaded a non-trivial vector file covering all three kinds', () => {
    expect(vectors.length).toBeGreaterThan(0)
    const kinds = new Set(vectors.map((v) => v.kind))
    expect(kinds).toEqual(new Set(['verification', 'recovery', 'serialization']))
  })

  describe.each(vectors.map((v, i) => ({ i, vector: v })))('vector $i ($vector.kind)', ({ vector }) => {
    const label = vector.comment ?? vector.error ?? '(no comment)'

    if (vector.kind === 'serialization') {
      it(`serialization: ${label}`, () => {
        if (vector.error) {
          expect(() => decodeAdaptorSignature(hexToBytes(vector.adaptor_sig))).toThrow()
        } else {
          const decoded = decodeAdaptorSignature(hexToBytes(vector.adaptor_sig))
          // Round-trip: re-encoding must reproduce the exact original bytes (canonical encoding).
          const reEncoded = Buffer.from(encodeAdaptorSignature(decoded)).toString('hex')
          expect(reEncoded).toBe(vector.adaptor_sig)
        }
      })
      return
    }

    if (vector.kind === 'verification') {
      it(`verification: ${label}`, () => {
        const publicSigningKey = pointFromHex(vector.public_signing_key!)
        const encryptionKey = pointFromHex(vector.encryption_key!)
        const messageHash = hexToBytes(vector.message_hash!)
        const adaptorSig: AdaptorSignature = decodeAdaptorSignature(hexToBytes(vector.adaptor_sig))

        const verified = verifyEncryptedSignature(publicSigningKey, encryptionKey, messageHash, adaptorSig)

        if (vector.error) {
          expect(verified).toBe(false)
          return
        }

        expect(verified).toBe(true)

        const decryptionKey = scalarFromHex(vector.decryption_key!)
        const completed = decryptSignature(adaptorSig, decryptionKey)
        const expectedSig = decodeEcdsaSignature(hexToBytes(vector.signature!))
        expect(completed.r).toBe(expectedSig.r)
        expect(completed.s).toBe(expectedSig.s)

        const recovered = recoverTweak(encryptionKey, adaptorSig, completed)
        expect(recovered).toBe(decryptionKey)
      })
      return
    }

    // kind === 'recovery'
    it(`recovery: ${label}`, () => {
      const encryptionKey = pointFromHex(vector.encryption_key!)
      const adaptorSig: AdaptorSignature = decodeAdaptorSignature(hexToBytes(vector.adaptor_sig))
      const sig: EcdsaSignature = decodeEcdsaSignature(hexToBytes(vector.signature!))

      if (vector.error) {
        expect(() => recoverTweak(encryptionKey, adaptorSig, sig)).toThrow()
        return
      }

      const decryptionKey = scalarFromHex(vector.decryption_key!)
      const recovered = recoverTweak(encryptionKey, adaptorSig, sig)
      expect(recovered).toBe(decryptionKey)
    })
  })
})
