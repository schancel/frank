import {
  CANONICAL_CHAIN_IDS,
  ChainId,
  asWalletId,
  createChainAdapter,
  createWalletArray,
  getPrimaryWallet,
  getWallet,
  getWallets,
  isCanonicalChainId,
  recoverAllWallets,
  type ChainWallet,
  type RootWalletContext,
  type WalletIdentifier,
} from './chain-adapter';

describe('Unified ChainAdapter & Multi-Wallet Architecture', () => {
  const TEST_MNEMONIC =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

  describe('ChainId & Protocol Registry Conformity', () => {
    it('defines exactly the 10 canonical chain identifiers', () => {
      expect(CANONICAL_CHAIN_IDS).toEqual([
        'monad-mainnet',
        'monad-testnet',
        'tempo-mainnet',
        'tempo-testnet',
        'hyperliquid-mainnet',
        'hyperliquid-testnet',
        'ecash-mainnet',
        'ecash-testnet',
        'solana-mainnet',
        'solana-devnet',
      ]);
    });

    it('recognizes canonical chain identifiers and rejects arbitrary strings', () => {
      expect(isCanonicalChainId('monad-testnet')).toBe(true);
      expect(isCanonicalChainId('solana-devnet')).toBe(true);
      expect(isCanonicalChainId('ecash-testnet')).toBe(true);
      expect(isCanonicalChainId('native-evm')).toBe(false);
      expect(isCanonicalChainId('arbitrary-chain')).toBe(false);
    });
  });

  describe('createChainAdapter - Canonical Switch Statement', () => {
    it.each(CANONICAL_CHAIN_IDS)(
      'creates an adapter for canonical chain %s with correct family and rpcUrl',
      (chainId: ChainId) => {
        const adapter = createChainAdapter(chainId);
        expect(adapter.chainId).toBe(chainId);
        expect(typeof adapter.family).toBe('string');
        expect(typeof adapter.rpcUrl).toBe('string');
        expect(adapter.rpcUrl.startsWith('https://')).toBe(true);

        if (chainId.startsWith('monad') || chainId.startsWith('tempo') || chainId.startsWith('hyperliquid')) {
          expect(adapter.family).toBe('evm');
        } else if (chainId.startsWith('solana')) {
          expect(adapter.family).toBe('solana');
        } else if (chainId.startsWith('ecash')) {
          expect(adapter.family).toBe('bitcoin');
        }
      }
    );

    it('rejects unsupported chain discriminators with an informative error', () => {
      expect(() => createChainAdapter('native-evm' as unknown as ChainId)).toThrow(
        /Unsupported canonical chain/
      );
    });
  });

  describe('Address formatting, parsing, and validation across chain families', () => {
    describe('EVM (Monad / Tempo / Hyperliquid)', () => {
      const adapter = createChainAdapter('monad-testnet');
      const testEvm = '0x9858effd232b4033e47d90003d41ec34ecaeda94';
      const checksummed = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';

      it('formats address from raw string to EIP-55 checksummed', () => {
        expect(adapter.formatAddress(testEvm)).toBe(checksummed);
      });

      it('formats address from 20 raw bytes', () => {
        const bytes = adapter.parseAddress(testEvm);
        expect(bytes.length).toBe(20);
        expect(adapter.formatAddress(bytes)).toBe(checksummed);
      });

      it('parses address to 20-byte Uint8Array', () => {
        const parsed = adapter.parseAddress(checksummed);
        expect(parsed instanceof Uint8Array).toBe(true);
        expect(parsed.length).toBe(20);
      });

      it('validates EVM addresses accurately', () => {
        expect(adapter.isValidAddress(checksummed)).toBe(true);
        expect(adapter.isValidAddress(testEvm)).toBe(true);
        expect(adapter.isValidAddress('0xinvalid')).toBe(false);
        expect(adapter.isValidAddress('HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk')).toBe(false);
      });
    });

    describe('Solana (Devnet / Mainnet)', () => {
      const adapter = createChainAdapter('solana-devnet');
      const testSol = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';

      it('formats address from base58 string', () => {
        expect(adapter.formatAddress(testSol)).toBe(testSol);
      });

      it('formats address from 32 raw bytes', () => {
        const bytes = adapter.parseAddress(testSol);
        expect(bytes.length).toBe(32);
        expect(adapter.formatAddress(bytes)).toBe(testSol);
      });

      it('parses address to 32-byte Uint8Array', () => {
        const parsed = adapter.parseAddress(testSol);
        expect(parsed instanceof Uint8Array).toBe(true);
        expect(parsed.length).toBe(32);
      });

      it('validates Solana addresses accurately', () => {
        expect(adapter.isValidAddress(testSol)).toBe(true);
        expect(adapter.isValidAddress('11111111111111111111111111111111')).toBe(true);
        expect(adapter.isValidAddress('invalid-solana-address')).toBe(false);
        expect(adapter.isValidAddress('0x9858EfFD232B4033E47d90003D41EC34EcaEda94')).toBe(false);
      });
    });

    describe('eCash (Mainnet / Testnet)', () => {
      const testnetAdapter = createChainAdapter('ecash-testnet');
      const testnetAddr = 'ectest:qq86jv6h0y97q8l63ndynvk3fn9aq8fqruhjcef2tw';

      it('formats address from valid cashaddress', () => {
        const formatted = testnetAdapter.formatAddress(testnetAddr);
        expect(formatted.startsWith('ectest:')).toBe(true);
      });

      it('parses address to 20-byte hash160 payload and reconstructs it', () => {
        const hash = testnetAdapter.parseAddress(testnetAddr);
        expect(hash.length).toBe(20);
        expect(testnetAdapter.formatAddress(hash)).toBe(testnetAddr);
      });

      it('validates eCash addresses accurately by network prefix', () => {
        expect(testnetAdapter.isValidAddress(testnetAddr)).toBe(true);
        expect(testnetAdapter.isValidAddress('0x9858EfFD232B4033E47d90003D41EC34EcaEda94')).toBe(false);
      });
    });
  });

  describe('Amount formatting and parsing (toDisplayAmount / fromDisplayAmount)', () => {
    it('handles 18 decimals for Monad and Hyperliquid', () => {
      const monad = createChainAdapter('monad-testnet');
      expect(monad.toDisplayAmount(1000000000000000000n)).toBe('1');
      expect(monad.toDisplayAmount(1500000000000000000n)).toBe('1.5');
      expect(monad.fromDisplayAmount('1.5')).toBe(1500000000000000000n);

      const hyperliquid = createChainAdapter('hyperliquid-mainnet');
      expect(hyperliquid.toDisplayAmount(2000000000000000000n)).toBe('2');
      expect(hyperliquid.fromDisplayAmount('2')).toBe(2000000000000000000n);
    });

    it('handles 9 decimals for Solana', () => {
      const solana = createChainAdapter('solana-devnet');
      expect(solana.toDisplayAmount(1000000000n)).toBe('1');
      expect(solana.toDisplayAmount(500000000n)).toBe('0.5');
      expect(solana.fromDisplayAmount('0.5')).toBe(500000000n);
    });

    it('handles 6 decimals for Tempo TIP-20 pathUSD', () => {
      const tempo = createChainAdapter('tempo-testnet');
      expect(tempo.toDisplayAmount(1000000n)).toBe('1');
      expect(tempo.toDisplayAmount(2500000n)).toBe('2.5');
      expect(tempo.fromDisplayAmount('2.5')).toBe(2500000n);
    });

    it('handles 2 decimals for eCash', () => {
      const ecash = createChainAdapter('ecash-testnet');
      expect(ecash.toDisplayAmount(100n)).toBe('1');
      expect(ecash.toDisplayAmount(150n)).toBe('1.5');
      expect(ecash.fromDisplayAmount('1.5')).toBe(150n);
    });
  });

  describe('createWalletArray - Multi-Wallet Architecture', () => {
    const rootContext: RootWalletContext = {
      mnemonic: TEST_MNEMONIC,
    };

    it('initializes default primary wallets when allocatedWallets is omitted', () => {
      const wallets = createWalletArray(rootContext);
      expect(wallets.size).toBeGreaterThan(0);

      // Verify each initialized wallet is primary (accountIndex === 0)
      for (const wallet of wallets.values()) {
        expect(wallet.isPrimary).toBe(true);
        expect(wallet.identifier.accountIndex).toBe(0);
        expect(wallet.identifier.walletName).toBe('Primary');
        expect(wallet.address).toBeTruthy();
      }

      // Check primary wallets exist for enabled testnets
      const monadPrimary = getPrimaryWallet('monad-testnet');
      expect(monadPrimary).toBeDefined();
      expect(monadPrimary?.chainId).toBe('monad-testnet');
      expect(monadPrimary?.isPrimary).toBe(true);
      expect(monadPrimary?.address).toBe('0x9858EfFD232B4033E47d90003D41EC34EcaEda94');

      const solanaPrimary = getPrimaryWallet('solana-devnet');
      expect(solanaPrimary).toBeDefined();
      expect(solanaPrimary?.chainId).toBe('solana-devnet');
      expect(solanaPrimary?.isPrimary).toBe(true);
      expect(solanaPrimary?.address).toBe('HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk');

      const ecashPrimary = getPrimaryWallet('ecash-testnet');
      expect(ecashPrimary).toBeDefined();
      expect(ecashPrimary?.chainId).toBe('ecash-testnet');
      expect(ecashPrimary?.address.startsWith('ectest:')).toBe(true);
    });

    it('supports named sub-wallets with arbitrary account indexes on the same chain', () => {
      const allocatedWallets: WalletIdentifier[] = [
        {
          walletName: 'Primary Spending',
          walletId: asWalletId('monad:primary'),
          walletChainId: 'monad-testnet',
          accountIndex: 0,
        },
        {
          walletName: 'Savings Vault',
          walletId: asWalletId('monad:savings'),
          walletChainId: 'monad-testnet',
          accountIndex: 1,
        },
        {
          walletName: 'Trading Stash',
          walletId: asWalletId('monad:trading'),
          walletChainId: 'monad-testnet',
          accountIndex: 2,
        },
        {
          walletName: 'Solana Primary',
          walletId: asWalletId('solana:primary'),
          walletChainId: 'solana-devnet',
          accountIndex: 0,
        },
        {
          walletName: 'Solana Staking',
          walletId: asWalletId('solana:staking'),
          walletChainId: 'solana-devnet',
          accountIndex: 1,
        },
      ];

      const walletMap = createWalletArray(rootContext, allocatedWallets);
      expect(walletMap.size).toBe(5);

      const monadWallets = getWallets('monad-testnet');
      expect(monadWallets.length).toBe(3);

      const primary = getPrimaryWallet('monad-testnet');
      expect(primary).toBeDefined();
      expect(primary?.identifier.accountIndex).toBe(0);
      expect(primary?.identifier.walletName).toBe('Primary Spending');
      expect(primary?.address).toBe('0x9858EfFD232B4033E47d90003D41EC34EcaEda94');

      const savings = getWallet(asWalletId('monad:savings'));
      expect(savings).toBeDefined();
      expect(savings?.isPrimary).toBe(false);
      expect(savings?.identifier.accountIndex).toBe(1);
      expect(savings?.identifier.walletName).toBe('Savings Vault');
      // Must derive distinct address deterministically from index 1: m/44'/60'/1'/0/0
      expect(savings?.address).toBe('0x78839F6054d7ed13918bAe0473BA31b1Ca9D7265');
      expect(savings?.address).not.toBe(primary?.address);

      const trading = getWallet(asWalletId('monad:trading'));
      expect(trading).toBeDefined();
      expect(trading?.identifier.accountIndex).toBe(2);
      expect(trading?.address).not.toBe(primary?.address);
      expect(trading?.address).not.toBe(savings?.address);

      // Solana named accounts
      const solPrimary = getPrimaryWallet('solana-devnet');
      const solStaking = getWallet(asWalletId('solana:staking'));
      expect(solPrimary?.address).toBe('HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk');
      expect(solStaking?.isPrimary).toBe(false);
      expect(solStaking?.address).not.toBe(solPrimary?.address);
    });
  });

  describe('Encapsulation Guarantee', () => {
    it('exposes only high-level intents and never leaks ledger internals', () => {
      const wallets = createWalletArray({ mnemonic: TEST_MNEMONIC });
      const wallet = getPrimaryWallet('monad-testnet') as ChainWallet;

      // Verify high-level intent methods exist
      expect(typeof wallet.getBalance).toBe('function');
      expect(typeof wallet.sendLegacyTransaction).toBe('function');
      expect(typeof wallet.sendStealthTransaction).toBe('function');
      expect(typeof wallet.sendStampTransaction).toBe('function');
      expect(typeof wallet.recover).toBe('function');

      // Verify ledger internals are NEVER leaked on public properties
      const leakedKeys = [
        'SpendableInputs',
        'spendableInputs',
        'nonces',
        'nonce',
        '_nonce',
        'leaderAccounts',
        'evmLeader',
        'utxoOutpoints',
        'outpoints',
        'privateKey',
        '_privateKey',
        'spendKey',
      ];

      for (const key of leakedKeys) {
        expect((wallet as unknown as Record<string, unknown>)[key]).toBeUndefined();
      }

      // Check enumerable keys
      const enumerableKeys = Object.keys(wallet);
      for (const key of leakedKeys) {
        expect(enumerableKeys).not.toContain(key);
      }
    });

    it('can execute high-level intent transactions', async () => {
      const wallets = createWalletArray({ mnemonic: TEST_MNEMONIC });
      const wallet = getPrimaryWallet('monad-testnet')!;

      const legacyRes = await wallet.sendLegacyTransaction({
        recipient: '0x0000000000000000000000000000000000000001',
        value: 1000n,
      });
      expect(typeof legacyRes.txHash).toBe('string');
      expect(legacyRes.txHash.startsWith('0x')).toBe(true);

      const stealthRes = await wallet.sendStealthTransaction({
        recipient: '0x0000000000000000000000000000000000000002',
        value: 500n,
      });
      expect(typeof stealthRes.txHash).toBe('string');
      expect(stealthRes.stealthAddress).toBe('0x0000000000000000000000000000000000000002');
      expect(typeof stealthRes.messageId).toBe('string');

      const stampRes = await wallet.sendStampTransaction({
        recipient: '0x0000000000000000000000000000000000000003',
        value: 100n,
      });
      expect(typeof stampRes.txHash).toBe('string');
    });
  });

  describe('Resilient Recovery', () => {
    it('handles individual RPC issues gracefully without failing session recovery', async () => {
      const wallets = createWalletArray({ mnemonic: TEST_MNEMONIC });

      // Directly call recover() on a wallet
      const monadWallet = getPrimaryWallet('monad-testnet')!;
      // When offline or unmocked RPC fails, recover() should resolve without throwing fatal errors
      await expect(monadWallet.recover()).resolves.toBeUndefined();

      // recoverAllWallets loops over all wallets and reports results gracefully
      const report = await recoverAllWallets();
      expect(report.succeeded.length + report.failed.length).toBe(wallets.size);
    });

    it('isolates chain RPC failure from other wallets during multi-wallet recovery', async () => {
      const allocatedWallets: WalletIdentifier[] = [
        {
          walletName: 'Monad Primary',
          walletId: asWalletId('monad:primary'),
          walletChainId: 'monad-testnet',
          accountIndex: 0,
        },
        {
          walletName: 'Solana Primary',
          walletId: asWalletId('solana:primary'),
          walletChainId: 'solana-devnet',
          accountIndex: 0,
        },
      ];

      const walletMap = createWalletArray({ mnemonic: TEST_MNEMONIC }, allocatedWallets);
      const solanaWallet = walletMap.get(asWalletId('solana:primary'))!;

      // Even if one wallet's recover has an issue, recoverAllWallets completes
      const result = await recoverAllWallets(walletMap.values());
      expect(result.succeeded.length + result.failed.length).toBe(2);
    });
  });
});
