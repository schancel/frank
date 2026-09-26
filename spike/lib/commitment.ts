// THROWAWAY spike helper.
//
// Commitment hash domain (documented per spike instructions — exact domain
// separation doesn't matter here, just consistency between sender & receiver):
//
//   h_m = keccak256( utf8(message) || senderPubKeyCompressed(33 bytes) || timestampBE(8 bytes, unix seconds) )
//
// We hash the PLAINTEXT message (not the ciphertext). This is a spike
// decision: it lets the verifier prove "the sender committed to burning MON
// for exactly this message" once they've decrypted it out-of-band, which is
// the more interesting property to demo. (A ciphertext-based commitment would
// only prove "committed to this blob"; either is fine per the ticket.)
import { keccak256 } from 'ethers'

export function computeCommitment(
  message: string,
  senderPubKeyCompressed: Uint8Array,
  timestampSeconds: number,
): string {
  const msgBytes = Buffer.from(message, 'utf8')
  const pubBytes = Buffer.from(senderPubKeyCompressed)
  const tsBuf = Buffer.alloc(8)
  tsBuf.writeBigUInt64BE(BigInt(timestampSeconds))

  const preimage = Buffer.concat([msgBytes, pubBytes, tsBuf])
  return keccak256(preimage) // 0x-prefixed 32-byte hash, used directly as tx calldata
}
