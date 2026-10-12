import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ActiveChain, WalletHandle } from '@frank/wallet/chain/active-chain';
import { createJournaledMailHost } from '../src/host/journaled-mail-host';

const GATEWAY = `0x${'9'.repeat(40)}`;

describe('journaled mail host admission', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-host-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const options = (dir: string, journalMode: 'existing' | 'provision') => ({
    chain: { chainIdentifier: 'monad-testnet' } as ActiveChain,
    wallet: { identity: { address: { raw: GATEWAY } } } as WalletHandle,
    journalFile: path.join(dir, 'mail.sqlite3'),
    blobDirectory: path.join(dir, 'blobs'),
    journalMode,
    gatewayDomain: 'signet.mx',
    mailboxSalt: new Uint8Array(32).fill(7),
    resendApiKey: 're_test',
    resendWebhookSecret: 'whsec_test',
    resendRawOrigins: ['https://raw.example.test'],
    inboundStampValue: 1000n,
    webhookHost: '127.0.0.1',
    webhookPort: 0,
  });

  it('requires explicit provisioning, then reopens only the original journal identity and format', async () => {
    expect(() => createJournaledMailHost(options(dir, 'existing'))).toThrow('Existing mail journal is missing');
    const first = createJournaledMailHost(options(dir, 'provision'));
    expect(first.journal.chainIdentifier).toBe('monad-testnet');
    await first.close();
    expect(() => createJournaledMailHost(options(dir, 'provision'))).toThrow('already exists');
    const reopened = createJournaledMailHost(options(dir, 'existing'));
    await reopened.close();
    expect(() => createJournaledMailHost({ ...options(dir, 'existing'),
      wallet: { identity: { address: { raw: `0x${'8'.repeat(40)}` } } } as WalletHandle,
    })).toThrow('identity or format differs');
  });
});
