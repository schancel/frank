/** Forum feature capability. The active wallet owns chain execution and durable recovery. */
import type {
  AccountRef,
  ForumOperationStatus,
  ParsedFrame,
} from '@frank/codec'

export type TopicVoteDirection = 'up' | 'down'
export type TopicOperationStatus = ForumOperationStatus<ParsedFrame>
export interface TopicAuthor {
  readonly account: AccountRef
  signDigest(digest: Uint8Array): Uint8Array | Promise<Uint8Array>
}
export interface TopicOperationRequest {
  readonly kind: 'post' | 'vote'
  readonly target: Uint8Array
  readonly direction: TopicVoteDirection
  readonly amountAtomic: bigint
  readonly operationId?: string
  readonly postFrame?: Uint8Array
}
export interface TopicOperationResult {
  readonly transactionSetHash: string
  readonly transactionHashes: string[]
  readonly status: TopicOperationStatus
}
export interface TopicOperationCapability {
  readonly chainIdentifier: string
  readonly author?: TopicAuthor
  submit(request: TopicOperationRequest): Promise<TopicOperationResult>
  reconcile(kind: 'post' | 'vote'): Promise<void>
}
export interface TopicWalletHandle {
  readonly chainIdentifier: string
  readonly topicOperations?: TopicOperationCapability
}
export class TopicUnsupportedError extends Error {
  constructor(chainIdentifier: string) {
    super(`Forum operations are unsupported on ${chainIdentifier}`)
    this.name = 'TopicUnsupportedError'
  }
}
export class TopicOperationPendingError extends Error {
  constructor(message: string, readonly cause: unknown) {
    super(message)
    this.name = 'TopicOperationPendingError'
  }
}
export function requireTopicOperations(
  wallet: TopicWalletHandle,
): TopicOperationCapability {
  const operations = wallet.topicOperations
  if (!operations) throw new TopicUnsupportedError(wallet.chainIdentifier)
  if (operations.chainIdentifier !== wallet.chainIdentifier)
    throw new Error('Forum capability belongs to a different chain')
  return operations
}
export function assertTopicAmount(amount: bigint): void {
  if (amount < 1n || amount > (1n << 63n) - 1n)
    throw new Error('Forum burn must be 1..i64::MAX atomic units')
}
