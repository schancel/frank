export * from './types';
export * from './stamps/stamp-provider.interface';
export * from './stamps/monad-stamp-provider';
export * from './stamps/ecash-stamp-provider';
export * from './storage/blob-store';
export * from './storage/local-fs-blob-store';
export * from './storage/s3-blob-store';
export * from './ledger/schema';
export * from './ledger/database';
export * from './ledger/credit-ledger';
export * from './http/checkout-server';
export * from './smtp/inbound-server';
export * from './smtp/smtp-listener';
export * from './mta/outbound-delivery';
export * from './mta/mx-transport';
export * from './mta/dkim-signer';
export * from './mta/outbound-worker';
export * from './relay/mailbox-listener';
export * from './dns/domain-resolver';

import { BlobStore, createBlobStore } from './storage/blob-store';
import { CreditLedger } from './ledger/credit-ledger';
import { CheckoutServer } from './http/checkout-server';
import { InboundEmailHandler } from './smtp/inbound-server';
import { SmtpListener } from './smtp/smtp-listener';
import { OutboundEmailDelivery } from './mta/outbound-delivery';
import { MxDirectTransport } from './mta/mx-transport';
import { DkimSigner } from './mta/dkim-signer';
import { OutboundMtaWorker } from './mta/outbound-worker';
import { RelayMailboxListener } from './relay/mailbox-listener';
import { GatewayStampProvider } from './stamps/stamp-provider.interface';
import { GatewayConfig } from './types';
import type { ActiveChain, WalletHandle } from '@frank/wallet/chain/active-chain';

export class EmailGatewayDaemon {
  readonly config: GatewayConfig;
  readonly blobStore: BlobStore;
  readonly ledger: CreditLedger;
  readonly checkoutServer: CheckoutServer;
  readonly inboundHandler: InboundEmailHandler;
  readonly smtpListener: SmtpListener;
  readonly outboundDelivery: OutboundEmailDelivery;
  readonly mxTransport: MxDirectTransport;
  readonly dkimSigner: DkimSigner;
  readonly outboundWorker: OutboundMtaWorker;
  readonly mailboxListener?: RelayMailboxListener;

  constructor(
    config: GatewayConfig,
    stampProvider: GatewayStampProvider,
    options?: {
      dbPath?: string;
      blobStore?: BlobStore;
      activeChain?: ActiveChain;
      wallet?: WalletHandle;
    }
  ) {
    this.config = config;
    this.blobStore = options?.blobStore ?? createBlobStore(config);
    this.ledger = new CreditLedger(options?.dbPath ?? './gateway.sqlite3', this.blobStore);
    this.outboundDelivery = new OutboundEmailDelivery({
      gatewayDomain: config.gatewayDomain,
      ledger: this.ledger,
    });
    this.checkoutServer = new CheckoutServer({
      port: config.httpPort,
      ledger: this.ledger,
      stampProvider,
      stripeWebhookSecret: config.stripeWebhookSecret,
      paypalWebhookId: config.paypalWebhookId,
      outboundDelivery: this.outboundDelivery,
      stripePaymentLinkTier1: config.stripePaymentLinkTier1,
      stripePaymentLinkTier2: config.stripePaymentLinkTier2,
      stripePaymentLinkTier3: config.stripePaymentLinkTier3,
    });
    this.inboundHandler = new InboundEmailHandler({
      gatewayDomain: config.gatewayDomain,
      relayUrl: config.gatewayRelayUrl,
      ledger: this.ledger,
      stampProvider,
      blobStore: this.blobStore,
    });
    this.smtpListener = new SmtpListener({
      gatewayDomain: config.gatewayDomain,
      handler: this.inboundHandler,
    });
    this.mxTransport = new MxDirectTransport({
      heloDomain: config.gatewayDomain,
    });
    this.dkimSigner = new DkimSigner({
      domain: config.gatewayDomain,
      selector: config.dkimSelector,
      privateKey: config.dkimPrivateKey,
    });
    this.outboundWorker = new OutboundMtaWorker({
      gatewayDomain: config.gatewayDomain,
      ledger: this.ledger,
      delivery: this.outboundDelivery,
      dkimSigner: this.dkimSigner,
      mxTransport: this.mxTransport,
      blobStore: this.blobStore,
    });

    if (options?.activeChain && options?.wallet) {
      this.mailboxListener = new RelayMailboxListener({
        gatewayDomain: config.gatewayDomain,
        activeChain: options.activeChain,
        wallet: options.wallet,
        ledger: this.ledger,
        outboundWorker: this.outboundWorker,
        relayUrl: config.gatewayRelayUrl,
      });
    }
  }

  async start(): Promise<void> {
    console.log(`[mail-gateway] Starting Email Gateway for domain: ${this.config.gatewayDomain}`);
    await this.checkoutServer.start();
    console.log(`[mail-gateway] Checkout HTTP server listening on port ${this.config.httpPort}`);
    await this.smtpListener.start(this.config.smtpPort);
    console.log(`[mail-gateway] Inbound SMTP server listening on port ${this.config.smtpPort}`);
    this.outboundWorker.startSpoolProcessor();
    if (this.mailboxListener) {
      await this.mailboxListener.start();
      console.log(`[mail-gateway] Relay Mailbox Listener started for ${this.config.gatewayRelayUrl}`);
    }
  }

  async stop(): Promise<void> {
    if (this.mailboxListener) {
      await this.mailboxListener.stop();
    }
    this.outboundWorker.stopSpoolProcessor();
    await this.smtpListener.stop();
    await this.checkoutServer.stop();
    console.log('[mail-gateway] Gateway shutdown complete.');
  }
}
