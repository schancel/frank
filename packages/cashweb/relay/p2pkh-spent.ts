// Spent inputs of a P2PKH entry transaction (decision #524).
// The wire prevout hash is the internal txid. Display order is its
// reverse: bitcoinsuite Sha256d::to_hex_be and bitcore readReverse.
// A rejected buffer throws p2pkh-tx and the caller deletes nothing.

import {
  XPI_MAINNET,
  displayTxidFromInternal,
  parseTransaction,
} from '@frank/nakamoto'

export function p2pkhSpentOutpoints(
  raw: Uint8Array,
): { txId: string; outputIndex: number }[] {
  const parsed = parseTransaction(Uint8Array.from(raw), XPI_MAINNET)
  if (!parsed.ok) throw new Error('p2pkh-tx')
  return parsed.value.inputs.map(input => {
    const display = displayTxidFromInternal(input.prevout.txid)
    let txId = ''
    for (const byte of display) {
      txId += byte.toString(16).padStart(2, '0')
    }
    return { txId, outputIndex: input.prevout.vout }
  })
}
