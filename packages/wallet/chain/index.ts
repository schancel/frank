/**
 * The single compile-time seam every store/component should import through (ticket #41 -- see
 * `PLAN.md`'s M9 section, and `./active-chain.ts`'s header for the full design rationale).
 *
 * Selecting a different chain is a one-line change here (swap `MonadChain` for a future
 * `LotusChain`, once one is actually built for real -- see issue #41's "Non-goals"), never a
 * runtime branch anywhere else in the app.
 */
import { MonadChain } from './monad-chain'
import { ActiveChain } from './active-chain'

export const activeChain: ActiveChain = MonadChain

export type {
  ActiveChain,
  ChainAddress,
  DirectMessageAttemptStatus,
  DirectMessageClient,
  DirectMessagePreparationProgress,
  DirectMessageReceived,
  DirectMessageSendResult,
  FrankIdentityHandle,
  HDSeed,
  NativeTransferClient,
  ProfileInfo,
  TopicBroadcastClient,
  WalletHandle,
} from './active-chain'
