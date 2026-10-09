export interface BlobStorageConfig {
  readonly provider?: 'local' | 's3' | 'memory';
  readonly storageDir?: string;
  readonly s3Endpoint?: string;
  readonly s3Bucket?: string;
  readonly s3AccessKeyId?: string;
  readonly s3SecretAccessKey?: string;
  readonly s3Region?: string;
  readonly s3ForcePathStyle?: boolean;
}

export interface GatewayConfig {
  readonly gatewayDomain: string;
  readonly gatewayRelayUrl: string;
  readonly stampChain: 'monad' | 'ecash';
  readonly httpPort: number;
  readonly smtpPort: number;
  readonly dkimSelector: string;
  readonly dkimPrivateKey: string;
  readonly lowBalanceThresholdWei: bigint;
  readonly stripeSecretKey?: string;
  readonly stripeWebhookSecret?: string;
  readonly stripePaymentLinkTier1?: string;
  readonly stripePaymentLinkTier2?: string;
  readonly stripePaymentLinkTier3?: string;
  readonly paypalClientId?: string;
  readonly paypalWebhookId?: string;

  // Blob storage configuration
  readonly blobStorage?: BlobStorageConfig;
  readonly storageDir?: string;
  readonly s3Endpoint?: string;
  readonly s3Bucket?: string;
  readonly s3AccessKeyId?: string;
  readonly s3SecretAccessKey?: string;
  readonly s3Region?: string;
  readonly s3ForcePathStyle?: boolean;
}

export interface InboundEmail {
  readonly messageId: string;
  readonly fromAddress: string;
  readonly fromName?: string;
  readonly fromDomain: string;
  readonly toAddress: string;
  readonly toAddresses?: Array<{ address: string; name?: string }>;
  readonly ccAddresses?: Array<{ address: string; name?: string }>;
  readonly localPart: string;
  readonly subject: string;
  readonly textBody: string;
  readonly htmlBody?: string;
  readonly dkimValid: boolean;
  readonly spfValid: boolean;
  readonly inReplyTo?: string;
  readonly references?: string[];
  readonly rawRfc822: Uint8Array;
}

export interface HeldMessageRecord {
  readonly id: string;
  readonly senderEmail: string;
  readonly recipientAddress: string;
  readonly dkimDomain: string;
  readonly subject: string;
  readonly rawRfc822: Uint8Array;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly status: 'held' | 'released' | 'expired';
}

export interface ThreadMappingRecord {
  readonly conversationId: string;
  readonly frankMessageId: string;
  readonly rfc822MessageId: string;
  readonly inReplyToRfc822?: string;
  readonly subject?: string;
  readonly senderAddress?: string;
  readonly toRecipientsJson?: string;
  readonly ccRecipientsJson?: string;
  readonly senderHomeRelay?: string;
  readonly createdAtMs: number;
}

export interface OutboundSpoolJob {
  readonly id: number;
  readonly recipientEmail: string;
  readonly fromAddress: string;
  readonly rawRfc822: string;
  readonly attempts: number;
  readonly nextAttemptAt: number;
  readonly maxAttempts: number;
  readonly lastError?: string;
  readonly status: 'pending' | 'success' | 'failed';
}

// ---------------------------------------------------------------------------
// Mail journal records (#1237 G1, format 2 from G1b). See src/ledger/mail-journal.ts.
// ---------------------------------------------------------------------------

/**
 * Mail bytes held by a journal row: inline, or in the blob store under the
 * SHA-256 of the bytes (lowercase hex). Blob keys are content-addressed so a
 * stored key can never come to name different bytes.
 */
export type StoredMailBytes =
  | { readonly kind: 'inline'; readonly bytes: Uint8Array }
  | { readonly kind: 'blob'; readonly sha256: string };

export type MailDirection = 'email_to_frank' | 'frank_to_email';

export interface MailThreadRecord {
  readonly scopeAccount: string;
  readonly conversationId: string;
  readonly origin: 'email' | 'frank';
  readonly createdAtMs: number;
}

export interface MailMessageRecord {
  readonly scopeAccount: string;
  /** The identifier this message is known by in the scope. For a contested message, the regenerated local one. */
  readonly rfcMessageId: string;
  /** Set only on a contested message: the identifier it claimed, which another message holds. */
  readonly claimedRfcId?: string;
  /**
   * Identity of the RFC 5322 message: for an inbound message its `inbound_email`
   * key, for an outbound message the key of the emitted mail. Never compared
   * with an item key.
   */
  readonly mailKey: string;
  /** Outbound only: identity of the authored email item, independent of the seal. */
  readonly itemKey?: string;
  /** Outbound only: the payload digest of the Frank message this email was bridged from. */
  readonly payloadDigest?: string;
  readonly frankMessageId: string;
  readonly conversationId: string;
  readonly direction: MailDirection;
  readonly inReplyTo?: string;
  readonly createdAtMs: number;
}

export type InboundEmailDisposition = 'relay' | 'held' | 'released' | 'echo' | 'expired';

export interface InboundEmailRecord {
  readonly scopeAccount: string;
  readonly mailKey: string;
  /** The identifier the mail claimed (its Message-ID, or the synthetic one). */
  readonly rfcMessageId: string;
  readonly senderEmail: string;
  readonly dataSha256: string;
  /** Absent only on an `expired` row: the bytes of a mail that was never paid for are not kept. */
  readonly raw?: StoredMailBytes;
  readonly disposition: InboundEmailDisposition;
  readonly heldMessageId?: string;
  /** When a `held` mail may be expired. Absent once it is relayed, and on an echo. */
  readonly expiresAtMs?: number;
  readonly createdAtMs: number;
}

export type FrankSendSourceKind = 'inbound_email' | 'bounce' | 'reject';
export type FrankSendState = 'staged' | 'sending' | 'linked' | 'delivered' | 'held';

export interface FrankSendRecord {
  readonly slotId: number;
  readonly sourceKind: FrankSendSourceKind;
  readonly sourceKey: string;
  readonly frankMessageId: string;
  readonly payloadDigest?: string;
  readonly scopeAccount: string;
  readonly conversationId: string;
  readonly stampValue: string;
  readonly state: FrankSendState;
  readonly lastRefusedAtMs?: number;
  readonly failedCalls: number;
  readonly nextCallAtMs?: number;
  readonly holdReason?: string;
  readonly createdAtMs: number;
}

export type FrankInboundDisposition = 'bridged' | 'rejected' | 'quarantined' | 'resealed';

export const FRANK_INBOUND_REJECT_REASONS = [
  'no_email_item',
  'multiple_email_items',
  'no_sealed_identity',
  'bad_message_id',
  'bad_in_reply_to',
  'bad_reference',
  'bad_recipient',
  'header_unsafe',
  'header_too_long',
  'quota',
] as const;
export type FrankInboundRejectReason = (typeof FRANK_INBOUND_REJECT_REASONS)[number];

export interface FrankInboundRecord {
  readonly payloadDigest: string;
  readonly scopeAccount?: string;
  readonly frankMessageId?: string;
  readonly conversationId?: string;
  readonly receivedTimeMs: number;
  /**
   * The stamp the message carried: decimal text in the smallest unit of the
   * journal chain's native asset. `budget` and `spent` have the same form.
   */
  readonly stampValue: string;
  readonly budget: string;
  readonly spent: string;
  readonly disposition: FrankInboundDisposition;
  readonly reason?: string;
}

export type OutboundJobState = 'pending' | 'sent' | 'failed' | 'bounced';

export interface OutboundJobRecord {
  readonly jobId: number;
  readonly scopeAccount: string;
  /** The identifier the email goes out under; with the scope and the recipient, the job's key. */
  readonly rfcMessageId: string;
  readonly recipientEmail: string;
  /** Read from the job's `mail_message` row, as are `conversationId` and `payloadDigest`. */
  readonly frankMessageId: string;
  readonly conversationId: string;
  readonly payloadDigest: string;
  readonly bounceToken: string;
  readonly signedRfc822: StoredMailBytes;
  readonly state: OutboundJobState;
  readonly attempts: number;
  readonly nextAttemptAtMs: number;
  readonly lastError?: string;
  readonly createdAtMs: number;
}
