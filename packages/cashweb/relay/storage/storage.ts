import { MessageWrapper } from "../../types/messages";

/** Relay receipt clocks may be slightly ahead of the client, but never arbitrarily far ahead. */
export const MAX_RELAY_FUTURE_SKEW_MS = 5 * 60 * 1000;

export function isSafeRelayTimestamp(
  value: unknown,
  now = Date.now()
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= now + MAX_RELAY_FUTURE_SKEW_MS
  );
}

/** Cursor is the exclusive millisecond immediately after a receipt timestamp. */
export function isSafeRelayCursor(
  value: unknown,
  now = Date.now()
): value is number {
  return (
    typeof value === "number" &&
    (value === 0 || isSafeRelayTimestamp(value - 1, now))
  );
}

export type RelayReceiptIdentity = {
  payloadDigest: string;
  receivedTime: number;
};

export type RelayDeliverySuppression = {
  payloadDigest: string;
  /** Known for a receipt already seen; absent while waiting for a delayed receipt. */
  receivedTime?: number;
};
export class MessageResult implements IteratorYieldResult<MessageWrapper> {
  done: false;
  value: MessageWrapper;

  constructor(value: MessageWrapper) {
    this.done = false;
    this.value = value;
  }
}

export class MessageReturnResult
  implements IteratorReturnResult<MessageWrapper | undefined>
{
  done: true;
  value: MessageWrapper | undefined;

  constructor(value: MessageWrapper | undefined = undefined) {
    this.done = true;
    this.value = value;
  }
}

export interface MessageStore {
  getMessage(payloadDigest: string): Promise<MessageWrapper | undefined>;
  saveMessage(
    message: MessageWrapper,
    options?: { advanceCursor?: boolean }
  ): Promise<void>;
  deleteMessage(payloadDigest: string): Promise<void>;
  mostRecentMessageTime(newLastServerTime?: number): Promise<number>;
  /**
   * Recipient-scoped mailbox frontier, as an INCLUSIVE relay timestamp: the highest durable
   * receipt time this store holds evidence for, so a poll that resumes here re-fetches that
   * whole timestamp group and dedupes by digest. There is no separately persisted cursor row:
   * the frontier is derived from the same durable records (message receipts, suppression and
   * quarantine anchors) that justify it, so no crash state can exist where saved progress
   * outruns a receipt that was lost (see `level-storage.ts`'s header).
   */
  relayCursor(recipientAddress: string): Promise<number>;
  /**
   * Durably records receipts that are terminally undeliverable (e.g. the registry
   * authoritatively has no profile for the sender). A quarantined receipt anchors the frontier
   * like a delivered one, so a hostile or permanently unregistered sender cannot pin the bounded
   * inbox scan; unlike suppression it does not hide a re-fetched row -- the row is simply
   * classified again (and re-quarantined) if the anchor write was ever lost.
   */
  quarantineRelayReceipts(
    recipientAddress: string,
    receipts: RelayReceiptIdentity[]
  ): Promise<void>;
  suppressAndDelete(
    recipientAddress: string,
    payloadDigests: string[],
    suppressions: RelayDeliverySuppression[]
  ): Promise<void>;
  suppressedRelayReceipts(
    recipientAddress: string,
    receipts: RelayReceiptIdentity[]
  ): Promise<Set<string>>;
  getIterator(): Promise<AsyncIterableIterator<MessageWrapper>>;
  clear(): Promise<void>;
}
