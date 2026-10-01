// Legacy registry burn script (decision #519) and the signed output amount
// read from those bytes (decision #521). Not cashweb-payload
// build_commitment_script: that version is always OP_1 and the commitment
// is SHA256(SHA256(pubkey) || payload hash). Opcode bytes are
// bitcoinsuite-core opcode.rs. A push shorter than 0x4c is one length
// byte then the data (Script::opreturn in script.rs).

import { XPI_MAINNET, parseTransaction } from '@frank/nakamoto'

const OP_RETURN = 0x6a
const OP_0 = 0x00
const OP_1 = 0x51
const POND = Uint8Array.of(0x50, 0x4f, 0x4e, 0x44)
const MAX_SAFE_SATOSHIS = BigInt(Number.MAX_SAFE_INTEGER)

/** 32-byte hash. Upvote is OP_1. A zero vote is OP_0. Other lengths throw. */
export function pondBurnScript(hash: Uint8Array, upvote: boolean): Uint8Array {
  const commitment = Uint8Array.from(hash)
  if (commitment.length !== 32) throw new Error('burn-hash')
  const script = new Uint8Array(8 + commitment.length)
  script[0] = OP_RETURN
  script[1] = POND.length
  script.set(POND, 2)
  script[6] = upvote ? OP_1 : OP_0
  script[7] = commitment.length
  script.set(commitment, 8)
  return script
}

/** Byte 6 is OP_0. A shorter script is not a downvote. */
export function pondBurnIsDownvote(script: Uint8Array): boolean {
  return script[6] === OP_0
}

/**
 * Signed satoshis of output `index`. A downvote is negative, including a
 * zero value. A value above 2^53-1 throws `burn-value`. A rejected
 * transaction throws `burn-tx`. A missing output throws `burn-output`.
 * Nothing is added in those cases (decision #521).
 */
export function pondBurnOutputSatoshis(tx: Uint8Array, index: number): number {
  const parsed = parseTransaction(Uint8Array.from(tx), XPI_MAINNET)
  if (!parsed.ok) throw new Error('burn-tx')
  if (!Number.isInteger(index) || index < 0) throw new Error('burn-output')
  const output = parsed.value.outputs[index]
  if (output === undefined) throw new Error('burn-output')
  if (output.value > MAX_SAFE_SATOSHIS) throw new Error('burn-value')
  const satoshis = Number(output.value)
  return pondBurnIsDownvote(output.scriptPubKey) ? -satoshis : satoshis
}
