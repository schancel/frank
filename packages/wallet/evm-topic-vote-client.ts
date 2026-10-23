/** Canonical Forum votes; transport uncertainty preserves the exact signed journal authority. */
import { topicBurnCalldata } from '@frank/codec'
import { hexlify, Transaction } from 'ethers'
import type { TopicVoteDirection } from './evm-topic-post-client'
import type { EvmWalletHandle } from './evm-wallet-handle'
import type { MonadWalletOperationAdmission } from './storage/evm-wallet-bundle'
import {
  assertForumAmount,
  requireForumWallet,
  reconcileForumOperations,
  submitForumOperation,
  ForumOperationPendingError,
} from './evm-forum-operation'
import type { MatchedForumStatus } from './evm-forum-operation'

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
  operationId?: string
}
export interface CastTopicVoteResult {
  transactionSetHash: string
  transactionHashes: string[]
  status: MatchedForumStatus
}
export class MonadTopicVoteClient {
  constructor(private readonly wallet: EvmWalletHandle) {}
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
    return (async () => {
      try {
        const { operation, status } = await submitForumOperation(
          this.wallet,
          {
            kind: 'vote',
            target,
            direction: params.direction,
            burnAddress: params.burnAddress,
            value: params.voteWeightWei,
            operationId: params.operationId,
          },
        )
        return {
          transactionSetHash: operation.transactionSetHash,
          transactionHashes: operation.rawTransactions.map(
            (raw) => Transaction.from(raw).hash!,
          ),
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
    })()
  }
  async resumePendingOperations(
    admission?: MonadWalletOperationAdmission,
  ): Promise<void> {
    return reconcileForumOperations(this.wallet, 'vote', admission)
  }
}
