/**
 * Monad and EVM stealth direct payment engine (STEALTH-4).
 *
 * Implements DKSAP / secp256k1 ECDH stealth address derivation, transaction creation,
 * and recipient spendable keyring indexing without sweeping on receipt.
 */
import {
  computeAddress,
  getBytes,
  hexlify,
  randomBytes,
  SigningKey,
  Wallet,
  type Provider,
} from 'ethers'
import { fromHex, toHex } from '@frank/codec'
import { stealthSharedPoint } from '@frank/cashweb/relay/stealth-shared'
import { stealthPointDigest } from '@frank/cashweb/relay/stealth-point-digest'
import { stealthParentPublicKey } from '@frank/cashweb/relay/stealth-public'
import { stealthParentSecret } from '@frank/cashweb/relay/stealth-parent'
import type { StealthItem } from '@frank/cashweb/types/messages'
import { MonadAccountTxSigner, type MonadTxSubmitter } from './monad-account-tx'
import type { MonadChainWalletHandle } from './chain/monad-chain'

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

export interface StealthAccountRecord {
  readonly address: string
  readonly privateKey: string
  readonly ephemeralPubKey: string
  readonly networkTag: string
  readonly discoveredAtMs: number
  readonly initialAmountWei?: bigint
  readonly txHash?: string
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

export interface MonadStealthKeyringStore {
  get(address: string): StealthAccountRecord | undefined
  put(record: StealthAccountRecord): Promise<void> | void
  all(): StealthAccountRecord[]
  close?(): Promise<void> | void
}

export class MemoryMonadStealthKeyringStore implements MonadStealthKeyringStore {
  private readonly records = new Map<string, StealthAccountRecord>()

  get(address: string): StealthAccountRecord | undefined {
    return this.records.get(address.toLowerCase())
  }

  put(record: StealthAccountRecord): void {
    this.records.set(record.address.toLowerCase(), { ...record })
  }

  all(): StealthAccountRecord[] {
    return [...this.records.values()]
  }
}

/**
 * Keyring managing discovered stealth accounts without sweeping.
 * Funds stay in individual stealth accounts; the wallet spends directly from them.
 */
export class MonadStealthKeyring {
  private readonly store: MonadStealthKeyringStore

  constructor(store?: MonadStealthKeyringStore) {
    this.store = store ?? new MemoryMonadStealthKeyringStore()
  }

  async addAccount(record: StealthAccountRecord): Promise<boolean> {
    const existing = this.store.get(record.address)
    if (existing !== undefined) {
      return false
    }
    await this.store.put(record)
    return true
  }

  hasAccount(address: string): boolean {
    return this.store.get(address) !== undefined
  }

  getAccount(address: string): StealthAccountRecord | undefined {
    return this.store.get(address)
  }

  getAccounts(networkTag?: string): StealthAccountRecord[] {
    const all = this.store.all()
    if (!networkTag) return all
    return all.filter(
      r => r.networkTag.toLowerCase() === networkTag.toLowerCase(),
    )
  }

  /**
   * Sums the spendable on-chain balance of all registered stealth accounts for a given network.
   */
  async getTotalBalance(
    provider: Provider,
    networkTag?: string,
  ): Promise<bigint> {
    const accounts = this.getAccounts(networkTag)
    if (accounts.length === 0) return 0n

    const balances = await Promise.all(
      accounts.map(async account => {
        try {
          return await provider.getBalance(account.address)
        } catch {
          return 0n
        }
      }),
    )

    return balances.reduce((sum, b) => sum + b, 0n)
  }

  /**
   * Selects a single stealth account with sufficient balance to cover `amountWei` plus optional fee reserve.
   */
  async selectAccountForSpend(
    neededWei: bigint,
    provider: Provider,
    networkTag?: string,
  ): Promise<StealthAccountRecord | undefined> {
    const accounts = this.getAccounts(networkTag)
    for (const account of accounts) {
      try {
        const bal = await provider.getBalance(account.address)
        if (bal >= neededWei) {
          return account
        }
      } catch {
        continue
      }
    }
    return undefined
  }
}

export interface BuildEvmStealthPaymentParams {
  wallet: MonadChainWalletHandle
  recipientSpendPubKey: Uint8Array
  amountWei: bigint
  networkTag?: string
  memo?: string
  fromAddress?: string
}

export interface EvmStealthPaymentResult {
  stealthDestination: EvmStealthDestination
  txHash: string
  rawTransaction: string
  stealthItem: StealthItem
}

/**
 * Builds, signs, and broadcasts an on-chain EVM transfer to an ephemeral DKSAP stealth address.
 * Generates the corresponding StealthItem to include in direct messages.
 */
export async function buildEvmStealthPayment(
  params: BuildEvmStealthPaymentParams,
): Promise<EvmStealthPaymentResult> {
  const { wallet, recipientSpendPubKey, amountWei } = params
  if (amountWei <= 0n) {
    throw new Error('Transfer amount must be positive')
  }

  // 1. Derive one-time stealth destination address
  const stealthDestination = deriveEvmStealthAddress({ recipientSpendPubKey })

  // 2. Select funding account (main account or an un-swept stealth account)
  let fundingPrivateKey = wallet.identity.toPrivateKeyHex()
  if (params.fromAddress) {
    const custom = wallet.stealthKeyring?.getAccount(params.fromAddress)
    if (custom) {
      fundingPrivateKey = custom.privateKey
    } else if (
      params.fromAddress.toLowerCase() !==
      wallet.identity.address.raw.toLowerCase()
    ) {
      throw new Error(`Account ${params.fromAddress} not found in wallet`)
    }
  } else if (wallet.stealthKeyring) {
    // If main account has insufficient funds, try selecting a funded stealth account
    const mainBal = await wallet.provider.getBalance(wallet.identity.address.raw)
    if (mainBal < amountWei) {
      const selected = await wallet.stealthKeyring.selectAccountForSpend(
        amountWei,
        wallet.provider,
        params.networkTag,
      )
      if (selected) {
        fundingPrivateKey = selected.privateKey
      }
    }
  }

  // 3. Build and sign transaction
  const signer = new MonadAccountTxSigner({
    privateKey: fundingPrivateKey,
    provider: wallet.provider,
    httpClient: wallet.httpClient,
  })

  const signed = await signer.buildAndSignTransfer(
    stealthDestination.stealthAddress,
    amountWei,
  )

  // 4. Submit transaction to RPC
  const txHash = await wallet.httpClient.submitRawTransaction(
    signed.rawTx,
  )

  // 5. Construct StealthItem
  const stealthItem: StealthItem = {
    type: 'stealth',
    networkTag: params.networkTag ?? 'MONT',
    keyType: 1,
    ephemeralPubKey: toHex(stealthDestination.ephemeralPubKey),
    transactions: [txHash],
    amount: Number(amountWei),
    ...(params.memo ? { memo: params.memo } : {}),
    // Compatibility fields
    chainId: params.networkTag ?? 'MONT',
  }

  return {
    stealthDestination,
    txHash,
    rawTransaction: signed.rawTx,
    stealthItem,
  }
}
