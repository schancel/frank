import { Provider, Wallet, isAddress, keccak256 } from "ethers";
import type { ChainAddress, ChainTransaction } from "./chain-wallet";
import type {
  LegacyFeeEstimate,
  LegacySendProgress,
  LegacySendResult,
} from "./active-chain";
import type { EvmAddressInventory, InventoryAccountRecord } from "../hd-address-inventory";
import type { EvmTransactionBuilder } from "./evm-transaction-builder";

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
  chainId?: number | bigint;
  transactionBuilder?: EvmTransactionBuilder;
  journal?: LegacySendJournalStore;
  standardGasLimit?: bigint;
}

const DEFAULT_STANDARD_TRANSFER_GAS = 21_000n;

export class EvmLegacyConsolidator {
  private readonly provider: Provider;
  private readonly inventory?: EvmAddressInventory;
  private readonly getFundingAccounts?: () => Promise<FundingAccount[]>;
  private readonly journal: LegacySendJournalStore;
  private readonly standardGasLimit: bigint;

  constructor(config: EvmLegacyConsolidatorConfig) {
    this.provider = config.provider;
    this.inventory = config.inventory;
    this.getFundingAccounts = config.getFundingAccounts;
    this.journal = config.journal ?? new InMemoryLegacySendJournalStore();
    this.standardGasLimit = config.standardGasLimit ?? DEFAULT_STANDARD_TRANSFER_GAS;
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
   * Executes the two-phase legacy send:
   * Phase 1: Fan-in from selected internal accounts to an ephemeral single-use staging EOA.
   * Phase 2: Drains from the staging EOA to the destination legacy address with nonce = 1, discarding the key.
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
      netAggregated += acc.balanceWei - singleTransferFee;
      if (netAggregated >= value + deliveryFee) {
        break;
      }
    }

    if (netAggregated < value + deliveryFee && selected.length > 0) {
      // If we don't have enough to cover value + delivery fee, check if we can cover at least value
      if (netAggregated < value) {
        throw new RangeError(
          `Insufficient clean balance across accounts to fulfill legacy send of ${value} plus consolidation gas fees`
        );
      }
    } else if (selected.length === 0) {
      throw new RangeError(
        `No spendable clean accounts available for legacy consolidation`
      );
    }

    // Step 2: Generate ephemeral staging EOA
    const stagingWallet = Wallet.createRandom(this.provider);

    // Step 3: Persist intent to journal
    const intentId = `legacy-send-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const intent: LegacySendIntent = {
      id: intentId,
      recipientAddress: recipient.raw,
      targetValueWei: value.toString(),
      stagingAddress: stagingWallet.address,
      stagingPrivateKey: stagingWallet.privateKey,
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
        total: selected.length,
        stagingTxHashes: [],
      },
      message: `Consolidating funds from ${selected.length} accounts to intermediate staging account`,
    });

    // Step 4: Phase 1 Fan-in consolidation
    let neededInStaging = value + deliveryFee;
    let totalConsolidationFeePaid = 0n;

    for (let i = 0; i < selected.length; i++) {
      const funder = selected[i];
      const maxFunderNet = funder.balanceWei - singleTransferFee;
      const transferAmount =
        maxFunderNet >= neededInStaging ? neededInStaging : maxFunderNet;

      if (transferAmount <= 0n) continue;

      const funderSigner = new Wallet(funder.privateKey, this.provider);
      const txResponse = await funderSigner.sendTransaction({
        to: stagingWallet.address,
        value: transferAmount,
        gasLimit: this.standardGasLimit,
      });

      intent.consolidationTxHashes.push(txResponse.hash);
      intent.updatedAtMs = Date.now();
      await this.journal.setPendingIntent(intent);
      totalConsolidationFeePaid += singleTransferFee;

      // Update inventory record if inventory is present
      if (this.inventory) {
        this.inventory.recordSpend(funder.address, {
          txHash: txResponse.hash,
          valueWei: transferAmount + singleTransferFee,
        });
      }

      onProgress?.({
        status: {
          stage: "consolidating",
          completed: i + 1,
          total: selected.length,
          stagingTxHashes: [...intent.consolidationTxHashes],
        },
        message: `Funded staging account (${i + 1}/${selected.length})`,
      });

      await txResponse.wait?.();
      neededInStaging -= transferAmount;
      if (neededInStaging <= 0n) break;
    }

    intent.phase = "consolidated";
    intent.updatedAtMs = Date.now();
    await this.journal.setPendingIntent(intent);

    // Step 5: Phase 2 Drain from staging to recipient
    const stagingBalance = await this.provider.getBalance(stagingWallet.address);
    const actualDeliveryGas = this.standardGasLimit * gasPrice;
    const actualDrainValue =
      stagingBalance >= value + actualDeliveryGas
        ? value
        : stagingBalance > actualDeliveryGas
        ? stagingBalance - actualDeliveryGas
        : 0n;

    if (actualDrainValue <= 0n) {
      throw new Error("Staging account balance is insufficient to cover delivery gas fee");
    }

    const drainTxRequest = {
      to: recipient.raw,
      value: actualDrainValue,
      gasLimit: this.standardGasLimit,
    };

    const populated = await stagingWallet.populateTransaction(drainTxRequest);
    const signedRaw = await stagingWallet.signTransaction(populated);
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
        stagingAddress: stagingWallet.address,
        drainTxHash,
      },
      message: `Broadcasting final transfer to destination address`,
    });

    const drainResponse = await this.provider.broadcastTransaction(signedRaw);
    await drainResponse.wait?.();

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
    await this.journal.clearPendingIntent();

    return {
      txHash: drainResponse.hash,
      intermediateTxHashes: pending.consolidationTxHashes,
      totalValueSent: drainValue,
      totalFeePaid: deliveryGas,
    };
  }
}
