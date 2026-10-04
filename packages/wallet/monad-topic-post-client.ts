/** Canonical schema-2 public Forum posts and exact signed-operation reconciliation. */
import { hexlify } from 'ethers'
import { encodeForumPost, encodeTopicPostSubmission, topicBurnCommitment, topicBurnCalldata } from '@frank/codec'
import type { ForumMessageEntry } from '@frank/cashweb/types/forum'
import type { MonadAccountTxSigner, MonadTxOverrides } from './monad-account-tx'
import type { AcquireLeaseWhenAvailableOptions } from './monad-account-lease'
import type { MonadWalletHandle } from './monad-wallet-handle'
import type { MonadWalletOperationAdmission } from './storage/monad-wallet-bundle'
import {
  assertForumAmount, requireForumWallet, reconcileForumOperations, submitForumOperation,
  ForumOperationPendingError,
} from './monad-forum-operation'
import type { MatchedForumStatus } from './monad-forum-operation'

export type TopicVoteDirection = 'up' | 'down'
export const MONAD_TOPIC_VOTE_CALLDATA_LENGTH = 38
export const buildCborTopicVoteCalldata = (direction: TopicVoteDirection, commitment: Uint8Array): string => hexlify(topicBurnCalldata(direction, commitment))

/** Quote only; the probe is never sent or journaled. */
export async function quoteMonadTopicBurnGasReserve(params: {
  signer: MonadAccountTxSigner; burnAddress: string; overrides?: MonadTxOverrides
}): Promise<bigint> {
  const probe = await params.signer.buildAndSignCall(params.burnAddress, 1n, buildCborTopicVoteCalldata('up', new Uint8Array(32).fill(0xff)), params.overrides)
  const fee = probe.maxFeePerGas ?? probe.gasPrice
  if (fee === undefined) throw new Error('Unable to determine a maximum fee for a topic burn')
  return probe.gasLimit * fee * 5n / 4n
}
export class MonadTopicPostError extends Error {}
export class MonadTopicPostRejectedError extends MonadTopicPostError {
  constructor(message: string, readonly status: number | undefined, readonly detail: unknown) { super(message) }
}
export class MonadTopicPostAbandonedError extends MonadTopicPostError {
  constructor(message: string, readonly payloadHashHex: string) { super(message) }
}
export interface SubmitTopicPostParams {
  topic: string
  entries: ForumMessageEntry[]
  parentPostHash?: Uint8Array
  direction: TopicVoteDirection
  burnAddress: string
  voteWeightWei: bigint
  overrides?: MonadTxOverrides
  waitForLease?: AcquireLeaseWhenAvailableOptions
  leaseIndex?: number
  timestampMs?: number
}
export interface SubmitTopicPostResult {
  payloadHashHex: string
  txHash: string
  leaseIndex: number
  postFrame: Uint8Array
  status: MatchedForumStatus
}

export class MonadTopicPostClient {
  constructor(private readonly wallet: MonadWalletHandle) {}
  async submitTopicPost(params: SubmitTopicPostParams, admission?: MonadWalletOperationAdmission): Promise<SubmitTopicPostResult> {
    requireForumWallet(this.wallet)
    assertForumAmount(params.voteWeightWei)
    if (params.direction !== 'up') throw new Error('A Forum post requires an up burn')
    if (params.entries.some(entry => entry.kind !== 'post')) throw new Error('Unsupported Forum entry kind')
    const ms = params.timestampMs ?? Date.now()
    if (!Number.isSafeInteger(ms)) throw new Error('Invalid Forum authored timestamp')
    const seconds = Math.floor(ms / 1000)
    const postFrame = encodeForumPost({
      network: this.wallet.cborNetwork!, topic: params.topic,
      ...(params.parentPostHash?.length ? { parentHash: params.parentPostHash } : {}),
      authored: { seconds: BigInt(seconds), nanoseconds: (ms - seconds * 1000) * 1_000_000 },
      entries: params.entries,
    })
    const { hash } = topicBurnCommitment(postFrame)
    const payloadHashHex = hexlify(hash).slice(2)
    return this.wallet.walletState!.runOperation(async admitted => {
      await reconcileForumOperations(this.wallet, 'post', admitted)
      await reconcileForumOperations(this.wallet, 'vote', admitted)
      try {
        const { operation, status } = await submitForumOperation(this.wallet, {
          kind: 'post', target: hash, direction: 'up', burnAddress: params.burnAddress,
          value: params.voteWeightWei, overrides: params.overrides, leaseIndex: params.leaseIndex,
          waitForLease: params.waitForLease, encode: raw => encodeTopicPostSubmission(postFrame, raw),
        }, admitted)
        return { payloadHashHex, txHash: operation.txHash, leaseIndex: operation.leaseIndex, postFrame, status }
      } catch (error) {
        if (error instanceof ForumOperationPendingError) throw new MonadTopicPostAbandonedError(error.message, payloadHashHex)
        throw error
      }
    }, admission)
  }
  async resumePendingOperations(admission?: MonadWalletOperationAdmission): Promise<void> {
    return reconcileForumOperations(this.wallet, 'post', admission)
  }
}
