import { MessageWrapper } from '../../types/messages'

/** Relay receipt clocks may be slightly ahead of the client, but never arbitrarily far ahead. */
export const MAX_RELAY_FUTURE_SKEW_MS = 5 * 60 * 1000

export function isSafeRelayTimestamp(
  value: unknown,
  now = Date.now(),
): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= now + MAX_RELAY_FUTURE_SKEW_MS
  )
}

/** Cursor is the exclusive millisecond immediately after a receipt timestamp. */
export function isSafeRelayCursor(
  value: unknown,
  now = Date.now(),
): value is number {
  return (
    typeof value === 'number' &&
    (value === 0 || isSafeRelayTimestamp(value - 1, now))
  )
}

export type RelayReceiptIdentity = {
  payloadDigest: string
  receivedTime: number
}

export type RelayDeliverySuppression = {
  payloadDigest: string
  /** Known for a receipt already seen; absent while waiting for a delayed receipt. */
  receivedTime?: number
}
export class MessageResult implements IteratorYieldResult<MessageWrapper> {
  done: false
  value: MessageWrapper

  constructor(value: MessageWrapper) {
    this.done = false
    this.value = value
  }
}

export class MessageReturnResult
  implements IteratorReturnResult<MessageWrapper | undefined>
{
  done: true
  value: MessageWrapper | undefined

  constructor(value: MessageWrapper | undefined = undefined) {
    this.done = true
    this.value = value
  }
}

export interface MessageStore {
  getMessage(payloadDigest: string): Promise<MessageWrapper | undefined>
  saveMessage(
    message: MessageWrapper,
    options?: { advanceCursor?: boolean },
  ): Promise<void>
  deleteMessage(payloadDigest: string): Promise<void>
  mostRecentMessageTime(newLastServerTime?: number): Promise<number>
  relayCursor(recipientAddress: string): Promise<number>
  advanceRelayCursor(
    recipientAddress: string,
    nextReceivedTime: number,
    suppressedReceipts?: RelayReceiptIdentity[],
  ): Promise<number>
  suppressAndDelete(
    recipientAddress: string,
    payloadDigests: string[],
    suppressions: RelayDeliverySuppression[],
  ): Promise<void>
  suppressedRelayReceipts(
    recipientAddress: string,
    receipts: RelayReceiptIdentity[],
  ): Promise<Set<string>>
  getIterator(): Promise<AsyncIterableIterator<MessageWrapper>>
  clear(): Promise<void>
}
