import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadGatewayHostConfig } from '../src/host/gateway-config';

jest.mock('@frank/wallet/chain/monad-chain', () => ({
  loadMonadChainConfigFromEnv: () => ({
    networkId: 'monad-testnet', rpcChain: 'monad-testnet', chainId: 10143n,
    networkTag: 'MONT', relayBaseUrl: 'http://unused.invalid',
  }),
}));

describe('mail executable configuration', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-config-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const settings = (dir: string): NodeJS.ProcessEnv => {
    const apiKey = path.join(dir, 'resend-api');
    const webhookSecret = path.join(dir, 'resend-webhook');
    fs.writeFileSync(apiKey, 're_test\n', { mode: 0o600 });
    fs.writeFileSync(webhookSecret, 'whsec_test\n', { mode: 0o600 });
    return {
      FRANK_MAIL_WALLET_STATE_DIR: path.join(dir, 'wallet'),
      FRANK_MAIL_ROOTS_FILE: path.join(dir, 'roots'),
      FRANK_MAIL_EXPECTED_IDENTITY: `0x${'9'.repeat(40)}`,
      FRANK_MAIL_JOURNAL_FILE: path.join(dir, 'mail.sqlite3'),
      FRANK_MAIL_BLOB_DIR: path.join(dir, 'blobs'),
      FRANK_MAIL_DIRECTORY_DIR: path.join(dir, 'directory'),
      FRANK_MAIL_GATEWAY_DOMAIN: 'signet.mx',
      FRANK_MAIL_RELAY_URL: 'https://relay.signet.mx',
      FRANK_MAIL_RESEND_API_KEY_FILE: apiKey,
      FRANK_MAIL_RESEND_WEBHOOK_SECRET_FILE: webhookSecret,
      FRANK_MAIL_RESEND_RAW_ORIGINS: 'https://email-receiving.resend.com',
      FRANK_MAIL_STAMP_WEI: '10000000000000000',
      FRANK_MAIL_WEBHOOK_HOST: '127.0.0.1',
      FRANK_MAIL_WEBHOOK_PORT: '8000',
      FRANK_MAIL_POLL_MS: '5000',
    };
  };

  it('builds canonical testnet config from file-backed secrets and explicit durable paths', () => {
    const config = loadGatewayHostConfig(settings(dir));
    expect(config.chain.chainIdentifier).toBe('monad-testnet');
    expect(config.chain.walletStorageLocation).toBe(path.join(dir, 'wallet'));
    expect(config.chain.requireBoundWalletState).toBe(true);
    expect(config.journalMode).toBe('existing');
    expect(config.resendApiKey).toBe('re_test');
    expect(config.inboundStampValue).toBe(10_000_000_000_000_000n);
  });

  it('refuses a public secret file and relative wallet state before opening custody', () => {
    const env = settings(dir);
    fs.chmodSync(env.FRANK_MAIL_RESEND_API_KEY_FILE!, 0o644);
    expect(() => loadGatewayHostConfig(env)).toThrow('owner-readable only');
    fs.chmodSync(env.FRANK_MAIL_RESEND_API_KEY_FILE!, 0o600);
    env.FRANK_MAIL_WALLET_STATE_DIR = 'relative';
    expect(() => loadGatewayHostConfig(env)).toThrow('absolute path');
  });

  it('enables direct SMTP only with a complete file-backed TLS configuration', () => {
    const env = settings(dir);
    const key = path.join(dir, 'smtp-key');
    const cert = path.join(dir, 'smtp-cert');
    fs.writeFileSync(key, 'PRIVATE KEY\nsecond line\n', { mode: 0o600 });
    fs.writeFileSync(cert, 'CERTIFICATE\nsecond line\n', { mode: 0o600 });
    env.FRANK_MAIL_SMTP_HOST = '127.0.0.1';
    expect(() => loadGatewayHostConfig(env)).toThrow('FRANK_MAIL_SMTP_PORT');
    env.FRANK_MAIL_SMTP_PORT = '2525';
    env.FRANK_MAIL_SMTP_HOSTNAME = 'mail.signet.mx';
    env.FRANK_MAIL_SMTP_TLS_KEY_FILE = key;
    env.FRANK_MAIL_SMTP_TLS_CERT_FILE = cert;
    const config = loadGatewayHostConfig(env);
    expect(config.nativeSmtp).toMatchObject({ host: '127.0.0.1', port: 2525, hostname: 'mail.signet.mx' });
    expect(config.nativeSmtp?.tlsKey.toString()).toContain('second line');
    fs.chmodSync(key, 0o644);
    expect(() => loadGatewayHostConfig(env)).toThrow('owner-readable only');
  });

  it('normalizes FRANK_NETWORK_TAG variations and aliases', () => {
    const env = settings(dir);
    env.FRANK_NETWORK_TAG = 'monad-testnet';
    const config = loadGatewayHostConfig(env);
    expect(config.chain.networkTag).toBe('MONT');
    expect(config.chain.chainIdentifier).toBe('monad-testnet');
    expect(config.chain.chainId).toBe(10143n);
  });
});
