/** Canonical Forum votes; transport uncertainty preserves the exact signed journal authority. */
import { encodeTopicVote, topicBurnCalldata } from '@frank/codec'
import { hexlify } from 'ethers'
import type { TopicVoteDirection } from './monad-topic-post-client'
import type { AcquireLeaseWhenAvailableOptions } from './monad-account-lease'
import type { MonadTxOverrides } from './monad-account-tx'
import type { MonadWalletHandle } from './monad-wallet-handle'
import type { MonadWalletOperationAdmission } from './storage/monad-wallet-bundle'
import {
  assertForumAmount,
  requireForumWallet,
  reconcileForumOperations,
  submitForumOperation,
  ForumOperationPendingError,
} from './monad-forum-operation'
import type { MatchedForumStatus } from './monad-forum-operation'

export const buildCborMonadTopicVoteCalldata = (
  direction: TopicVoteDirection,
  commitment: Uint8Array,
): string => hexlify(topicBurnCalldata(direction, commitment))
export class MonadTopicVoteError extends Error {}
export class MonadTopicVoteRejectedError extends MonadTopicVoteError {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly detail: unknown,
  ) {
    super(message)
  }
}
export class MonadTopicVoteAbandonedError extends MonadTopicVoteError {
  constructor(message: string, readonly targetPayloadHashHex: string) {
    super(message)
  }
}
export interface CastTopicVoteParams {
  targetPayloadHash: Uint8Array
  direction: TopicVoteDirection
  burnAddress: string
  voteWeightWei: bigint
  overrides?: MonadTxOverrides
  waitForLease?: AcquireLeaseWhenAvailableOptions
  leaseIndex?: number
}
export interface CastTopicVoteResult {
  txHash: string
  leaseIndex: number
  status: MatchedForumStatus
}
export class MonadTopicVoteClient {
  constructor(private readonly wallet: MonadWalletHandle) {}
  async castVote(
    params: CastTopicVoteParams,
    admission?: MonadWalletOperationAdmission,
  ): Promise<CastTopicVoteResult> {
    requireForumWallet(this.wallet)
    assertForumAmount(params.voteWeightWei)
    if (params.targetPayloadHash.length !== 32)
      throw new Error('Forum target must be exactly 32 bytes')
    // Validate target/network/direction through the facade before any lease/sign effect.
    topicBurnCalldata(params.direction, new Uint8Array(32))
    const target = params.targetPayloadHash.slice()
    const targetPayloadHashHex = hexlify(target).slice(2)
    return this.wallet.walletState!.runOperation(async admitted => {
      await reconcileForumOperations(this.wallet, 'post', admitted)
      await reconcileForumOperations(this.wallet, 'vote', admitted)
      try {
        const { operation, status } = await submitForumOperation(
          this.wallet,
          {
            kind: 'vote',
            target,
            direction: params.direction,
            burnAddress: params.burnAddress,
            value: params.voteWeightWei,
            overrides: params.overrides,
            leaseIndex: params.leaseIndex,
            waitForLease: params.waitForLease,
            encode: raw =>
              encodeTopicVote(this.wallet.cborNetwork!, target, raw),
          },
          admitted,
        )
        return {
          txHash: operation.txHash,
          leaseIndex: operation.leaseIndex,
          status,
        }
      } catch (error) {
        if (error instanceof ForumOperationPendingError)
          throw new MonadTopicVoteAbandonedError(
            error.message,
            targetPayloadHashHex,
          )
        throw error
      }
    }, admission)
  }
  async resumePendingOperations(
    admission?: MonadWalletOperationAdmission,
  ): Promise<void> {
    return reconcileForumOperations(this.wallet, 'vote', admission)
  }
}
