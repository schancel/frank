import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomBytes } from 'crypto';

import { deriveDomainRoot } from '@frank/domain-roots';
import { MonadIdentity } from '@frank/wallet/monad-identity';
import { createMonadWalletMaterial } from '@frank/wallet/monad-wallet-material';
import { createEvmChain } from '@frank/wallet/chain/monad-chain';

import {
  GatewayWalletStartRefusal,
  loadGatewayWalletRoots,
  openGatewayWallet,
} from '../src/host/gateway-wallet';

jest.mock('@frank/wallet/chain/monad-chain', () => ({ createEvmChain: jest.fn() }));

const mockedChain = jest.mocked(createEvmChain);

describe('gateway wallet host admission', () => {
  let directory: string;
  let rootFile: string;
  let walletBase: string;
  let identityAddress: string;
  let mainAddress: string;
  let rootDocument: string;
  const closeWallet = jest.fn(async () => {});

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'frank-mail-wallet-'));
    rootFile = join(directory, 'roots.json');
    walletBase = join(directory, 'wallet');
    const accountRoot = randomBytes(32);
    const evm = deriveDomainRoot(accountRoot, 'evm-wallet');
    const authentication = deriveDomainRoot(accountRoot, 'identity-authentication');
    const messaging = deriveDomainRoot(accountRoot, 'messaging-encryption');
    accountRoot.fill(0);
    const roots = { evm, authentication, messaging };
    identityAddress = MonadIdentity.fromDomainRoot(authentication).displayAddress;
    const material = createMonadWalletMaterial(roots);
    mainAddress = material.mainAccount.address.toLowerCase();
    material.dispose();
    rootDocument = JSON.stringify({
      registry: 'frank-domain-roots-v1',
      roots: {
        'evm-wallet': Buffer.from(evm.bytes).toString('hex'),
        'identity-authentication': Buffer.from(authentication.bytes).toString('hex'),
        'messaging-encryption': Buffer.from(messaging.bytes).toString('hex'),
      },
    });
    writeFileSync(rootFile, rootDocument, { mode: 0o600 });
    mockedChain.mockReset();
    closeWallet.mockClear();
    mockedChain.mockReturnValue({
      createWallet: jest.fn(async () => ({
        chainIdentifier: 'monad-testnet',
        identity: MonadIdentity.fromDomainRoot(authentication),
        walletState: { durability: 'persistent' },
        close: closeWallet,
      })),
    } as never);
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
    } as Parameters<typeof openGatewayWallet>[0]['chain'],
  });

  const existingWalletState = () => {
    for (const namespace of ['wallet-manifest', 'sub-account-pool', 'change-pool']) {
      const path = `${walletBase}-evm-${mainAddress}/${namespace}`;
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, 'CURRENT'), 'MANIFEST-000001\n');
    }
  };

  it('refuses a new state path before opening a wallet that could reuse spent accounts', async () => {
    await expect(openGatewayWallet(input())).rejects.toMatchObject({
      code: 'wallet-state-missing',
    });
    expect(mockedChain).not.toHaveBeenCalled();
  });

  it('opens only the bound existing wallet and supplies a stable private reply-alias salt', async () => {
    existingWalletState();
    const first = await openGatewayWallet(input());
    const salt = first.replyAliasSalt();
    const expectedSalt = new Uint8Array(salt);
    expect(salt).toHaveLength(32);
    salt.fill(0);
    expect(first.replyAliasSalt()).not.toEqual(salt);
    await first.close();
    expect(closeWallet).toHaveBeenCalledTimes(1);
    expect(() => first.replyAliasSalt()).toThrow(GatewayWalletStartRefusal);
    const reopened = await openGatewayWallet(input());
    expect(reopened.replyAliasSalt()).toEqual(expectedSalt);
    await reopened.close();
  });

  it('refuses a wrong public identity and network before opening wallet state', async () => {
    existingWalletState();
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
    require('fs').symlinkSync(rootFile, link);
    expect(() => loadGatewayWalletRoots(link)).toThrow('root-file-unavailable');
  });
});
