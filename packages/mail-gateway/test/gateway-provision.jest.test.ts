import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { deriveDomainRoot } from '@frank/domain-roots';
import { MonadIdentity } from '@frank/wallet/monad-identity';
import { loadGatewayProvisionConfig } from '../src/host/gateway-config';
import { provisionNewMailGateway } from '../src/host/gateway-provision';
import { openGatewayWallet } from '../src/host/gateway-wallet';

describe('explicit testnet mail provisioning', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'frank-mail-provision-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function setup() {
    const accountRoot = randomBytes(32);
    const roots = {
      evm: deriveDomainRoot(accountRoot, 'evm-wallet'),
      authentication: deriveDomainRoot(accountRoot, 'identity-authentication'),
      messaging: deriveDomainRoot(accountRoot, 'messaging-encryption'),
    };
    accountRoot.fill(0);
    const rootFile = join(dir, 'roots.json');
    const backupRootFile = join(dir, 'offline-roots.json');
    const document = JSON.stringify({
      registry: 'frank-domain-roots-v1',
      roots: {
        'evm-wallet': Buffer.from(roots.evm.bytes).toString('hex'),
        'identity-authentication': Buffer.from(roots.authentication.bytes).toString('hex'),
        'messaging-encryption': Buffer.from(roots.messaging.bytes).toString('hex'),
      },
    });
    writeFileSync(rootFile, document, { mode: 0o600 });
    writeFileSync(backupRootFile, document, { mode: 0o400 });
    const identity = MonadIdentity.fromDomainRoot(roots.authentication).displayAddress;
    roots.evm.bytes.fill(0); roots.authentication.bytes.fill(0); roots.messaging.bytes.fill(0);
    const config = loadGatewayProvisionConfig({
      FRANK_MAIL_WALLET_STATE_DIR: join(dir, 'wallet'),
      FRANK_MAIL_ROOTS_FILE: rootFile,
      FRANK_MAIL_ROOTS_BACKUP_FILE: backupRootFile,
      FRANK_MAIL_EXPECTED_IDENTITY: identity,
      FRANK_MAIL_JOURNAL_FILE: join(dir, 'mail.sqlite3'),
      FRANK_MAIL_BLOB_DIR: join(dir, 'blobs'),
      FRANK_MAIL_GATEWAY_DOMAIN: 'signet.mx',
      FRANK_MAIL_RELAY_URL: 'https://relay.signet.mx',
    });
    return { config, rootFile, backupRootFile };
  }

  it('needs matching distinct private backups before any writes', async () => {
    const { config, rootFile, backupRootFile } = setup();
    await expect(provisionNewMailGateway({ ...config, backupRootFile: rootFile }))
      .rejects.toThrow('distinct private file');
    chmodSync(backupRootFile, 0o600);
    writeFileSync(backupRootFile, JSON.stringify({ registry: 'frank-domain-roots-v1', roots: {
      'evm-wallet': '01'.repeat(32),
      'identity-authentication': '02'.repeat(32),
      'messaging-encryption': '03'.repeat(32),
    } }));
    chmodSync(backupRootFile, 0o400);
    await expect(provisionNewMailGateway(config)).rejects.toThrow('does not match');
    expect(existsSync(config.journalFile)).toBe(false);
    chmodSync(backupRootFile, 0o644);
    await expect(provisionNewMailGateway(config)).rejects.toThrow('root-file-permissions');
    expect(existsSync(config.journalFile)).toBe(false);
  });

  it('creates complete bound wallet, admission marker and matching journal exactly once', async () => {
    const { config } = setup();
    await provisionNewMailGateway(config);
    const opened = await openGatewayWallet({
      rootFile: config.rootFile, chain: config.chain,
      expectedIdentityAddress: config.expectedIdentityAddress,
    });
    await opened.close();
    const database = new DatabaseSync(config.journalFile, { readOnly: true });
    try {
      expect(database.prepare('SELECT chain_identifier, gateway_account, gateway_domain FROM mail_journal_meta WHERE id = 1').get())
        .toMatchObject({
          chain_identifier: 'monad-testnet',
          gateway_account: config.expectedIdentityAddress.toLowerCase(),
          gateway_domain: 'signet.mx',
        });
    } finally { database.close(); }
    await expect(provisionNewMailGateway(config)).rejects.toThrow('already exists');
  });

  it('refuses a different expected identity without writing wallet or journal', async () => {
    const { config } = setup();
    await expect(provisionNewMailGateway({
      ...config,
      expectedIdentityAddress: `0x${'1'.repeat(40)}`,
    })).rejects.toThrow('differs from expected public address');
    expect(existsSync(config.journalFile)).toBe(false);
    expect(readdirSync(dir).some(name => name.startsWith('wallet-evm-'))).toBe(false);
  });
});
