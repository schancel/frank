import type { GatewayHostConfig } from '../src/host/gateway-config';
import { startMailGateway } from '../src/host/gateway-service';
import { openGatewayWallet } from '../src/host/gateway-wallet';
import { openGatewayDirectory } from '../src/host/gateway-directory';
import { createJournaledMailHost } from '../src/host/journaled-mail-host';

jest.mock('../src/host/gateway-wallet');
jest.mock('../src/host/gateway-directory');
jest.mock('../src/host/journaled-mail-host');

const walletOpen = jest.mocked(openGatewayWallet);
const directoryOpen = jest.mocked(openGatewayDirectory);
const hostCreate = jest.mocked(createJournaledMailHost);

describe('mail gateway executable lifecycle', () => {
  const order: string[] = [];
  const salt = new Uint8Array(32).fill(7);
  const config = {
    rootFile: '/private/roots', chain: { chainIdentifier: 'monad-testnet' },
    expectedIdentityAddress: `0x${'9'.repeat(40)}`,
    journalFile: '/private/mail.sqlite3', blobDirectory: '/private/blobs',
    journalMode: 'existing', gatewayDomain: 'signet.mx',
    resendApiKey: 're_test', resendWebhookSecret: 'whsec_test',
    resendRawOrigins: ['https://raw.example'], inboundStampValue: 1000n,
    webhookHost: '127.0.0.1', webhookPort: 8000,
    relayBaseUrl: 'https://relay.signet.mx', directoryStorage: '/private/directory',
    pollIntervalMs: 5_000,
  } as unknown as GatewayHostConfig;
  const poll = jest.fn(async () => { order.push('poll'); });
  const webhookStart = jest.fn(async () => { order.push('webhook start'); });
  const webhookStop = jest.fn(async () => { order.push('webhook stop'); });
  const webhookSetReady = jest.fn();
  const hostClose = jest.fn(async () => { await webhookStop(); });
  const directoryClose = jest.fn(async () => { order.push('directory close'); });
  const walletClose = jest.fn(async () => { order.push('wallet close'); });

  beforeEach(() => {
    order.length = 0;
    salt.fill(7);
    jest.clearAllMocks();
    walletOpen.mockResolvedValue({
      chain: config.chain, wallet: { identity: { address: { raw: config.expectedIdentityAddress } } },
      identityAddress: config.expectedIdentityAddress,
      replyAliasSalt: () => salt, close: walletClose,
    } as unknown as Awaited<ReturnType<typeof openGatewayWallet>>);
    hostCreate.mockReturnValue({
      runtime: { runOnce: poll }, webhook: { start: webhookStart, setReady: webhookSetReady }, close: hostClose,
    } as unknown as ReturnType<typeof createJournaledMailHost>);
    directoryOpen.mockImplementation(async () => {
      order.push('directory publish');
      return { close: directoryClose } as unknown as Awaited<ReturnType<typeof openGatewayDirectory>>;
    });
  });

  it('opens the bound wallet and journal before publishing, recovers before ingress, and closes in reverse order', async () => {
    const service = await startMailGateway(config);
    expect(order).toEqual(['directory publish', 'poll', 'webhook start']);
    expect(hostCreate).toHaveBeenCalledWith(expect.objectContaining({
      chain: config.chain, journalMode: 'existing', gatewayDomain: 'signet.mx',
    }));
    expect(salt.every(byte => byte === 0)).toBe(true);
    await service.close();
    expect(order).toEqual([
      'directory publish', 'poll', 'webhook start',
      'webhook stop', 'directory close', 'wallet close',
    ]);
  });

  it('reports optional challenge failure without gating ingress or later financial recovery', async () => {
    jest.useFakeTimers();
    const diagnostic = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const sendPendingHeldAutoReplies = jest.fn(async () => { throw new Error('Held auto-reply failures: 1'); });
    hostCreate.mockReturnValue({
      inbound: { sendPendingHeldAutoReplies },
      runtime: { runOnce: poll }, webhook: { start: webhookStart, setReady: webhookSetReady }, close: hostClose,
    } as unknown as ReturnType<typeof createJournaledMailHost>);
    let service: Awaited<ReturnType<typeof startMailGateway>> | undefined;
    try {
      service = await startMailGateway(config);
      expect(webhookStart).toHaveBeenCalledTimes(1);
      expect(sendPendingHeldAutoReplies).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(config.pollIntervalMs);
      expect(sendPendingHeldAutoReplies).toHaveBeenCalledTimes(1);
      expect(poll).toHaveBeenCalledTimes(2);
      expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining('Held auto-reply dispatch has unresolved failures'));
      expect(webhookSetReady).not.toHaveBeenCalledWith(false);
      await jest.advanceTimersByTimeAsync(config.pollIntervalMs);
      expect(poll).toHaveBeenCalledTimes(3);
    } finally {
      await service?.close();
      diagnostic.mockRestore();
      jest.useRealTimers();
    }
  });

  it('refuses a failed recovery pass and closes every opened owner without listening', async () => {
    poll.mockRejectedValueOnce(new Error('recovery failed'));
    await expect(startMailGateway(config)).rejects.toThrow('recovery failed');
    expect(webhookStart).not.toHaveBeenCalled();
    expect(order).toEqual(['directory publish', 'webhook stop', 'directory close', 'wallet close']);
  });

  it('does not construct transport when persistent wallet admission fails', async () => {
    walletOpen.mockRejectedValueOnce(new Error('wallet-state-binding-mismatch'));
    await expect(startMailGateway(config)).rejects.toThrow('wallet-state-binding-mismatch');
    expect(hostCreate).not.toHaveBeenCalled();
    expect(directoryOpen).not.toHaveBeenCalled();
    expect(webhookStart).not.toHaveBeenCalled();
  });

  it('starts optional SMTP after recovery and withdraws readiness before shutdown', async () => {
    const tlsKey = Buffer.from('synthetic-key');
    const tlsCert = Buffer.from('synthetic-cert');
    const smtpStart = jest.fn(async () => { order.push('smtp start'); });
    const smtpReady = jest.fn();
    hostCreate.mockReturnValue({
      runtime: { runOnce: poll }, webhook: { start: webhookStart, setReady: webhookSetReady },
      smtp: { start: smtpStart, setReady: smtpReady }, close: hostClose,
    } as unknown as ReturnType<typeof createJournaledMailHost>);
    const withSmtp = { ...config, nativeSmtp: {
      host: '127.0.0.1', port: 2525, hostname: 'mail.signet.mx', tlsKey, tlsCert,
    } };
    const service = await startMailGateway(withSmtp);
    expect(order).toEqual(['directory publish', 'poll', 'webhook start', 'smtp start']);
    expect(smtpStart).toHaveBeenCalledWith(2525, '127.0.0.1');
    await service.close();
    expect(smtpReady).toHaveBeenCalledWith(false);
    expect(tlsKey.every(byte => byte === 0)).toBe(true);
    expect(tlsCert.every(byte => byte === 0)).toBe(true);
  });

  it('closes all opened owners and clears TLS input if SMTP bind fails', async () => {
    const tlsKey = Buffer.from('synthetic-key');
    const tlsCert = Buffer.from('synthetic-cert');
    const smtpStart = jest.fn(async () => { throw new Error('smtp bind failed'); });
    hostCreate.mockReturnValue({
      runtime: { runOnce: poll }, webhook: { start: webhookStart, setReady: webhookSetReady },
      smtp: { start: smtpStart, setReady: jest.fn() }, close: hostClose,
    } as unknown as ReturnType<typeof createJournaledMailHost>);
    await expect(startMailGateway({ ...config, nativeSmtp: {
      host: '127.0.0.1', port: 2525, hostname: 'mail.signet.mx', tlsKey, tlsCert,
    } })).rejects.toThrow('smtp bind failed');
    expect(order).toEqual(['directory publish', 'poll', 'webhook start',
      'webhook stop', 'directory close', 'wallet close']);
    expect(tlsKey.every(byte => byte === 0)).toBe(true);
    expect(tlsCert.every(byte => byte === 0)).toBe(true);
  });
});
