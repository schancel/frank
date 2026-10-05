/** Helpers shared by the experiments: a real EVM (type-2) transaction, its signing digest, and
 * turning a compact (r || s) signature into a signed, broadcastable transaction. */
import { secp256k1 } from '@noble/curves/secp256k1.js'
import {
  computeAddress,
  getBytes,
  hexlify,
  Signature,
  SigningKey,
  Transaction,
} from 'ethers'

/** Monad testnet. The chain id is inside the signing digest (EIP-155 / EIP-1559). */
export const CHAIN_ID = 10143n

export function transferTx(params: {
  to: string
  valueWei: bigint
  nonce: number
  maxFeePerGas?: bigint
}): Transaction {
  return Transaction.from({
    type: 2,
    chainId: CHAIN_ID,
    nonce: params.nonce,
    to: params.to,
    value: params.valueWei,
    gasLimit: 21000n,
    maxFeePerGas: params.maxFeePerGas ?? 100n * 10n ** 9n,
    maxPriorityFeePerGas: 2n * 10n ** 9n,
  })
}

export const digestOf = (tx: Transaction): Uint8Array =>
  getBytes(tx.unsignedHash)

/** The EVM address of a compressed secp256k1 public key. */
export function addressOf(publicKey33: Uint8Array): string {
  const point = secp256k1.ProjectivePoint.fromHex(publicKey33)
  return computeAddress(hexlify(point.toRawBytes(false)))
}

/** Attach a compact signature to the transaction: find the recovery bit that recovers
 * `publicKey33`, and return the raw signed transaction. Throws if neither bit does. */
export function signedRawTx(
  tx: Transaction,
  compact: Uint8Array,
  publicKey33: Uint8Array,
): string {
  const expected = SigningKey.computePublicKey(hexlify(publicKey33), true)
  const r = hexlify(compact.slice(0, 32))
  const s = hexlify(compact.slice(32))
  for (const yParity of [0, 1] as const) {
    const signature = Signature.from({ r, s, yParity })
    const recovered = SigningKey.computePublicKey(
      SigningKey.recoverPublicKey(tx.unsignedHash, signature),
      true,
    )
    if (recovered === expected) {
      const signed = tx.clone()
      signed.signature = signature
      return signed.serialized
    }
  }
  throw new Error('signature does not recover to the expected key')
}

/** The compact (r || s) signature carried by a raw signed transaction, as read from chain. */
export function compactOf(rawTx: string): Uint8Array {
  const signature = Transaction.from(rawTx).signature
  if (!signature) throw new Error('unsigned transaction')
  return getBytes(signature.r + signature.s.slice(2))
}
