import type { GatewayHostConfig } from '../src/host/gateway-config';
import { startMailGateway } from '../src/host/gateway-service';
import { openGatewayWallet } from '../src/host/gateway-wallet';
import { openGatewayDirectory } from '../src/host/gateway-directory';
import { registerMonadIdentityCbor } from '@frank/wallet/evm-identity';
import { createJournaledMailHost } from '../src/host/journaled-mail-host';

jest.mock('@frank/wallet/evm-identity', () => ({ registerMonadIdentityCbor: jest.fn() }));
jest.mock('../src/host/gateway-wallet');
jest.mock('../src/host/gateway-directory');
jest.mock('../src/host/journaled-mail-host');

const profileRegister = jest.mocked(registerMonadIdentityCbor);
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
  const sendPendingHeldAutoReplies = jest.fn(async () => undefined);
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
    profileRegister.mockImplementation(async () => { order.push('profile publish'); });
    walletOpen.mockResolvedValue({
      chain: config.chain, wallet: { chainIdentifier: 'monad-testnet', identity: { address: { raw: config.expectedIdentityAddress } } },
      identityAddress: config.expectedIdentityAddress,
      replyAliasSalt: () => salt, close: walletClose,
    } as unknown as Awaited<ReturnType<typeof openGatewayWallet>>);
    hostCreate.mockReturnValue({
      inbound: { sendPendingHeldAutoReplies },
      runtime: { runOnce: poll }, webhook: { start: webhookStart, setReady: webhookSetReady }, close: hostClose,
    } as unknown as ReturnType<typeof createJournaledMailHost>);
    directoryOpen.mockImplementation(async () => {
      order.push('directory publish');
      return { close: directoryClose } as unknown as Awaited<ReturnType<typeof openGatewayDirectory>>;
    });
  });

  it('opens the bound wallet and journal before publishing, recovers before ingress, and closes in reverse order', async () => {
    const service = await startMailGateway(config);
    expect(order).toEqual(['directory publish', 'profile publish', 'poll', 'webhook start']);
    expect(hostCreate).toHaveBeenCalledWith(expect.objectContaining({
      chain: config.chain, journalMode: 'existing', gatewayDomain: 'signet.mx',
    }));
    expect(salt.every(byte => byte === 0)).toBe(true);
    await service.close();
    expect(order).toEqual([
      'directory publish', 'profile publish', 'poll', 'webhook start',
      'webhook stop', 'directory close', 'wallet close',
    ]);
  });

  it('reports profile and challenge failures independently without gating ingress or financial recovery', async () => {
    jest.useFakeTimers();
    const diagnostic = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    profileRegister.mockRejectedValueOnce(new Error('profile unavailable'));
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
      expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining('profile publication failed; retrying in 60s'));
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

  it('publishes a signed service profile for the existing wallet before ingress, including on restart', async () => {
    const service = await startMailGateway(config);
    expect(profileRegister).toHaveBeenCalledWith({
      relayBaseUrl: config.relayBaseUrl,
      identity: (await walletOpen.mock.results[0].value).wallet.identity,
      network: 'monad-testnet',
      signal: expect.any(AbortSignal),
      profile: {
        name: 'Frank Email Gateway',
        bio: 'Email bridge between Frank and Internet email at signet.mx.',
        avatar: expect.stringMatching(/^data:image\/png;base64,/),
        bot: true, accountType: 2, botRole: 4,
      },
    });
    await service.close();
    const restarted = await startMailGateway(config);
    expect(profileRegister).toHaveBeenCalledTimes(2);
    await restarted.close();
  });

  it('keeps recovery and ingress running after profile failure, then retries the same identity', async () => {
    jest.useFakeTimers();
    const warning = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
    profileRegister.mockRejectedValueOnce(new Error('profile rejected'));
    const service = await startMailGateway(config);
    expect(poll).toHaveBeenCalled();
    expect(webhookStart).toHaveBeenCalledTimes(1);
    expect(walletClose).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('publication failed; retrying in 60s: profile rejected'));
    await jest.advanceTimersByTimeAsync(60_000);
    expect(profileRegister).toHaveBeenCalledTimes(2);
    expect(profileRegister.mock.calls[0][0].identity).toBe(profileRegister.mock.calls[1][0].identity);
    await jest.advanceTimersByTimeAsync(120_000);
    expect(profileRegister).toHaveBeenCalledTimes(2);
    await service.close();
    warning.mockRestore();
    jest.useRealTimers();
  });

  it('does not hold financial recovery for slow profile requests, and aborts them before custody closes', async () => {
    let signal: AbortSignal | undefined;
    profileRegister.mockImplementationOnce(options => {
      signal = options.signal;
      return new Promise((_, reject) => {
        signal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      });
    });
    const service = await startMailGateway(config);
    expect(signal!.aborted).toBe(false);
    expect(poll).toHaveBeenCalled();
    expect(webhookStart).toHaveBeenCalled();
    expect(profileRegister).toHaveBeenCalledTimes(1);
    await service.close();
    expect(signal!.aborted).toBe(true);
    expect(walletClose).toHaveBeenCalledTimes(1);
  });

  it('cancels profile requests and waits for active challenge delivery before closing custody', async () => {
    jest.useFakeTimers();
    let signal: AbortSignal | undefined;
    let finishChallenge!: () => void;
    sendPendingHeldAutoReplies.mockImplementationOnce(() => new Promise(resolve => { finishChallenge = () => resolve(undefined); }));
    profileRegister.mockImplementationOnce(options => {
      signal = options.signal;
      return new Promise((_, reject) => {
        signal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      });
    });
    const service = await startMailGateway(config);
    await jest.advanceTimersByTimeAsync(config.pollIntervalMs);
    const closing = service.close();
    expect(signal!.aborted).toBe(true);
    await Promise.resolve();
    expect(walletClose).not.toHaveBeenCalled();
    expect(hostClose).not.toHaveBeenCalled();
    finishChallenge();
    await closing;
    expect(walletClose).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(120_000);
    expect(profileRegister).toHaveBeenCalledTimes(1);
    expect(sendPendingHeldAutoReplies).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  it('cancels pending retries when startup recovery fails', async () => {
    jest.useFakeTimers();
    const warning = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
    profileRegister.mockRejectedValueOnce(new Error('profile unavailable'));
    poll.mockRejectedValueOnce(new Error('recovery failed'));
    await expect(startMailGateway(config)).rejects.toThrow('recovery failed');
    await jest.advanceTimersByTimeAsync(120_000);
    expect(profileRegister).toHaveBeenCalledTimes(1);
    expect(walletClose).toHaveBeenCalledTimes(1);
    poll.mockImplementation(async () => { order.push('poll'); });
    const restarted = await startMailGateway(config);
    expect(profileRegister).toHaveBeenCalledTimes(2);
    expect(profileRegister.mock.calls[0][0].identity.address.raw).toBe(config.expectedIdentityAddress);
    expect(profileRegister.mock.calls[1][0].identity.address.raw).toBe(config.expectedIdentityAddress);
    await restarted.close();
    warning.mockRestore();
    jest.useRealTimers();
  });

  it('refuses a failed recovery pass and closes every opened owner without listening', async () => {
    poll.mockRejectedValueOnce(new Error('recovery failed'));
    await expect(startMailGateway(config)).rejects.toThrow('recovery failed');
    expect(webhookStart).not.toHaveBeenCalled();
    expect(order).toEqual(['directory publish', 'profile publish', 'webhook stop', 'directory close', 'wallet close']);
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
      inbound: { sendPendingHeldAutoReplies },
      runtime: { runOnce: poll }, webhook: { start: webhookStart, setReady: webhookSetReady },
      smtp: { start: smtpStart, setReady: smtpReady }, close: hostClose,
    } as unknown as ReturnType<typeof createJournaledMailHost>);
    const withSmtp = { ...config, nativeSmtp: {
      host: '127.0.0.1', port: 2525, hostname: 'mail.signet.mx', tlsKey, tlsCert,
    } };
    const service = await startMailGateway(withSmtp);
    expect(order).toEqual(['directory publish', 'profile publish', 'poll', 'webhook start', 'smtp start']);
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
      inbound: { sendPendingHeldAutoReplies },
      runtime: { runOnce: poll }, webhook: { start: webhookStart, setReady: webhookSetReady },
      smtp: { start: smtpStart, setReady: jest.fn() }, close: hostClose,
    } as unknown as ReturnType<typeof createJournaledMailHost>);
    await expect(startMailGateway({ ...config, nativeSmtp: {
      host: '127.0.0.1', port: 2525, hostname: 'mail.signet.mx', tlsKey, tlsCert,
    } })).rejects.toThrow('smtp bind failed');
    expect(order).toEqual(['directory publish', 'profile publish', 'poll', 'webhook start',
      'webhook stop', 'directory close', 'wallet close']);
    expect(tlsKey.every(byte => byte === 0)).toBe(true);
    expect(tlsCert.every(byte => byte === 0)).toBe(true);
  });
});
