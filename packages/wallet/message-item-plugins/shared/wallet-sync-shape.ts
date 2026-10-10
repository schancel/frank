/**
 * `wallet-sync` and `payment-transfer` are two item types declared with one shape
 * (`WalletSyncItem`). Each has its own plugin directory; this is the schema and the value rule
 * they share.
 */
import type {
  WalletSyncCreatedOutput,
  WalletSyncItem,
  WalletSyncSpentInput,
} from '@frank/cashweb/types/messages'

import {
  amount,
  cborItemCodec,
  chainAddress,
  chainIdentifier,
  hex,
  int,
  listOf,
  oneOf,
  opt,
  req,
  str,
  struct,
  timestampMs,
  token,
  transactionId,
  type ItemCodec,
  type Spec,
} from './cbor-fields'
import { nonce, outputIndex } from './limits'

type Shaped<T extends WalletSyncItem['type']> = WalletSyncItem & { type: T }

/** A complete signed transaction as hex: at most 16 KiB, as a payment member carries. */
const rawTransaction = hex(1, 16_384)
/** A UTXO outpoint, `<transaction id>:<output index>`. */
const outpoint = token(140)
/** Inputs or outputs of one transaction. */
const MAX_TRANSACTION_ENTRIES = 256

const spentInput = struct<WalletSyncSpentInput>({
  address: req(0, chainAddress),
  nonce: opt(1, nonce),
  outpoint: opt(2, outpoint),
  valueWei: opt(3, amount),
})

const createdOutput = struct<WalletSyncCreatedOutput>({
  address: req(0, chainAddress),
  valueWei: opt(1, amount),
  branch: opt(2, oneOf('spend', 'change', 'staging')),
  // A derivation index: below 2^31.
  index: opt(3, int(0, 2_147_483_647)),
  outpoint: opt(4, outpoint),
})

const transfer = struct<NonNullable<WalletSyncItem['transfer']>>({
  networkTag: req(0, token(64)),
  txId: req(1, transactionId),
  vout: opt(2, outputIndex),
  destination: req(3, chainAddress),
  value: req(4, amount),
  token: opt(5, token(128)),
  rawTx: opt(6, rawTransaction),
})

const shape: Spec<Omit<WalletSyncItem, 'type'>> = {
  direction: req(0, oneOf('in', 'out')),
  // Exactly a canonical identifier from the protocol registry; no alias, no family name.
  chainIdentifier: req(1, chainIdentifier),
  chainId: opt(2, token(64)),
  txHash: req(3, transactionId),
  rawTx: opt(4, rawTransaction),
  spentInputs: opt(5, listOf(spentInput, MAX_TRANSACTION_ENTRIES)),
  createdOutputs: opt(6, listOf(createdOutput, MAX_TRANSACTION_ENTRIES)),
  transfer: opt(7, transfer),
  memo: opt(8, str(1024)),
  timestamp: opt(9, timestampMs),
}

export function walletSyncShapeCodec<T extends WalletSyncItem['type']>(
  type: T,
): ItemCodec<Shaped<T>> {
  return cborItemCodec<WalletSyncItem>(type, shape) as ItemCodec<Shaped<T>>
}

/** What an incoming item adds to a message's sort/badge value: the sum of its created outputs. */
/** What an incoming item adds to a message's sort/badge value: the sum of its created outputs.
 * Never NaN: an amount that is not a plain number adds nothing. */
export function walletSyncIncomingValue(raw: WalletSyncItem): number {
  if (raw.createdOutputs && raw.direction === 'in') {
    return raw.createdOutputs.reduce((acc, out) => {
      const value = Number(out.valueWei || 0)
      return acc + (Number.isFinite(value) ? value : 0)
    }, 0)
  }
  return 0
}

/** `<label>: Sent|Received tx 0x12345678... on <chain>` */
export function walletSyncPreview(label: string, raw: WalletSyncItem): string {
  return `${label}: ${
    raw.direction === 'out' ? 'Sent' : 'Received'
  } tx ${raw.txHash.slice(0, 10)}... on ${raw.chainIdentifier ?? raw.chainId}`
}
