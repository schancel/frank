// Registry burn output passed to constructTransaction (decision #596).
// Upvote is vote > 0. Satoshis are the absolute value. Zero is a downvote.
// paymentOutput copies the pondBurnScript bytes. No address string.
import { paymentOutput } from '../pop'
import { pondBurnScript } from './burn-script'

export function registryBurnOutput(hash: Uint8Array, vote: number): {
  script: Buffer
  satoshis: number
} {
  const upvote = vote > 0
  const satoshis = vote < 0 ? -vote : vote
  return paymentOutput(pondBurnScript(hash, upvote), satoshis)
}
