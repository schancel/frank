import { Transaction } from 'ethers'
import type { ContactPaymentInfo } from '@frank/wallet/chain'

export interface StealthTransactionGroup {
  ephemeralPubKey?: string
  chainIdentifier?: string
  unit?: string
  state: string
  transactions: {
    txHash: string
    destinationAddress?: string
    valueWei?: bigint
    invalid?: boolean
    state?: string
  }[]
}

/** Decode every carried EVM transaction; bare hashes remain links with unknown value. */
export function stealthTransactionDetails(transactions: readonly string[]) {
  return transactions.map(raw => {
    const hex = raw.replace(/^0x/, '')
    if (/^[0-9a-f]{64}$/i.test(hex)) return { txHash: `0x${hex}` }
    try {
      const tx = Transaction.from(`0x${hex}`)
      return {
        txHash: tx.hash ?? '',
        destinationAddress: tx.to ?? undefined,
        valueWei: tx.value,
      }
    } catch {
      return { txHash: '', invalid: true }
    }
  })
}

/** A journal entry describes this exact signed transfer, not just another payment to the peer. */
export function contactPaymentState(
  payments: readonly ContactPaymentInfo[],
  ephemeralPubKey: string,
  hashes: readonly string[],
) {
  const key = ephemeralPubKey.replace(/^0x/, '').toLowerCase()
  if (!hashes.length || hashes.some(hash => !hash)) return 'unknown'
  const states = hashes.map(
    hash =>
      payments.find(
        payment =>
          payment.ephemeralPubKey.replace(/^0x/, '').toLowerCase() === key &&
          payment.txHash?.toLowerCase() === hash.toLowerCase(),
      )?.state ?? 'unknown',
  )
  return (
    ['failed', 'released', 'unknown', 'planned', 'prepared', 'delivered'].find(
      state => states.includes(state as (typeof states)[number]),
    ) ?? 'paid'
  )
}

/** How a received `stealth-asset` item is shown with the stealth payment card: one native
 * payment to one one-time account (what the app's stealth send writes). The amount is the sum
 * of the transfers the sender wrote; the card's status and received amount come from the
 * wallet's coin for that account, never from the item. Anything else (several accounts, a
 * token) is left to the item's plain preview. */
export function stealthAssetCard(item: {
  transfers: readonly {
    chainIdentifier: string
    asset: { kind: string }
    amountAtomic: string
    rawTx?: string
    txId: string
    stealthMetadata: { ephemeralPubKey: string }
  }[]
  memo?: string
}):
  | {
      networkTag: string
      ephemeralPubKey: string
      /** The card's approximate figure; `amountWei` is exact. */
      amount: number
      amountWei: string
      transactions: string[]
      memo?: string
    }
  | undefined {
  const first = item.transfers[0]
  if (
    first === undefined ||
    item.transfers.some(
      transfer =>
        transfer.asset.kind !== 'native' ||
        transfer.chainIdentifier !== first.chainIdentifier ||
        transfer.stealthMetadata.ephemeralPubKey !==
          first.stealthMetadata.ephemeralPubKey ||
        !/^[1-9][0-9]*$/.test(transfer.amountAtomic),
    )
  )
    return undefined
  const amountWei = item.transfers.reduce(
    (sum, transfer) => sum + BigInt(transfer.amountAtomic),
    0n,
  )
  return {
    // The card resolves the unit and chain from the canonical identifier.
    networkTag: first.chainIdentifier,
    ephemeralPubKey: first.stealthMetadata.ephemeralPubKey,
    amount: Number(amountWei),
    amountWei: amountWei.toString(),
    transactions: item.transfers.map(
      transfer => transfer.rawTx ?? transfer.txId,
    ),
    ...(item.memo === undefined ? {} : { memo: item.memo }),
  }
}
