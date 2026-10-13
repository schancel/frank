import type {
  RecipientAssetPaymentItem,
  RecipientPaymentClaimKeyType,
} from '@frank/cashweb/types/messages'
import {
  encodeStealthAssetMessageItem,
  fromHex,
  isStealthAssetMessageItemFrame,
  toHex,
} from '@frank/codec'
import { getChainRegistryEntry } from '../../chain/chains-registry'
import {
  MessageItemDecodeError,
  type MessageItemDecodeContext,
} from '../registry'
import { decodeWith, openItemFrame } from '../shared/frame'

function canonicalChain(chainIdentifier: string): void {
  if (getChainRegistryEntry(chainIdentifier)?.id !== chainIdentifier) {
    throw new Error(`Unsupported payment chain: ${chainIdentifier}`)
  }
}

function claimKeyType(keyType: number): RecipientPaymentClaimKeyType {
  if (keyType !== 1 && keyType !== 2 && keyType !== 3) {
    throw new Error(`Unallocated recipient claim key type: ${keyType}`)
  }
  return keyType
}

/** Dedicated frame only. Pure serialization; no signing, verification or wallet mutation. */
export function encodeRecipientAssetPaymentItem(
  item: RecipientAssetPaymentItem,
): Uint8Array {
  return encodeStealthAssetMessageItem({
    transfers: item.transfers.map(entry => {
      canonicalChain(entry.chainIdentifier)
      if (!/^[1-9][0-9]*$/.test(entry.amountAtomic))
        throw new Error('Expected positive decimal atomic amount')
      if (entry.asset.kind !== 'native' && entry.asset.kind !== 'token')
        throw new Error('Unsupported payment asset')
      return {
        transfer: {
          network: entry.chainIdentifier,
          transactionId: entry.txId,
          address: entry.destination,
          value: BigInt(entry.amountAtomic),
          ...(entry.asset.kind === 'token'
            ? { token: entry.asset.identifier }
            : {}),
          stealthMetadata: entry.stealthMetadata,
          ...(entry.vout !== undefined ? { vout: entry.vout } : {}),
          ...(entry.commitment !== undefined
            ? { commitment: entry.commitment }
            : {}),
          ...(entry.rawTx !== undefined ? { rawTx: entry.rawTx } : {}),
        },
        derivationScheme: entry.derivationScheme,
        recipientSpendKey: {
          keyType: entry.recipientSpendKey.keyType,
          keyBytes: fromHex(entry.recipientSpendKey.publicKey),
        },
        ...(entry.tokenProgram !== undefined
          ? { tokenProgram: fromHex(entry.tokenProgram) }
          : {}),
        ...(entry.derivationContext !== undefined
          ? { derivationContext: fromHex(entry.derivationContext) }
          : {}),
      }
    }),
    ...(item.memo !== undefined ? { memo: item.memo } : {}),
  })
}

/** Uses the enclosing frame/budget. Unknown schemes are projected as claims, never executed. */
export function decodeRecipientAssetPaymentItem(
  bytes: Uint8Array,
  context: MessageItemDecodeContext,
): RecipientAssetPaymentItem {
  const parsed = openItemFrame('stealth-asset', bytes, context)
  if (!isStealthAssetMessageItemFrame(parsed))
    throw new MessageItemDecodeError(
      'stealth-asset',
      'expected schema-2 recipient payment frame',
    )
  return decodeWith('stealth-asset', () => ({
    type: 'stealth-asset',
    transfers: parsed.typed.transfers.map(entry => {
      const transfer = entry.transfer
      canonicalChain(transfer.network)
      const metadata = transfer.stealthMetadata
      if (!metadata) throw new Error('Missing recipient stealth metadata')
      const amount =
        transfer.value instanceof Uint8Array
          ? BigInt(`0x${toHex(transfer.value)}`)
          : transfer.value
      if (amount <= 0n)
        throw new Error('Expected positive recipient payment amount')
      return {
        chainIdentifier: transfer.network,
        txId: toHex(transfer.transactionId),
        destination: toHex(transfer.address),
        amountAtomic: amount.toString(),
        asset:
          transfer.token !== undefined
            ? { kind: 'token' as const, identifier: toHex(transfer.token) }
            : { kind: 'native' as const },
        stealthMetadata: {
          keyType: claimKeyType(metadata.ephemeralPubKey.keyType),
          ephemeralPubKey: toHex(metadata.ephemeralPubKey.keyBytes),
          ...(metadata.viewTag !== undefined
            ? {
                viewTag:
                  metadata.viewTag instanceof Uint8Array
                    ? toHex(metadata.viewTag)
                    : metadata.viewTag,
              }
            : {}),
        },
        ...(transfer.vout !== undefined ? { vout: transfer.vout } : {}),
        ...(transfer.commitment !== undefined
          ? { commitment: toHex(transfer.commitment) }
          : {}),
        ...(transfer.rawTx !== undefined
          ? { rawTx: toHex(transfer.rawTx) }
          : {}),
        derivationScheme: entry.derivationScheme,
        recipientSpendKey: {
          keyType: claimKeyType(entry.recipientSpendKey.keyType),
          publicKey: toHex(entry.recipientSpendKey.keyBytes),
        },
        ...(entry.tokenProgram !== undefined
          ? { tokenProgram: toHex(entry.tokenProgram) }
          : {}),
        ...(entry.derivationContext !== undefined
          ? { derivationContext: toHex(entry.derivationContext) }
          : {}),
      }
    }),
    ...(parsed.typed.memo !== undefined ? { memo: parsed.typed.memo } : {}),
  }))
}
