import {
  CANONICAL_CHAIN_IDS,
  ChainId,
  PATHUSD,
  asWalletId,
  createChainAdapter,
  createWalletArray,
  getFundedWallets,
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
    it('defines exactly the 28 canonical chain identifiers', () => {
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
        'btc-mainnet',
        'btc-testnet',
        'bch-mainnet',
        'bch-testnet',
        'doge-mainnet',
        'doge-testnet',
        'litecoin-mainnet',
        'litecoin-testnet',
        'ethereum-mainnet',
        'ethereum-sepolia',
        'bnb-mainnet',
        'bnb-testnet',
        'polygon-mainnet',
        'polygon-amoy',
        'base-mainnet',
        'base-sepolia',
        'arbitrum-mainnet',
        'arbitrum-sepolia',
      ]);
    });

    it('recognizes canonical chain identifiers and rejects arbitrary strings', () => {
      expect(isCanonicalChainId('monad-testnet')).toBe(true);
      expect(isCanonicalChainId('solana-devnet')).toBe(true);
      expect(isCanonicalChainId('ecash-testnet')).toBe(true);
      expect(isCanonicalChainId('btc-mainnet')).toBe(true);
      expect(isCanonicalChainId('litecoin-mainnet')).toBe(true);
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

        if (
          chainId.startsWith('monad') ||
          chainId.startsWith('tempo') ||
          chainId.startsWith('hyperliquid') ||
          chainId.startsWith('ethereum') ||
          chainId.startsWith('bnb') ||
          chainId.startsWith('polygon') ||
          chainId.startsWith('base') ||
          chainId.startsWith('arbitrum')
        ) {
          expect(adapter.family).toBe('evm');
        } else if (chainId.startsWith('solana')) {
          expect(adapter.family).toBe('solana');
        } else if (
          chainId.startsWith('ecash') ||
          chainId.startsWith('btc') ||
          chainId.startsWith('bch') ||
          chainId.startsWith('doge') ||
          chainId.startsWith('litecoin')
        ) {
          expect(adapter.family).toBe('bitcoin');
        }
      }
    );

    it('exposes dex adapters on chains that configure them', () => {
      const monadAdapter = createChainAdapter('monad-testnet');
      expect(monadAdapter.dex).toBeDefined();
      expect(monadAdapter.dex?.length).toBeGreaterThan(0);
      expect(monadAdapter.dex?.[0].adapter).toBe('uniswap-v4');

      const solanaAdapter = createChainAdapter('solana-devnet');
      expect(solanaAdapter.dex).toBeDefined();
      expect(solanaAdapter.dex?.length).toBeGreaterThan(0);
    });

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

    describe('Bitcoin (Mainnet / Testnet)', () => {
      const btcAdapter = createChainAdapter('btc-mainnet');
      const btcAddr = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';

      it('validates Bitcoin addresses accurately', () => {
        expect(btcAdapter.isValidAddress(btcAddr)).toBe(true);
        expect(btcAdapter.isValidAddress('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2')).toBe(true);
        expect(btcAdapter.isValidAddress('0x9858EfFD232B4033E47d90003D41EC34EcaEda94')).toBe(false);
      });

      it('parses address to 20-byte payload and reconstructs it', () => {
        const payload = btcAdapter.parseAddress(btcAddr);
        expect(payload.length).toBe(20);
        expect(btcAdapter.formatAddress(payload)).toBe(btcAddr);
      });
    });

    describe('Litecoin (Mainnet / Testnet)', () => {
      const ltcAdapter = createChainAdapter('litecoin-mainnet');
      const ltcAddr = 'ltc1qw508d6qejxtdg4y5r3zarvary0c5xw7kgm6n4w';

      it('validates Litecoin addresses accurately', () => {
        expect(ltcAdapter.isValidAddress(ltcAddr)).toBe(true);
        expect(ltcAdapter.isValidAddress('LTC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KGM6N4W')).toBe(true);
        expect(ltcAdapter.isValidAddress('0x9858EfFD232B4033E47d90003D41EC34EcaEda94')).toBe(false);
      });
    });

    describe('Dogecoin (Mainnet / Testnet)', () => {
      const dogeAdapter = createChainAdapter('doge-mainnet');
      const dogeAddr = 'DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L';

      it('validates Dogecoin addresses accurately', () => {
        expect(dogeAdapter.isValidAddress(dogeAddr)).toBe(true);
        expect(dogeAdapter.isValidAddress('0x9858EfFD232B4033E47d90003D41EC34EcaEda94')).toBe(false);
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
    }, 15000);

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

  describe('Polymorphic Payment Transfers across Chain Adapters', () => {
    it('creates and parses recipient, sync, and binary payment transfers on EVM (Monad)', () => {
      const adapter = createChainAdapter('monad-testnet');
      const recipient = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';

      const transfer = adapter.createRecipientPaymentTransfer({
        recipient,
        value: 1000000000000000000n, // 1 MON
        txId: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      });
      expect(transfer.destination.length).toBe(40); // 20 bytes in hex

      const parsed = adapter.parseRecipientPaymentTransfer(transfer);
      expect(parsed.recipient).toBe(recipient);
      expect(parsed.amount).toBe(1000000000000000000n);
      expect(parsed.displayAmount).toBe('1');

      const syncItem = adapter.createSyncPaymentTransfer({
        recipient,
        value: 500000000000000000n,
        txHash: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdef',
        direction: 'sent',
      });
      expect(syncItem.type).toBe('payment-transfer');
      const parsedSync = adapter.parseSyncPaymentTransfer(syncItem);
      expect(parsedSync.recipient).toBe(recipient);
      expect(parsedSync.amount).toBe(500000000000000000n);
      expect(parsedSync.displayAmount).toBe('0.5');

      const poly = adapter.createPaymentTransfer({
        recipient,
        value: 1000000000000000000n,
        txId: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      });
      expect(poly.destination instanceof Uint8Array).toBe(true);
      expect(poly.destination.length).toBe(20);
      const parsedPoly = adapter.parsePaymentTransfer(poly);
      expect(parsedPoly.recipient).toBe(recipient);
      expect(parsedPoly.value).toBe(1000000000000000000n);
    });

    it('defaults token to PATHUSD and formats 6 decimals on Tempo', () => {
      const adapter = createChainAdapter('tempo-testnet');
      const recipient = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';

      const transfer = adapter.createRecipientPaymentTransfer({
        recipient,
        value: 5000000n, // 5 USD
        txId: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      });
      const parsed = adapter.parseRecipientPaymentTransfer(transfer);
      expect(parsed.token).toBe(adapter.formatAddress(PATHUSD));
      expect(parsed.displayAmount).toBe('5');
    });

    it('creates and parses transfers on Solana with 32-byte destination and base58 txId', () => {
      const adapter = createChainAdapter('solana-devnet');
      const recipient = '4Nd1mBQtrMJVYVfKf2PJy9NZPdde5VU55j4MpTuqFs3C';

      const transfer = adapter.createRecipientPaymentTransfer({
        recipient,
        value: 2000000000n, // 2 SOL
        txId: '5H6QzLqUq9b1o9L3ZgM4N8mS4qL7k9X2Z1y7w6v5u4t3',
      });
      expect(transfer.destination.length).toBe(64); // 32 bytes in hex

      const parsed = adapter.parseRecipientPaymentTransfer(transfer);
      expect(parsed.recipient).toBe(recipient);
      expect(parsed.amount).toBe(2000000000n);
      expect(parsed.displayAmount).toBe('2');

      const poly = adapter.createPaymentTransfer({
        recipient,
        value: 2000000000n,
        txId: '5H6QzLqUq9b1o9L3ZgM4N8mS4qL7k9X2Z1y7w6v5u4t3',
      });
      expect(poly.destination instanceof Uint8Array).toBe(true);
      expect(poly.destination.length).toBe(32);
      const parsedPoly = adapter.parsePaymentTransfer(poly);
      expect(parsedPoly.recipient).toBe(recipient);
      expect(parsedPoly.value).toBe(2000000000n);
    });

    it('creates and parses transfers on eCash with 20-byte hash160 and vout', () => {
      const adapter = createChainAdapter('ecash-mainnet');
      const recipient = adapter.formatAddress(new Uint8Array(20).fill(1));

      const transfer = adapter.createRecipientPaymentTransfer({
        recipient,
        value: 50000n, // 500.00 XEC
        txId: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        vout: 1,
      });
      expect(transfer.destination.length).toBe(40); // 20 bytes in hex
      expect(transfer.vout).toBe(1);

      const parsed = adapter.parseRecipientPaymentTransfer(transfer);
      expect(parsed.recipient).toBe(recipient);
      expect(parsed.amount).toBe(50000n);
      expect(parsed.displayAmount).toBe('500');
      expect(parsed.vout).toBe(1);

      const poly = adapter.createPaymentTransfer({
        recipient,
        value: 50000n,
        txId: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        vout: 1,
      });
      expect(poly.destination instanceof Uint8Array).toBe(true);
      expect(poly.destination.length).toBe(20);
      expect(poly.vout).toBe(1);
      const parsedPoly = adapter.parsePaymentTransfer(poly);
      expect(parsedPoly.recipient).toBe(recipient);
      expect(parsedPoly.value).toBe(50000n);
      expect(parsedPoly.vout).toBe(1);
    });
  });

  describe('Fee Estimation and Transaction Simulation', () => {
    it('estimates fee and simulates transaction on EVM adapter', async () => {
      const adapter = createChainAdapter('monad-testnet');
      const fee = await adapter.estimateFee({
        recipient: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94',
        value: 1000n,
      });
      expect(fee.estimatedFee).toBeGreaterThan(0n);
      expect(fee.gasLimit).toBe(21000n);

      const simSuccess = await adapter.simulateTransaction({
        recipient: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94',
        value: 1000n,
      });
      expect(simSuccess.success).toBe(true);
      expect(simSuccess.estimatedFee).toBe(fee.estimatedFee);

      const simInvalid = await adapter.simulateTransaction({
        recipient: 'invalid-address',
        value: 1000n,
      });
      expect(simInvalid.success).toBe(false);
      expect(simInvalid.error).toBeDefined();
    });

    it('delegates estimateFee and simulateTransaction on ChainWallet', async () => {
      const adapter = createChainAdapter('monad-testnet');
      const wallet = adapter.getWallet('0x9858EfFD232B4033E47d90003D41EC34EcaEda94');
      const fee = await wallet.estimateFee({
        recipient: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94',
        value: 1000n,
      });
      expect(fee.estimatedFee).toBeGreaterThan(0n);
    });
  });

  describe('Multi-Wallet Selection & getFundedWallets', () => {
    it('filters wallets by balance > 0n', async () => {
      const allocated: WalletIdentifier[] = [
        {
          walletName: 'Funded Account',
          walletId: asWalletId('monad:funded'),
          walletChainId: 'monad-testnet',
          accountIndex: 0,
        },
        {
          walletName: 'Empty Account',
          walletId: asWalletId('monad:empty'),
          walletChainId: 'monad-testnet',
          accountIndex: 1,
        },
      ];
      const walletMap = createWalletArray({ mnemonic: TEST_MNEMONIC }, allocated);
      const fundedWallet = walletMap.get(asWalletId('monad:funded'))!;
      const emptyWallet = walletMap.get(asWalletId('monad:empty'))!;

      // Mock getBalance
      jest.spyOn(fundedWallet, 'getBalance').mockResolvedValue(1000000n);
      jest.spyOn(emptyWallet, 'getBalance').mockResolvedValue(0n);

      const funded = await getFundedWallets('monad-testnet', walletMap);
      expect(funded.length).toBe(1);
      expect(funded[0].walletId).toBe(asWalletId('monad:funded'));
    });
  });

  describe('Tempo TIP-20 Balance Resolution', () => {
    it('uses eth_call to query PATHUSD balanceOf instead of eth_getBalance', async () => {
      const adapter = createChainAdapter('tempo-testnet');
      const wallet = adapter.getWallet('0x9858EfFD232B4033E47d90003D41EC34EcaEda94');

      const mockFetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        const body = JSON.parse(init?.body as string);
        expect(body.method).toBe('eth_call');
        expect(body.params[0].to.toLowerCase()).toBe(PATHUSD.toLowerCase());
        // Return 5000000 atomic units = 5 USD (6 decimals) encoded as 32-byte hex
        return {
          ok: true,
          json: async () => ({ result: '0x00000000000000000000000000000000000000000000000000000000004c4b40' }),
        } as Response;
      });

      const balance = await wallet.getBalance();
      expect(balance).toBe(5000000n);
      expect(adapter.toDisplayAmount(balance)).toBe('5');
      mockFetch.mockRestore();
    });
  });

  describe('Observable Wallet Storage Integration', () => {
    it('allocates an isolated storage adapter per wallet and notifies on state mutations', async () => {
      const adapter = createChainAdapter('monad-testnet');
      const wallet = await adapter.createWallet({
        root: { mnemonic: TEST_MNEMONIC },
        accountIndex: 0,
      });

      expect(wallet.storage).toBeDefined();
      expect(wallet.storage?.walletId).toBe(wallet.walletId);
      expect(wallet.storage?.dbName).toBe(`frank-wallet-${wallet.walletId.replace(/[^a-zA-Z0-9_-]/g, '_')}`);

      const events: any[] = [];
      const unsubscribe = wallet.storage?.subscribe((event) => {
        events.push(event);
      });

      await wallet.storage?.set('custom_key', 'custom_val');
      expect(events).toHaveLength(1);
      expect(events[0].key).toBe('custom_key');
      expect(events[0].value).toBe('custom_val');

      unsubscribe?.();
    });
  });
});
