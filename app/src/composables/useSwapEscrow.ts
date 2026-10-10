/**
 * Composable for Cross-Chain Atomic Swap HTLC Escrows.
 *
 * Reads lock state on GenericHTLC (EVM) and generic-htlc (Solana). Depositing, claiming
 * and refunding are refused: atomic swaps are not available yet.
 * Integrates with `useLeaderStore` to prevent duplicate or conflicting automated reactions.
 */
import { ref } from 'vue'
import { Contract } from 'ethers'
import type { Provider } from 'ethers'
import { Connection } from '@solana/web3.js'
import {
  decodeEvmHtlcLockState,
  decodeSolanaHtlcLockState,
  evaluateSwapStepPhase,
  resolveHtlcContract,
  toBytes32Hex,
  EVM_GENERIC_HTLC_ABI,
} from '@frank/wallet/swap-escrow'
import type { SwapLockRecord } from '@frank/wallet/swap-escrow'
import { findSolanaLockPda } from '@frank/wallet/solana-game-escrow'
import { PROTOCOL_CHAINS } from '@frank/wallet/chain/chains-registry'
import { useLeaderStore } from '../stores/leader'
import { useMonadWallet } from '../utils/clients'

export const SWAPS_NOT_AVAILABLE = 'Atomic swaps are not available yet'

export interface DepositLockParams {
  swapId: string
  chain: string
  amount: string
  recipient: string
  refundAddress?: string
  hashLock?: string
  durationSeconds?: number
}

export interface ClaimLockParams {
  swapId: string
  chain: string
  preimage?: string
  recipient?: string
}

export interface RefundLockParams {
  swapId: string
  chain: string
  recipient?: string
  refundAddress?: string
}

export function useSwapEscrow() {
  const leaderStore = useLeaderStore()
  const loading = ref(false)
  const error = ref<string | null>(null)

  /**
   * Fetches on-chain lock state for a given chain and lockId.
   */
  async function fetchSwapLock(params: {
    chain: string
    lockId: string
    customProvider?: Provider
  }): Promise<SwapLockRecord | null> {
    const { chain, lockId, customProvider } = params
    const resolved = resolveHtlcContract(chain)

    try {
      if (resolved.family === 'evm') {
        let provider = customProvider
        if (!provider) {
          try {
            const wallet = useMonadWallet()
            provider = (wallet as any).provider
          } catch {
            // provider unavailable
          }
        }
        if (!provider) return null

        const contract = new Contract(
          resolved.contractAddress,
          EVM_GENERIC_HTLC_ABI,
          provider,
        )
        const lockIdHex = toBytes32Hex(lockId)
        const raw = await contract.locks(lockIdHex)
        return decodeEvmHtlcLockState({
          lockId: lockIdHex,
          result: raw,
        })
      }

      if (resolved.family === 'solana') {
        const [pda] = await findSolanaLockPda(lockId, resolved.contractAddress)
        const rpcUrl =
          PROTOCOL_CHAINS[chain]?.rpcUrl ?? 'https://api.devnet.solana.com'
        const conn = new Connection(rpcUrl, 'confirmed')
        const accountInfo = await conn.getAccountInfo(pda)
        if (!accountInfo || !accountInfo.data) return null

        return decodeSolanaHtlcLockState({
          lockId,
          accountData: new Uint8Array(accountInfo.data),
        })
      }
    } catch (err: unknown) {
      console.warn(`[useSwapEscrow] fetchSwapLock error on ${chain}:`, err)
      return null
    }

    return null
  }

  // Atomic swaps are being rebuilt after the wallet unification. Until then nothing here
  // moves funds: these three refuse before deriving a secret, building a transaction or
  // touching a key, and never return a transaction hash.
  async function depositLock(_params: DepositLockParams): Promise<{
    txHash: string
    lockId: string
    hashLock: string
    preimageHex?: string
  }> {
    return refuse()
  }

  async function claimLock(_params: ClaimLockParams): Promise<{ txHash: string }> {
    return refuse()
  }

  async function refundLock(
    _params: RefundLockParams,
  ): Promise<{ txHash: string }> {
    return refuse()
  }

  function refuse(): never {
    error.value = SWAPS_NOT_AVAILABLE
    throw new Error(SWAPS_NOT_AVAILABLE)
  }

  return {
    loading,
    error,
    leaderStore,
    fetchSwapLock,
    depositLock,
    claimLock,
    refundLock,
    evaluatePhase: evaluateSwapStepPhase,
  }
}
