import type { RecipientPaymentTransfer } from '@frank/cashweb/types/messages'
import {
  decodePaymentMember,
  encodePaymentMember,
  toHex,
  type PaymentMember,
  type PaymentMemberInput,
} from '@frank/codec'
import { getChainRegistryEntry } from '../../chain/chains-registry'

/** Decode a standalone nested record. Enclosing frames must retain their shared validation
 * budgets and use projectRecipientPaymentTransfer on the already validated child instead.
 * This does not allocate or encode a message-item frame.
 */
export function decodeRecipientPaymentTransfer(
  bytes: Uint8Array,
): RecipientPaymentTransfer {
  return projectRecipientPaymentTransfer(decodePaymentMember(bytes))
}

/** Project validated protocol bytes without converting amounts through JavaScript numbers. */
export function projectRecipientPaymentTransfer(
  transfer: PaymentMember,
): RecipientPaymentTransfer {
  const chain = getChainRegistryEntry(transfer.network)
  if (!chain)
    throw new Error(`Unsupported payment network tag: ${transfer.network}`)
  const metadata = transfer.stealthMetadata
  if (!metadata || metadata.ephemeralPubKey.keyType !== chain.keyType) {
    throw new Error('Missing or incompatible recipient stealth key')
  }
  if (transfer.token && chain.family === 'bitcoin') {
    throw new Error('Unsupported Bitcoin-family token payment')
  }
  if (
    transfer.token &&
    transfer.token.length !== (chain.family === 'evm' ? 20 : 32)
  ) {
    throw new Error('Invalid token identifier length')
  }
  const amount =
    transfer.value instanceof Uint8Array
      ? BigInt(`0x${toHex(transfer.value)}`)
      : transfer.value
  if (amount <= 0n) throw new Error('Recipient payment amount must be positive')
  return {
    chainIdentifier: chain.id,
    txId: toHex(transfer.transactionId),
    destination: toHex(transfer.address),
    amountAtomic: amount.toString(),
    asset: transfer.token
      ? { kind: 'token', identifier: toHex(transfer.token) }
      : { kind: 'native' },
    ...(transfer.vout !== undefined ? { vout: transfer.vout } : {}),
    stealthMetadata: {
      keyType: chain.keyType,
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
    ...(transfer.commitment !== undefined
      ? { commitment: toHex(transfer.commitment) }
      : {}),
    ...(transfer.rawTx !== undefined ? { rawTx: toHex(transfer.rawTx) } : {}),
  }
}

/** Use only inside a centrally allocated enclosing schema; never wrap stealth in type 27. */
export function encodeRecipientPaymentTransfer(
  transfer: RecipientPaymentTransfer,
): Uint8Array {
  const chain = getChainRegistryEntry(transfer.chainIdentifier)
  if (!chain || chain.id !== transfer.chainIdentifier) {
    throw new Error(`Unsupported payment chain: ${transfer.chainIdentifier}`)
  }
  if (!/^[1-9][0-9]*$/.test(transfer.amountAtomic)) {
    throw new Error(
      'Recipient payment amount must be canonical positive decimal',
    )
  }
  if (transfer.asset.kind !== 'native' && transfer.asset.kind !== 'token') {
    throw new Error('Unsupported recipient payment asset')
  }
  const record: PaymentMemberInput = {
    network: chain.id,
    transactionId: transfer.txId,
    address: transfer.destination,
    // Pass bigint: the underlying codec also accepts 64-character hex strings.
    value: BigInt(transfer.amountAtomic),
    ...(transfer.asset.kind === 'token'
      ? { token: transfer.asset.identifier }
      : {}),
    ...(transfer.vout !== undefined ? { vout: transfer.vout } : {}),
    stealthMetadata: transfer.stealthMetadata,
    ...(transfer.commitment !== undefined
      ? { commitment: transfer.commitment }
      : {}),
    ...(transfer.rawTx !== undefined ? { rawTx: transfer.rawTx } : {}),
  }
  const bytes = encodePaymentMember(record)
  // Apply the same recipient semantics on both boundaries after structural validation.
  decodeRecipientPaymentTransfer(bytes)
  return bytes
}
