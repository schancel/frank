import type { RecipientAssetPaymentItem } from '@frank/cashweb/types/messages'
import { toHex } from '@frank/codec'
import { getChainRegistryEntry } from '../../chain/chains-registry'
import type { PreparedStealthPayment } from '../../stealth-payment'

const MAX_QUANTITY = (1n << 256n) - 1n

function positiveQuantity(value: bigint): void {
  if (typeof value !== 'bigint' || value <= 0n || value > MAX_QUANTITY)
    throw new Error('Expected positive uint256 atomic quantity')
}

function bytesHex(value: Uint8Array, min: number, max: number): string {
  if (
    !(value instanceof Uint8Array) ||
    value.length < min ||
    value.length > max
  )
    throw new Error(`Expected ${min}..${max} destination/key bytes`)
  return toHex(value)
}

function compressedKey(value: Uint8Array): string {
  const hex = bytesHex(value, 33, 33)
  if (value[0] !== 2 && value[0] !== 3)
    throw new Error('Expected compressed secp256k1 key encoding')
  return hex
}

function normalizedHex(value: string, min: number, max: number): string {
  if (typeof value !== 'string') throw new Error('Expected transaction hex')
  const hex = value.replace(/^0x/i, '').toLowerCase()
  if (
    !/^[0-9a-f]+$/.test(hex) ||
    hex.length % 2 !== 0 ||
    hex.length < min * 2 ||
    hex.length > max * 2
  )
    throw new Error(`Expected ${min}..${max} bytes of transaction hex`)
  return hex
}

/** Pure public-payload projection. Family operation owners validate signatures, destinations
 * and chain effects; this function never signs, submits, or establishes receipt of funds. */
export function recipientAssetPaymentFromPrepared(
  prepared: PreparedStealthPayment,
  memo?: string
): RecipientAssetPaymentItem {
  const chain = getChainRegistryEntry(prepared.chainIdentifier)
  if (
    chain?.id !== prepared.chainIdentifier ||
    chain.keyType !== 1 ||
    (chain.family !== 'evm' && chain.family !== 'bitcoin')
  )
    throw new Error(
      `Unsupported prepared payment chain: ${prepared.chainIdentifier}`
    )
  positiveQuantity(prepared.amountAtomic)
  if (
    !Array.isArray(prepared.members) ||
    prepared.members.length < 1 ||
    prepared.members.length > 16
  )
    throw new Error('Expected 1..16 signed payment members')
  const recipient = compressedKey(prepared.recipientSpendPublicKey)
  const ephemeral = compressedKey(prepared.ephemeralPublicKey)
  const destination =
    chain.family === 'evm'
      ? bytesHex(prepared.recipientDestination, 20, 20)
      : bytesHex(prepared.recipientDestination, 1, 128)
  const asset =
    prepared.asset.kind === 'native'
      ? { kind: 'native' as const }
      : prepared.asset.kind === 'erc20' && chain.family === 'evm'
      ? {
          kind: 'token' as const,
          identifier: normalizedHex(prepared.asset.contractAddress, 20, 20),
        }
      : undefined
  if (!asset) throw new Error('Unsupported prepared payment asset/family')
  let total = 0n
  const transfers = prepared.members.map((member) => {
    positiveQuantity(member.recipientAmountAtomic)
    total += member.recipientAmountAtomic
    if (chain.family === 'bitcoin') {
      if (
        member.vout === undefined ||
        !Number.isInteger(member.vout) ||
        member.vout < 0 ||
        member.vout > 0xffffffff
      )
        throw new Error('Expected Bitcoin-family output index')
    } else if (member.vout !== undefined) {
      throw new Error('EVM payments do not have an output index')
    }
    return {
      chainIdentifier: chain.id,
      asset: { ...asset },
      txId: normalizedHex(member.txHash, 32, 32),
      rawTx: normalizedHex(member.rawTransaction, 1, 16384),
      destination,
      amountAtomic: member.recipientAmountAtomic.toString(),
      derivationScheme: 1,
      recipientSpendKey: { keyType: 1 as const, publicKey: recipient },
      stealthMetadata: { keyType: 1 as const, ephemeralPubKey: ephemeral },
      ...(member.vout !== undefined ? { vout: member.vout } : {}),
    }
  })
  if (total !== prepared.amountAtomic)
    throw new Error(
      'Signed member quantities differ from intended recipient amount'
    )
  return {
    type: 'stealth-asset',
    transfers,
    ...(memo !== undefined ? { memo } : {}),
  }
}
