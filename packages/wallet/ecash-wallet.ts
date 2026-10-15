import {
  defaultEcashOperationStore,
  parseEcashOperationLedger,
} from "./ecash-operation-store";
import type {
  EcashNativeOperation,
  EcashOperationStore,
  EcashOperationLedger,
  EcashOperationExposureBinding,
} from "./ecash-operation-store";
import type {
  EcashInputReference,
  EcashNativeConstruction,
  EcashBalanceObservation,
} from "./ecash-sdk-backend";
import type { ReceivedCoinItem } from "@frank/cashweb/types/messages";
import { validateEcashStealthReceipt } from "./ecash-stealth";
import type {
  EcashStealthDerivation,
  EcashStealthReceipt,
} from "./ecash-stealth";
import type { HistoricalBip39Seed } from "../domain-roots/src";
import { BIP39_DERIVATION } from "../domain-roots/src";
import {
  ChainAddress,
  ChainTransaction,
  defaultNativeTransactionAttemptStore,
  NativeFeeExceededError,
  nativeTransactionAttemptKey,
  NativeTransactionAttemptStore,
  NativeTransactionSubmissionError,
  NativeWalletHandle,
  runNativeTransactionExclusive,
  sameChainTransaction,
} from "./chain/chain-wallet";
import { Address } from "ecash-lib/dist/address/address";
import type { ChronikClient } from "chronik-client";
import type { DomainRoot } from "../domain-roots/src";
import {
  createEcashSeedBackend,
  createEcashBip39SeedBackend,
  snapshotEcashDomainRoot,
} from "./ecash-seed-boundary";
import type { LegacyEcashSeedOptions } from "./ecash-legacy-seed";
import type {
  ChainUtxoPool,
  ChainUtxoCoin,
  ChainUtxoOrigin,
} from "./chain-utxo-pool";

export type EcashAddressPrefix = "ecash" | "ectest" | "ecregtest";
export type EcashNetworkId =
  | "xec-mainnet"
  | "xec-testnet"
  | "xec-regtest"
  | "ecash-mainnet"
  | "ecash-testnet";

export const ECASH_MAINNET_CHECKPOINT_HEIGHT = 661_648;
export const ECASH_MAINNET_CHECKPOINT_HASH =
  "000000000000000004284c9d8b2c8ff731efeaec6be50729bdc9bd07f910757d";
export const ECASH_TESTNET_CHECKPOINT_HEIGHT = 1_421_481;
export const ECASH_TESTNET_CHECKPOINT_HASH =
  "00000000062c7f32591d883c99fc89ebe74a83287c0f2b7ffeef72e62217d40b";

export const ECASH_CHECKPOINTS: Record<
  "xec-mainnet" | "xec-testnet",
  { height: number; hash: string }
> = {
  "xec-mainnet": {
    height: ECASH_MAINNET_CHECKPOINT_HEIGHT,
    hash: ECASH_MAINNET_CHECKPOINT_HASH,
  },
  "xec-testnet": {
    height: ECASH_TESTNET_CHECKPOINT_HEIGHT,
    hash: ECASH_TESTNET_CHECKPOINT_HASH,
  },
};

export type CanonicalEcashNetworkId =
  | "xec-mainnet"
  | "xec-testnet"
  | "xec-regtest";

export function canonicalEcashNetworkId(
  networkId: EcashNetworkId
): CanonicalEcashNetworkId {
  if (networkId === "xec-regtest") return "xec-regtest";
  if (networkId === "ecash-testnet" || networkId === "xec-testnet")
    return "xec-testnet";
  if (networkId === "ecash-mainnet" || networkId === "xec-mainnet")
    return "xec-mainnet";
  throw new Error("Unknown eCash network identifier");
}

export const ECASH_ADDRESS_PREFIXES: Record<
  CanonicalEcashNetworkId,
  EcashAddressPrefix
> = {
  "xec-mainnet": "ecash",
  "xec-testnet": "ectest",
  "xec-regtest": "ecregtest",
};

export interface EcashCheckpoint {
  readonly height: number;
  /** Block hash in the usual hex order. */
  readonly hash: string;
}

/**
 * The block an indexer must have to be this network. Mainnet and testnet are pinned here. Every
 * regtest starts from the same genesis block, so a regtest wallet is given a block of the node it
 * runs on (the same one the relay was given) and is refused without one.
 */
export function ecashCheckpoint(
  networkId: EcashNetworkId,
  operatorCheckpoint?: EcashCheckpoint
): EcashCheckpoint {
  const canonicalId = canonicalEcashNetworkId(networkId);
  if (canonicalId === "xec-regtest") {
    if (
      operatorCheckpoint === undefined ||
      !Number.isSafeInteger(operatorCheckpoint.height) ||
      operatorCheckpoint.height < 1 ||
      !/^[0-9a-f]{64}$/.test(operatorCheckpoint.hash)
    ) {
      throw new Error(
        "xec-regtest needs the checkpoint block (height above 0 and hash) of the node it runs on"
      );
    }
    return operatorCheckpoint;
  }
  if (operatorCheckpoint !== undefined) {
    throw new Error(
      `The checkpoint of ${canonicalId} is fixed and cannot be given`
    );
  }
  return ECASH_CHECKPOINTS[canonicalId];
}

type EcashCheckpointClient = Pick<ChronikClient, "block">;
type EcashChronikConstructor = new (urls: string[]) => ChronikClient;

async function verifyEcashChronikEndpoints(params: {
  chronik: ChronikClient;
  networkId: EcashNetworkId;
  checkpoint?: EcashCheckpoint;
  allowStructuralTestClient: boolean;
  checkpointClientFactory?: (url: string) => EcashCheckpointClient;
}): Promise<void> {
  const proxyInterface = (
    params.chronik as ChronikClient & {
      proxyInterface?: () => {
        getEndpointArray(): ReadonlyArray<{ url: string }>;
      };
    }
  ).proxyInterface;
  let checkpointClients: ReadonlyArray<{
    label: string;
    client: EcashCheckpointClient;
  }>;
  if (typeof proxyInterface === "function") {
    const urls = Array.from(
      new Set(
        proxyInterface
          .call(params.chronik)
          .getEndpointArray()
          .map((endpoint) => endpoint.url)
      )
    );
    if (urls.length === 0) {
      throw new Error("eCash Chronik client has no configured endpoints");
    }
    checkpointClients = urls.map((url) => ({
      label: url,
      client:
        params.checkpointClientFactory?.(url) ??
        new (params.chronik.constructor as EcashChronikConstructor)([url]),
    }));
  } else if (params.allowStructuralTestClient) {
    checkpointClients = [{ label: "injected Chronik", client: params.chronik }];
  } else {
    throw new Error("eCash wallet requires chronik-client 4.3 or newer");
  }

  const checkpointSpec = ecashCheckpoint(params.networkId, params.checkpoint);

  await Promise.all(
    checkpointClients.map(async ({ label, client }) => {
      const checkpoint = await client.block(checkpointSpec.height);
      if (checkpoint.blockInfo.hash !== checkpointSpec.hash) {
        throw new Error(
          `eCash Chronik checkpoint mismatch for ${label} at height ${checkpointSpec.height}: expected ${checkpointSpec.hash}, got ${checkpoint.blockInfo.hash}`
        );
      }
    })
  );
}

function canonicalEcashAddress(
  input: string,
  expectedPrefix: EcashAddressPrefix = "ecash"
): string {
  try {
    const parsed = Address.fromCashAddress(input.toLowerCase());
    if (parsed.prefix !== expectedPrefix) throw new Error("wrong prefix");
    return parsed.toString().toLowerCase();
  } catch {
    throw new Error("Invalid eCash address for the configured network");
  }
}

interface EcashPreparationBackend extends EcashWalletBackend {
  buildNativeConstruction(params: {
    recipient: string;
    value: bigint;
    excludedInputs: ReadonlyArray<EcashInputReference>;
    changeIndexFloor?: number;
  }): EcashNativeConstruction;
  restoreChangeIndex(floor: number): void;
  getAvailableBalance(excluded: ReadonlyArray<EcashInputReference>): bigint;
  inputReferencesFromTransactions(
    raw: ReadonlyArray<string>
  ): EcashInputReference[];
  validateNativeOperation(operation: EcashNativeOperation): void;
  validateLegacyTransaction(transaction: ChainTransaction): void;
}

export interface EcashWalletBackend {
  getStealthIdentityPublicKey?(): string;
  describeStealthDerivation?(
    derivation: EcashStealthDerivation
  ): Promise<{ address: string; publicKey: string }>;
  importStealthDerivation?(
    derivation: EcashStealthDerivation,
    expected: { address: string; publicKey: string }
  ): Promise<{ address: string; publicKey: string }>;
  buildNativeConstruction?: EcashPreparationBackend["buildNativeConstruction"];
  restoreChangeIndex?: EcashPreparationBackend["restoreChangeIndex"];
  getAvailableBalance?: EcashPreparationBackend["getAvailableBalance"];
  inputReferencesFromTransactions?: EcashPreparationBackend["inputReferencesFromTransactions"];
  validateNativeOperation?: EcashPreparationBackend["validateNativeOperation"];
  validateLegacyTransaction?: EcashPreparationBackend["validateLegacyTransaction"];
  /** Last complete public display projection; never the SDK's in-progress mutable inventory. */
  getCompleteBalanceObservation?(): EcashBalanceObservation | undefined;
  readonly balanceSats: bigint;
  readonly receiveIndex: number;
  sync(): Promise<void>;
  syncAndDiscoverAddresses(): Promise<void>;
  getReceiveAddress(index: number): string;
}

export type EcashWalletFactory = (params: {
  domainRoot: DomainRoot<"ecash-bch-wallet">;
  chronik: ChronikClient;
  addressPrefix: EcashAddressPrefix;
}) => EcashWalletBackend | Promise<EcashWalletBackend>;

export type EcashBip39WalletFactory = (params: {
  material: HistoricalBip39Seed;
  chronik: ChronikClient;
  addressPrefix: EcashAddressPrefix;
}) => EcashWalletBackend | Promise<EcashWalletBackend>;

export interface EcashWalletOptions {
  chronik: ChronikClient;
  networkId: EcashNetworkId;
  /** Required for `xec-regtest` and refused for every other network. See `ecashCheckpoint`. */
  checkpoint?: EcashCheckpoint;
  /** Test seam for independently checking every URL reported by a failover client. */
  checkpointClientFactory?: (url: string) => EcashCheckpointClient;
  nativeAttemptStore?: NativeTransactionAttemptStore;
  operationStore?: EcashOperationStore;
  chainUtxoPool?: ChainUtxoPool;
  getTransactionStatus?: (
    transaction: ChainTransaction
  ) => Promise<"confirmed" | "failed" | "pending" | "unknown">;
  /**
   * Sends already signed transactions (hex, in order) again. Chronik's "Failed getting <path>:
   * <reason>" error means the node answered and refused them; anything else means unknown.
   */
  rebroadcast?: (rawTransactions: ReadonlyArray<string>) => Promise<void>;
}

/**
 * The SDK/Chronik own derived coin inventory and construction. This facade owns durable
 * per-input operations, change allocation and signed-byte submission. Selection reloads the
 * shared journal under a short canonical-wallet lock; no network wait holds that lock.
 * Native-attempt rows are retained prior obligations, not a second owner for new operations.
 */
export class EcashWallet implements NativeWalletHandle {
  readonly family = "bitcoin" as const;
  readonly chainIdentifier: string;
  readonly networkId: string;
  readonly chainUtxoPool?: ChainUtxoPool;
  private readonly nativeAttemptKey: string;
  private balanceRefresh: Promise<bigint> | undefined;
  /** Derived in-memory display projection; never used by selection or signing. */
  private balanceObservation: EcashBalanceObservation | undefined;

  private constructor(
    private readonly backend: EcashWalletBackend,
    private readonly primaryAddress: string,
    networkId: string,
    attemptNetworkId: string,
    private readonly nativeAttemptStore: NativeTransactionAttemptStore,
    private readonly getTransactionStatus: (
      transaction: ChainTransaction
    ) => Promise<"confirmed" | "failed" | "pending" | "unknown">,
    chainUtxoPool: ChainUtxoPool | undefined,
    private readonly rebroadcast: (
      rawTransactions: ReadonlyArray<string>
    ) => Promise<void>,
    private readonly operationStore: EcashOperationStore
  ) {
    this.chainUtxoPool = chainUtxoPool;
    this.networkId = networkId;
    this.chainIdentifier = attemptNetworkId;
    this.nativeAttemptKey = nativeTransactionAttemptKey({
      family: "bitcoin",
      chainIdentifier: this.chainIdentifier,
      address: this.primaryAddress,
    });
    const obligation = this.nativeAttemptStore.get(this.nativeAttemptKey);
    if (obligation?.rawTransactions !== undefined)
      this.preparationBackend().validateLegacyTransaction(obligation);
  }

  static async fromDerivationMaterial(
    params: EcashWalletOptions & {
      material: DomainRoot<"ecash-bch-wallet"> | HistoricalBip39Seed;
      walletFactory?: EcashWalletFactory;
      bip39WalletFactory?: EcashBip39WalletFactory;
    }
  ): Promise<EcashWallet> {
    if (!("seed" in params.material))
      return EcashWallet.fromDomainRoot({
        ...params,
        domainRoot: params.material,
      });
    if (
      params.material.derivation !== BIP39_DERIVATION ||
      !(params.material.seed instanceof Uint8Array) ||
      params.material.seed.length !== 64
    )
      throw new Error("Expected the original 64-byte historical BIP39 seed");
    // Snapshot before endpoint verification or SDK loading; the caller may wipe its copy.
    const seed = new Uint8Array(params.material.seed);
    const factory: EcashBip39WalletFactory =
      params.bip39WalletFactory ??
      (({ material, chronik, addressPrefix }) =>
        createEcashBip39SeedBackend(material, chronik, addressPrefix));
    try {
      return await EcashWallet.initialize(
        params,
        () =>
          factory({
            material: { derivation: BIP39_DERIVATION, seed },
            chronik: params.chronik,
            addressPrefix:
              ECASH_ADDRESS_PREFIXES[canonicalEcashNetworkId(params.networkId)],
          }),
        false
      );
    } finally {
      seed.fill(0);
    }
  }

  static async fromDomainRoot(
    params: EcashWalletOptions & {
      domainRoot: DomainRoot<"ecash-bch-wallet">;
      walletFactory?: EcashWalletFactory;
    }
  ): Promise<EcashWallet> {
    // Validate and own a snapshot before the first await, endpoint probe, or SDK load.
    const domainRoot = snapshotEcashDomainRoot(params.domainRoot);
    try {
      return await EcashWallet.initialize(
        params,
        () =>
          (params.walletFactory ?? createEcashSeedBackend)({
            domainRoot,
            chronik: params.chronik,
            addressPrefix:
              ECASH_ADDRESS_PREFIXES[canonicalEcashNetworkId(params.networkId)],
          }),
        params.walletFactory !== undefined
      );
    } finally {
      domainRoot.bytes.fill(0);
    }
  }

  /** Legacy import only. Application activation/removal is owned by #692. */
  static async fromLegacyMnemonic(
    params: EcashWalletOptions & LegacyEcashSeedOptions
  ): Promise<EcashWallet> {
    const { legacyEcashBackendFactory } = await import("./ecash-legacy-seed");
    const createBackend = legacyEcashBackendFactory(params);
    return EcashWallet.initialize(
      params,
      createBackend,
      params.walletFactory !== undefined
    );
  }

  private static async initialize(
    params: EcashWalletOptions,
    createBackend: () => EcashWalletBackend | Promise<EcashWalletBackend>,
    allowStructuralTestClient: boolean
  ): Promise<EcashWallet> {
    await verifyEcashChronikEndpoints({
      chronik: params.chronik,
      networkId: params.networkId,
      checkpoint: params.checkpoint,
      allowStructuralTestClient,
      checkpointClientFactory: params.checkpointClientFactory,
    });
    const backend = await createBackend();
    const canonicalId = canonicalEcashNetworkId(params.networkId);
    const addressPrefix = ECASH_ADDRESS_PREFIXES[canonicalId];
    const primaryAddress = canonicalEcashAddress(
      backend.getReceiveAddress(0),
      addressPrefix
    );
    const wallet = new EcashWallet(
      backend,
      primaryAddress,
      canonicalId,
      // The canonical chain identifier everywhere, including the attempt record's key. It was
      // the checkpoint hash, which no caller comparing against `xec-testnet` could match.
      canonicalId,
      params.nativeAttemptStore ?? defaultNativeTransactionAttemptStore,
      params.getTransactionStatus ?? (async () => "unknown"),
      params.chainUtxoPool,
      params.rebroadcast ??
        (async (rawTransactions) => {
          for (const raw of rawTransactions)
            await params.chronik.broadcastTx(raw);
        }),
      params.operationStore ?? defaultEcashOperationStore
    );
    // Await journal validation before publishing the wallet; absent state stays in memory.
    const ledger = await wallet.loadLedger();
    await wallet.restoreStealthReceipts();
    if (ledger.nextChangeIndex > 0) {
      wallet.preparationBackend().restoreChangeIndex(ledger.nextChangeIndex);
    }
    await backend.syncAndDiscoverAddresses();
    wallet.captureBalanceObservation();
    // Resume still-authorized RPC attempts independently of new sends. Prepared operations
    // never broadcast here; parse/affinity failures above remain activation failures.
    await wallet.finishInterruptedSend().catch(() => undefined);
    return wallet;
  }

  getChainUtxoPool(): ChainUtxoPool | undefined {
    return this.chainUtxoPool;
  }

  registerUtxoCoin(params: {
    address: string;
    privateKey: string;
    txid: string;
    vout: number;
    satoshis: bigint;
    origin?: ChainUtxoOrigin;
    label?: string;
    pool?: ChainUtxoPool;
  }): ChainUtxoCoin {
    const targetPool = params.pool ?? this.chainUtxoPool;
    if (!targetPool) {
      throw new Error("No ChainUtxoPool provided or attached to EcashWallet");
    }
    return targetPool.utxo.registerOutpoint({
      chain: this.chainIdentifier,
      address: params.address,
      privateKey: params.privateKey,
      txid: params.txid,
      vout: params.vout,
      balanceWei: params.satoshis,
      origin: params.origin ?? "utxo",
      label: params.label,
    });
  }

  get identity(): NativeWalletHandle["identity"] {
    return {
      address: { raw: this.primaryAddress },
      displayAddress: this.primaryAddress,
    };
  }

  private stealthBackend(): Required<
    Pick<
      EcashWalletBackend,
      | "describeStealthDerivation"
      | "importStealthDerivation"
      | "getStealthIdentityPublicKey"
    >
  > {
    if (
      this.backend.describeStealthDerivation === undefined ||
      this.backend.importStealthDerivation === undefined ||
      this.backend.getStealthIdentityPublicKey === undefined
    )
      throw new Error(
        "eCash backend does not support recipient stealth custody"
      );
    return this.backend as Required<
      Pick<
        EcashWalletBackend,
        | "describeStealthDerivation"
        | "importStealthDerivation"
        | "getStealthIdentityPublicKey"
      >
    >;
  }

  private async restoreStealthReceipts(): Promise<void> {
    for (const receipt of (await this.loadLedger()).stealthReceipts ?? []) {
      const imported = await this.stealthBackend().importStealthDerivation(
        receipt.derivation,
        receipt
      );
      if (
        imported.address !== receipt.address ||
        imported.publicKey !== receipt.publicKey
      )
        throw new Error("Restored eCash stealth derivation mismatch");
    }
  }

  /** Public claim validation only. Receipt arrival does not credit SDK inventory or balance. */
  async recordStealthPayment(params: {
    chainIdentifier: string;
    ephemeralPubKey: string;
    claimedAmount: bigint;
    transactions: ReadonlyArray<string>;
    payloadDigest: string;
    timestamp: number;
    expectedAddress?: string;
  }): Promise<EcashStealthReceipt> {
    const snapshot = { ...params, transactions: [...params.transactions] };
    if (snapshot.chainIdentifier !== this.chainIdentifier)
      throw new Error("eCash stealth payment belongs to another chain");
    const backend = this.stealthBackend();
    const derivation = Object.freeze({
      chainIdentifier: this.chainIdentifier,
      identityPublicKey: backend.getStealthIdentityPublicKey(),
      ephemeralPubKey: snapshot.ephemeralPubKey,
    });
    const imported = await backend.describeStealthDerivation(derivation);
    if (
      snapshot.expectedAddress !== undefined &&
      snapshot.expectedAddress !== imported.address
    )
      throw new Error("eCash received coin address mismatch");
    const receipt: EcashStealthReceipt = {
      derivation,
      ...imported,
      claimedAmount: snapshot.claimedAmount.toString(),
      payloadDigest: snapshot.payloadDigest,
      timestamp: snapshot.timestamp,
      transactions: snapshot.transactions,
    };
    const prefix =
      ECASH_ADDRESS_PREFIXES[this.chainIdentifier as CanonicalEcashNetworkId];
    const incoming = validateEcashStealthReceipt(
      receipt,
      this.chainIdentifier,
      prefix
    );
    const recorded = await this.exclusive(async () => {
      const ledger = await this.loadLedger();
      const receipts = ledger.stealthReceipts ?? [];
      for (const previous of receipts) {
        const outpoints = validateEcashStealthReceipt(
          previous,
          this.chainIdentifier,
          prefix
        );
        const overlap = outpoints.some((outpoint) =>
          incoming.includes(outpoint)
        );
        const sameDigest = previous.payloadDigest === receipt.payloadDigest;
        if (sameDigest || overlap) {
          if (
            previous.address === receipt.address &&
            previous.publicKey === receipt.publicKey &&
            previous.derivation.identityPublicKey ===
              receipt.derivation.identityPublicKey &&
            previous.derivation.ephemeralPubKey ===
              receipt.derivation.ephemeralPubKey &&
            previous.claimedAmount === receipt.claimedAmount &&
            previous.transactions.length === receipt.transactions.length &&
            previous.transactions.every(
              (raw, index) => raw === receipt.transactions[index]
            )
          )
            return previous;
          throw new Error(
            "Conflicting eCash stealth receipt or duplicate outpoint"
          );
        }
      }
      await this.operationStore.put(this.nativeAttemptKey, {
        ...ledger,
        stealthReceipts: [...receipts, receipt],
      });
      return receipt;
    });
    const restored = await backend.importStealthDerivation(
      recorded.derivation,
      recorded
    );
    if (
      restored.address !== recorded.address ||
      restored.publicKey !== recorded.publicKey
    )
      throw new Error("Restored eCash stealth derivation mismatch");
    return recorded;
  }

  async recordReceivedCoin(note: ReceivedCoinItem): Promise<boolean> {
    if (
      note.type !== "received-coin" ||
      note.origin !== "stealth" ||
      typeof note.ephemeralPubKey !== "string" ||
      typeof note.payloadDigest !== "string" ||
      !Array.isArray(note.transactions) ||
      typeof note.claimedAmountWei !== "string" ||
      !/^[1-9][0-9]*$/.test(note.claimedAmountWei)
    )
      throw new Error("Invalid eCash received coin note");
    await this.recordStealthPayment({
      chainIdentifier: note.chainIdentifier,
      ephemeralPubKey: note.ephemeralPubKey,
      expectedAddress: note.address,
      claimedAmount: BigInt(note.claimedAmountWei),
      transactions: note.transactions,
      payloadDigest: note.payloadDigest,
      timestamp: note.timestamp,
    });
    return true;
  }

  async getStealthReceipts(): Promise<ReadonlyArray<EcashStealthReceipt>> {
    return (await this.loadLedger()).stealthReceipts ?? [];
  }

  private preparationBackend(): EcashPreparationBackend {
    const backend = this.backend as Partial<EcashPreparationBackend>;
    if (
      typeof backend.buildNativeConstruction !== "function" ||
      typeof backend.restoreChangeIndex !== "function" ||
      typeof backend.getAvailableBalance !== "function" ||
      typeof backend.inputReferencesFromTransactions !== "function" ||
      typeof backend.validateNativeOperation !== "function" ||
      typeof backend.validateLegacyTransaction !== "function"
    )
      throw new Error(
        "eCash backend does not support durable input preparation"
      );
    return backend as EcashPreparationBackend;
  }

  private async loadLedger(): Promise<EcashOperationLedger> {
    const stored = await this.operationStore.get(this.nativeAttemptKey);
    if (stored === undefined)
      return {
        version: 1,
        chainIdentifier: this.chainIdentifier,
        walletAddress: this.primaryAddress,
        nextChangeIndex: 0,
        operations: [],
      };
    const ledger = parseEcashOperationLedger(JSON.stringify(stored));
    if (
      ledger.chainIdentifier !== this.chainIdentifier ||
      ledger.walletAddress !== this.primaryAddress
    )
      throw new Error(
        "eCash operation ledger belongs to another wallet or chain"
      );
    const backend = this.preparationBackend();
    for (const operation of ledger.operations)
      backend.validateNativeOperation(operation);
    const outpoints = new Set<string>();
    const digests = new Set<string>();
    for (const receipt of ledger.stealthReceipts ?? []) {
      const inputs = validateEcashStealthReceipt(
        receipt,
        this.chainIdentifier,
        ECASH_ADDRESS_PREFIXES[this.chainIdentifier as CanonicalEcashNetworkId]
      );
      if (
        digests.has(receipt.payloadDigest) ||
        inputs.some((input) => outpoints.has(input))
      )
        throw new Error("Duplicate persisted eCash stealth receipt");
      digests.add(receipt.payloadDigest);
      inputs.forEach((input) => outpoints.add(input));
    }
    return ledger;
  }

  private exclusive<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.nativeAttemptStore.coordinationScope !== "single-realm")
      return Promise.reject(
        new Error(
          "Cross-process eCash obligation stores require an external coordinator"
        )
      );
    return runNativeTransactionExclusive(
      this.nativeAttemptKey,
      this.operationStore.coordinationScope,
      async () => operation()
    );
  }

  private exclusions(ledger: EcashOperationLedger): EcashInputReference[] {
    // Confirmed inputs remain spent tombstones, preventing stale indexer snapshots from
    // resurrecting them. Only a genuinely unexposed released operation frees its claims.
    const claims = [
      ...(ledger.consumedInputs ?? []),
      ...ledger.operations
        .filter((operation) => operation.state !== "released")
        .flatMap((operation) =>
          operation.inputs.map(({ txid, vout }) => ({ txid, vout }))
        ),
    ];
    const obligation = this.nativeAttemptStore.get(this.nativeAttemptKey);
    if (obligation !== undefined) {
      // These are derived exclusions, not a copied lifecycle/bytes owner. The original store
      // retains this still-authorized obligation until chain confirmation reconciles it.
      if (
        obligation.rawTransactions === undefined ||
        obligation.rawTransactions.length === 0
      )
        throw new NativeTransactionSubmissionError({
          transaction: obligation,
          reason: new Error(
            "Existing eCash obligation lacks signed input evidence; reconcile it before selecting new inputs"
          ),
        });
      this.preparationBackend().validateLegacyTransaction(obligation);
      claims.push(
        ...this.preparationBackend().inputReferencesFromTransactions(
          obligation.rawTransactions
        )
      );
    }
    return claims;
  }

  async getEcashOperations(): Promise<ReadonlyArray<EcashNativeOperation>> {
    return (await this.loadLedger()).operations;
  }

  private transaction(operation: EcashNativeOperation): ChainTransaction {
    return {
      txHash: operation.transactions[0].txid,
      rawTransactions: operation.transactions.map((tx) => tx.rawTransaction),
    };
  }

  private sameIntent(
    left: EcashNativeOperation["intent"],
    right: EcashNativeOperation["intent"]
  ): boolean {
    return (
      left.recipient === right.recipient &&
      left.value === right.value &&
      left.maxFee === right.maxFee
    );
  }

  private async updateOperation(
    operationId: string,
    change: (operation: EcashNativeOperation) => EcashNativeOperation
  ): Promise<EcashNativeOperation> {
    return this.exclusive(async () => {
      const ledger = await this.loadLedger();
      const current = ledger.operations.find(
        (operation) => operation.operationId === operationId
      );
      if (current === undefined) throw new Error("Unknown eCash operation");
      const updated = change(current);
      if (updated !== current)
        await this.operationStore.put(this.nativeAttemptKey, {
          ...ledger,
          operations: ledger.operations.map((operation) =>
            operation.operationId === operationId ? updated : operation
          ),
        });
      return updated;
    });
  }

  async prepareNativeOperation(params: {
    operationId: string;
    recipient: ChainAddress;
    value: bigint;
    maxFee?: bigint;
  }): Promise<EcashNativeOperation> {
    const { operationId, value, maxFee } = params;
    if (typeof operationId !== "string" || operationId.length === 0)
      throw new Error("eCash operation id is required");
    if (value <= 0n || (maxFee !== undefined && maxFee < 0n))
      throw new RangeError(
        "Transfer value must be greater than zero and fee ceiling nonnegative"
      );
    let recipient: string;
    try {
      recipient = canonicalEcashAddress(
        params.recipient.raw,
        ECASH_ADDRESS_PREFIXES[this.chainIdentifier as CanonicalEcashNetworkId]
      );
    } catch {
      throw new Error("Invalid eCash recipient for the configured network");
    }
    const intent = {
      recipient,
      value: value.toString(),
      ...(maxFee === undefined ? {} : { maxFee: maxFee.toString() }),
    };
    const existing = await this.exclusive(async () => {
      const operation = (await this.loadLedger()).operations.find(
        (item) => item.operationId === operationId
      );
      if (operation === undefined) return undefined;
      if (!this.sameIntent(operation.intent, intent))
        throw new Error("eCash operation id is bound to another intent");
      if (operation.state === "released")
        throw new Error("Released eCash operation cannot be reused");
      return operation;
    });
    if (existing !== undefined) return existing;
    const backend = this.preparationBackend();
    backend.restoreChangeIndex((await this.loadLedger()).nextChangeIndex);
    // Indexer waits occur outside the shared atomic selection section. A stale indexer cannot
    // make already claimed inputs selectable because claims are reloaded after this await.
    await this.restoreStealthReceipts();
    await this.backend.sync();
    return this.exclusive(async () => {
      const ledger = await this.loadLedger();
      const repeated = ledger.operations.find(
        (operation) => operation.operationId === operationId
      );
      if (repeated !== undefined) {
        if (
          !this.sameIntent(repeated.intent, intent) ||
          repeated.state === "released"
        )
          throw new Error("eCash operation id is already bound");
        return repeated;
      }
      const construction = backend.buildNativeConstruction({
        recipient,
        value: value,
        excludedInputs: this.exclusions(ledger),
        changeIndexFloor: ledger.nextChangeIndex,
      });
      if (maxFee !== undefined && construction.fee > maxFee)
        throw new NativeFeeExceededError(construction.fee);
      const operation: EcashNativeOperation = {
        operationId: operationId,
        intent,
        state: "prepared",
        transactions: construction.transactions,
        inputs: construction.selectedInputs.map((input) => ({
          ...input,
          satoshis: input.satoshis.toString(),
        })),
        fee: construction.fee.toString(),
        nextChangeIndex: construction.nextChangeIndex,
      };
      backend.validateNativeOperation(operation);
      await this.operationStore.put(this.nativeAttemptKey, {
        ...ledger,
        nextChangeIndex: Math.max(
          ledger.nextChangeIndex,
          construction.nextChangeIndex
        ),
        operations: [...ledger.operations, operation],
      });
      backend.restoreChangeIndex(construction.nextChangeIndex);
      return operation;
    });
  }

  /** Trusted host assertion: host MUST durably save its complete payload/intent before this call,
   * await this transition's success, and only then hand bytes to any relay/broadcaster.
   * The bound digest is an audit association, not proof that an application DB write occurred. */
  recordNativeOperationExposure(params: {
    operationId: string;
    binding: EcashOperationExposureBinding;
  }): Promise<EcashNativeOperation> {
    const binding = {
      ...params.binding,
      transactionHashes: [...params.binding.transactionHashes],
    };
    return this.updateOperation(params.operationId, (operation) => {
      if (
        binding.chainIdentifier !== this.chainIdentifier ||
        binding.walletAddress !== this.primaryAddress ||
        !/^[0-9a-f]{64}$/.test(binding.externalPayloadDigest) ||
        binding.transactionHashes.length !== operation.transactions.length ||
        binding.transactionHashes.some(
          (hash, i) => hash !== operation.transactions[i].txid
        )
      )
        throw new Error("eCash exposure binding does not match operation");
      if (operation.state === "released")
        throw new Error("Released eCash operation cannot be exposed");
      if (operation.exposure !== undefined) {
        if (
          operation.exposure.kind !== "external-payload" ||
          operation.exposure.binding.chainIdentifier !==
            binding.chainIdentifier ||
          operation.exposure.binding.walletAddress !== binding.walletAddress ||
          operation.exposure.binding.externalPayloadDigest !==
            binding.externalPayloadDigest ||
          operation.exposure.binding.transactionHashes.some(
            (hash, i) => hash !== binding.transactionHashes[i]
          )
        )
          throw new Error("eCash exposure is already bound");
        return operation;
      }
      return {
        ...operation,
        state: "exposed",
        exposure: { kind: "external-payload", binding },
      };
    });
  }

  releaseNativeOperation(operationId: string): Promise<EcashNativeOperation> {
    return this.updateOperation(operationId, (operation) => {
      if (operation.state === "released") return operation;
      if (operation.state !== "prepared")
        throw new Error("Exposed eCash input claims cannot be released");
      return { ...operation, state: "released" };
    });
  }

  private exposeNativeRpc(operationId: string): Promise<EcashNativeOperation> {
    return this.updateOperation(operationId, (operation) => {
      if (operation.state === "released")
        throw new Error("Released eCash operation cannot be submitted");
      if (operation.state !== "prepared") return operation;
      return {
        ...operation,
        state: "exposed",
        exposure: { kind: "native-rpc" },
      };
    });
  }

  async submitNativeOperation(operationId: string): Promise<ChainTransaction> {
    const operation = await this.exposeNativeRpc(operationId);
    const transaction = this.transaction(operation);
    if (operation.state === "confirmed") return transaction;
    try {
      await this.rebroadcast(transaction.rawTransactions!);
      await this.updateOperation(operationId, (current) =>
        current.state === "confirmed"
          ? current
          : { ...current, state: "submitted" }
      );
    } catch (reason) {
      // Refusal or a journal failure after acceptance does not prove signed bytes cannot land.
      throw new NativeTransactionSubmissionError({ transaction, reason });
    }
    return transaction;
  }

  async reconcileNativeOperation(
    operationId: string
  ): Promise<EcashNativeOperation> {
    const operation = (await this.loadLedger()).operations.find(
      (item) => item.operationId === operationId
    );
    if (operation === undefined) throw new Error("Unknown eCash operation");
    if (
      operation.state === "prepared" ||
      operation.state === "released" ||
      operation.state === "confirmed"
    )
      return operation;
    const status = await this.getTransactionStatus(this.transaction(operation));
    if (status !== "confirmed" && status !== "pending") return operation;
    return this.updateOperation(operationId, (current) =>
      current.state === "confirmed"
        ? current
        : {
            ...current,
            state: status === "confirmed" ? "confirmed" : "submitted",
          }
    );
  }

  async getReceiveAddress(): Promise<ChainAddress> {
    await this.restoreStealthReceipts();
    await this.backend.syncAndDiscoverAddresses();
    const ledger = await this.loadLedger();
    if (ledger.nextChangeIndex > 0)
      this.preparationBackend().restoreChangeIndex(ledger.nextChangeIndex);
    return {
      raw: canonicalEcashAddress(
        this.backend.getReceiveAddress(this.backend.receiveIndex),
        ECASH_ADDRESS_PREFIXES[this.chainIdentifier as CanonicalEcashNetworkId]
      ),
    };
  }

  /** Last complete SDK observation, excluding the authoritative journal's current claims. */
  async getBalanceObservation(): Promise<
    { balance: bigint; observedAt: number } | undefined
  > {
    const observation = this.balanceObservation;
    if (!observation) return undefined;
    const excluded = new Set(
      this.exclusions(await this.loadLedger()).map(
        (input) => `${input.txid}:${input.vout}`
      )
    );
    return {
      observedAt: observation.observedAt,
      balance: observation.coins.reduce(
        (sum, coin) =>
          excluded.has(`${coin.txid}:${coin.vout}`) ? sum : sum + coin.satoshis,
        0n
      ),
    };
  }

  private captureBalanceObservation(): void {
    const observation = this.backend.getCompleteBalanceObservation?.();
    if (observation)
      this.balanceObservation = {
        observedAt: observation.observedAt,
        coins: observation.coins.map(({ txid, vout, satoshis }) => ({
          txid,
          vout,
          satoshis,
        })),
      };
  }

  getBalance(): Promise<bigint> {
    if (this.balanceRefresh) return this.balanceRefresh;
    const refresh = this.refreshBalance();
    this.balanceRefresh = refresh;
    const clear = () => {
      if (this.balanceRefresh === refresh) this.balanceRefresh = undefined;
    };
    void refresh.then(clear, clear);
    return refresh;
  }

  private async refreshBalance(): Promise<bigint> {
    const floor = (await this.loadLedger()).nextChangeIndex;
    if (floor > 0) this.preparationBackend().restoreChangeIndex(floor);
    await this.restoreStealthReceipts();
    await this.backend.sync();
    return this.exclusive(async () => {
      const ledger = await this.loadLedger();
      const excluded = this.exclusions(ledger);
      this.captureBalanceObservation();
      const observation = await this.getBalanceObservation();
      if (observation) return observation.balance;
      return excluded.length === 0 &&
        this.backend.getAvailableBalance === undefined
        ? this.backend.balanceSats
        : this.preparationBackend().getAvailableBalance(excluded);
    });
  }

  async estimateFee(params: {
    recipient: ChainAddress;
    value: bigint;
  }): Promise<bigint> {
    const recipient = params.recipient.raw;
    const value = params.value;
    const floor = (await this.loadLedger()).nextChangeIndex;
    if (floor > 0) this.preparationBackend().restoreChangeIndex(floor);
    await this.restoreStealthReceipts();
    await this.backend.sync();
    return this.exclusive(async () => {
      const ledger = await this.loadLedger();
      return this.preparationBackend().buildNativeConstruction({
        recipient,
        value,
        excludedInputs: this.exclusions(ledger),
        changeIndexFloor: ledger.nextChangeIndex,
      }).fee;
    });
  }

  async getUnresolvedNativeTransaction(): Promise<
    ChainTransaction | undefined
  > {
    const old = this.nativeAttemptStore.get(this.nativeAttemptKey);
    if (old !== undefined) return old;
    const operation = (await this.loadLedger()).operations.find(
      (item) => item.state === "exposed"
    );
    return operation === undefined ? undefined : this.transaction(operation);
  }

  async retryUnresolvedNativeTransaction(): Promise<ChainTransaction> {
    const old = this.nativeAttemptStore.get(this.nativeAttemptKey);
    if (old !== undefined) {
      if (old.rawTransactions === undefined || old.rawTransactions.length === 0)
        throw new NativeTransactionSubmissionError({
          transaction: old,
          reason: new Error("Existing obligation has no signed replay bytes"),
        });
      this.preparationBackend().validateLegacyTransaction(old);
      await this.rebroadcast(old.rawTransactions);
      return old;
    }
    const operation = (await this.loadLedger()).operations.find(
      (item) => item.state === "exposed"
    );
    if (operation === undefined)
      throw new Error("No unresolved native transaction to retry");
    return this.submitNativeOperation(operation.operationId);
  }

  /** Under the shared lock, transfer only confirmed spent-input evidence before retiring its
   * original journal owner. If persistence fails, the original obligation remains recoverable.
   */
  private async retireConfirmedPriorObligation(
    old: ChainTransaction
  ): Promise<void> {
    const current = this.nativeAttemptStore.get(this.nativeAttemptKey);
    if (current === undefined || !sameChainTransaction(current, old)) return;
    const backend = this.preparationBackend();
    backend.validateLegacyTransaction(current);
    const inputs = backend.inputReferencesFromTransactions(
      current.rawTransactions!
    );
    const ledger = await this.loadLedger();
    const consumed = new Map(
      (ledger.consumedInputs ?? []).map((input) => [
        `${input.txid}:${input.vout}`,
        input,
      ])
    );
    for (const input of inputs)
      consumed.set(`${input.txid}:${input.vout}`, input);
    await this.operationStore.put(this.nativeAttemptKey, {
      ...ledger,
      consumedInputs: [...consumed.values()],
    });
    const retained = this.nativeAttemptStore.get(this.nativeAttemptKey);
    if (retained !== undefined && sameChainTransaction(retained, current))
      this.nativeAttemptStore.delete(this.nativeAttemptKey);
  }

  private async finishPriorObligation(): Promise<void> {
    const old = this.nativeAttemptStore.get(this.nativeAttemptKey);
    if (old !== undefined) {
      const status = await this.getTransactionStatus(old);
      if (status === "confirmed")
        await this.exclusive(() => this.retireConfirmedPriorObligation(old));
      else if (
        status === "unknown" &&
        old.rawTransactions !== undefined &&
        old.rawTransactions.length > 0
      ) {
        this.preparationBackend().validateLegacyTransaction(old);
        await this.rebroadcast(old.rawTransactions);
      }
    }
  }

  async finishInterruptedSend(): Promise<void> {
    const failures: unknown[] = [];
    await this.finishPriorObligation().catch((error) => {
      failures.push(error);
    });
    for (const operation of (await this.loadLedger()).operations) {
      if (
        (operation.state === "exposed" || operation.state === "submitted") &&
        operation.exposure?.kind === "native-rpc"
      ) {
        try {
          const reconciled = await this.reconcileNativeOperation(
            operation.operationId
          );
          if (reconciled.state !== "confirmed")
            await this.submitNativeOperation(operation.operationId);
        } catch (error) {
          failures.push(error);
        }
      }
    }
    if (failures.length > 0)
      throw new AggregateError(
        failures,
        "eCash recovery has unresolved operations"
      );
  }

  async resolveUnresolvedNativeTransaction(params: {
    transaction: ChainTransaction;
    outcome: "submitted" | "not-submitted";
  }): Promise<void> {
    const status = await this.getTransactionStatus(params.transaction);
    if (status !== "confirmed")
      throw new Error(
        "Exposed eCash obligations require chain confirmation; caller assertion cannot release claims"
      );
    const old = this.nativeAttemptStore.get(this.nativeAttemptKey);
    if (old !== undefined && sameChainTransaction(old, params.transaction)) {
      await this.exclusive(() => this.retireConfirmedPriorObligation(old));
      return;
    }
    const operation = (await this.loadLedger()).operations.find((item) =>
      sameChainTransaction(this.transaction(item), params.transaction)
    );
    if (operation === undefined)
      throw new Error("Transaction does not match an eCash operation");
    await this.updateOperation(operation.operationId, (current) => ({
      ...current,
      state: "confirmed",
    }));
  }

  async sendNative(params: {
    recipient: ChainAddress;
    minimumRemainingBalance?: bigint;
    value: bigint;
    maxFee?: bigint;
    onSigned?: (signed: ChainTransaction) => Promise<void>;
  }): Promise<ChainTransaction> {
    if (params.minimumRemainingBalance !== undefined)
      throw new Error("Minimum native reserve is unsupported by this wallet");
    const onSigned = params.onSigned;
    const operation = await this.prepareNativeOperation({
      ...params,
      operationId: globalThis.crypto.randomUUID(),
    });
    const exposed = await this.exposeNativeRpc(operation.operationId);
    const transaction = this.transaction(exposed);
    if (onSigned !== undefined) {
      try {
        await onSigned(transaction);
      } catch (reason) {
        throw new NativeTransactionSubmissionError({ transaction, reason });
      }
    }
    return this.submitNativeOperation(operation.operationId);
  }
}
