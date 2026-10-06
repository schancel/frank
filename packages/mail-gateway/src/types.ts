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
  readonly paypalClientId?: string;
  readonly paypalWebhookId?: string;
}

export interface InboundEmail {
  readonly messageId: string;
  readonly fromAddress: string;
  readonly fromDomain: string;
  readonly toAddress: string;
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
  readonly createdAtMs: number;
}
