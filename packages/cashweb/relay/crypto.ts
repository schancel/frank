import assert from 'assert'
import { hmacSha256 } from '@frank/crypto-box'
import { privateKeyFromSecretBytes, publicFromPrivate } from '@frank/nakamoto'
import { PrivateKey, PublicKey } from 'bitcore-lib-xpi'
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
   * The ECDH shared point `privateKey * publicKey`. Serialize it with `toBuffer()`: the result is
   * always the 33-byte compressed encoding (`02`/`03` parity prefix, then the x coordinate
   * left-padded to exactly 32 big-endian bytes), so both parties derive identical bytes.
   */
  constructMergedKey(privateKey: PrivateKey, publicKey: PublicKey) {
    return PublicKey.fromPoint(publicKey.point.mul(privateKey.toBigNumber()))
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
    const canonical = this.constructMergedKey(privateKey, publicKey).toBuffer()
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
  // error. The digest is the raw SHA-256 and is the HD chain code. Bytes
  // match PublicKey.fromPoint: compressed, default network. Envelope ECDH
  // stays on bitcore point.mul until #258.
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
      stealthPublicKey: new PublicKey(Buffer.from(bytes)),
      digest,
    }
  }

  // Depth-0 node. Chain code is the raw SHA-256 digest, not the reduced
  // scalar (decision #559). Public key bytes match bitcore HDPublicKey.
  // A secret outside (0, n), a public key that is not 33 or 65 SEC1
  // bytes, an invalid point, or a point at infinity is an error. The
  // caller's PrivateKey is not wiped. HMAC, salt, and envelope ECDH stay on bitcore.
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
  // invalid point, or a zero sum is an error. Hex matches new PrivateKey(bn):
  // compressed, default network. The digest is the raw SHA-256 and is the
  // HD chain code. Stealth public addition is stealthParentPublicKey.
  constructStealthPrivateKey(
    emphemeralPubKey: PublicKey,
    destinationPrivateKey: PrivateKey,
  ) {
    const derived = stealthParentSecret(
      Uint8Array.from(destinationPrivateKey.toBuffer()),
      Uint8Array.from(emphemeralPubKey.toBuffer()),
    )
    try {
      return {
        stealthPrivateKey: new PrivateKey(
          Buffer.from(derived.secret).toString('hex'),
        ),
        digest: Buffer.from(derived.digest),
      }
    } finally {
      derived.secret.fill(0)
    }
  }

  // Depth-0 node. Chain code is the raw SHA-256 digest, not the reduced
  // scalar (decision #559). Secret bytes match bitcore HDPrivateKey.
  // A secret outside (0, n), a public key that is not 33 or 65 SEC1
  // bytes, an invalid point, or a zero sum is an error. The caller's
  // PrivateKey is not wiped. HMAC, salt, and envelope ECDH stay on bitcore.
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
  // is an error (decision #539). Bytes match PublicKey.fromPoint: compressed,
  // default network. Stealth public addition reduces H mod n and does
  // not use this reject-digest rule.
  constructStampPublicKey(
    payloadDigest: Uint8Array,
    destinationPublicKey: PublicKey,
  ) {
    const bytes = stampParentPublicKey(
      Uint8Array.from(destinationPublicKey.toBuffer()),
      payloadDigest,
    )
    return new PublicKey(Buffer.from(bytes))
  }

  // Depth-0 node. Chain code is the raw payload digest, not a reduced
  // scalar (decision #537). A digest >= n is an error and is not reduced.
  // Public key bytes match bitcore HDPublicKey. A zero digest, a digest
  // that is not 32 bytes, a destination that is not 33 or 65 SEC1 bytes,
  // or a point at infinity is an error. The caller's PublicKey is not
  // wiped. HMAC, salt, and envelope ECDH stay on bitcore.
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
  // error (decision #537). Hex matches new PrivateKey(bn): compressed,
  // default network. Stealth parent scalars use stealthParentSecret
  // (decision #559).
  constructStampPrivateKey(
    payloadDigest: Uint8Array,
    destinationPrivateKey: PrivateKey,
  ) {
    const secret = stampParentSecret(
      Uint8Array.from(destinationPrivateKey.toBuffer()),
      payloadDigest,
    )
    try {
      return new PrivateKey(Buffer.from(secret).toString('hex'))
    } finally {
      secret.fill(0)
    }
  }

  // Depth-0 node. Chain code is the raw payload digest, not the tweaked
  // scalar (decision #537). A digest >= n is an error and is not reduced.
  // Secret bytes match bitcore HDPrivateKey. A zero digest, a digest that
  // is not 32 bytes, a destination outside (0, n), or a zero sum is an
  // error. The caller's PrivateKey is not wiped. HMAC, salt, and envelope
  // ECDH stay on bitcore.
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
