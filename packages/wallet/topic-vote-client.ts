/** Forum vote validation and submission through the active wallet's capability. */
import { toHex } from '@frank/codec'
import {
  assertTopicAmount,
  requireTopicOperations,
  TopicOperationPendingError,
} from './topic-operations'
import type {
  TopicOperationResult,
  TopicVoteDirection,
  TopicWalletHandle,
} from './topic-operations'

export class TopicVoteAbandonedError extends Error {
  constructor(message: string, readonly targetPayloadHashHex: string) {
    super(message)
    this.name = 'TopicVoteAbandonedError'
  }
}
export interface CastTopicVoteParams {
  targetPayloadHash: Uint8Array
  direction: TopicVoteDirection
  amountAtomic: bigint
  operationId?: string
}
export type CastTopicVoteResult = TopicOperationResult
export class TopicVoteClient {
  constructor(private readonly wallet: TopicWalletHandle) {}
  async castVote(params: CastTopicVoteParams): Promise<CastTopicVoteResult> {
    const operations = requireTopicOperations(this.wallet)
    assertTopicAmount(params.amountAtomic)
    if (params.targetPayloadHash.length !== 32)
      throw new Error('Forum target must be exactly 32 bytes')
    if (params.direction !== 'up' && params.direction !== 'down')
      throw new Error('Invalid Forum vote direction')
    const target = params.targetPayloadHash.slice()
    try {
      return await operations.submit({
        kind: 'vote',
        target,
        direction: params.direction,
        amountAtomic: params.amountAtomic,
        operationId: params.operationId,
      })
    } catch (error) {
      if (error instanceof TopicOperationPendingError)
        throw new TopicVoteAbandonedError(error.message, toHex(target))
      throw error
    }
  }
  resumePendingOperations(): Promise<void> {
    return requireTopicOperations(this.wallet).reconcile('vote')
  }
}
