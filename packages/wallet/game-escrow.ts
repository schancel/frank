/**
 * Game Escrow & DKSAP Stealth Address Payouts (GAME-3).
 *
 * Wires Frank's Dual-Key Stealth Address Protocol (DKSAP) into game escrows so that
 * all game settlements (ChannelVault 2-of-2 state channels and TablePotVault table pots)
 * pay directly to one-time stealth addresses, ensuring complete on-chain identity privacy.
 *
 * Winning clients automatically index and attribute the payout into their MonadStealthKeyring,
 * enabling immediate spendability without requiring sweeping.
 */
import {
  AbiCoder,
  concat,
  getBytes,
  hexlify,
  Interface,
  keccak256,
  toUtf8Bytes,
} from 'ethers'
import {
  deriveEvmStealthAddress,
  deriveEvmStealthPrivateKey,
  type EvmStealthDestination,
  type StealthAccountRecord,
} from './monad-stealth'
import type { MonadChainWalletHandle } from './chain/monad-chain'
import { parseAddressWithOptionalRelay } from './chain/active-chain'
import { fromHex, toHex } from '@frank/codec'

export interface ChannelSettlementDigestParams {
  sessionId: string
  winnerAddress: string
  payoutWei: bigint
  vaultAddress: string
  chainId: bigint | number
}

export interface ChannelSettlementDigestResult {
  innerHash: string
  messageHash: string
  digestBytes: Uint8Array
}

export interface TablePayoutRecipient {
  recipient: string
  amount: bigint
}

export interface TableSettlementDigestParams {
  tableId: string
  payouts: TablePayoutRecipient[]
  vaultAddress: string
  chainId: bigint | number
}

export interface TableSettlementDigestResult {
  innerHash: string
  messageHash: string
  digestBytes: Uint8Array
}

export interface WinnerStealthPayoutPlan {
  stealthDestination: EvmStealthDestination
  stealthAddress: string
  ephemeralPubKeyHex: string
  amountWei: bigint
}

export interface TableStealthSettlementPlan {
  payouts: TablePayoutRecipient[]
  stealthPlans: WinnerStealthPayoutPlan[]
  digest: TableSettlementDigestResult
}

export interface RegisterEscrowStealthPayoutParams {
  wallet: MonadChainWalletHandle
  ephemeralPubKey: Uint8Array | string
  stealthAddress?: string
  payoutWei: bigint
  txHash?: string
  networkTag?: string
  timestampMs?: number
}

const CHANNEL_VAULT_ABI = [
  'function settle(bytes32 sessionId, address winner, uint256 payout, bytes calldata jointSig) external',
]

const TABLE_POT_VAULT_ABI = [
  'function settleTable(bytes32 tableId, tuple(address recipient, uint256 amount)[] calldata payouts, bytes calldata hostSig) external',
]

const channelVaultInterface = new Interface(CHANNEL_VAULT_ABI)
const tablePotVaultInterface = new Interface(TABLE_POT_VAULT_ABI)

/**
 * Derives a one-time DKSAP stealth address for game escrow winnings.
 */
export function deriveEscrowStealthPayout(params: {
  recipientSpendPubKey: Uint8Array | string
  ephemeralSecret?: Uint8Array
}): EvmStealthDestination {
  const recipientSpendPubKey =
    typeof params.recipientSpendPubKey === 'string'
      ? fromHex(
          params.recipientSpendPubKey.startsWith('0x')
            ? params.recipientSpendPubKey.slice(2)
            : params.recipientSpendPubKey,
        )
      : params.recipientSpendPubKey

  return deriveEvmStealthAddress({
    recipientSpendPubKey,
    ephemeralSecret: params.ephemeralSecret,
  })
}

/**
 * Computes the EIP-191 Ethereum Signed Message hash for ChannelVault.settle:
 * keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", keccak256(abi.encode(sessionId, winner, payout, vault, chainId))))
 */
export function buildChannelSettlementDigest(
  params: ChannelSettlementDigestParams,
): ChannelSettlementDigestResult {
  const abiCoder = AbiCoder.defaultAbiCoder()
  const innerPayload = abiCoder.encode(
    ['bytes32', 'address', 'uint256', 'address', 'uint256'],
    [
      params.sessionId,
      params.winnerAddress,
      params.payoutWei,
      params.vaultAddress,
      BigInt(params.chainId),
    ],
  )
  const innerHash = keccak256(innerPayload)
  const messageHash = keccak256(
    concat([
      toUtf8Bytes('\x19Ethereum Signed Message:\n32'),
      getBytes(innerHash),
    ]),
  )

  return {
    innerHash,
    messageHash,
    digestBytes: getBytes(innerHash),
  }
}

/**
 * Computes the EIP-191 Ethereum Signed Message hash for TablePotVault.settleTable:
 * keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", keccak256(abi.encode(tableId, payouts, vault, chainId))))
 */
export function buildTableSettlementDigest(
  params: TableSettlementDigestParams,
): TableSettlementDigestResult {
  const abiCoder = AbiCoder.defaultAbiCoder()
  const innerPayload = abiCoder.encode(
    [
      'bytes32',
      'tuple(address recipient, uint256 amount)[]',
      'address',
      'uint256',
    ],
    [
      params.tableId,
      params.payouts,
      params.vaultAddress,
      BigInt(params.chainId),
    ],
  )
  const innerHash = keccak256(innerPayload)
  const messageHash = keccak256(
    concat([
      toUtf8Bytes('\x19Ethereum Signed Message:\n32'),
      getBytes(innerHash),
    ]),
  )

  return {
    innerHash,
    messageHash,
    digestBytes: getBytes(innerHash),
  }
}

/**
 * Prepares a complete multi-winner TablePotVault settlement with fresh DKSAP stealth addresses.
 */
export function prepareTableStealthSettlement(params: {
  tableId: string
  winners: Array<{
    recipientSpendPubKey: Uint8Array | string
    amountWei: bigint
  }>
  vaultAddress: string
  chainId: bigint | number
}): TableStealthSettlementPlan {
  const stealthPlans: WinnerStealthPayoutPlan[] = []
  const payouts: TablePayoutRecipient[] = []

  for (const winner of params.winners) {
    const dest = deriveEscrowStealthPayout({
      recipientSpendPubKey: winner.recipientSpendPubKey,
    })
    stealthPlans.push({
      stealthDestination: dest,
      stealthAddress: dest.stealthAddress,
      ephemeralPubKeyHex: toHex(dest.ephemeralPubKey),
      amountWei: winner.amountWei,
    })
    payouts.push({
      recipient: dest.stealthAddress,
      amount: winner.amountWei,
    })
  }

  const digest = buildTableSettlementDigest({
    tableId: params.tableId,
    payouts,
    vaultAddress: params.vaultAddress,
    chainId: params.chainId,
  })

  return {
    payouts,
    stealthPlans,
    digest,
  }
}

/**
 * Encodes the calldata for ChannelVault.settle(sessionId, winner, payout, jointSig).
 */
export function encodeChannelSettlementCall(params: {
  sessionId: string
  winnerAddress: string
  payoutWei: bigint
  jointSig: string
}): string {
  return channelVaultInterface.encodeFunctionData('settle', [
    params.sessionId,
    params.winnerAddress,
    params.payoutWei,
    params.jointSig,
  ])
}

/**
 * Encodes the calldata for TablePotVault.settleTable(tableId, payouts, hostSig).
 */
export function encodeTableSettlementCall(params: {
  tableId: string
  payouts: TablePayoutRecipient[]
  hostSig: string
}): string {
  return tablePotVaultInterface.encodeFunctionData('settleTable', [
    params.tableId,
    params.payouts,
    params.hostSig,
  ])
}

/**
 * Automatically indexes an incoming game escrow stealth payout into the winner's wallet.
 * Computes the one-time private key, registers the stealth account into `MonadStealthKeyring`,
 * and makes it immediately available for future balance checks and spends.
 */
export async function registerEscrowStealthPayout(
  params: RegisterEscrowStealthPayoutParams,
): Promise<StealthAccountRecord> {
  const { wallet, payoutWei } = params
  if (!wallet.stealthKeyring) {
    throw new Error('Wallet does not have an active stealth keyring')
  }
  if (!wallet.identity) {
    throw new Error('Wallet does not have an active Frank identity')
  }

  const ephemeralPubKeyBytes =
    typeof params.ephemeralPubKey === 'string'
      ? fromHex(
          params.ephemeralPubKey.startsWith('0x')
            ? params.ephemeralPubKey.slice(2)
            : params.ephemeralPubKey,
        )
      : params.ephemeralPubKey

  const derived = deriveEvmStealthPrivateKey({
    recipientSpendSecret: wallet.identity.toPrivateKeyHex(),
    ephemeralPubKey: ephemeralPubKeyBytes,
  })

  if (
    params.stealthAddress &&
    derived.stealthAddress.toLowerCase() !== params.stealthAddress.toLowerCase()
  ) {
    throw new Error(
      `Derived stealth address (${derived.stealthAddress}) does not match expected (${params.stealthAddress})`,
    )
  }

  const record: StealthAccountRecord = {
    address: derived.stealthAddress,
    privateKey: derived.stealthPrivateKey,
    ephemeralPubKey:
      typeof params.ephemeralPubKey === 'string'
        ? params.ephemeralPubKey
        : toHex(params.ephemeralPubKey),
    networkTag: params.networkTag ?? 'MONT',
    discoveredAtMs: params.timestampMs ?? Date.now(),
    initialAmountWei: payoutWei,
    txHash: params.txHash,
  }

  await wallet.stealthKeyring.addAccount(record)
  return record
}
