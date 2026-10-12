import type { GatewayHostConfig } from './gateway-config';
import { openGatewayWallet } from './gateway-wallet';
import { openGatewayDirectory } from './gateway-directory';
import { createJournaledMailHost } from './journaled-mail-host';

/** Opens only an explicitly admitted testnet wallet and its matching mail journal. */
export async function startMailGateway(config: GatewayHostConfig): Promise<{ close(): Promise<void> }> {
  const clearSmtpCredentials = () => {
    config.nativeSmtp?.tlsKey.fill(0);
    config.nativeSmtp?.tlsCert.fill(0);
  };
  let opened: Awaited<ReturnType<typeof openGatewayWallet>>;
  try {
    opened = await openGatewayWallet({
      rootFile: config.rootFile,
      chain: config.chain,
      expectedIdentityAddress: config.expectedIdentityAddress,
    });
  } catch (error) {
    clearSmtpCredentials();
    throw error;
  }
  let host: ReturnType<typeof createJournaledMailHost> | undefined;
  let directory: Awaited<ReturnType<typeof openGatewayDirectory>> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let activePass: Promise<void> | undefined;
  let closed = false;
  try {
    const mailboxSalt = opened.replyAliasSalt();
    try {
      host = createJournaledMailHost({
        chain: opened.chain,
        wallet: opened.wallet,
        journalFile: config.journalFile,
        blobDirectory: config.blobDirectory,
        journalMode: config.journalMode,
        gatewayDomain: config.gatewayDomain,
        mailboxSalt,
        resendApiKey: config.resendApiKey,
        resendWebhookSecret: config.resendWebhookSecret,
        resendRawOrigins: config.resendRawOrigins,
        inboundStampValue: config.inboundStampValue,
        webhookHost: config.webhookHost,
        webhookPort: config.webhookPort,
        nativeSmtp: config.nativeSmtp,
      });
    } finally {
      mailboxSalt.fill(0);
    }
    directory = await openGatewayDirectory({
      wallet: opened.wallet,
      relayBaseUrl: config.relayBaseUrl,
      storageDirectory: config.directoryStorage,
    });
    await host.runtime.runOnce();
    await host.webhook.start();
    if (config.nativeSmtp) await host.smtp!.start(config.nativeSmtp.port, config.nativeSmtp.host);
    timer = setInterval(() => {
      if (activePass || closed) return;
      activePass = host!.runtime.runOnce().then(() => {
        if (!closed) {
          host!.webhook.setReady(true);
          host!.smtp?.setReady(true);
        }
      }, error => {
        host!.webhook.setReady(false);
        host!.smtp?.setReady(false);
        process.stderr.write(`Mail recovery pass failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
      }).finally(() => { activePass = undefined; });
    }, config.pollIntervalMs);
    return {
      async close() {
        if (closed) return;
        closed = true;
        if (timer) clearInterval(timer);
        host!.webhook.setReady(false);
        host!.smtp?.setReady(false);
        await activePass;
        try { await host!.close(); }
        finally {
          try { await directory!.close(); }
          finally {
            try { await opened.close(); }
            finally { clearSmtpCredentials(); }
          }
        }
      },
    };
  } catch (error) {
    if (timer) clearInterval(timer);
    try { await host?.close(); }
    finally {
      try { await directory?.close(); }
      finally {
        try { await opened.close(); }
        finally { clearSmtpCredentials(); }
      }
    }
    throw error;
  }
}
