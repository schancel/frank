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
