/** Canonical Forum post encoding, independent of the wallet's chain family. */
import {
  encodeForumPost,
  encodeForumPostContent,
  topicBurnCommitment,
  topicPostSignatureDigest,
  toHex,
} from '@frank/codec'
import type { AccountRef } from '@frank/codec'
import type { ForumMessageEntry } from './forum-model'
import {
  assertTopicAmount,
  requireTopicOperations,
  TopicOperationPendingError,
} from './topic-operations'
import type {
  TopicAuthor,
  TopicOperationResult,
  TopicVoteDirection,
  TopicWalletHandle,
} from './topic-operations'

export class TopicPostAbandonedError extends Error {
  constructor(message: string, readonly payloadHashHex: string) {
    super(message)
    this.name = 'TopicPostAbandonedError'
  }
}
export interface SubmitTopicPostParams {
  topic: string
  entries: ForumMessageEntry[]
  parentPostHash?: Uint8Array
  direction: TopicVoteDirection
  amountAtomic: bigint
  author?: TopicAuthor
  operationId?: string
  timestampMs?: number
}
export interface SubmitTopicPostResult extends TopicOperationResult {
  payloadHashHex: string
  postFrame: Uint8Array
}

export class TopicPostClient {
  constructor(private readonly wallet: TopicWalletHandle) {}
  async submitTopicPost(
    params: SubmitTopicPostParams,
  ): Promise<SubmitTopicPostResult> {
    const operations = requireTopicOperations(this.wallet)
    // Author signing may be asynchronous. Keep the encoded intent stable across that await.
    params = {
      ...params,
      entries: structuredClone(params.entries),
      parentPostHash: params.parentPostHash?.slice(),
    }
    assertTopicAmount(params.amountAtomic)
    if (params.direction !== 'up')
      throw new Error('A Forum post requires an up burn')
    if (
      params.entries.some(
        entry => entry.kind !== 'post' && entry.kind !== 'game',
      )
    )
      throw new Error('Unsupported Forum entry kind')
    const ms = params.timestampMs ?? Date.now()
    if (!Number.isSafeInteger(ms))
      throw new Error('Invalid Forum authored timestamp')
    const seconds = Math.floor(ms / 1000)
    const authored = {
      seconds: BigInt(seconds),
      nanoseconds: (ms - seconds * 1000) * 1_000_000,
    }
    const author = params.author ?? operations.author
    let from: AccountRef | undefined
    let signature: Uint8Array | undefined
    if (author) {
      const body = encodeForumPostContent(authored, params.entries)
      const digest = topicPostSignatureDigest(
        this.wallet.chainIdentifier,
        params.topic,
        body,
        params.parentPostHash,
      )
      from = {
        ...author.account,
        keyBytes: new Uint8Array(author.account.keyBytes),
      }
      signature = new Uint8Array(await author.signDigest(digest))
    }
    const postFrame = encodeForumPost({
      network: this.wallet.chainIdentifier,
      topic: params.topic,
      ...(params.parentPostHash?.length
        ? { parentHash: params.parentPostHash }
        : {}),
      authored,
      entries: params.entries,
      ...(from && signature ? { from, signature } : {}),
    })
    const { hash } = topicBurnCommitment(postFrame)
    const payloadHashHex = toHex(hash)
    try {
      const result = await operations.submit({
        kind: 'post',
        target: hash,
        direction: 'up',
        amountAtomic: params.amountAtomic,
        operationId: params.operationId,
        postFrame,
      })
      return { ...result, payloadHashHex, postFrame }
    } catch (error) {
      if (error instanceof TopicOperationPendingError)
        throw new TopicPostAbandonedError(error.message, payloadHashHex)
      throw error
    }
  }
  resumePendingOperations(): Promise<void> {
    return requireTopicOperations(this.wallet).reconcile('post')
  }
}
