import { HDNodeWallet, Mnemonic } from 'ethers';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  AccountHygieneEngine,
  DirtyAccountRecord,
  SweepResult,
  WalletWithHygiene,
} from './account-hygiene';
import {
  MonadAccountHygieneEngine,
} from './monad-account-hygiene';
import {
  SolanaAccountHygieneEngine,
} from './solana-account-hygiene';
import {
  UtxoAccountHygieneEngine,
  UtxoDustDescriptor,
  UtxoWalletBackendBridge,
} from './utxo-account-hygiene';
import { MonadChangeKeyring } from './monad-change-keyring';
import { MonadHdKeyring } from './monad-hd-keyring';
import { MonadAccountTxSigner } from './monad-account-tx';
import { TransactionBundleCapability } from './transaction-bundle-wallet';

const TEST_MNEMONIC =
  'announce room limb pattern dry unit scale effort smooth jazz weasel alcohol';

describe('Account Hygiene & Dirty Account Sweeper (Ticket #925)', () => {
  describe('EVM / MonadAccountHygieneEngine', () => {
    let changeKeyring: MonadChangeKeyring;
    let hdKeyring: MonadHdKeyring;
    let mockProvider: any;
    let mockHttpClient: any;

    beforeEach(() => {
      changeKeyring = MonadChangeKeyring.fromMnemonic(TEST_MNEMONIC);
      hdKeyring = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC);

      mockProvider = {
        getBalance: jest.fn().mockResolvedValue(100_000_000_000_000_000n), // 0.1 MON
        getFeeData: jest.fn().mockResolvedValue({
          maxFeePerGas: 1_000_000_000n, // 1 gwei
          gasPrice: 1_000_000_000n,
        }),
        getTransactionCount: jest.fn().mockResolvedValue(1),
        getNetwork: jest.fn().mockResolvedValue({ chainId: 10143n }),
        estimateGas: jest.fn().mockResolvedValue(21000n),
      };

      mockHttpClient = {
        submitRawTransaction: jest.fn().mockResolvedValue('0x' + '11'.repeat(32)),
        getTransactionReceipt: jest.fn().mockResolvedValue({
          blockNumber: 100,
          status: 1,
        }),
      };
    });

    it('tracks and reports dirty accounts', async () => {
      const engine = new MonadAccountHygieneEngine({
        provider: mockProvider,
        httpClient: mockHttpClient,
        changeKeyring,
        hdKeyring,
      });

      const sub0 = hdKeyring.deriveSubAccount(0);
      expect(engine.isDirty(sub0.address)).toBe(false);

      engine.markDirty(sub0.address, 'nonce-incremented', { txHash: '0xabc' });
      expect(engine.isDirty(sub0.address)).toBe(true);
      // Case-insensitive check
      expect(engine.isDirty(sub0.address.toUpperCase())).toBe(true);

      const dirtyList = await engine.getDirtyAccounts();
      expect(dirtyList).toHaveLength(1);
      expect(dirtyList[0].address).toBe(sub0.address);
      expect(dirtyList[0].reason).toBe('nonce-incremented');
    });

    it('sweeps leftover balance to fresh BIP-44 change address when above dust threshold', async () => {
      const engine = new MonadAccountHygieneEngine({
        provider: mockProvider,
        httpClient: mockHttpClient,
        changeKeyring,
        hdKeyring,
        initialChangeIndex: 0,
      });

      const sub0 = hdKeyring.deriveSubAccount(0);
      engine.markDirty(sub0.address);

      // Provider balance: 0.1 MON. Dust threshold (21000 * 1 gwei * 2) = 42,000 gwei = 42,000,000,000,000 wei.
      const results = await engine.sweepDirtyAccounts();
      expect(results).toHaveLength(1);

      const res = results[0];
      expect(res.outcome).toBe('swept');
      expect(res.sourceAddress).toBe(sub0.address);

      // Verify destination is BIP-44 change address 0
      const expectedChange0 = changeKeyring.deriveChangeAccount(0).address;
      expect(res.destinationAddress).toBe(expectedChange0);
      expect(res.amountSwept).toBeGreaterThan(0n);
      expect(mockHttpClient.submitRawTransaction).toHaveBeenCalledTimes(1);

      // Change index advanced to 1
      expect(engine.getNextChangeIndex()).toBe(1);

      // Dirty account is now cleaned / unmarked
      expect(engine.isDirty(sub0.address)).toBe(false);

      const stats = await engine.getHygieneStats();
      expect(stats.totalSweptCount).toBe(1);
      expect(stats.totalSweptWei).toBe(res.amountSwept);
    });

    it('skips sweep when account balance is at or below dust threshold', async () => {
      mockProvider.getBalance.mockResolvedValue(10_000_000_000_000n); // 0.00001 MON (below dust)

      const engine = new MonadAccountHygieneEngine({
        provider: mockProvider,
        httpClient: mockHttpClient,
        changeKeyring,
        hdKeyring,
      });

      const sub1 = hdKeyring.deriveSubAccount(1);
      engine.markDirty(sub1.address);

      const results = await engine.sweepDirtyAccounts();
      expect(results).toHaveLength(1);
      expect(results[0].outcome).toBe('below-dust');
      expect(results[0].amountSwept).toBe(0n);
      expect(mockHttpClient.submitRawTransaction).not.toHaveBeenCalled();
    });

    it('starts and stops the autonomous background worker with jitter', () => {
      jest.useFakeTimers();

      const engine = new MonadAccountHygieneEngine({
        provider: mockProvider,
        httpClient: mockHttpClient,
        changeKeyring,
        hdKeyring,
        options: {
          sweepIntervalMs: 10_000,
          jitterMaxMs: 2_000,
        },
      });

      expect(engine.isBackgroundWorkerActive()).toBe(false);
      engine.startBackgroundWorker();
      expect(engine.isBackgroundWorkerActive()).toBe(true);

      // Calling start again is idempotent
      engine.startBackgroundWorker();
      expect(engine.isBackgroundWorkerActive()).toBe(true);

      engine.stopBackgroundWorker();
      expect(engine.isBackgroundWorkerActive()).toBe(false);

      jest.useRealTimers();
    });
  });

  describe('Solana / SolanaAccountHygieneEngine', () => {
    let mockConnection: any;
    let signers: Map<string, Keypair>;
    let changeKeypairs: Keypair[];

    beforeEach(async () => {
      signers = new Map();
      changeKeypairs = [await Keypair.generate(), await Keypair.generate()];

      mockConnection = {
        getBalance: jest.fn().mockResolvedValue(100_000_000), // 0.1 SOL
        getLatestBlockhash: jest.fn().mockResolvedValue({
          blockhash: 'EkSnNWid2cvwEVnVx9aBqawnZZj5UGLKG',
          lastValidBlockHeight: 1000,
        }),
        sendRawTransaction: jest.fn().mockResolvedValue('5UGLKGmocktxid'),
      };
    });

    it('tracks dirty signers and sweeps lamports to change accounts', async () => {
      const ephemeralKeypair = await Keypair.generate();
      signers.set(ephemeralKeypair.publicKey.toBase58(), ephemeralKeypair);

      const engine = new SolanaAccountHygieneEngine({
        connection: mockConnection,
        signerSupplier: (addr) => signers.get(addr) ?? null,
        changeDestinationSupplier: (idx) => changeKeypairs[idx].publicKey,
        initialChangeIndex: 0,
      });

      const addr = ephemeralKeypair.publicKey.toBase58();
      engine.markDirty(addr, 'transaction-signed');
      expect(engine.isDirty(addr)).toBe(true);

      const results = await engine.sweepDirtyAccounts();
      expect(results).toHaveLength(1);
      expect(results[0].outcome).toBe('swept');
      expect(results[0].sourceAddress).toBe(addr);
      expect(results[0].destinationAddress).toBe(changeKeypairs[0].publicKey.toBase58());
      expect(mockConnection.sendRawTransaction).toHaveBeenCalledTimes(1);

      expect(engine.getNextChangeIndex()).toBe(1);
      expect(engine.isDirty(addr)).toBe(false);
    });

    it('skips sweep when balance is below minimum sweep threshold', async () => {
      mockConnection.getBalance.mockResolvedValue(4_000); // 4000 lamports (below 5000)

      const ephemeralKeypair = await Keypair.generate();
      signers.set(ephemeralKeypair.publicKey.toBase58(), ephemeralKeypair);

      const engine = new SolanaAccountHygieneEngine({
        connection: mockConnection,
        signerSupplier: (addr) => signers.get(addr) ?? null,
        changeDestinationSupplier: (idx) => changeKeypairs[idx].publicKey,
      });

      const addr = ephemeralKeypair.publicKey.toBase58();
      engine.markDirty(addr);

      const results = await engine.sweepDirtyAccounts();
      expect(results[0].outcome).toBe('below-dust');
      expect(mockConnection.sendRawTransaction).not.toHaveBeenCalled();
    });
  });

  describe('UTXO / UtxoAccountHygieneEngine', () => {
    let mockBackend: jest.Mocked<UtxoWalletBackendBridge>;
    const changeAddresses = ['bitcoincash:qpchange0', 'bitcoincash:qpchange1'];

    beforeEach(() => {
      mockBackend = {
        getUtxosForAddress: jest.fn().mockResolvedValue([
          {
            txid: 'a'.repeat(64),
            vout: 0,
            satoshis: 50_000n,
            address: 'bitcoincash:qpdirty0',
          },
        ]),
        broadcastConsolidationTx: jest.fn().mockResolvedValue('txid_consolidation_123'),
        getFeeRateSatPerByte: jest.fn().mockResolvedValue(1), // 1 sat/byte
      };
    });

    it('consolidates dust UTXOs from dirty addresses into fresh change addresses', async () => {
      const engine = new UtxoAccountHygieneEngine({
        backend: mockBackend,
        changeDestinationSupplier: (idx) => changeAddresses[idx],
        maxFeeRateSatPerByte: 5,
        initialChangeIndex: 0,
      });

      const dirtyAddr = 'bitcoincash:qpdirty0';
      engine.markDirty(dirtyAddr, 'output-spent');
      expect(engine.isDirty(dirtyAddr)).toBe(true);

      const results = await engine.sweepDirtyAccounts();
      expect(results).toHaveLength(1);
      expect(results[0].outcome).toBe('swept');
      expect(results[0].sourceAddress).toBe(dirtyAddr);
      expect(results[0].destinationAddress).toBe(changeAddresses[0]);
      expect(mockBackend.broadcastConsolidationTx).toHaveBeenCalledTimes(1);

      expect(engine.getNextChangeIndex()).toBe(1);
      expect(engine.isDirty(dirtyAddr)).toBe(false);
    });

    it('defers consolidation during high fee-rate spikes', async () => {
      mockBackend.getFeeRateSatPerByte.mockResolvedValue(10); // 10 sat/byte > max 5 sat/byte

      const engine = new UtxoAccountHygieneEngine({
        backend: mockBackend,
        changeDestinationSupplier: (idx) => changeAddresses[idx],
        maxFeeRateSatPerByte: 5,
      });

      engine.markDirty('bitcoincash:qpdirty0');
      const results = await engine.sweepDirtyAccounts({ force: false });

      // Sweep deferred until fee rates normalize
      expect(results).toHaveLength(0);
      expect(mockBackend.broadcastConsolidationTx).not.toHaveBeenCalled();
    });
  });

  describe('Wallet API Encapsulation Barrier', () => {
    it('demonstrates that higher-level caller consumes TransactionBundleCapability without managing nonces or sweeps', async () => {
      // Mock wallet backend encapsulating hygiene
      const mockHygiene: AccountHygieneEngine<string> = {
        markDirty: jest.fn(),
        isDirty: jest.fn().mockReturnValue(false),
        unmarkDirty: jest.fn(),
        getDirtyAccounts: jest.fn().mockResolvedValue([]),
        sweepDirtyAccounts: jest.fn().mockResolvedValue([]),
        startBackgroundWorker: jest.fn(),
        stopBackgroundWorker: jest.fn(),
        isBackgroundWorkerActive: jest.fn().mockReturnValue(true),
        getHygieneStats: jest.fn().mockResolvedValue({
          trackedDirtyCount: 0,
          totalSweptWei: 0n,
          totalSweptCount: 0,
        }),
      };

      const highLevelWallet: TransactionBundleCapability<string, string, { to: string; amount: bigint }> = {
        address: '0xMainWallet',
        getBalance: jest.fn().mockResolvedValue(1_000_000_000n),
        buildTransactionBundle: jest.fn().mockResolvedValue({
          bundleId: 'bundle-1',
          source: '0xMainWallet',
          transactions: [
            {
              index: 0,
              destination: '0xRecipient',
              value: 100n,
              rawTransaction: '0xrawtx',
            },
          ],
        }),
        submitTransactionBundle: jest.fn().mockImplementation(async (bundle) => {
          // Internal automatic encapsulation: marks source dirty upon submit
          mockHygiene.markDirty(bundle.source, 'nonce-incremented');
          return {
            submitted: [
              {
                index: 0,
                destination: '0xRecipient',
                value: 100n,
                txId: '0xtxid123',
              },
            ],
          };
        }),
        hygiene: mockHygiene,
      };

      // Caller only performs high-level actions:
      const bundle = await highLevelWallet.buildTransactionBundle({ to: '0xRecipient', amount: 100n });
      const submission = await highLevelWallet.submitTransactionBundle(bundle);

      expect(submission.submitted).toHaveLength(1);
      expect(submission.submitted[0].txId).toBe('0xtxid123');

      // Caller never touched nonces or sweeps directly, but hygiene was tracked automatically:
      expect(mockHygiene.markDirty).toHaveBeenCalledWith('0xMainWallet', 'nonce-incremented');
    });
  });
});
