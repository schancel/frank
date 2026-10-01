// Legacy registry burn script (decision #519). Not cashweb-payload
// build_commitment_script: that version is always OP_1 and the commitment
// is SHA256(SHA256(pubkey) || payload hash). Opcode bytes are
// bitcoinsuite-core opcode.rs. A push shorter than 0x4c is one length
// byte then the data (Script::opreturn in script.rs).

const OP_RETURN = 0x6a
const OP_0 = 0x00
const OP_1 = 0x51
const POND = Uint8Array.of(0x50, 0x4f, 0x4e, 0x44)

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
