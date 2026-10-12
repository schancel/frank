import type { RecipientAssetPaymentItem } from '@frank/cashweb/types/messages'
import type { NativeWalletHandle } from '@frank/wallet/chain'
import { getChainRegistryEntry } from '@frank/wallet/chain/chains-registry'
import type {
  StealthPaymentAsset,
  StealthPaymentReceiptClaim,
} from '@frank/wallet/stealth-payment'

export interface RecipientPaymentContext {
  readonly payloadDigest: string
  /** Captured published identity, not the receiving family's HD wallet public key. */
  readonly spendPublicKey: Uint8Array
  assertCurrent(): void
  openWallet(
    chainIdentifier: string,
  ): Promise<Pick<NativeWalletHandle, 'chainIdentifier' | 'stealthReceipts'>>
}

export type RecipientPaymentApplication =
  | { readonly index: number; readonly status: 'recorded' }
  | { readonly index: number; readonly status: 'unsupported' }

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join(
    '',
  )
}

function bytes(value: string): Uint8Array {
  if (!/^(?:[a-f0-9]{2})+$/i.test(value))
    throw new Error('Invalid recipient payment key')
  return Uint8Array.from(value.match(/../g)!, part => parseInt(part, 16))
}

/** Consumes an already validated application item. Family owners verify signed claims and
 * discover balances; this function neither credits money nor dispatches outgoing wallet sync.
 * A failure rejects the receive so its mailbox frontier remains retryable. Earlier successful
 * entries are replayed through their owners' idempotent receipt operations.
 */
export async function recordRecipientAssetPayment(
  item: RecipientAssetPaymentItem,
  context: RecipientPaymentContext,
): Promise<readonly RecipientPaymentApplication[]> {
  const result: RecipientPaymentApplication[] = []
  for (const [index, transfer] of item.transfers.entries()) {
    context.assertCurrent()
    // Unknown schemes are honest opaque claims, even when their keys resemble supported ones.
    if (
      transfer.derivationScheme !== 1 ||
      transfer.recipientSpendKey.keyType !== 1 ||
      transfer.stealthMetadata.keyType !== 1
    ) {
      result.push({ index, status: 'unsupported' })
      continue
    }
    const entry = getChainRegistryEntry(transfer.chainIdentifier)
    if (!entry) throw new Error('Unknown recipient payment chain')
    if (
      entry.family !== 'evm' &&
      !(entry.family === 'bitcoin' && transfer.asset.kind === 'native')
    ) {
      result.push({ index, status: 'unsupported' })
      continue
    }
    if (
      transfer.recipientSpendKey.publicKey.toLowerCase() !==
      hex(context.spendPublicKey)
    )
      throw new Error('Recipient payment identity differs from this account')
    if (!transfer.rawTx)
      throw new Error('Recipient payment has no signed transaction evidence')
    const amountAtomic = BigInt(transfer.amountAtomic)
    if (amountAtomic <= 0n)
      throw new Error('Recipient payment amount must be positive')
    const asset: StealthPaymentAsset =
      transfer.asset.kind === 'native'
        ? { kind: 'native' }
        : { kind: 'erc20', contractAddress: transfer.asset.identifier }
    const claim: StealthPaymentReceiptClaim = {
      chainIdentifier: transfer.chainIdentifier,
      asset,
      recipientAddress: transfer.destination,
      ephemeralPublicKey: bytes(transfer.stealthMetadata.ephemeralPubKey),
      amountAtomic,
      rawTransactions: [transfer.rawTx],
      payloadDigest: context.payloadDigest,
    }
    const wallet = await context.openWallet(transfer.chainIdentifier)
    context.assertCurrent()
    if (wallet.chainIdentifier !== transfer.chainIdentifier)
      throw new Error('Recipient payment wallet has a different chain')
    if (!wallet.stealthReceipts)
      throw new Error('Recipient payment owner is unavailable')
    await wallet.stealthReceipts.record(claim)
    context.assertCurrent()
    result.push({ index, status: 'recorded' })
  }
  return result
}
