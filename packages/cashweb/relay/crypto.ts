import assert from 'assert'
import { hmacSha256 } from '@frank/crypto-box'
import {
  ecdh,
  privateKeyFromSecretBytes,
  publicFromPrivate,
} from '@frank/nakamoto'
import * as forge from 'node-forge'
import { p2pkhHashFromPublicKey } from '../legacy-wallet/lotus-address'
import { lotusP2pkhFromHash } from '../legacy-wallet/lotus-identity'
import { stampParentHdNode } from './stamp-hd'
import { stampParentHdPublicNode } from './stamp-hd-public'
import { stampParentSecret } from './stamp-parent'
import { stampParentPublicKey } from './stamp-public'
import { stealthParentHdNode } from './stealth-hd'
import { stealthParentHdPublicNode } from './stealth-hd-public'
import { stealthParentSecret } from './stealth-parent'
import { stealthParentPublicKey } from './stealth-public'
import { stealthPointDigest } from './stealth-point-digest'
import { stealthSharedPoint } from './stealth-shared'

/** 32-byte secret. `toBuffer()` is that secret. */
type PrivateKey = {
  toBuffer(): Uint8Array
}

/** SEC1 point. `toBuffer()` is the 33-byte or 65-byte encoding. */
type PublicKey = {
  toBuffer(): Uint8Array
}

type DerivedPrivateKey = {
  toBuffer(): Uint8Array
  toPublicKey(): PublicKey
}

// Copy of SEC1 bytes. Each toBuffer call returns a new copy so a caller
// cannot mutate the stored key. The bytes are the encoding
// PublicKey(bytes).toBuffer() already produced.
function sec1PublicKey(bytes: Uint8Array): PublicKey {
  const copy = Uint8Array.from(bytes)
  return Object.freeze({
    toBuffer(): Uint8Array {
      return Buffer.from(copy)
    },
  })
}

// 32-byte secret and its compressed point. Copies both before the source
// secret and the parsed key bytes are wiped.
function derivedPrivateKey(
  secret: Uint8Array,
  label: string,
): DerivedPrivateKey {
  const parsed = privateKeyFromSecretBytes(secret, true)
  if (!parsed.ok) {
    secret.fill(0)
    throw new Error(`${label}:${parsed.error.code}`)
  }
  try {
    const point = publicFromPrivate(parsed.value)
    if (!point.ok) throw new Error(`${label}:${point.error.code}`)
    const publicKey = sec1PublicKey(point.value.compressed)
    const copy = Uint8Array.from(secret)
    return Object.freeze({
      toBuffer(): Uint8Array {
        return Buffer.from(copy)
      },
      toPublicKey(): PublicKey {
        return publicKey
      },
    })
  } finally {
    parsed.value.bytes.fill(0)
    secret.fill(0)
  }
}

export class PayloadConstructor {
  networkName: string

  constructor({ networkName }: { networkName: string }) {
    assert(
      networkName,
      'Missing networkName while initializing PayloadConstructor',
    )
    this.networkName = networkName
  }

  constructPayloadHmac(sharedKey: Buffer, payloadDigest: Uint8Array) {
    return Buffer.from(hmacSha256(sharedKey, Buffer.from(payloadDigest)))
  }

  /**
   * The ECDH shared point `privateKey * publicKey`. `toBuffer()` is the 33-byte
   * compressed encoding (`02`/`03` || x), the same bytes as bitcore
   * `publicKey.point.mul(privateKey.toBigNumber()).toBuffer()`.
   */
  constructMergedKey(privateKey: PrivateKey, publicKey: PublicKey) {
    const secret = Uint8Array.from(privateKey.toBuffer())
    const parsed = privateKeyFromSecretBytes(secret, true)
    secret.fill(0)
    if (!parsed.ok) throw new Error(`merged-key:${parsed.error.code}`)
    try {
      const shared = ecdh(parsed.value, Uint8Array.from(publicKey.toBuffer()))
      if (!shared.ok) throw new Error(`merged-key:${shared.error.code}`)
      return sec1PublicKey(shared.value.point)
    } finally {
      parsed.value.bytes.fill(0)
    }
  }

  /**
   * Encodings of the ECDH shared point to try, canonical first. Before #309 one side of some key
   * pairs (about 1 in 256, every pair whose shared x starts with a zero byte) hashed the point with
   * its leading zero byte(s) trimmed, so already-stored messages may have been keyed from that
   * form. It is returned second, and only when it differs from the canonical encoding. Writers
   * must use only the first entry; the rest exist for read-side compatibility.
   */
  constructSharedPointEncodings(
    privateKey: PrivateKey,
    publicKey: PublicKey,
  ): Buffer[] {
    const canonical = Buffer.from(
      this.constructMergedKey(privateKey, publicKey).toBuffer(),
    )
    let firstNonZero = 1
    while (
      firstNonZero < canonical.length - 1 &&
      canonical[firstNonZero] === 0
    ) {
      firstNonZero++
    }
    if (firstNonZero === 1) return [canonical]
    const trimmed = Buffer.concat([
      canonical.slice(0, 1),
      canonical.slice(firstNonZero),
    ])
    return [canonical, trimmed]
  }

  constructSharedKey(
    privateKey: PrivateKey,
    publicKey: PublicKey,
    salt: Uint8Array,
  ) {
    return this.constructSharedKeys(privateKey, publicKey, salt)[0]
  }

  /** {@link constructSharedKey} for every encoding of {@link constructSharedPointEncodings}. */
  constructSharedKeys(
    privateKey: PrivateKey,
    publicKey: PublicKey,
    salt: Uint8Array,
  ) {
    return this.constructSharedPointEncodings(privateKey, publicKey).map(
      (rawMergedKey) =>
        Buffer.from(hmacSha256(Buffer.from(salt), rawMergedKey)),
    )
  }

  // ebG is ecdh of the ephemeral secret and the destination point
  // (decision #559). The scalar is a secret. The parent public key is
  // destination + (H(ebG) mod n)·G.
  // A reduced hash of 0 yields the destination. A point at infinity is an
  // error. The digest is the raw SHA-256 and is the HD chain code.
  // toBuffer is the compressed SEC1 encoding. The shared point is
  // nakamoto ecdh.
  constructStealthPublicKey(
    emphemeralPrivKey: PrivateKey,
    destinationPublicKey: PublicKey,
  ) {
    const dhKeyPointRaw = Buffer.from(
      stealthSharedPoint(
        Uint8Array.from(emphemeralPrivKey.toBuffer()),
        Uint8Array.from(destinationPublicKey.toBuffer()),
      ),
    )

    const digest = Buffer.from(stealthPointDigest(dhKeyPointRaw)) // H(ebG)
    const bytes = stealthParentPublicKey(
      Uint8Array.from(destinationPublicKey.toBuffer()),
      digest,
    )
    return {
      stealthPublicKey: sec1PublicKey(bytes),
      digest,
    }
  }

  // Depth-0 node. Chain code is the raw SHA-256 digest, not the reduced
  // scalar (decision #559). Public key bytes match bitcore HDPublicKey.
  // A secret outside (0, n), a public key that is not 33 or 65 SEC1
  // bytes, an invalid point, or a point at infinity is an error. The
  // caller's key is not wiped.
  constructHDStealthPublicKey(
    emphemeralPrivKey: PrivateKey,
    destinationPublicKey: PublicKey,
  ) {
    return stealthParentHdPublicNode(
      Uint8Array.from(emphemeralPrivKey.toBuffer()),
      Uint8Array.from(destinationPublicKey.toBuffer()),
    )
  }

  // ebG is ecdh of the destination secret and the ephemeral point.
  // The parent is (H(ebG) + destination) mod n (decision #559). A secret
  // outside (0, n), a public key that is not 33 or 65 SEC1 bytes, an
  // invalid point, or a zero sum is an error. toBuffer is the 32-byte
  // secret. toPublicKey is its compressed point. The digest is the raw
  // SHA-256 and is the HD chain code. Stealth public addition is
  // stealthParentPublicKey.
  constructStealthPrivateKey(
    emphemeralPubKey: PublicKey,
    destinationPrivateKey: PrivateKey,
  ) {
    const derived = stealthParentSecret(
      Uint8Array.from(destinationPrivateKey.toBuffer()),
      Uint8Array.from(emphemeralPubKey.toBuffer()),
    )
    return {
      stealthPrivateKey: derivedPrivateKey(derived.secret, 'stealth-private'),
      digest: Buffer.from(derived.digest),
    }
  }

  // Depth-0 node. Chain code is the raw SHA-256 digest, not the reduced
  // scalar (decision #559). Secret bytes match bitcore HDPrivateKey.
  // A secret outside (0, n), a public key that is not 33 or 65 SEC1
  // bytes, an invalid point, or a zero sum is an error. The caller's
  // key is not wiped.
  constructHDStealthPrivateKey(
    emphemeralPubKey: PublicKey,
    destinationPrivateKey: PrivateKey,
  ) {
    return stealthParentHdNode(
      Uint8Array.from(destinationPrivateKey.toBuffer()),
      Uint8Array.from(emphemeralPubKey.toBuffer()),
    )
  }

  // Digest in (0, n). A zero digest, a digest >= n, a non-32-byte digest,
  // a destination that is not 33 or 65 SEC1 bytes, or a point at infinity
  // is an error (decision #539). toBuffer is the compressed SEC1 encoding.
  // Stealth public addition reduces H mod n and does not use this
  // reject-digest rule.
  constructStampPublicKey(
    payloadDigest: Uint8Array,
    destinationPublicKey: PublicKey,
  ) {
    const bytes = stampParentPublicKey(
      Uint8Array.from(destinationPublicKey.toBuffer()),
      payloadDigest,
    )
    return sec1PublicKey(bytes)
  }

  // Depth-0 node. Chain code is the raw payload digest, not a reduced
  // scalar (decision #537). A digest >= n is an error and is not reduced.
  // Public key bytes match bitcore HDPublicKey. A zero digest, a digest
  // that is not 32 bytes, a destination that is not 33 or 65 SEC1 bytes,
  // or a point at infinity is an error. The caller's public key is not
  // wiped.
  constructStampHDPublicKey(
    payloadDigest: Uint8Array,
    destinationPublicKey: PublicKey,
  ) {
    return stampParentHdPublicNode(
      Uint8Array.from(destinationPublicKey.toBuffer()),
      payloadDigest,
    )
  }

  // Digest in (0, n). A zero digest, a digest >= n, or a zero sum is an
  // error (decision #537). toBuffer is the 32-byte secret. toPublicKey is
  // its compressed point. Stealth parent scalars use stealthParentSecret
  // (decision #559).
  constructStampPrivateKey(
    payloadDigest: Uint8Array,
    destinationPrivateKey: PrivateKey,
  ) {
    const secret = stampParentSecret(
      Uint8Array.from(destinationPrivateKey.toBuffer()),
      payloadDigest,
    )
    return derivedPrivateKey(secret, 'stamp-private')
  }

  // Depth-0 node. Chain code is the raw payload digest, not the tweaked
  // scalar (decision #537). A digest >= n is an error and is not reduced.
  // Secret bytes match bitcore HDPrivateKey. A zero digest, a digest that
  // is not 32 bytes, a destination outside (0, n), or a zero sum is an
  // error. The caller's key is not wiped.
  constructStampHDPrivateKey(
    payloadDigest: Uint8Array,
    destinationPrivateKey: PrivateKey,
  ) {
    return stampParentHdNode(
      Uint8Array.from(destinationPrivateKey.toBuffer()),
      payloadDigest,
    )
  }

  // Same scalar as constructStampPrivateKey (decision #537). A digest
  // outside (0, n) or a zero sum returns no address. The string is the
  // Lotus P2PKH of the compressed public key. An uncompressed destination
  // still hashes that compressed point.
  constructStampAddress(
    outpointDigest: Uint8Array,
    privKey: PrivateKey,
  ): string {
    const secret = stampParentSecret(
      Uint8Array.from(privKey.toBuffer()),
      outpointDigest,
    )
    const parsed = privateKeyFromSecretBytes(secret, true)
    if (!parsed.ok) {
      secret.fill(0)
      throw new Error(`stamp-address:${parsed.error.code}`)
    }
    try {
      const point = publicFromPrivate(parsed.value)
      if (!point.ok) throw new Error(`stamp-address:${point.error.code}`)
      return lotusP2pkhFromHash(
        p2pkhHashFromPublicKey(point.value.compressed),
        this.networkName,
      )
    } finally {
      parsed.value.bytes.fill(0)
      secret.fill(0)
    }
  }

  encrypt(sharedKey: Buffer, plainText: Uint8Array) {
    // Split shared key
    const iv = forge.util.createBuffer(sharedKey.slice(0, 16))
    const key = forge.util.createBuffer(sharedKey.slice(16))

    // Encrypt entries
    const cipher = forge.cipher.createCipher('AES-CBC', key)
    cipher.start({ iv })
    const rawBuffer = forge.util.createBuffer(plainText)
    cipher.update(rawBuffer)
    cipher.finish()
    const cipherText = Uint8Array.from(
      Buffer.from(cipher.output.toHex(), 'hex'),
    ) // TODO: Faster

    return cipherText
  }

  decrypt(sharedKey: Buffer, cipherText: Uint8Array) {
    // Split shared key
    const iv = forge.util.createBuffer(sharedKey.slice(0, 16))
    const key = forge.util.createBuffer(sharedKey.slice(16))

    // Encrypt entries
    const cipher = forge.cipher.createDecipher('AES-CBC', key)
    cipher.start({ iv })
    const rawBuffer = forge.util.createBuffer(cipherText)
    cipher.update(rawBuffer)
    cipher.finish()
    const plainText = Uint8Array.from(Buffer.from(cipher.output.toHex(), 'hex')) // TODO: Faster
    return plainText
  }
}
