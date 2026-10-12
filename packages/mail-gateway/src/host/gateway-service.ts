import type { GatewayHostConfig } from './gateway-config';
import { openGatewayWallet } from './gateway-wallet';
import { openGatewayDirectory } from './gateway-directory';
import { createJournaledMailHost } from './journaled-mail-host';

/** Opens only an explicitly admitted testnet wallet and its matching mail journal. */
export async function startMailGateway(config: GatewayHostConfig): Promise<{ close(): Promise<void> }> {
  const opened = await openGatewayWallet({
    rootFile: config.rootFile,
    chain: config.chain,
    expectedIdentityAddress: config.expectedIdentityAddress,
  });
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
    timer = setInterval(() => {
      if (activePass || closed) return;
      activePass = host!.runtime.runOnce().then(() => {
        host!.webhook.setReady(true);
      }, error => {
        host!.webhook.setReady(false);
        process.stderr.write(`Mail recovery pass failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
      }).finally(() => { activePass = undefined; });
    }, config.pollIntervalMs);
    return {
      async close() {
        if (closed) return;
        closed = true;
        if (timer) clearInterval(timer);
        await activePass;
        try { await host!.close(); }
        finally {
          try { await directory!.close(); }
          finally { await opened.close(); }
        }
      },
    };
  } catch (error) {
    if (timer) clearInterval(timer);
    try { await host?.close(); }
    finally {
      try { await directory?.close(); }
      finally { await opened.close(); }
    }
    throw error;
  }
}
