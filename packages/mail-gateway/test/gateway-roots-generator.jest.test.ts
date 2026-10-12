import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadGatewayWalletRoots } from '../src/host/gateway-wallet';
import { generateGatewayRoots } from '../src/host/gateway-roots-generator';
import { createMonadWalletMaterial } from '@frank/wallet/monad-wallet-material';

describe('one-time mail gateway roots generation', () => {
  let top: string;
  beforeEach(() => { top = mkdtempSync(join(tmpdir(), 'frank-mail-roots-')); });
  afterEach(() => { rmSync(top, { recursive: true, force: true }); });

  function destinations() {
    const primaryDir = join(top, 'primary');
    const backupDir = join(top, 'backup');
    mkdirSync(primaryDir, { mode: 0o700 });
    mkdirSync(backupDir, { mode: 0o700 });
    return { primaryFile: join(primaryDir, 'roots.json'), backupFile: join(backupDir, 'roots.json') };
  }

  it('writes two owner-only matching roots and returns their public identity', () => {
    const paths = destinations();
    const identity = generateGatewayRoots(paths);
    expect(identity).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(statSync(paths.primaryFile).mode & 0o777).toBe(0o600);
    expect(statSync(paths.backupFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(paths.primaryFile).equals(readFileSync(paths.backupFile))).toBe(true);
    const roots = loadGatewayWalletRoots(paths.primaryFile);
    const material = createMonadWalletMaterial(roots);
    try { expect(material.identity.displayAddress).toBe(identity); }
    finally {
      material.dispose();
      roots.evm.bytes.fill(0);
      roots.authentication.bytes.fill(0);
      roots.messaging.bytes.fill(0);
    }
  });

  it('refuses existing files and leaves them unchanged', () => {
    const paths = destinations();
    generateGatewayRoots(paths);
    const original = readFileSync(paths.primaryFile);
    expect(() => generateGatewayRoots(paths)).toThrow();
    expect(readFileSync(paths.primaryFile).equals(original)).toBe(true);
  });

  it('leaves the first file intact if the second destination already exists', () => {
    const paths = destinations();
    writeFileSync(paths.backupFile, 'sentinel', { mode: 0o600 });
    expect(() => generateGatewayRoots(paths)).toThrow();
    expect(existsSync(paths.primaryFile)).toBe(true);
    expect(readFileSync(paths.backupFile, 'utf8')).toBe('sentinel');
  });

  it('requires private and separate parent directories', () => {
    const paths = destinations();
    chmodSync(join(top, 'backup'), 0o755);
    expect(() => generateGatewayRoots(paths)).toThrow('owner-only');
    chmodSync(join(top, 'backup'), 0o700);
    expect(() => generateGatewayRoots({ primaryFile: paths.primaryFile, backupFile: join(top, 'primary', 'other.json') }))
      .toThrow('separate private directory');
  });
});
