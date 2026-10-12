import type { RecipientAssetPaymentItem } from '@frank/cashweb/types/messages'
import {
  encodeExperimentalSolanaStealthContext,
  fromHex,
  MAX_PAYMENT_MEMBERS,
  toHex,
} from '@frank/codec'
import {
  getBase58Decoder,
  getBase58Encoder,
  getBase64Decoder,
  getBase64Encoder,
} from '@solana/codecs-strings'
import { PublicKey, VersionedTransaction } from '@solana/web3.js'
import { getChainRegistryEntry } from '../../chain/chains-registry'
import { u64 } from '../../solana-contact-payments/amount'
import type {
  SolanaPaymentDestination,
  SolanaPaymentOperation,
} from '../../solana-contact-payments/types'
import { encodeRecipientAssetPaymentItem } from './codec'

const CLASSIC_SPL = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const base58 = getBase58Encoder()
const base58Text = getBase58Decoder()
const base64 = getBase64Encoder()
const base64Text = getBase64Decoder()

function address(value: string): string {
  if (typeof value !== 'string' || value.length < 32 || value.length > 44)
    throw new Error('Expected canonical Solana public address')
  const key = new PublicKey(value)
  if (key.toBase58() !== value) throw new Error('Noncanonical Solana address')
  return toHex(key.toBytes())
}

function context32(value: string): Uint8Array {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value))
    throw new Error('Expected lowercase crypto context bytes32')
  return fromHex(value)
}

function sameAddresses(a: readonly string[], b: readonly string[]): boolean {
  return (
    Array.isArray(a) &&
    Array.isArray(b) &&
    a.length === b.length &&
    a.every((value, index) => value === b[index])
  )
}

function sameDestination(
  a: SolanaPaymentDestination,
  b: SolanaPaymentDestination,
): boolean {
  return (
    !!a &&
    !!b &&
    a.recipientPoint === b.recipientPoint &&
    a.ephemeralPoint === b.ephemeralPoint &&
    a.destinationOwner === b.destinationOwner
  )
}

/**
 * UNALLOCATED experimental public projection. The financial owner/custody must validate
 * cryptography, transaction policy and receipts. This function never derives, signs or
 * submits. It preserves the complete original set, including each member's own R and P.
 */
export function experimentalSolanaRecipientAssetPaymentsFromOperation(
  operation: Readonly<SolanaPaymentOperation>,
  memo?: string,
): readonly RecipientAssetPaymentItem[] {
  if (!['signed', 'exposed', 'settled'].includes(operation.phase))
    throw new Error('Expected a complete signed original set')
  const { intent, members, contexts, signed } = operation
  const chain = getChainRegistryEntry(intent.chainIdentifier)
  if (
    chain?.id !== intent.chainIdentifier ||
    chain.family !== 'solana' ||
    chain.keyType !== 2
  )
    throw new Error('Expected canonical configured Solana chain')
  if (
    !Array.isArray(members) ||
    members.length < 1 ||
    members.length > MAX_PAYMENT_MEMBERS ||
    !Array.isArray(contexts) ||
    contexts.length !== members.length ||
    !Array.isArray(signed) ||
    signed.length !== members.length
  )
    throw new Error(
      'Expected complete bounded member/context/original cardinality',
    )
  const intendedAmount = u64(intent.amount)
  if (intendedAmount === 0n)
    throw new Error('Expected positive intended amount')
  const recipient = address(intent.recipientSpendPoint)
  const asset = intent.asset
  let wireAsset: RecipientAssetPaymentItem['transfers'][number]['asset']
  let tokenProgram: string | undefined
  if (asset.kind === 'native' && Object.keys(asset).length === 1) {
    wireAsset = { kind: 'native' }
  } else if (
    asset.kind === 'spl' &&
    Object.keys(asset).sort().join() === 'decimals,kind,mint,program' &&
    asset.program === CLASSIC_SPL &&
    Number.isInteger(asset.decimals) &&
    asset.decimals >= 0 &&
    asset.decimals <= 255
  ) {
    wireAsset = { kind: 'token', identifier: address(asset.mint) }
    tokenProgram = address(asset.program)
  } else throw new Error('Expected native or classic SPL asset metadata')

  const signatures = new Set<string>()
  const originals = new Set<string>()
  const sourceAddresses: string[] = []
  let total = 0n
  const transfers: RecipientAssetPaymentItem['transfers'] = signed.map(
    (original, index) => {
      const member = members[index]
      const context = contexts[index]
      if (original.memberIndex !== index || context.memberIndex !== index)
        throw new Error('Signed member/context index mismatch')
      const amount = u64(member.amount)
      if (amount === 0n || original.amount !== member.amount)
        throw new Error('Signed member quantity mismatch')
      total += amount
      if (
        !member.destination ||
        !sameDestination(original.destination, member.destination) ||
        original.destination.recipientPoint !== intent.recipientSpendPoint
      )
        throw new Error('Signed member destination/recipient affinity mismatch')
      if (
        !sameAddresses(original.sourceAddresses, member.sourceAddresses) ||
        !original.sourceAddresses.length
      )
        throw new Error('Signed member source allocation mismatch')
      original.sourceAddresses.forEach(source => {
        address(source)
        sourceAddresses.push(source)
      })
      address(original.sourceOwner)
      const cryptoOperationId = context32(context.cryptoOperationId32)
      const derivationContext = context32(context.derivationContext32)
      if (context.cryptoOperationId32 === context.derivationContext32)
        throw new Error(
          'Crypto operation and derivation context must be distinct',
        )
      if (
        typeof original.signature !== 'string' ||
        original.signature.length > 88
      )
        throw new Error('Expected canonical Solana signature')
      const signature = Uint8Array.from(base58.encode(original.signature))
      if (
        signature.length !== 64 ||
        base58Text.decode(signature) !== original.signature
      )
        throw new Error('Expected canonical signature64')
      if (
        typeof original.transaction !== 'string' ||
        original.transaction.length > 21848
      )
        throw new Error('Expected bounded canonical base64 original')
      const raw = Uint8Array.from(base64.encode(original.transaction))
      if (
        raw.length === 0 ||
        raw.length > 16384 ||
        base64Text.decode(raw) !== original.transaction
      )
        throw new Error('Expected canonical signed original base64')
      const transaction = VersionedTransaction.deserialize(raw)
      if (
        transaction.signatures.length !== 1 ||
        base58Text.decode(transaction.signatures[0]) !== original.signature
      )
        throw new Error('Original bytes/signature binding mismatch')
      if (
        signatures.has(original.signature) ||
        originals.has(original.transaction)
      )
        throw new Error('Duplicate signed original')
      signatures.add(original.signature)
      originals.add(original.transaction)
      return {
        chainIdentifier: chain.id,
        asset: { ...wireAsset },
        txId: toHex(signature),
        rawTx: toHex(raw),
        destination: address(original.destination.destinationOwner),
        amountAtomic: original.amount,
        derivationScheme: 2,
        recipientSpendKey: { keyType: 2, publicKey: recipient },
        stealthMetadata: {
          keyType: 2,
          ephemeralPubKey: address(original.destination.ephemeralPoint),
        },
        ...(tokenProgram !== undefined ? { tokenProgram } : {}),
        derivationContext: toHex(
          encodeExperimentalSolanaStealthContext({
            cryptoOperationId,
            memberIndex: index,
            derivationContext,
          }),
        ),
      }
    },
  )
  if (total !== intendedAmount)
    throw new Error('Member quantities differ from intended amount')
  if (
    !sameAddresses(sourceAddresses, operation.sourceAddresses) ||
    new Set(sourceAddresses).size !== sourceAddresses.length
  )
    throw new Error(
      'Original set does not match complete unique source allocation',
    )
  const items: RecipientAssetPaymentItem[] = []
  for (let index = 0; index < transfers.length; index += 16) {
    const item: RecipientAssetPaymentItem = {
      type: 'stealth-asset',
      transfers: transfers.slice(index, index + 16),
      ...(memo !== undefined ? { memo } : {}),
    }
    // Existing pure codec owns memo bytes, per-item bounds and enclosing structural limits.
    encodeRecipientAssetPaymentItem(item)
    items.push(item)
  }
  return Object.freeze(items)
}
