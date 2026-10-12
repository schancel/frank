import type { RecipientAssetPaymentItem } from '@frank/cashweb/types/messages'
import { getChainRegistryEntry } from '@frank/wallet/chain/chains-registry'
import type {
  StealthPaymentAsset,
  StealthPaymentReceiptCapability,
  StealthPaymentReceiptClaim,
  StealthPaymentReceiptObservation,
} from '@frank/wallet/stealth-payment'
import { groupRecipientAssetPayment } from './receive'
import {
  formatStealthAmount,
  sameStealthAsset,
  type StealthAssetOption,
} from './options'

/** Cache-only host seam. Looking up an owner must never open custody or start recovery. */
export interface RecipientAssetObservationContext {
  readonly payloadDigest: string
  readonly spendPublicKey: Uint8Array
  assertCurrent(): void
  receipts(
    chainIdentifier: string,
  ): Pick<StealthPaymentReceiptCapability, 'observe'> | undefined
}
export type RecipientAssetRowStatus =
  | 'pending'
  | 'partial'
  | 'received'
  | 'failed'
  | 'needs-native-gas'
  | 'unavailable'
  | 'unsupported'
  | 'outgoing'
export interface RecipientAssetRow {
  readonly key: string
  readonly indices: readonly number[]
  readonly chainIdentifier: string
  readonly chainName: string
  readonly unit: string
  readonly decimals?: number
  readonly intendedAmountAtomic: bigint
  readonly intendedAmount: string
  readonly status: RecipientAssetRowStatus
  readonly verifiedAmount?: string
  readonly spendability?: StealthPaymentReceiptObservation['spendability']
  readonly claim?: StealthPaymentReceiptClaim
  readonly transactions: readonly {
    readonly txId: string
    readonly url?: string
  }[]
}

function metadata(
  chainIdentifier: string,
  asset: StealthPaymentAsset,
  options: readonly StealthAssetOption[],
) {
  const entry = getChainRegistryEntry(chainIdentifier)
  const configured = options.find(
    option =>
      option.chainIdentifier === chainIdentifier &&
      sameStealthAsset(option.asset, asset),
  )
  if (configured)
    return { unit: configured.unit, decimals: configured.decimals }
  if (asset.kind === 'erc20' && entry?.family === 'evm') {
    for (const dex of entry.dex ?? []) {
      if (dex.adapter !== 'uniswap-v4') continue
      const token = dex.tokens.find(
        token =>
          'address' in token &&
          typeof token.address === 'string' &&
          token.address.toLowerCase() === asset.contractAddress.toLowerCase(),
      )
      if (token) return { unit: token.symbol, decimals: token.decimals }
    }
  }
  return {
    unit:
      asset.kind === 'native' ? entry?.unit ?? 'native' : asset.contractAddress,
    decimals: undefined,
  }
}
function amount(value: bigint, decimals?: number): string {
  return decimals === undefined
    ? value.toString()
    : formatStealthAmount(value, decimals)
}

/** Uses the receipt owner's exact grouping. Each derived account/asset remains its own row. */
export function recipientAssetRows(
  item: RecipientAssetPaymentItem,
  options: readonly StealthAssetOption[],
  context?: Pick<
    RecipientAssetObservationContext,
    'payloadDigest' | 'spendPublicKey'
  >,
  outbound = false,
  transactionUrl?: (
    chainIdentifier: string,
    txId: string,
  ) => string | undefined,
): readonly RecipientAssetRow[] {
  const grouped = groupRecipientAssetPayment(item, {
    payloadDigest: context?.payloadDigest ?? '',
    spendPublicKey: outbound ? undefined : context?.spendPublicKey,
  })
  const row = (
    indices: readonly number[],
    intended: bigint,
    claim?: StealthPaymentReceiptClaim,
  ): RecipientAssetRow => {
    const first = item.transfers[indices[0]!]!
    const asset: StealthPaymentAsset =
      first.asset.kind === 'native'
        ? { kind: 'native' }
        : { kind: 'erc20', contractAddress: `0x${first.asset.identifier}` }
    const entry = getChainRegistryEntry(first.chainIdentifier)
    const meta = metadata(first.chainIdentifier, asset, options)
    const txIds = [
      ...new Set(indices.map(index => item.transfers[index]!.txId)),
    ]
    return {
      key: indices.join(','),
      indices,
      chainIdentifier: first.chainIdentifier,
      chainName: entry?.name ?? first.chainIdentifier,
      ...meta,
      intendedAmountAtomic: intended,
      intendedAmount: amount(intended, meta.decimals),
      status: !claim ? 'unsupported' : outbound ? 'outgoing' : 'pending',
      claim,
      transactions: txIds.map(txId => ({
        txId,
        url:
          transactionUrl?.(first.chainIdentifier, txId) ??
          (entry?.explorerUrl && /^https?:\/\//.test(entry.explorerUrl)
            ? `${entry.explorerUrl.replace(/\/$/, '')}/tx/${encodeURIComponent(
                txId,
              )}`
            : undefined),
      })),
    }
  }
  return [
    ...grouped.groups.map(group =>
      row(group.indices, group.claim.amountAtomic, group.claim),
    ),
    ...grouped.unsupported.map(index =>
      row([index], BigInt(item.transfers[index]!.amountAtomic)),
    ),
  ].sort((left, right) => left.indices[0]! - right.indices[0]!)
}

/** Observation only: no record, get/open-wallet, reconcile, submit, or broadcast capability. */
export async function observeRecipientAssetRow(
  row: RecipientAssetRow,
  context?: RecipientAssetObservationContext,
): Promise<RecipientAssetRow> {
  if (!row.claim || row.status === 'outgoing') return row
  if (!context)
    return {
      ...row,
      status: 'unavailable',
      verifiedAmount: undefined,
      spendability: undefined,
    }
  try {
    context.assertCurrent()
    if (context.payloadDigest !== row.claim.payloadDigest)
      throw new Error('Receipt observation has a different payload origin')
    const owner = context.receipts(row.chainIdentifier)
    if (!owner)
      return {
        ...row,
        status: 'unavailable',
        verifiedAmount: undefined,
        spendability: undefined,
      }
    const observation = await owner.observe(row.claim)
    context.assertCurrent()
    if (observation.intendedAmountAtomic !== row.intendedAmountAtomic)
      throw new Error('Receipt observation has a different intended amount')
    const verified = observation.verifiedReceivedAmountAtomic
    if (
      verified !== undefined &&
      (verified < 0n || verified > row.intendedAmountAtomic)
    )
      throw new Error('Invalid verified recipient amount')
    const status: RecipientAssetRowStatus =
      observation.status === 'failed'
        ? 'failed'
        : observation.spendability === 'needs-native-gas' &&
          verified !== undefined &&
          verified > 0n
        ? 'needs-native-gas'
        : observation.status === 'succeeded' &&
          verified === row.intendedAmountAtomic
        ? 'received'
        : observation.status === 'partial' &&
          verified !== undefined &&
          verified > 0n
        ? 'partial'
        : 'pending'
    return {
      ...row,
      status,
      verifiedAmount:
        verified === undefined ? undefined : amount(verified, row.decimals),
      spendability: observation.spendability,
    }
  } catch {
    // Unavailable evidence is not zero or proof of financial failure. Drop any older observation.
    return {
      ...row,
      status: 'unavailable',
      verifiedAmount: undefined,
      spendability: undefined,
    }
  }
}
