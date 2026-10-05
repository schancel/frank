/**
 * EVM transaction helpers for Monad testnet blackjack escrow settlement.
 * Construct EIP-1559 transactions, compute unsigned digests for threshold signing,
 * and attach threshold signatures into broadcastable raw transactions.
 */
import {
  computeAddress,
  getBytes,
  hexlify,
  Signature,
  SigningKey,
  Transaction,
} from 'ethers'

/** Monad testnet. The chain ID is inside the EIP-1559 signing digest. */
export const MONAD_TESTNET_CHAIN_ID = 10143n

export interface TransferTxParams {
  to: string
  valueWei: bigint
  nonce?: number
  chainId?: bigint
  gasLimit?: bigint
  maxFeePerGas?: bigint
  maxPriorityFeePerGas?: bigint
}

export function transferTx(params: TransferTxParams): Transaction {
  return Transaction.from({
    type: 2,
    chainId: params.chainId ?? MONAD_TESTNET_CHAIN_ID,
    nonce: params.nonce ?? 0,
    to: params.to,
    value: params.valueWei,
    gasLimit: params.gasLimit ?? 21000n,
    maxFeePerGas: params.maxFeePerGas ?? 100n * 10n ** 9n,
    maxPriorityFeePerGas: params.maxPriorityFeePerGas ?? 2n * 10n ** 9n,
  })
}

export const digestOf = (tx: Transaction): Uint8Array =>
  getBytes(tx.unsignedHash)

export function addressOf(publicKey33: Uint8Array): string {
  const pubHex = hexlify(publicKey33)
  return computeAddress(pubHex)
}

export function signedRawTx(
  tx: Transaction,
  signature64: Uint8Array,
  recovery: 0 | 1,
): string {
  const r = hexlify(signature64.slice(0, 32))
  const s = hexlify(signature64.slice(32, 64))
  const sig = Signature.from({ r, s, yParity: recovery })
  const signed = tx.clone()
  signed.signature = sig
  return signed.serialized
}

export function verifySignedTxSender(rawTx: string, expectedAddress: string): boolean {
  const tx = Transaction.from(rawTx)
  return tx.from !== null && tx.from.toLowerCase() === expectedAddress.toLowerCase()
}
