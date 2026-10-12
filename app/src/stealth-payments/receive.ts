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

export interface GroupedRecipientAssetPayment {
  readonly indices: readonly number[]
  readonly claim: StealthPaymentReceiptClaim
}

/** Pure claim grouping shared by receipt application and read-only presentation. Unknown
 * schemes remain opaque; only a receiving account supplies spendPublicKey for affinity checks. */
export function groupRecipientAssetPayment(
  item: RecipientAssetPaymentItem,
  context: {
    readonly payloadDigest: string
    readonly spendPublicKey?: Uint8Array
  },
): {
  readonly groups: readonly GroupedRecipientAssetPayment[]
  readonly unsupported: readonly number[]
} {
  const unsupported: number[] = []
  const groups = new Map<
    string,
    {
      indices: number[]
      claim: StealthPaymentReceiptClaim
      members: Set<string>
      transactions: Map<string, string>
    }
  >()
  for (const [index, transfer] of item.transfers.entries()) {
    // Unknown schemes are honest opaque claims, even when their keys resemble supported ones.
    if (
      transfer.derivationScheme !== 1 ||
      transfer.recipientSpendKey.keyType !== 1 ||
      transfer.stealthMetadata.keyType !== 1
    ) {
      unsupported.push(index)
      continue
    }
    const entry = getChainRegistryEntry(transfer.chainIdentifier)
    if (!entry) throw new Error('Unknown recipient payment chain')
    if (
      entry.family !== 'evm' &&
      !(entry.family === 'bitcoin' && transfer.asset.kind === 'native')
    ) {
      unsupported.push(index)
      continue
    }
    if (
      context.spendPublicKey !== undefined &&
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
        : { kind: 'erc20', contractAddress: `0x${transfer.asset.identifier}` }
    // One claim owns the complete signed set for one asset and derived account. Different
    // accounts or assets in the same message remain independent claims under the same origin.
    const groupKey = JSON.stringify([
      transfer.chainIdentifier,
      transfer.asset.kind,
      transfer.asset.kind === 'native'
        ? ''
        : transfer.asset.identifier.toLowerCase(),
      transfer.destination.toLowerCase(),
      transfer.stealthMetadata.ephemeralPubKey.toLowerCase(),
    ])
    const memberKey = `${transfer.txId.toLowerCase()}:${transfer.vout ?? ''}`
    let group = groups.get(groupKey)
    if (!group) {
      group = {
        indices: [],
        claim: {
          chainIdentifier: transfer.chainIdentifier,
          asset,
          recipientDestination: bytes(transfer.destination),
          ephemeralPublicKey: bytes(transfer.stealthMetadata.ephemeralPubKey),
          amountAtomic: 0n,
          rawTransactions: [],
          payloadDigest: context.payloadDigest,
        },
        members: new Set(),
        transactions: new Map(),
      }
      groups.set(groupKey, group)
    }
    if (group.members.has(memberKey))
      throw new Error('Duplicate recipient payment member')
    const oldRaw = group.transactions.get(transfer.txId.toLowerCase())
    if (oldRaw !== undefined && oldRaw !== transfer.rawTx)
      throw new Error('Conflicting recipient signed transaction evidence')
    const total = group.claim.amountAtomic + amountAtomic
    if (total >= 1n << 256n)
      throw new Error('Recipient payment total exceeds the quantity limit')
    group.indices.push(index)
    group.members.add(memberKey)
    group.transactions.set(transfer.txId.toLowerCase(), transfer.rawTx)
    group.claim = { ...group.claim, amountAtomic: total }
  }
  return {
    unsupported,
    groups: [...groups.values()].map(group => ({
      indices: group.indices,
      claim: {
        ...group.claim,
        rawTransactions: [...group.transactions.values()],
      },
    })),
  }
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
  context.assertCurrent()
  const grouped = groupRecipientAssetPayment(item, context)
  const result: RecipientPaymentApplication[] = grouped.unsupported.map(
    index => ({ index, status: 'unsupported' }),
  )
  for (const group of grouped.groups) {
    context.assertCurrent()
    const claim = group.claim
    const wallet = await context.openWallet(claim.chainIdentifier)
    context.assertCurrent()
    if (wallet.chainIdentifier !== claim.chainIdentifier)
      throw new Error('Recipient payment wallet has a different chain')
    if (!wallet.stealthReceipts)
      throw new Error('Recipient payment owner is unavailable')
    await wallet.stealthReceipts.record(claim)
    context.assertCurrent()
    for (const index of group.indices)
      result.push({ index, status: 'recorded' })
  }
  return result.sort((left, right) => left.index - right.index)
}
