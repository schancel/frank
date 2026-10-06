import type { MessageItem } from '@frank/cashweb/types/messages';

export interface GatewayWalletBalance {
  readonly raw: bigint;
  readonly display: string;
  readonly isLowBalance: boolean;
}

export interface StampSubmissionResult {
  readonly txHash: string;
  readonly payloadDigest: string;
  readonly recipientAddress: string;
  readonly relayResponse?: unknown;
}

export interface GatewayStampProvider {
  readonly chainFamily: 'evm' | 'bitcoin' | 'solana';
  readonly assetUnit: string;

  /** Health check and native balance query. */
  getBalance(): Promise<GatewayWalletBalance>;
  checkHealth(): Promise<{ ok: boolean; message?: string }>;

  /** Stamp and send a direct message to a Frank recipient. */
  stampAndSendDirectMessage(params: {
    recipientAddress: string;
    items?: MessageItem[];
    text?: string;
    conversationId?: string;
    inReplyToFrankMessageId?: string;
    relayUrl?: string;
  }): Promise<StampSubmissionResult>;

  /** Clean up resources or account leases. */
  close?(): Promise<void>;
}
