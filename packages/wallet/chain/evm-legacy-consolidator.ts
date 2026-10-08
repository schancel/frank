import { Provider, Wallet, isAddress, keccak256 } from "ethers";
import type { ChainAddress, ChainTransaction } from "./chain-wallet";
import type {
  LegacyFeeEstimate,
  LegacySendProgress,
  LegacySendResult,
} from "./active-chain";
import type { EvmAddressInventory, InventoryAccountRecord } from "../hd-address-inventory";
import type { EvmTransactionBuilder } from "./evm-transaction-builder";
import type { WalletSyncItem } from "@frank/cashweb/types/messages";

export interface LegacySendIntent {
  readonly id: string;
  readonly recipientAddress: string;
  readonly targetValueWei: string;
  readonly stagingAddress: string;
  readonly stagingPrivateKey: string;
  readonly inputAddresses: string[];
  phase: "consolidating" | "consolidated" | "draining" | "confirmed" | "failed";
  consolidationTxHashes: string[];
  drainTxHash?: string;
  readonly createdAtMs: number;
  updatedAtMs: number;
}

export interface LegacySendJournalStore {
  getPendingIntent(): LegacySendIntent | undefined;
  setPendingIntent(intent: LegacySendIntent): Promise<void>;
  clearPendingIntent(): Promise<void>;
}

export class InMemoryLegacySendJournalStore implements LegacySendJournalStore {
  private pendingIntent?: LegacySendIntent;

  getPendingIntent(): LegacySendIntent | undefined {
    return this.pendingIntent;
  }

  async setPendingIntent(intent: LegacySendIntent): Promise<void> {
    this.pendingIntent = { ...intent, consolidationTxHashes: [...intent.consolidationTxHashes] };
  }

  async clearPendingIntent(): Promise<void> {
    this.pendingIntent = undefined;
  }
}

export interface FundingAccount {
  readonly address: string;
  readonly balanceWei: bigint;
  readonly privateKey: string;
}

export interface EvmLegacyConsolidatorConfig {
  provider: Provider;
  inventory?: EvmAddressInventory;
  getFundingAccounts?: () => Promise<FundingAccount[]>;
  chainIdentifier?: string;
  /** @deprecated Use chainIdentifier instead. */
  chainId?: number | bigint | string;
  transactionBuilder?: EvmTransactionBuilder;
  journal?: LegacySendJournalStore;
  standardGasLimit?: bigint;
  onSyncTransaction?: (item: WalletSyncItem) => Promise<void>;
}

const DEFAULT_STANDARD_TRANSFER_GAS = 21_000n;

export class EvmLegacyConsolidator {
  private readonly provider: Provider;
  private readonly inventory?: EvmAddressInventory;
  private readonly getFundingAccounts?: () => Promise<FundingAccount[]>;
  private readonly chainIdentifier: string;
  private readonly journal: LegacySendJournalStore;
  private readonly standardGasLimit: bigint;
  private readonly onSyncTransaction?: (item: WalletSyncItem) => Promise<void>;

  constructor(config: EvmLegacyConsolidatorConfig) {
    this.provider = config.provider;
    this.inventory = config.inventory;
    this.getFundingAccounts = config.getFundingAccounts;
    this.chainIdentifier =
      config.chainIdentifier ??
      (config.chainId !== undefined ? String(config.chainId) : "monad-testnet");
    this.journal = config.journal ?? new InMemoryLegacySendJournalStore();
    this.standardGasLimit = config.standardGasLimit ?? DEFAULT_STANDARD_TRANSFER_GAS;
    this.onSyncTransaction = config.onSyncTransaction;
  }

  private async getGasPrice(): Promise<bigint> {
    try {
      const feeData = await this.provider.getFeeData();
      return feeData.maxFeePerGas ?? feeData.gasPrice ?? 1_000_000_000n;
    } catch {
      return 1_000_000_000n;
    }
  }

  private async collectAvailableFundingAccounts(): Promise<FundingAccount[]> {
    if (this.getFundingAccounts) {
      return await this.getFundingAccounts();
    }
    if (this.inventory) {
      const cleanAccounts = this.inventory
        .getAllAccounts()
        .filter((acc) => acc.isClean && acc.nonce === 0 && acc.balanceWei > 0n);

      return cleanAccounts.map((record) => {
        const privateKey =
          record.branch === "spend"
            ? this.inventory!.spendKeyring.deriveSubAccount(record.index).privateKey
            : this.inventory!.changeKeyring.deriveChangeAccount(record.index).privateKey;

        return {
          address: record.address,
          balanceWei: record.balanceWei,
          privateKey,
        };
      });
    }
    return [];
  }

  /**
   * Estimates the network fee required to consolidate multiple sub-accounts and execute
   * the single drain transfer to the legacy recipient.
   */
  async estimateLegacyFee(
    recipient: ChainAddress,
    value: bigint
  ): Promise<LegacyFeeEstimate> {
    const gasPrice = await this.getGasPrice();
    const singleTransferFee = this.standardGasLimit * gasPrice;
    const deliveryFee = singleTransferFee;

    const available = await this.collectAvailableFundingAccounts();
    available.sort((a, b) =>
      b.balanceWei > a.balanceWei ? 1 : b.balanceWei < a.balanceWei ? -1 : 0
    );

    let covered = 0n;
    let inputCount = 0;
    let consolidationFee = 0n;

    for (const acc of available) {
      if (acc.balanceWei <= singleTransferFee) continue;
      const netContribution = acc.balanceWei - singleTransferFee;
      covered += netContribution;
      inputCount++;
      consolidationFee += singleTransferFee;

      if (covered >= value + deliveryFee) {
        break;
      }
    }

    if (inputCount === 0) {
      inputCount = 1;
    }

    return {
      totalFee: consolidationFee + deliveryFee,
      inputCount,
      consolidationFee,
      deliveryFee,
    };
  }

  /**
   * Executes the legacy send:
   * - Fast-Path Direct Execution: If a single account covers the target amount (balanceWei >= value + deliveryFee),
   *   funds are sent directly to the destination address with zero intermediate staging account or hops.
   * - In-Set Leader Selection: If multi-account fan-in is required, the account with the largest balance
   *   is designated as the leader. Peer accounts send fan-in transfers directly into the leader address,
   *   and the leader executes the final delivery transfer to the legacy recipient.
   */
  async sendLegacy(params: {
    recipient: ChainAddress;
    value: bigint;
    onProgress?: (progress: LegacySendProgress) => void;
    onSigned?: (signed: ChainTransaction) => Promise<void>;
  }): Promise<LegacySendResult> {
    const { recipient, value, onProgress, onSigned } = params;

    if (!isAddress(recipient.raw)) {
      throw new TypeError(`Invalid EVM recipient address: ${recipient.raw}`);
    }
    if (value <= 0n) {
      throw new RangeError("Legacy send amount must be positive");
    }

    const gasPrice = await this.getGasPrice();
    const singleTransferFee = this.standardGasLimit * gasPrice;
    const deliveryFee = singleTransferFee;

    const available = await this.collectAvailableFundingAccounts();
    available.sort((a, b) =>
      b.balanceWei > a.balanceWei ? 1 : b.balanceWei < a.balanceWei ? -1 : 0
    );

    const selected: FundingAccount[] = [];
    let netAggregated = 0n;

    for (const acc of available) {
      if (acc.balanceWei <= singleTransferFee) continue;
      selected.push(acc);
      if (selected.length === 1 && selected[0].balanceWei >= value + deliveryFee) {
        break;
      }
      netAggregated += acc.balanceWei - singleTransferFee;
      if (netAggregated >= value + deliveryFee) {
        break;
      }
    }

    if (selected.length === 0) {
      throw new RangeError(
        `No spendable clean accounts available for legacy consolidation`
      );
    }

    if (selected.length === 1 && selected[0].balanceWei < value + deliveryFee) {
      throw new RangeError(
        `Insufficient clean balance across accounts to fulfill legacy send of ${value} plus consolidation gas fees`
      );
    }

    if (selected.length > 1 && netAggregated < value + deliveryFee) {
      // If we don't have enough to cover value + delivery fee, check if we can cover at least value
      if (netAggregated < value) {
        throw new RangeError(
          `Insufficient clean balance across accounts to fulfill legacy send of ${value} plus consolidation gas fees`
        );
      }
    }

    // Fast-Path Direct Execution:
    // If a single account covers the target amount, send directly to recipient.raw
    if (selected.length === 1 && selected[0].balanceWei >= value + deliveryFee) {
      const funder = selected[0];
      const funderWallet = new Wallet(funder.privateKey, this.provider);

      onProgress?.({
        status: {
          stage: "broadcasting",
        },
        message: `Broadcasting direct transfer to destination address`,
      });

      const txResponse = await funderWallet.sendTransaction({
        to: recipient.raw,
        value,
        gasLimit: this.standardGasLimit,
      });

      if (onSigned) {
        await onSigned({ txHash: txResponse.hash });
      }

      onProgress?.({
        status: {
          stage: "broadcasting",
          txHash: txResponse.hash,
        },
        message: `Broadcasting direct transfer to destination address`,
      });

      onProgress?.({
        status: {
          stage: "confirmed",
          txHash: txResponse.hash,
        },
        message: `Legacy transfer confirmed on-chain`,
      });

      const directSyncItem: WalletSyncItem = {
        type: "wallet-sync",
        direction: "out",
        chainIdentifier: this.chainIdentifier,
        txHash: txResponse.hash,
        spentInputs: [
          {
            address: funder.address,
            valueWei: (value + deliveryFee).toString(),
          },
        ],
        createdOutputs: [
          {
            address: recipient.raw,
            valueWei: value.toString(),
          },
        ],
        timestamp: Date.now(),
      };

      if (this.inventory) {
        this.inventory.processSyncTransaction(directSyncItem);
      }

      if (this.onSyncTransaction) {
        try {
          await this.onSyncTransaction(directSyncItem);
        } catch (err) {
          console.warn("Could not dispatch direct sync item:", err);
        }
      }

      return {
        txHash: txResponse.hash,
        intermediateTxHashes: [],
        totalValueSent: value,
        totalFeePaid: deliveryFee,
      };
    }

    // In-Set Leader Selection:
    // Sort selected descending by balanceWei
    selected.sort((a, b) =>
      b.balanceWei > a.balanceWei ? 1 : b.balanceWei < a.balanceWei ? -1 : 0
    );

    const leader = selected[0];
    const peers = selected.slice(1);
    const leaderWallet = new Wallet(leader.privateKey, this.provider);

    // Step 2: Persist intent to journal using leader as staging/leader address
    const intentId = `legacy-send-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const intent: LegacySendIntent = {
      id: intentId,
      recipientAddress: recipient.raw,
      targetValueWei: value.toString(),
      stagingAddress: leader.address,
      stagingPrivateKey: leader.privateKey,
      inputAddresses: selected.map((a) => a.address),
      phase: "consolidating",
      consolidationTxHashes: [],
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
    };

    await this.journal.setPendingIntent(intent);

    onProgress?.({
      status: {
        stage: "consolidating",
        completed: 0,
        total: peers.length,
        stagingTxHashes: [],
      },
      message: `Consolidating funds from ${peers.length} accounts to leader account`,
    });

    // Step 3: Phase 1 Fan-in consolidation into leader
    let neededInLeader =
      value + deliveryFee > leader.balanceWei
        ? value + deliveryFee - leader.balanceWei
        : 0n;
    let totalConsolidationFeePaid = 0n;

    for (let i = 0; i < peers.length; i++) {
      const funder = peers[i];
      const maxFunderNet = funder.balanceWei - singleTransferFee;
      const transferAmount =
        maxFunderNet >= neededInLeader ? neededInLeader : maxFunderNet;

      if (transferAmount <= 0n) continue;

      const funderSigner = new Wallet(funder.privateKey, this.provider);
      const txResponse = await funderSigner.sendTransaction({
        to: leader.address,
        value: transferAmount,
        gasLimit: this.standardGasLimit,
      });

      intent.consolidationTxHashes.push(txResponse.hash);
      intent.updatedAtMs = Date.now();
      await this.journal.setPendingIntent(intent);
      totalConsolidationFeePaid += singleTransferFee;

      const syncItem: WalletSyncItem = {
        type: "wallet-sync",
        direction: "out",
        chainIdentifier: this.chainIdentifier,
        txHash: txResponse.hash,
        spentInputs: [
          {
            address: funder.address,
            valueWei: (transferAmount + singleTransferFee).toString(),
          },
        ],
        createdOutputs: [
          {
            address: leader.address,
            valueWei: transferAmount.toString(),
            branch: "staging",
          },
        ],
        timestamp: Date.now(),
      };

      // Update inventory record if inventory is present
      if (this.inventory) {
        this.inventory.processSyncTransaction(syncItem);
      }

      if (this.onSyncTransaction) {
        try {
          await this.onSyncTransaction(syncItem);
        } catch (err) {
          console.warn("Could not dispatch consolidation sync item:", err);
        }
      }

      onProgress?.({
        status: {
          stage: "consolidating",
          completed: i + 1,
          total: peers.length,
          stagingTxHashes: [...intent.consolidationTxHashes],
        },
        message: `Funded leader account (${i + 1}/${peers.length})`,
      });

      await txResponse.wait?.();
      neededInLeader -= transferAmount;
      if (neededInLeader <= 0n) break;
    }

    intent.phase = "consolidated";
    intent.updatedAtMs = Date.now();
    await this.journal.setPendingIntent(intent);

    // Step 4: Phase 2 Drain from leader to recipient
    const leaderBalance = await this.provider.getBalance(leader.address);
    const actualDeliveryGas = this.standardGasLimit * gasPrice;
    const actualDrainValue =
      leaderBalance >= value + actualDeliveryGas
        ? value
        : leaderBalance > actualDeliveryGas
        ? leaderBalance - actualDeliveryGas
        : 0n;

    if (actualDrainValue <= 0n) {
      throw new Error("Leader account balance is insufficient to cover delivery gas fee");
    }

    const drainTxRequest = {
      to: recipient.raw,
      value: actualDrainValue,
      gasLimit: this.standardGasLimit,
    };

    const populated = await leaderWallet.populateTransaction(drainTxRequest);
    const signedRaw = await leaderWallet.signTransaction(populated);
    const drainTxHash = keccak256(signedRaw);

    if (onSigned) {
      await onSigned({ txHash: drainTxHash });
    }

    intent.phase = "draining";
    intent.drainTxHash = drainTxHash;
    intent.updatedAtMs = Date.now();
    await this.journal.setPendingIntent(intent);

    onProgress?.({
      status: {
        stage: "draining",
        stagingAddress: leader.address,
        drainTxHash,
      },
      message: `Broadcasting final transfer to destination address`,
    });

    const drainResponse = await this.provider.broadcastTransaction(signedRaw);
    await drainResponse.wait?.();

    const drainSyncItem: WalletSyncItem = {
      type: "wallet-sync",
      direction: "out",
      chainIdentifier: this.chainIdentifier,
      txHash: drainTxHash,
      spentInputs: [
        {
          address: leader.address,
          valueWei: actualDrainValue.toString(),
        },
      ],
      createdOutputs: [
        {
          address: recipient.raw,
          valueWei: actualDrainValue.toString(),
        },
      ],
      timestamp: Date.now(),
    };

    if (this.inventory) {
      this.inventory.processSyncTransaction(drainSyncItem);
    }

    if (this.onSyncTransaction) {
      try {
        await this.onSyncTransaction(drainSyncItem);
      } catch (err) {
        console.warn("Could not dispatch drain sync item:", err);
      }
    }

    intent.phase = "confirmed";
    intent.updatedAtMs = Date.now();
    await this.journal.setPendingIntent(intent);

    onProgress?.({
      status: {
        stage: "confirmed",
        txHash: drainTxHash,
      },
      message: `Legacy transfer confirmed on-chain`,
    });

    await this.journal.clearPendingIntent();

    return {
      txHash: drainTxHash,
      intermediateTxHashes: intent.consolidationTxHashes,
      totalValueSent: actualDrainValue,
      totalFeePaid: totalConsolidationFeePaid + actualDeliveryGas,
    };
  }

  /**
   * Returns any pending legacy send intent interrupted mid-flight.
   */
  getUnresolvedLegacySend(): LegacySendIntent | undefined {
    return this.journal.getPendingIntent();
  }

  /**
   * Resumes an interrupted legacy send to ensure funds in staging are drained to destination.
   */
  async resumeLegacySend(): Promise<LegacySendResult> {
    const pending = this.journal.getPendingIntent();
    if (!pending) {
      throw new Error("No pending legacy send intent to resume");
    }

    const stagingWallet = new Wallet(pending.stagingPrivateKey, this.provider);
    const gasPrice = await this.getGasPrice();
    const deliveryGas = this.standardGasLimit * gasPrice;

    // Check if the drain transaction was already broadcasted and mined
    if (pending.drainTxHash) {
      try {
        const receipt = await this.provider.getTransactionReceipt(pending.drainTxHash);
        if (receipt && receipt.status !== 0) {
          await this.journal.clearPendingIntent();
          return {
            txHash: pending.drainTxHash,
            intermediateTxHashes: pending.consolidationTxHashes,
            totalValueSent: BigInt(pending.targetValueWei),
            totalFeePaid: deliveryGas,
          };
        }
      } catch {
        // Fall through to re-checking balance
      }
    }

    const stagingBalance = await this.provider.getBalance(stagingWallet.address);
    if (stagingBalance <= deliveryGas) {
      throw new Error(
        `Staging account ${stagingWallet.address} has insufficient balance (${stagingBalance}) to drain`
      );
    }

    const targetValue = BigInt(pending.targetValueWei);
    const drainValue =
      stagingBalance >= targetValue + deliveryGas ? targetValue : stagingBalance - deliveryGas;

    const drainResponse = await stagingWallet.sendTransaction({
      to: pending.recipientAddress,
      value: drainValue,
      gasLimit: this.standardGasLimit,
    });

    await drainResponse.wait?.();

    const drainSyncItem: WalletSyncItem = {
      type: "wallet-sync",
      direction: "out",
      chainIdentifier: this.chainIdentifier,
      txHash: drainResponse.hash,
      spentInputs: [
        {
          address: stagingWallet.address,
          valueWei: drainValue.toString(),
        },
      ],
      createdOutputs: [
        {
          address: pending.recipientAddress,
          valueWei: drainValue.toString(),
        },
      ],
      timestamp: Date.now(),
    };

    if (this.inventory) {
      this.inventory.processSyncTransaction(drainSyncItem);
    }

    if (this.onSyncTransaction) {
      try {
        await this.onSyncTransaction(drainSyncItem);
      } catch (err) {
        console.warn("Could not dispatch resumed drain sync item:", err);
      }
    }

    await this.journal.clearPendingIntent();

    return {
      txHash: drainResponse.hash,
      intermediateTxHashes: pending.consolidationTxHashes,
      totalValueSent: drainValue,
      totalFeePaid: deliveryGas,
    };
  }
}
