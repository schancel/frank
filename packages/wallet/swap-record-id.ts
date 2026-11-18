/**
 * The id of a swap record, shared by every chain family that records swaps (EVM and Solana
 * are peers here; neither owns it).
 */
import { keccak_256 } from '@noble/hashes/sha3'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils'

/**
 * The id every frontend of the account derives for a swap: from its chain and the transaction
 * id, hashed exactly as given (keccak-256, lower-case hex without `0x`). A Solana signature is
 * case-sensitive; a caller with an EVM hash passes it in lower case.
 */
export function swapRecordId(
  chainIdentifier: string,
  transactionId: string,
): string {
  return bytesToHex(
    keccak_256(utf8ToBytes(`frank-swap:${chainIdentifier}:${transactionId}`)),
  )
}
