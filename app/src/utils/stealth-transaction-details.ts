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
