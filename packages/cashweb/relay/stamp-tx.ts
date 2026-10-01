// Stamp outpoint transaction bytes (decision #527).
// The UTXO id is the display form of the XPI segmented id
// (lotusd ComputeTxId, bitcore Transaction#_getTxid). Spent prevouts
// use that same reversal. A rejected buffer throws stamp-tx before
// the caller deletes a UTXO. Address strings stay on bitcore Script.

import {
  XPI_MAINNET,
  displayTxidFromInternal,
  parseTransaction,
  transactionId,
} from '@frank/nakamoto'

const MAX_SAFE_SATOSHIS = BigInt(Number.MAX_SAFE_INTEGER)

function displayHex(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0')
  }
  return hex
}

export interface StampOutput {
  readonly satoshis: number
  readonly script: Uint8Array
}

export interface StampTransaction {
  readonly txId: string
  readonly inputs: readonly { txId: string; outputIndex: number }[]
  readonly outputs: readonly StampOutput[]
}

/** Display txid, spent prevouts, and output amounts. Throws stamp-tx or stamp-value. */
export function readStampTransaction(raw: Uint8Array): StampTransaction {
  const parsed = parseTransaction(Uint8Array.from(raw), XPI_MAINNET)
  if (!parsed.ok) throw new Error('stamp-tx')
  const id = transactionId(parsed.value, XPI_MAINNET)
  if (!id.ok) throw new Error('stamp-tx')
  const outputs: StampOutput[] = []
  for (const output of parsed.value.outputs) {
    if (output.value > MAX_SAFE_SATOSHIS) throw new Error('stamp-value')
    outputs.push({
      satoshis: Number(output.value),
      script: output.scriptPubKey,
    })
  }
  return {
    txId: displayHex(displayTxidFromInternal(id.value)),
    inputs: parsed.value.inputs.map(input => ({
      txId: displayHex(displayTxidFromInternal(input.prevout.txid)),
      outputIndex: input.prevout.vout,
    })),
    outputs,
  }
}
