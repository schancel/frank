import { existsSync, mkdtempSync, rmSync, writeFileSync, chmodSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomBytes } from 'crypto';

import { deriveDomainRoot } from '@frank/domain-roots';
import { MonadIdentity } from '@frank/wallet/monad-identity';
import { createEvmChain } from '@frank/wallet/chain/monad-chain';

import { loadGatewayWalletRoots, openGatewayWallet } from '../src/host/gateway-wallet';

jest.mock('@frank/wallet/chain/monad-chain', () => ({ createEvmChain: jest.fn() }));

const mockedChain = jest.mocked(createEvmChain);

describe('gateway wallet host admission', () => {
  let directory: string;
  let rootFile: string;
  let walletBase: string;
  let identityAddress: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'frank-mail-wallet-'));
    rootFile = join(directory, 'roots.json');
    walletBase = join(directory, 'wallet');
    const accountRoot = randomBytes(32);
    const evm = deriveDomainRoot(accountRoot, 'evm-wallet');
    const authentication = deriveDomainRoot(accountRoot, 'identity-authentication');
    const messaging = deriveDomainRoot(accountRoot, 'messaging-encryption');
    accountRoot.fill(0);
    identityAddress = MonadIdentity.fromDomainRoot(authentication).displayAddress;
    const rootDocument = JSON.stringify({
      registry: 'frank-domain-roots-v1',
      roots: {
        'evm-wallet': Buffer.from(evm.bytes).toString('hex'),
        'identity-authentication': Buffer.from(authentication.bytes).toString('hex'),
        'messaging-encryption': Buffer.from(messaging.bytes).toString('hex'),
      },
    });
    writeFileSync(rootFile, rootDocument, { mode: 0o600 });
    mockedChain.mockReset();
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  const input = () => ({
    rootFile,
    expectedIdentityAddress: identityAddress,
    chain: {
      chainIdentifier: 'monad-testnet',
      rpcChain: 'monad-testnet',
      networkId: 'monad-testnet',
      networkTag: 'MONT',
      chainId: 10143,
      walletStorageLocation: walletBase,
      requireBoundWalletState: true,
      walletStateExists: existsSync,
    } as Parameters<typeof openGatewayWallet>[0]['chain'],
  });

  it('refuses a new state path before opening a wallet that could reuse spent accounts', async () => {
    await expect(openGatewayWallet(input())).rejects.toMatchObject({
      code: 'wallet-state-missing',
    });
    expect(mockedChain).not.toHaveBeenCalled();
  });

  it('refuses a wrong public identity and network before opening wallet state', async () => {
    await expect(
      openGatewayWallet({
        ...input(),
        expectedIdentityAddress: '0x0000000000000000000000000000000000000001',
      })
    ).rejects.toMatchObject({ code: 'identity-mismatch' });
    await expect(
      openGatewayWallet({
        ...input(),
        chain: { ...input().chain, chainIdentifier: 'monad-mainnet' },
      })
    ).rejects.toMatchObject({ code: 'network-mismatch' });
    expect(mockedChain).not.toHaveBeenCalled();
  });

  it('refuses a readable-by-group root file and a symlink without exposing its contents', () => {
    chmodSync(rootFile, 0o640);
    expect(() => loadGatewayWalletRoots(rootFile)).toThrow('root-file-permissions');
    chmodSync(rootFile, 0o600);
    const link = join(directory, 'roots-link.json');
    symlinkSync(rootFile, link);
    expect(() => loadGatewayWalletRoots(link)).toThrow('root-file-unavailable');
  });
});
