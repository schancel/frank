/**
 * EVM stealth payments: the one-time address a sender derives for a contact, the key only that
 * contact can derive for it, and the message item that carries what the contact needs.
 *
 * Nothing here sends, signs or stores. A payment to a contact is sent by the wallet
 * (`sendToContact` in `chain/monad-chain.ts`), and a received one is recorded as a coin in the
 * wallet's coin store (`storage/evm-coin-store.ts`).
 */
import {
  computeAddress,
  getBytes,
  hexlify,
  randomBytes,
  SigningKey,
  Transaction,
} from 'ethers'
import { fromHex, toHex } from '@frank/codec'
import { stealthSharedPoint } from '@frank/cashweb/relay/stealth-shared'
import { stealthPointDigest } from '@frank/cashweb/relay/stealth-point-digest'
import { stealthParentPublicKey } from '@frank/cashweb/relay/stealth-public'
import { stealthParentSecret } from '@frank/cashweb/relay/stealth-parent'
import type {
  RecipientAssetPaymentItem,
  StealthItem,
} from '@frank/cashweb/types/messages'
import type { EvmCoin } from './storage/evm-coin-store'
import type { StealthPaymentReceiptClaim } from './stealth-payment'
const SECP256K1_ORDER =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

export interface EvmStealthDestination {
  readonly ephemeralPubKey: Uint8Array
  readonly ephemeralSecret?: Uint8Array
  readonly stealthAddress: string
  readonly stealthPublicKey: Uint8Array
}

export interface EvmStealthDerivedAccount {
  readonly ephemeralPubKey: Uint8Array
  readonly stealthAddress: string
  readonly stealthPrivateKey: string
  readonly stealthPublicKey: Uint8Array
}

function randomScalar(): Uint8Array {
  while (true) {
    const bytes = randomBytes(32)
    let val = 0n
    for (const b of bytes) {
      val = (val << 8n) | BigInt(b)
    }
    if (val > 0n && val < SECP256K1_ORDER) {
      return getBytes(bytes)
    }
  }
}

/**
 * Sender derivation: derive an ephemeral one-time EVM address using recipient's secp256k1 spend public key.
 */
export function deriveEvmStealthAddress(params: {
  recipientSpendPubKey: Uint8Array
  ephemeralSecret?: Uint8Array
}): EvmStealthDestination {
  const recipientPubKey = params.recipientSpendPubKey
  if (recipientPubKey.length !== 33 && recipientPubKey.length !== 65) {
    throw new Error(
      `recipientSpendPubKey must be 33 or 65 bytes, got ${recipientPubKey.length}`,
    )
  }

  const ephemeralSecret = params.ephemeralSecret ?? randomScalar()
  if (ephemeralSecret.length !== 32) {
    throw new Error(
      `ephemeralSecret must be 32 bytes, got ${ephemeralSecret.length}`,
    )
  }

  const ephemeralPubKey = getBytes(
    SigningKey.computePublicKey(ephemeralSecret, true),
  )
  const sharedPoint = stealthSharedPoint(ephemeralSecret, recipientPubKey)
  const digest = stealthPointDigest(sharedPoint)
  const stealthPublicKey = stealthParentPublicKey(recipientPubKey, digest)
  const stealthAddress = computeAddress(hexlify(stealthPublicKey))

  return {
    ephemeralPubKey,
    ephemeralSecret: params.ephemeralSecret,
    stealthAddress,
    stealthPublicKey,
  }
}

/**
 * Recipient derivation: derive the one-time private key and EVM address using recipient's spend secret
 * and the ephemeral public key from the incoming stealth item.
 */
export function deriveEvmStealthPrivateKey(params: {
  recipientSpendSecret: Uint8Array | string
  ephemeralPubKey: Uint8Array
}): EvmStealthDerivedAccount {
  const secretBytes =
    typeof params.recipientSpendSecret === 'string'
      ? fromHex(
          params.recipientSpendSecret.startsWith('0x')
            ? params.recipientSpendSecret.slice(2)
            : params.recipientSpendSecret,
        )
      : params.recipientSpendSecret

  if (secretBytes.length !== 32) {
    throw new Error(
      `recipientSpendSecret must be 32 bytes, got ${secretBytes.length}`,
    )
  }

  const ephemeralPubKey = params.ephemeralPubKey
  if (ephemeralPubKey.length !== 33 && ephemeralPubKey.length !== 65) {
    throw new Error(
      `ephemeralPubKey must be 33 or 65 bytes, got ${ephemeralPubKey.length}`,
    )
  }

  const { secret } = stealthParentSecret(secretBytes, ephemeralPubKey)
  const stealthPublicKey = getBytes(SigningKey.computePublicKey(secret, true))
  const stealthAddress = computeAddress(hexlify(stealthPublicKey))

  return {
    ephemeralPubKey,
    stealthAddress,
    stealthPrivateKey: '0x' + toHex(secret),
    stealthPublicKey,
  }
}

const bare = (hex: string): string =>
  (hex.startsWith('0x') ? hex.slice(2) : hex).toLowerCase()

/** The stealth item for a signed transfer to a one-time address. It carries the whole signed
 * transaction, so whoever holds the message can put the transfer on the chain: delivery of the
 * message is delivery of the money. `amount` is the sender's statement, for display. */
export function evmStealthItem(params: {
  networkTag: string
  ephemeralPubKey: Uint8Array
  rawTransaction: string
  amountWei: bigint
  memo?: string
}): StealthItem {
  return {
    type: 'stealth',
    networkTag: params.networkTag,
    keyType: 1,
    ephemeralPubKey: toHex(params.ephemeralPubKey),
    transactions: [bare(params.rawTransaction)],
    amount: Number(params.amountWei),
    amountWei: params.amountWei.toString(),
    ...(params.memo ? { memo: params.memo } : {}),
  }
}

/** The transfer a stealth item names: a signed plain transfer of a positive value to `address` on
 * `chainId` (which the holder may broadcast), or only a hash (which proves nothing by itself: the
 * chain must show what that transaction pays). Anything else is not a transfer to this coin. */
export function stealthItemTransfer(
  transactions: readonly string[],
  address: string,
  chainId: bigint,
): { txHash: string; rawTransaction?: string; valueWei?: bigint } | undefined {
  for (const entry of transactions) {
    const hex = bare(entry)
    if (/^[0-9a-f]{64}$/.test(hex)) return { txHash: '0x' + hex }
    try {
      const tx = Transaction.from('0x' + hex)
      // A plain transfer of money to this account on this chain, and nothing else: no call
      // data, no zero value. Only such bytes are ever handed to a node by the recipient.
      if (
        tx.hash !== null &&
        tx.signature !== null &&
        tx.to?.toLowerCase() === address.toLowerCase() &&
        tx.chainId === chainId &&
        tx.data === '0x' &&
        tx.value > 0n
      )
        return {
          txHash: tx.hash,
          rawTransaction: tx.serialized,
          valueWei: tx.value,
        }
    } catch {
      /* not a transaction */
    }
  }
  return undefined
}

/** The coin a received secp256k1 stealth item describes for the holder of `recipientSpendSecret`:
 * the one-time account, its key, and the sender's stated amount. Pending: nothing is known about
 * the chain yet. Undefined when the item is not an EVM stealth item or its key is malformed. */
export function stealthCoinFromItem(params: {
  item: Pick<
    StealthItem,
    'keyType' | 'ephemeralPubKey' | 'transactions' | 'amount' | 'amountWei'
  >
  recipientSpendSecret: Uint8Array | string
  payloadDigest?: string
  discoveredAtMs: number
}): EvmCoin | undefined {
  const { item } = params
  if ((item.keyType ?? 1) !== 1 || !item.ephemeralPubKey) return undefined
  let derived: EvmStealthDerivedAccount
  let claimed: bigint
  try {
    derived = deriveEvmStealthPrivateKey({
      recipientSpendSecret: params.recipientSpendSecret,
      ephemeralPubKey: fromHex(bare(item.ephemeralPubKey)),
    })
    // The exact figure when the item carries it; a JS number cannot hold most wei amounts.
    claimed = BigInt(item.amountWei ?? item.amount ?? 0)
  } catch {
    return undefined
  }
  return {
    address: derived.stealthAddress.toLowerCase(),
    privateKey: derived.stealthPrivateKey,
    origin: 'stealth',
    state: 'pending',
    amountWei: '0',
    claimedAmountWei: (claimed < 0n ? 0n : claimed).toString(),
    transactions: (item.transactions ?? []).map(bare),
    ...(params.payloadDigest === undefined
      ? {}
      : { payloadDigest: bare(params.payloadDigest) }),
    ephemeralPubKey: bare(item.ephemeralPubKey),
    discoveredAtMs: params.discoveredAtMs,
  }
}

/** The receipt claims a received `stealth-asset` item makes on `chainIdentifier`: one claim per
 * one-time account and asset, carrying every signed transfer to it. Only transfers this family
 * can open are read (derivation scheme 1, secp256k1 keys, a signed transaction to a 20-byte
 * address); anything else in the item is ignored, never an error. Whether a claim is addressed
 * to this wallet, and whether its transactions pay what it says, is the coin list's check. */
export function evmReceiptClaimsFromItem(
  item: Pick<RecipientAssetPaymentItem, 'transfers'>,
  chainIdentifier: string,
  payloadDigest: string,
): StealthPaymentReceiptClaim[] {
  const claims = new Map<
    string,
    {
      asset: StealthPaymentReceiptClaim['asset']
      destination: string
      ephemeralPubKey: string
      amountAtomic: bigint
      rawTransactions: string[]
    }
  >()
  for (const transfer of item.transfers ?? []) {
    if (
      transfer?.chainIdentifier !== chainIdentifier ||
      transfer.derivationScheme !== 1 ||
      transfer.stealthMetadata?.keyType !== 1 ||
      transfer.recipientSpendKey?.keyType !== 1 ||
      typeof transfer.rawTx !== 'string' ||
      typeof transfer.destination !== 'string' ||
      typeof transfer.stealthMetadata.ephemeralPubKey !== 'string' ||
      !/^[1-9][0-9]*$/.test(transfer.amountAtomic ?? '')
    )
      continue
    const destination = bare(transfer.destination)
    const ephemeralPubKey = bare(transfer.stealthMetadata.ephemeralPubKey)
    const rawTransaction = bare(transfer.rawTx)
    if (
      !/^[0-9a-f]{40}$/.test(destination) ||
      !/^0[23][0-9a-f]{64}$/.test(ephemeralPubKey) ||
      !/^(?:[0-9a-f]{2})+$/.test(rawTransaction)
    )
      continue
    let asset: StealthPaymentReceiptClaim['asset']
    if (transfer.asset?.kind === 'native') asset = { kind: 'native' }
    else if (
      transfer.asset?.kind === 'token' &&
      /^[0-9a-f]{40}$/.test(bare(transfer.asset.identifier ?? ''))
    )
      asset = {
        kind: 'erc20',
        contractAddress: '0x' + bare(transfer.asset.identifier),
      }
    else continue
    const key = [
      destination,
      ephemeralPubKey,
      asset.kind === 'native' ? 'native' : asset.contractAddress,
    ].join(':')
    const claim = claims.get(key) ?? {
      asset,
      destination,
      ephemeralPubKey,
      amountAtomic: 0n,
      rawTransactions: [],
    }
    if (claim.rawTransactions.includes(rawTransaction)) continue
    claim.amountAtomic += BigInt(transfer.amountAtomic)
    claim.rawTransactions.push(rawTransaction)
    claims.set(key, claim)
  }
  return [...claims.values()].map(claim => ({
    chainIdentifier,
    asset: claim.asset,
    recipientDestination: fromHex(claim.destination),
    ephemeralPublicKey: fromHex(claim.ephemeralPubKey),
    amountAtomic: claim.amountAtomic,
    rawTransactions: claim.rawTransactions,
    payloadDigest: bare(payloadDigest),
  }))
}
