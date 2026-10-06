export * from './types';
export * from './stamps/stamp-provider.interface';
export * from './stamps/monad-stamp-provider';
export * from './stamps/ecash-stamp-provider';
export * from './ledger/credit-ledger';
export * from './http/checkout-server';
export * from './smtp/inbound-server';
export * from './smtp/smtp-listener';
export * from './mta/outbound-delivery';
export * from './mta/mx-transport';

import { CreditLedger } from './ledger/credit-ledger';
import { CheckoutServer } from './http/checkout-server';
import { InboundEmailHandler } from './smtp/inbound-server';
import { SmtpListener } from './smtp/smtp-listener';
import { OutboundEmailDelivery } from './mta/outbound-delivery';
import { MxDirectTransport } from './mta/mx-transport';
import { GatewayStampProvider } from './stamps/stamp-provider.interface';
import { GatewayConfig } from './types';

export class EmailGatewayDaemon {
  readonly config: GatewayConfig;
  readonly ledger: CreditLedger;
  readonly checkoutServer: CheckoutServer;
  readonly inboundHandler: InboundEmailHandler;
  readonly smtpListener: SmtpListener;
  readonly outboundDelivery: OutboundEmailDelivery;
  readonly mxTransport: MxDirectTransport;

  constructor(config: GatewayConfig, stampProvider: GatewayStampProvider) {
    this.config = config;
    this.ledger = new CreditLedger('./gateway.sqlite3');
    this.checkoutServer = new CheckoutServer({
      port: config.httpPort,
      ledger: this.ledger,
      stampProvider,
      stripeWebhookSecret: config.stripeWebhookSecret,
      paypalWebhookId: config.paypalWebhookId,
    });
    this.inboundHandler = new InboundEmailHandler({
      gatewayDomain: config.gatewayDomain,
      ledger: this.ledger,
      stampProvider,
    });
    this.smtpListener = new SmtpListener({
      gatewayDomain: config.gatewayDomain,
      handler: this.inboundHandler,
    });
    this.outboundDelivery = new OutboundEmailDelivery({
      gatewayDomain: config.gatewayDomain,
      ledger: this.ledger,
    });
    this.mxTransport = new MxDirectTransport({
      heloDomain: config.gatewayDomain,
    });
  }

  async start(): Promise<void> {
    console.log(`[mail-gateway] Starting Email Gateway for domain: ${this.config.gatewayDomain}`);
    await this.checkoutServer.start();
    console.log(`[mail-gateway] Checkout HTTP server listening on port ${this.config.httpPort}`);
    await this.smtpListener.start(this.config.smtpPort);
    console.log(`[mail-gateway] Inbound SMTP server listening on port ${this.config.smtpPort}`);
  }

  async stop(): Promise<void> {
    await this.smtpListener.stop();
    await this.checkoutServer.stop();
    console.log('[mail-gateway] Gateway shutdown complete.');
  }
}
