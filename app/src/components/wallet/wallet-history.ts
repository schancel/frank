import type { EvmNativeOperationStatus } from '@frank/wallet/chain'
import type { SwapActivityRow } from 'src/swap/useSwapActivity'

/** Presentation only: the wallet journal and swap activity remain the state owners. */
export type WalletHistoryRow =
  | {
      kind: 'swap'
      id: string
      swap: SwapActivityRow
      operation?: EvmNativeOperationStatus
    }
  | { kind: 'native'; id: string; operation: EvmNativeOperationStatus }

export interface WalletHistoryGroup {
  id: string
  label: string
  rows: WalletHistoryRow[]
}
