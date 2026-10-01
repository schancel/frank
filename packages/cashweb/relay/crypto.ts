import assert from 'assert'
import {
  PrivateKey,
  PublicKey,
  crypto,
  HDPublicKey,
  HDPrivateKey,
} from 'bitcore-lib-xpi'
import * as forge from 'node-forge'
import { stampParentSecret } from './stamp-parent'
import { stampParentPublicKey } from './stamp-public'
import { stealthParentSecret } from './stealth-parent'
import { stealthPointDigest } from './stealth-point-digest'

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
    return crypto.Hash.sha256hmac(sharedKey, Buffer.from(payloadDigest))
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
      (rawMergedKey) => crypto.Hash.sha256hmac(Buffer.from(salt), rawMergedKey),
    )
  }

  constructStealthPublicKey(
    emphemeralPrivKey: PrivateKey,
    destinationPublicKey: PublicKey,
  ) {
    const dhKeyPoint = destinationPublicKey.point.mul(emphemeralPrivKey.bn) // ebG
    const dhKeyPointRaw = crypto.Point.pointToCompressed(dhKeyPoint)

    const digest = Buffer.from(stealthPointDigest(dhKeyPointRaw)) // H(ebG)
    const digestPublicKey = PrivateKey.fromBuffer(
      digest,
      this.networkName,
    ).toPublicKey() // H(ebG)G

    const stealthPublicKey = PublicKey.fromPoint(
      digestPublicKey.point.add(destinationPublicKey.point),
    ) // H(ebG)G + bG
    return { stealthPublicKey, digest }
  }

  constructHDStealthPublicKey(
    emphemeralPrivKey: PrivateKey,
    destinationPublicKey: PublicKey,
  ) {
    const { stealthPublicKey, digest } = this.constructStealthPublicKey(
      emphemeralPrivKey,
      destinationPublicKey,
    )
    return new HDPublicKey({
      publicKey: stealthPublicKey.toBuffer(),
      depth: 0,
      network: this.networkName,
      childIndex: 0,
      chainCode: digest,
      parentFingerPrint: 0,
    })
  }

  // ebG is ecdh of the destination secret and the ephemeral point.
  // The parent is (H(ebG) + destination) mod n (decision #559). A secret
  // outside (0, n), a public key that is not 33 or 65 SEC1 bytes, an
  // invalid point, or a zero sum is an error. Hex matches new PrivateKey(bn):
  // compressed, default network. The digest is the raw SHA-256 and is the
  // HD chain code. Stealth public point.add stays on bitcore.
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

  constructHDStealthPrivateKey(
    emphemeralPubKey: PublicKey,
    destinationPrivateKey: PrivateKey,
  ) {
    const { stealthPrivateKey, digest } = this.constructStealthPrivateKey(
      emphemeralPubKey,
      destinationPrivateKey,
    )
    return new HDPrivateKey({
      privateKey: stealthPrivateKey.toBuffer(),
      depth: 0,
      network: this.networkName,
      childIndex: 0,
      chainCode: digest,
      parentFingerPrint: 0,
    })
  }

  // Digest in (0, n). A zero digest, a digest >= n, a non-32-byte digest,
  // a destination that is not 33 or 65 SEC1 bytes, or a point at infinity
  // is an error (decision #539). Bytes match PublicKey.fromPoint: compressed,
  // default network. Stealth public point.add stays on bitcore.
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

  constructStampHDPublicKey(
    payloadDigest: Uint8Array,
    destinationPublicKey: PublicKey,
  ) {
    const stampPublicKey = this.constructStampPublicKey(
      payloadDigest,
      destinationPublicKey,
    )
    return new HDPublicKey({
      publicKey: stampPublicKey.toBuffer(),
      depth: 0,
      network: this.networkName,
      childIndex: 0,
      chainCode: payloadDigest,
      parentFingerPrint: 0,
    })
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

  constructStampHDPrivateKey(
    payloadDigest: Uint8Array,
    destinationPrivateKey: PrivateKey,
  ) {
    const stampPrivateKey = this.constructStampPrivateKey(
      payloadDigest,
      destinationPrivateKey,
    )
    return new HDPrivateKey({
      privateKey: stampPrivateKey.toBuffer(),
      depth: 0,
      network: this.networkName,
      childIndex: 0,
      chainCode: payloadDigest,
      parentFingerPrint: 0,
    })
  }

  constructStampAddress(outpointDigest: Uint8Array, privKey: PrivateKey) {
    const digestBn = crypto.BN.fromBuffer(Buffer.from(outpointDigest))
    const stampPrivBn = privKey
      .toBigNumber()
      .add(digestBn)
      .mod(crypto.Point.getN())
    const stampAddress = new PrivateKey(stampPrivBn).toAddress(this.networkName)
    return stampAddress
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
