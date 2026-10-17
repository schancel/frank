import { existsSync, mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomBytes } from 'crypto';
import level from 'level';

import { deriveDomainRoot } from '@frank/domain-roots';
import { createEvmChain } from './monad-chain';
import type { EvmChainConfig } from './evm-chain-config';
import { createMonadWalletMaterial } from '../monad-wallet-material';

it.each(['sub-account-pool', 'change-pool'] as const)(
  'refuses a fresh %s after a bound typed wallet has existed',
  async (namespace) => {
    const directory = mkdtempSync(join(tmpdir(), 'frank-evm-bound-pool-'));
    const accountRoot = randomBytes(32);
    const roots = {
      evm: deriveDomainRoot(accountRoot, 'evm-wallet'),
      authentication: deriveDomainRoot(accountRoot, 'identity-authentication'),
      messaging: deriveDomainRoot(accountRoot, 'messaging-encryption'),
    };
    accountRoot.fill(0);
    const config: EvmChainConfig = {
      chainIdentifier: 'monad-testnet',
      networkId: 'monad-testnet',
      chainId: 10143,
      rpcChain: 'monad-testnet',
      relayBaseUrl: 'http://127.0.0.1:1',
      networkTag: 'MONT',
      stampBurnAddress: '0x000000000000000000000000000000000000dEaD',
      defaultStampValueWei: 1n,
      defaultTopicVoteValueWei: 1n,
      subAccountPoolSize: 2,
      walletStorageLocation: join(directory, 'wallet'),
      requireBoundWalletState: true,
      walletStateExists: existsSync,
    };
    try {
      await expect(createEvmChain({ ...config, walletStateExists: undefined }).createWallet(roots))
        .rejects.toThrow('host-owned presence check');
      expect(readdirSync(directory)).toEqual([]);
      const first = await createEvmChain(config).createWallet(roots);
      await first.close();
      const reopened = await createEvmChain(config).createWallet(roots);
      await reopened.close();
      const material = createMonadWalletMaterial(roots);
      const statePath = `${config.walletStorageLocation}-evm-${material.mainAccount.address.toLowerCase()}`;
      material.dispose();
      const namespacePath = join(statePath, 'spend-pool');
      const db = level(namespacePath);
      await db.del(
        namespace === 'sub-account-pool'
          ? 'sub-account:__wallet_binding__'
          : 'change:__wallet_binding__'
      );
      await db.close();
      await expect(createEvmChain(config).createWallet(roots)).rejects.toThrow(
        namespace === 'sub-account-pool'
          ? 'Refusing to open an unbound sub-account store'
          : 'Refusing to open an unbound change store'
      );
    } finally {
      for (const root of [roots.evm, roots.authentication, roots.messaging]) root.bytes.fill(0);
      rmSync(directory, { recursive: true, force: true });
    }
  }
);
