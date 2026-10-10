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
import type { EvmChainWalletHandle } from "./evm-wallet-handle";
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
  wallet: EvmChainWalletHandle
  ephemeralPubKey: Uint8Array | string
  stealthAddress?: string
  payoutWei: bigint
  txHash?: string
  networkTag?: string
  timestampMs?: number
}

const STATE_CHANNEL_ABI = [
  'function closeCooperative(bytes32 channelId, uint256 seq, uint256[2] calldata balances, address payout0, address payout1, bytes calldata sig0, bytes calldata sig1) external',
  'function checkpoint(bytes32 channelId, uint256 seq, uint256[2] calldata balances, bytes calldata sig0, bytes calldata sig1) external',
]

const GENERIC_HTLC_ABI = [
  'function batchDistribute(bytes32[] calldata lockIds, tuple(address recipient, uint256 amount)[] calldata payouts, bytes calldata preimage) external',
  'function batchWithdraw(bytes32[] calldata lockIds, bytes calldata preimage) external',
  'function withdraw(bytes32 lockId, bytes calldata preimage) external',
  'function refund(bytes32 lockId) external',
]

const stateChannelInterface = new Interface(STATE_CHANNEL_ABI)
const genericHtlcInterface = new Interface(GENERIC_HTLC_ABI)

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
 * Computes the EIP-191 Ethereum Signed Message hash for StateChannel.closeCooperative:
 * keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", keccak256(abi.encode(channelId, seq, balances, payout0, payout1, true, contract, chainId))))
 */
export function buildStateChannelCloseDigest(params: {
  channelId: string
  seq: bigint | number
  balances: [bigint, bigint]
  payout0?: string
  payout1?: string
  contractAddress: string
  chainId: bigint | number
}): { innerHash: string; messageHash: string; digestBytes: Uint8Array } {
  const abiCoder = AbiCoder.defaultAbiCoder()
  const dest0 = params.payout0 || '0x0000000000000000000000000000000000000000'
  const dest1 = params.payout1 || '0x0000000000000000000000000000000000000000'

  const innerPayload = abiCoder.encode(
    ['bytes32', 'uint256', 'uint256[2]', 'address', 'address', 'bool', 'address', 'uint256'],
    [
      params.channelId,
      BigInt(params.seq),
      params.balances,
      dest0,
      dest1,
      true, // isFinal
      params.contractAddress,
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
 * Encodes the calldata for StateChannel.closeCooperative(channelId, seq, balances, payout0, payout1, sig0, sig1).
 */
export function encodeStateChannelCloseCall(params: {
  channelId: string
  seq: bigint | number
  balances: [bigint, bigint]
  payout0?: string
  payout1?: string
  sig0: string
  sig1: string
}): string {
  const dest0 = params.payout0 || '0x0000000000000000000000000000000000000000'
  const dest1 = params.payout1 || '0x0000000000000000000000000000000000000000'

  return stateChannelInterface.encodeFunctionData(
    'closeCooperative(bytes32,uint256,uint256[2],address,address,bytes,bytes)',
    [
      params.channelId,
      BigInt(params.seq),
      params.balances,
      dest0,
      dest1,
      params.sig0,
      params.sig1,
    ],
  )
}

/**
 * Encodes the calldata for GenericHTLC.batchDistribute(lockIds, payouts, preimage).
 */
export function encodeBatchDistributeCall(params: {
  lockIds: string[]
  payouts: TablePayoutRecipient[]
  preimage: Uint8Array | string
}): string {
  const preimageBytes =
    typeof params.preimage === 'string'
      ? getBytes(params.preimage.startsWith('0x') ? params.preimage : hexlify(toUtf8Bytes(params.preimage)))
      : params.preimage

  return genericHtlcInterface.encodeFunctionData('batchDistribute', [
    params.lockIds,
    params.payouts,
    preimageBytes,
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
