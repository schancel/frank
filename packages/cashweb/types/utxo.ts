import { privateKeyFromSecretBytes, publicFromPrivate } from '@frank/nakamoto'

/** Methods a bitcore PrivateKey already has. `compressed` is optional because
 * the bitcore type declaration omits the runtime flag. */
export interface UtxoPrivateKey {
  toBuffer(): Uint8Array
  toPublicKey(): { toBuffer(): Uint8Array }
  readonly compressed?: boolean
}

export interface Utxo {
  address: string
  privKey: UtxoPrivateKey // This is okay, we don't add it to the wallet.
  satoshis: number
  txId: string
  outputIndex: number
  type: string
  frozen?: boolean
}

export type UtxoId = string

/** Compressed outpoint key. `new PrivateKey(hex)` defaults compressed.
 * The caller buffer is not wiped. No address string. */
export function utxoPrivateKeyFromSecret(secret: Uint8Array): UtxoPrivateKey {
  const secretBytes = new Uint8Array(secret)
  let parsedBytes: Uint8Array | undefined
  try {
    const parsed = privateKeyFromSecretBytes(secretBytes, true)
    if (!parsed.ok) throw new Error(`utxo-privkey:${parsed.error.code}`)
    const keyBytes = parsed.value.bytes
    parsedBytes = keyBytes
    const derived = publicFromPrivate(parsed.value)
    if (!derived.ok) throw new Error(`utxo-privkey:${derived.error.code}`)
    const stored = new Uint8Array(keyBytes)
    const publicBytes = new Uint8Array(derived.value.compressed)
    const publicKey = Object.freeze({
      toBuffer(): Uint8Array {
        return new Uint8Array(publicBytes)
      },
    })
    return Object.freeze({
      compressed: true,
      toBuffer(): Uint8Array {
        return new Uint8Array(stored)
      },
      toPublicKey() {
        return publicKey
      },
    })
  } finally {
    secretBytes.fill(0)
    if (parsedBytes !== undefined) parsedBytes.fill(0)
  }
}
