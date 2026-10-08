import { Wallet, id, keccak256 } from "ethers";
import {
  EvmLegacyConsolidator,
  InMemoryLegacySendJournalStore,
  type FundingAccount,
  type LegacySendIntent,
} from "./evm-legacy-consolidator";
import type { LegacySendProgress } from "./active-chain";

describe("EvmLegacyConsolidator", () => {
  const wallet1 = Wallet.createRandom();
  const wallet2 = Wallet.createRandom();
  const wallet3 = Wallet.createRandom();
  const recipientAddress = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

  const standardGasLimit = 21_000n;
  const gasPrice = 1_000_000_000n; // 1 gwei
  const singleTransferFee = standardGasLimit * gasPrice; // 21_000 * 1 gwei = 21_000_000_000_000 wei

  function createMockProvider(initialBalances: Record<string, bigint> = {}) {
    const balances = new Map<string, bigint>(
      Object.entries(initialBalances).map(([k, v]) => [k.toLowerCase(), v])
    );
    const nonces = new Map<string, number>();

    const mockProvider = {
      getFeeData: jest.fn().mockResolvedValue({
        gasPrice,
        maxFeePerGas: gasPrice,
        maxPriorityFeePerGas: 100_000_000n,
      }),
      getBalance: jest.fn().mockImplementation(async (address: string) => {
        return balances.get(address.toLowerCase()) ?? 0n;
      }),
      getTransactionCount: jest.fn().mockImplementation(async (address: string) => {
        return nonces.get(address.toLowerCase()) ?? 0;
      }),
      getNetwork: jest.fn().mockResolvedValue({
        chainId: 10143n,
        name: "monad-testnet",
      }),
      estimateGas: jest.fn().mockResolvedValue(standardGasLimit),
      broadcastTransaction: jest.fn().mockImplementation(async (rawTx: string) => {
        const txHash = keccak256(rawTx);
        return {
          hash: txHash,
          wait: jest.fn().mockResolvedValue({
            status: 1,
            hash: txHash,
          }),
        };
      }),
      getTransactionReceipt: jest.fn().mockResolvedValue({
        status: 1,
      }),
      // Helper to mutate mock balance during test
      _setBalance: (address: string, bal: bigint) => {
        balances.set(address.toLowerCase(), bal);
      },
    };

    return mockProvider as any;
  }

  describe("estimateLegacyFee", () => {
    it("estimates fee for a single funding account covering the entire amount", async () => {
      const mockProvider = createMockProvider({
        [wallet1.address]: 5_000_000_000_000_000_000n, // 5 ETH
      });

      const consolidator = new EvmLegacyConsolidator({
        provider: mockProvider,
        standardGasLimit,
        getFundingAccounts: async () => [
          {
            address: wallet1.address,
            balanceWei: 5_000_000_000_000_000_000n,
            privateKey: wallet1.privateKey,
          },
        ],
      });

      const estimate = await consolidator.estimateLegacyFee(
        { raw: recipientAddress },
        1_000_000_000_000_000_000n // 1 ETH
      );

      // Single input -> inputCount: 1, consolidationFee: 21_000_000_000_000, deliveryFee: 21_000_000_000_000
      expect(estimate.inputCount).toBe(1);
      expect(estimate.deliveryFee).toBe(singleTransferFee);
      expect(estimate.consolidationFee).toBe(singleTransferFee);
      expect(estimate.totalFee).toBe(singleTransferFee * 2n);
    });

    it("estimates fees across multiple fragmented funding accounts", async () => {
      const mockProvider = createMockProvider();
      const accounts: FundingAccount[] = [
        {
          address: wallet1.address,
          balanceWei: 500_000_000_000_000n, // 0.0005 ETH
          privateKey: wallet1.privateKey,
        },
        {
          address: wallet2.address,
          balanceWei: 600_000_000_000_000n, // 0.0006 ETH
          privateKey: wallet2.privateKey,
        },
      ];

      const consolidator = new EvmLegacyConsolidator({
        provider: mockProvider,
        standardGasLimit,
        getFundingAccounts: async () => accounts,
      });

      const estimate = await consolidator.estimateLegacyFee(
        { raw: recipientAddress },
        800_000_000_000_000n // 0.0008 ETH (needs both accounts)
      );

      expect(estimate.inputCount).toBe(2);
      expect(estimate.consolidationFee).toBe(singleTransferFee * 2n);
      expect(estimate.deliveryFee).toBe(singleTransferFee);
      expect(estimate.totalFee).toBe(singleTransferFee * 3n);
    });
  });

  describe("sendLegacy", () => {
    it("validates recipient address format", async () => {
      const mockProvider = createMockProvider();
      const consolidator = new EvmLegacyConsolidator({
        provider: mockProvider,
        getFundingAccounts: async () => [],
      });

      await expect(
        consolidator.sendLegacy({
          recipient: { raw: "invalid-not-an-evm-address" },
          value: 1000n,
        })
      ).rejects.toThrow(TypeError);
    });

    it("rejects non-positive send amounts", async () => {
      const mockProvider = createMockProvider();
      const consolidator = new EvmLegacyConsolidator({
        provider: mockProvider,
        getFundingAccounts: async () => [],
      });

      await expect(
        consolidator.sendLegacy({
          recipient: { raw: recipientAddress },
          value: 0n,
        })
      ).rejects.toThrow(RangeError);
    });

    it("rejects when available funds cannot cover value plus delivery gas", async () => {
      const mockProvider = createMockProvider({
        [wallet1.address]: 500_000_000_000_000n,
      });
      const consolidator = new EvmLegacyConsolidator({
        provider: mockProvider,
        standardGasLimit,
        getFundingAccounts: async () => [
          {
            address: wallet1.address,
            balanceWei: 500_000_000_000_000n,
            privateKey: wallet1.privateKey,
          },
        ],
      });

      await expect(
        consolidator.sendLegacy({
          recipient: { raw: recipientAddress },
          value: 1_000_000_000_000_000n, // More than balance
        })
      ).rejects.toThrow(RangeError);
    });

    it("executes two-phase consolidation and drain to recipient with journal tracking", async () => {
      const valueToSend = 1_000_000_000_000_000n; // 0.001 ETH
      const account1Balance = 700_000_000_000_000n; // 0.0007 ETH
      const account2Balance = 800_000_000_000_000n; // 0.0008 ETH

      const mockProvider = createMockProvider({
        [wallet1.address]: account1Balance,
        [wallet2.address]: account2Balance,
      });

      const journal = new InMemoryLegacySendJournalStore();
      const progressUpdates: LegacySendProgress[] = [];
      const onSignedMock = jest.fn();

      const consolidator = new EvmLegacyConsolidator({
        provider: mockProvider,
        standardGasLimit,
        journal,
        getFundingAccounts: async () => [
          {
            address: wallet1.address,
            balanceWei: account1Balance,
            privateKey: wallet1.privateKey,
          },
          {
            address: wallet2.address,
            balanceWei: account2Balance,
            privateKey: wallet2.privateKey,
          },
        ],
      });

      // Track whenever setPendingIntent is called to ensure staging wallet receives funds in mock
      const originalSetPendingIntent = journal.setPendingIntent.bind(journal);
      journal.setPendingIntent = async (intent: LegacySendIntent) => {
        await originalSetPendingIntent(intent);
        if (intent.stagingAddress) {
          // Provide mock balance in the staging wallet to allow phase 2 drain
          mockProvider._setBalance(
            intent.stagingAddress,
            valueToSend + singleTransferFee
          );
        }
      };

      const result = await consolidator.sendLegacy({
        recipient: { raw: recipientAddress },
        value: valueToSend,
        onProgress: (p) => progressUpdates.push(p),
        onSigned: onSignedMock,
      });

      // Verification
      expect(result.txHash).toBeDefined();
      expect(result.totalValueSent).toBe(valueToSend);
      expect(result.intermediateTxHashes?.length).toBeGreaterThan(0);
      expect(onSignedMock).toHaveBeenCalledWith(
        expect.objectContaining({ txHash: result.txHash })
      );

      // Journal should be cleared after completion
      expect(journal.getPendingIntent()).toBeUndefined();

      // Progress updates should contain consolidating and confirmed stages
      const stages = progressUpdates.map((p) => p.status.stage);
      expect(stages).toContain("consolidating");
      expect(stages).toContain("draining");
      expect(stages).toContain("confirmed");
    });

    it("dispatches generic WalletSyncItem callbacks for Phase 1 and Phase 2 (Ticket #1115)", async () => {
      const funderBalance1 = 400_000_000_000_000n;
      const funderBalance2 = 300_000_000_000_000n;
      const targetValue = 500_000_000_000_000n;
      const mockProvider = createMockProvider({
        [wallet1.address]: funderBalance1,
        [wallet2.address]: funderBalance2,
      });

      const journal = new InMemoryLegacySendJournalStore();
      const originalSetPendingIntent = journal.setPendingIntent.bind(journal);
      journal.setPendingIntent = async (intent: LegacySendIntent) => {
        await originalSetPendingIntent(intent);
        if (intent.stagingAddress) {
          mockProvider._setBalance(
            intent.stagingAddress,
            targetValue + singleTransferFee
          );
        }
      };

      const syncItems: any[] = [];
      const consolidator = new EvmLegacyConsolidator({
        provider: mockProvider,
        journal,
        getFundingAccounts: async () => [
          {
            address: wallet1.address,
            balanceWei: funderBalance1,
            privateKey: wallet1.privateKey,
          },
          {
            address: wallet2.address,
            balanceWei: funderBalance2,
            privateKey: wallet2.privateKey,
          },
        ],
        standardGasLimit,
        chainIdentifier: "monad-testnet",
        onSyncTransaction: async (item) => {
          syncItems.push(item);
        },
      });

      const result = await consolidator.sendLegacy({
        recipient: { raw: recipientAddress },
        value: targetValue,
      });

      expect(result.txHash).toBeDefined();
      // Should have 2 sync items: 1 consolidation, 1 drain
      expect(syncItems.length).toBe(2);

      // Phase 1 Consolidation sync item: peer (wallet2) sends to leader (wallet1)
      const phase1 = syncItems[0];
      expect(phase1.type).toBe("wallet-sync");
      expect(phase1.direction).toBe("out");
      expect(phase1.chainIdentifier).toBe("monad-testnet");
      expect(phase1.spentInputs[0].address).toBe(wallet2.address);
      expect(phase1.createdOutputs[0].address).toBe(wallet1.address);
      expect(phase1.createdOutputs[0].branch).toBe("staging");

      // Phase 2 Drain sync item: leader (wallet1) sends to recipient
      const phase2 = syncItems[1];
      expect(phase2.type).toBe("wallet-sync");
      expect(phase2.direction).toBe("out");
      expect(phase2.chainIdentifier).toBe("monad-testnet");
      expect(phase2.txHash).toBe(result.txHash);
      expect(phase2.spentInputs[0].address).toBe(wallet1.address);
      expect(phase2.createdOutputs[0].address).toBe(recipientAddress);
    });

    it("executes single-account direct send on fast-path (Ticket #1203)", async () => {
      const funderBalance = 2_000_000_000_000_000n; // 0.002 ETH
      const targetValue = 1_000_000_000_000_000n; // 0.001 ETH
      const mockProvider = createMockProvider({
        [wallet1.address]: funderBalance,
      });

      const journal = new InMemoryLegacySendJournalStore();
      const progressUpdates: LegacySendProgress[] = [];
      const onSignedMock = jest.fn();
      const syncItems: any[] = [];

      const consolidator = new EvmLegacyConsolidator({
        provider: mockProvider,
        journal,
        standardGasLimit,
        chainIdentifier: "monad-testnet",
        getFundingAccounts: async () => [
          {
            address: wallet1.address,
            balanceWei: funderBalance,
            privateKey: wallet1.privateKey,
          },
        ],
        onSyncTransaction: async (item) => {
          syncItems.push(item);
        },
      });

      const result = await consolidator.sendLegacy({
        recipient: { raw: recipientAddress },
        value: targetValue,
        onProgress: (p) => progressUpdates.push(p),
        onSigned: onSignedMock,
      });

      // Verification: 1 direct transaction to recipient, 0 consolidation transactions
      expect(result.txHash).toBeDefined();
      expect(result.intermediateTxHashes).toEqual([]);
      expect(result.totalValueSent).toBe(targetValue);
      expect(result.totalFeePaid).toBe(singleTransferFee);

      // Provider broadcastTransaction should be called exactly once
      expect(mockProvider.broadcastTransaction).toHaveBeenCalledTimes(1);

      // onSigned invoked with direct tx hash
      expect(onSignedMock).toHaveBeenCalledWith(
        expect.objectContaining({ txHash: result.txHash })
      );

      // Journal has no pending intent (zero intermediate staging)
      expect(journal.getPendingIntent()).toBeUndefined();

      // Progress updates should contain broadcasting and confirmed (zero intermediate hops)
      const stages = progressUpdates.map((p) => p.status.stage);
      expect(stages).toContain("broadcasting");
      expect(stages).toContain("confirmed");
      expect(stages).not.toContain("consolidating");
      expect(stages).not.toContain("draining");

      // Exactly 1 sync item directly to recipient
      expect(syncItems.length).toBe(1);
      expect(syncItems[0].type).toBe("wallet-sync");
      expect(syncItems[0].direction).toBe("out");
      expect(syncItems[0].chainIdentifier).toBe("monad-testnet");
      expect(syncItems[0].txHash).toBe(result.txHash);
      expect(syncItems[0].spentInputs[0].address).toBe(wallet1.address);
      expect(syncItems[0].createdOutputs[0].address).toBe(recipientAddress);
    });

    it("executes multi-account in-set leader selection (Ticket #1203)", async () => {
      const balancePeer1 = 400_000_000_000_000n; // 0.0004 ETH
      const balanceLeader = 500_000_000_000_000n; // 0.0005 ETH (largest, will be leader)
      const balancePeer2 = 300_000_000_000_000n; // 0.0003 ETH
      const targetValue = 1_000_000_000_000_000n; // 0.0010 ETH

      const mockProvider = createMockProvider({
        [wallet1.address]: balancePeer1,
        [wallet2.address]: balanceLeader,
        [wallet3.address]: balancePeer2,
      });

      const journal = new InMemoryLegacySendJournalStore();
      const recordedIntents: LegacySendIntent[] = [];
      const originalSetPendingIntent = journal.setPendingIntent.bind(journal);
      journal.setPendingIntent = async (intent: LegacySendIntent) => {
        recordedIntents.push({ ...intent, consolidationTxHashes: [...intent.consolidationTxHashes] });
        await originalSetPendingIntent(intent);
        if (intent.stagingAddress) {
          // Provide mock balance in the leader wallet to allow phase 2 drain
          mockProvider._setBalance(
            intent.stagingAddress,
            targetValue + singleTransferFee
          );
        }
      };

      const syncItems: any[] = [];
      const progressUpdates: LegacySendProgress[] = [];

      const consolidator = new EvmLegacyConsolidator({
        provider: mockProvider,
        journal,
        standardGasLimit,
        chainIdentifier: "monad-testnet",
        getFundingAccounts: async () => [
          {
            address: wallet1.address,
            balanceWei: balancePeer1,
            privateKey: wallet1.privateKey,
          },
          {
            address: wallet2.address,
            balanceWei: balanceLeader,
            privateKey: wallet2.privateKey,
          },
          {
            address: wallet3.address,
            balanceWei: balancePeer2,
            privateKey: wallet3.privateKey,
          },
        ],
        onSyncTransaction: async (item) => {
          syncItems.push(item);
        },
      });

      const result = await consolidator.sendLegacy({
        recipient: { raw: recipientAddress },
        value: targetValue,
        onProgress: (p) => progressUpdates.push(p),
      });

      expect(result.txHash).toBeDefined();
      // Intermediate consolidation tx hashes should have 2 peer fan-in transfers
      expect(result.intermediateTxHashes?.length).toBe(2);
      expect(result.totalValueSent).toBe(targetValue);

      // Verify leader was designated as wallet2 (largest balance)
      expect(recordedIntents.length).toBeGreaterThan(0);
      expect(recordedIntents[0].stagingAddress).toBe(wallet2.address);
      expect(recordedIntents[0].stagingPrivateKey).toBe(wallet2.privateKey);

      // 3 sync items total: 2 peer transfers to leader + 1 leader drain to recipient
      expect(syncItems.length).toBe(3);

      // Peer 1 fan-in to leader
      expect(syncItems[0].spentInputs[0].address).toBe(wallet1.address);
      expect(syncItems[0].createdOutputs[0].address).toBe(wallet2.address);
      expect(syncItems[0].createdOutputs[0].branch).toBe("staging");

      // Peer 2 fan-in to leader
      expect(syncItems[1].spentInputs[0].address).toBe(wallet3.address);
      expect(syncItems[1].createdOutputs[0].address).toBe(wallet2.address);
      expect(syncItems[1].createdOutputs[0].branch).toBe("staging");

      // Leader final transfer to recipient
      expect(syncItems[2].spentInputs[0].address).toBe(wallet2.address);
      expect(syncItems[2].createdOutputs[0].address).toBe(recipientAddress);
      expect(syncItems[2].txHash).toBe(result.txHash);

      // Progress updates should contain consolidating, draining, and confirmed
      const stages = progressUpdates.map((p) => p.status.stage);
      expect(stages).toContain("consolidating");
      expect(stages).toContain("draining");
      expect(stages).toContain("confirmed");
    });
  });

  describe("resumeLegacySend", () => {
    it("throws when there is no pending intent to resume", async () => {
      const mockProvider = createMockProvider();
      const consolidator = new EvmLegacyConsolidator({
        provider: mockProvider,
      });

      await expect(consolidator.resumeLegacySend()).rejects.toThrow(
        "No pending legacy send intent to resume"
      );
    });

    it("resumes already-mined drain transaction and cleans journal", async () => {
      const mockProvider = createMockProvider();
      const journal = new InMemoryLegacySendJournalStore();
      const stagingWallet = Wallet.createRandom();

      await journal.setPendingIntent({
        id: "intent-1",
        recipientAddress,
        targetValueWei: "500000000000000",
        stagingAddress: stagingWallet.address,
        stagingPrivateKey: stagingWallet.privateKey,
        inputAddresses: [wallet1.address],
        phase: "draining",
        consolidationTxHashes: ["0xaaa"],
        drainTxHash: "0xbbb",
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
      });

      const consolidator = new EvmLegacyConsolidator({
        provider: mockProvider,
        journal,
      });

      const result = await consolidator.resumeLegacySend();
      expect(result.txHash).toBe("0xbbb");
      expect(result.totalValueSent).toBe(500000000000000n);
      expect(journal.getPendingIntent()).toBeUndefined();
    });

    it("broadcasts drain transaction from staging wallet when pending intent is consolidated", async () => {
      const stagingWallet = Wallet.createRandom();
      const stagingBalance = 600_000_000_000_000n;
      const targetValue = 500_000_000_000_000n;

      const mockProvider = createMockProvider({
        [stagingWallet.address]: stagingBalance,
      });

      const journal = new InMemoryLegacySendJournalStore();
      await journal.setPendingIntent({
        id: "intent-2",
        recipientAddress,
        targetValueWei: targetValue.toString(),
        stagingAddress: stagingWallet.address,
        stagingPrivateKey: stagingWallet.privateKey,
        inputAddresses: [wallet1.address],
        phase: "consolidated",
        consolidationTxHashes: ["0xaaa"],
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
      });

      const resumedSyncItems: any[] = [];
      const consolidator = new EvmLegacyConsolidator({
        provider: mockProvider,
        journal,
        standardGasLimit,
        chainIdentifier: "monad-testnet",
        onSyncTransaction: async (item) => {
          resumedSyncItems.push(item);
        },
      });

      const result = await consolidator.resumeLegacySend();
      expect(result.txHash).toBeDefined();
      expect(result.totalValueSent).toBe(targetValue);
      expect(journal.getPendingIntent()).toBeUndefined();
      expect(resumedSyncItems.length).toBe(1);
      expect(resumedSyncItems[0].chainIdentifier).toBe("monad-testnet");
      expect(resumedSyncItems[0].type).toBe("wallet-sync");
    });
  });
});
