#!/usr/bin/env node
import { EmailGatewayDaemon } from '../index';
import { GatewayConfig } from '../types';
import { GatewayStampProvider, GatewayWalletBalance, StampSubmissionResult } from '../stamps/stamp-provider.interface';

class DemoGatewayStampProvider implements GatewayStampProvider {
  readonly chainFamily = 'evm' as const;
  readonly assetUnit = 'MON';

  async stampAndSendDirectMessage(params: {
    recipientAddress: string;
    text?: string;
    conversationId?: string;
    inReplyToFrankMessageId?: string;
    relayUrl?: string;
  }): Promise<StampSubmissionResult> {
    console.log(`[mail-gateway:stamp] Stamping DM for recipient ${params.recipientAddress} (len=${params.text?.length ?? 0})`);
    return {
      txHash: `0xdemo_tx_${Date.now()}`,
      payloadDigest: `0xdemo_digest_${Date.now()}`,
      recipientAddress: params.recipientAddress,
    };
  }

  async checkHealth(): Promise<{ ok: boolean; message?: string; latencyMs?: number }> {
    return { ok: true, message: 'Demo Gateway Stamp Provider active', latencyMs: 1 };
  }

  async getBalance(): Promise<GatewayWalletBalance> {
    return {
      raw: 10000000000000000000n,
      display: '10.0 MON (Demo)',
      isLowBalance: false,
    };
  }
}

async function main(): Promise<void> {
  const gatewayDomain = process.env.GATEWAY_DOMAIN || 'frank.org';
  const gatewayRelayUrl = process.env.GATEWAY_RELAY_URL || 'http://backend:8080';
  const httpPort = parseInt(process.env.GATEWAY_HTTP_PORT || '8082', 10);
  const smtpPort = parseInt(process.env.GATEWAY_SMTP_PORT || '2525', 10);
  const dbPath = process.env.GATEWAY_DB_PATH || '/data/gateway.sqlite3';
  const provider = (process.env.BLOB_STORAGE_PROVIDER as 'local' | 's3' | 'memory') || 's3';

  const config: GatewayConfig = {
    gatewayDomain,
    gatewayRelayUrl,
    stampChain: 'monad',
    httpPort,
    smtpPort,
    dkimSelector: process.env.DKIM_SELECTOR || 'default',
    dkimPrivateKey: process.env.DKIM_PRIVATE_KEY || 'mock-dkim-key',
    lowBalanceThresholdWei: 1000n,
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || 'whsec_demo',
    stripePaymentLinkTier1: process.env.STRIPE_PAYMENT_LINK_TIER1,
    stripePaymentLinkTier2: process.env.STRIPE_PAYMENT_LINK_TIER2,
    stripePaymentLinkTier3: process.env.STRIPE_PAYMENT_LINK_TIER3,
    paypalClientId: process.env.PAYPAL_CLIENT_ID,
    paypalWebhookId: process.env.PAYPAL_WEBHOOK_ID,
    blobStorage: {
      provider,
      storageDir: process.env.BLOB_LOCAL_DIRECTORY || process.env.STORAGE_DIR || '/data/blobs',
      s3Endpoint: process.env.S3_ENDPOINT || 'http://minio:9000',
      s3Bucket: process.env.S3_BUCKET || 'frank-gateway-blobs',
      s3AccessKeyId: process.env.S3_ACCESS_KEY_ID || 'minioadmin',
      s3SecretAccessKey: process.env.S3_SECRET_ACCESS_KEY || 'minioadmin',
      s3Region: process.env.S3_REGION || 'us-east-1',
      s3ForcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
    },
  };

  const stampProvider = new DemoGatewayStampProvider();

  console.log(`[mail-gateway] Initializing daemon...`);
  console.log(`[mail-gateway]   Domain:    ${config.gatewayDomain}`);
  console.log(`[mail-gateway]   Relay:     ${config.gatewayRelayUrl}`);
  console.log(`[mail-gateway]   HTTP Port: ${config.httpPort}`);
  console.log(`[mail-gateway]   SMTP Port: ${config.smtpPort}`);
  console.log(`[mail-gateway]   Database:  ${dbPath}`);
  console.log(`[mail-gateway]   Storage:   ${provider} (Bucket: ${config.blobStorage?.s3Bucket ?? 'none'})`);

  const daemon = new EmailGatewayDaemon(config, stampProvider, { dbPath });
  await daemon.start();

  const shutdown = async () => {
    console.log('\n[mail-gateway] Received termination signal. Stopping daemon...');
    await daemon.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[mail-gateway] Fatal error during daemon startup:', err);
  process.exit(1);
});
