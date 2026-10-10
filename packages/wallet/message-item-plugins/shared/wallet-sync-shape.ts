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
  cborItemCodec,
  list,
  num,
  oneOf,
  opt,
  req,
  struct,
  text,
  type ItemCodec,
  type Spec,
} from './cbor-fields'

type Shaped<T extends WalletSyncItem['type']> = WalletSyncItem & { type: T }

const spentInput = struct<WalletSyncSpentInput>({
  address: req(0, text),
  nonce: opt(1, num),
  outpoint: opt(2, text),
  valueWei: opt(3, text),
})

const createdOutput = struct<WalletSyncCreatedOutput>({
  address: req(0, text),
  valueWei: opt(1, text),
  branch: opt(2, oneOf('spend', 'change', 'staging')),
  index: opt(3, num),
  outpoint: opt(4, text),
})

const transfer = struct<NonNullable<WalletSyncItem['transfer']>>({
  networkTag: req(0, text),
  txId: req(1, text),
  vout: opt(2, num),
  destination: req(3, text),
  value: req(4, text),
  token: opt(5, text),
  rawTx: opt(6, text),
})

const shape: Spec<Omit<WalletSyncItem, 'type'>> = {
  direction: req(0, oneOf('in', 'out')),
  chainIdentifier: req(1, text),
  chainId: opt(2, text),
  txHash: req(3, text),
  rawTx: opt(4, text),
  spentInputs: opt(5, list(spentInput)),
  createdOutputs: opt(6, list(createdOutput)),
  transfer: opt(7, transfer),
  memo: opt(8, text),
  timestamp: opt(9, num),
}

export function walletSyncShapeCodec<T extends WalletSyncItem['type']>(
  type: T,
): ItemCodec<Shaped<T>> {
  return cborItemCodec<WalletSyncItem>(type, shape) as ItemCodec<Shaped<T>>
}

/** What an incoming item adds to a message's sort/badge value: the sum of its created outputs. */
export function walletSyncIncomingValue(raw: WalletSyncItem): number {
  if (raw.createdOutputs && raw.direction === 'in') {
    return raw.createdOutputs.reduce(
      (acc, out) => acc + Number(out.valueWei || 0),
      0,
    )
  }
  return 0
}

/** `<label>: Sent|Received tx 0x12345678... on <chain>` */
export function walletSyncPreview(label: string, raw: WalletSyncItem): string {
  return `${label}: ${
    raw.direction === 'out' ? 'Sent' : 'Received'
  } tx ${raw.txHash.slice(0, 10)}... on ${raw.chainIdentifier ?? raw.chainId}`
}
