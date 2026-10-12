import type { OutgoingFinancialOperation } from "../../types/messages";
import protocol from "../../../../docs/protocol/chains/v1.json";
import { MAX_PAYMENT_MEMBERS } from "@frank/codec";
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

/** Host-owned binding to the messaging owner's original envelope. No funds or bytes live here.
 * Kept independently of chat rows, including UI deletion and history clearing. */
interface FinancialEnvelopeIntent {
  readonly version: 1;
  readonly accountId: string;
  readonly messagingChainIdentifier: string;
  readonly messageId: string;
  readonly financialOperations: readonly OutgoingFinancialOperation[];
}
export type FinancialEnvelopeBinding = FinancialEnvelopeIntent &
  (
    | { readonly phase: "pending"; readonly payloadDigest?: never }
    | { readonly phase: "bound"; readonly payloadDigest: string }
  );
export function financialEnvelopeBinding(
  value: unknown
): FinancialEnvelopeBinding {
  if (!value || typeof value !== "object")
    throw new Error("Invalid financial envelope binding");
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).some(
      (key) =>
        ![
          "version",
          "phase",
          "accountId",
          "messagingChainIdentifier",
          "messageId",
          "payloadDigest",
          "financialOperations",
        ].includes(key)
    )
  )
    throw new Error("Unknown financial envelope binding field");
  const canonical = (id: unknown): id is string =>
    typeof id === "string" && protocol.chains.some((chain) => chain.id === id);
  if (
    row.version !== 1 ||
    typeof row.accountId !== "string" ||
    !row.accountId.length ||
    row.accountId.length > 512 ||
    !canonical(row.messagingChainIdentifier) ||
    typeof row.messageId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      row.messageId
    ) ||
    (row.phase !== "pending" && row.phase !== "bound") ||
    (row.phase === "pending"
      ? row.payloadDigest !== undefined
      : typeof row.payloadDigest !== "string" ||
        !/^[0-9a-f]{64}$/.test(row.payloadDigest)) ||
    !Array.isArray(row.financialOperations) ||
    !row.financialOperations.length ||
    row.financialOperations.length > MAX_PAYMENT_MEMBERS
  )
    throw new Error("Invalid financial envelope binding");
  const seen = new Set<string>();
  const financialOperations = row.financialOperations.map((entry: unknown) => {
    if (!entry || typeof entry !== "object")
      throw new Error("Invalid financial operation reference");
    const ref = entry as Record<string, unknown>;
    if (
      Object.keys(ref).some(
        (key) => !["chainIdentifier", "operationId"].includes(key)
      )
    )
      throw new Error("Unknown financial operation reference field");
    if (
      !canonical(ref.chainIdentifier) ||
      typeof ref.operationId !== "string" ||
      !ref.operationId.length ||
      ref.operationId.length > 512
    )
      throw new Error("Invalid financial operation reference");
    const key = JSON.stringify([ref.chainIdentifier, ref.operationId]);
    if (seen.has(key))
      throw new Error("Duplicate financial operation reference");
    seen.add(key);
    return {
      chainIdentifier: ref.chainIdentifier,
      operationId: ref.operationId,
    };
  });
  return {
    version: 1,
    accountId: row.accountId,
    messagingChainIdentifier: row.messagingChainIdentifier,
    messageId: row.messageId,
    ...(row.phase === "bound"
      ? { phase: "bound" as const, payloadDigest: row.payloadDigest as string }
      : { phase: "pending" as const }),
    financialOperations,
  };
}

export interface MessageStore {
  /** Immutable intent with one pending-to-bound transition; conflicts reject before exposure. */
  bindFinancialEnvelope(binding: FinancialEnvelopeBinding): Promise<void>;
  /** Read-only host recovery facts; never opens custody or initializes defaults. */
  financialEnvelopeBindings(scope: {
    accountId: string;
    messagingChainIdentifier: string;
  }): Promise<readonly FinancialEnvelopeBinding[]>;
  getMessage(payloadDigest: string): Promise<MessageWrapper | undefined>;
  saveMessage(
    message: MessageWrapper,
    options?: { advanceCursor?: boolean }
  ): Promise<void>;
  deleteMessage(payloadDigest: string): Promise<void>;
  /** Read-only server timestamp; advancement belongs to saveMessage. */
  mostRecentMessageTime(): Promise<number>;
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
  /** May persist a newly observed time for an existing unresolved suppression anchor. */
  suppressedRelayReceipts(
    recipientAddress: string,
    receipts: RelayReceiptIdentity[]
  ): Promise<Set<string>>;
  getIterator(): Promise<AsyncIterableIterator<MessageWrapper>>;
  clear(): Promise<void>;
}
