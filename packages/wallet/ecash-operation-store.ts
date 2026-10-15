/**
 * New eCash operations own claims, signed bytes, immutable intent and monotonic HD change
 * allocation. The SDK/Chronik inventory remains derived. Existing native-attempt rows retain
 * their separate, still-authorized submission obligations; this ledger never copies them.
 * No keys or message content are stored here. Host composition persists the complete encrypted
 * payload before asserting its bound exposure digest. Reopen is read-only until an authorized
 * operation mutates. A source rollback must retain this namespace for signed-byte recovery.
 */
import type { EcashStealthReceipt } from "./ecash-stealth";

export interface EcashNativeIntent {
  readonly recipient: string;
  readonly value: string;
  readonly maxFee?: string;
}

export interface EcashOperationExposureBinding {
  readonly chainIdentifier: string;
  readonly walletAddress: string;
  readonly transactionHashes: ReadonlyArray<string>;
  readonly externalPayloadDigest: string;
}

export interface EcashNativeOperation {
  readonly operationId: string;
  readonly intent: EcashNativeIntent;
  readonly state:
    | "prepared"
    | "exposed"
    | "submitted"
    | "confirmed"
    | "released";
  readonly transactions: ReadonlyArray<{
    readonly txid: string;
    readonly rawTransaction: string;
  }>;
  readonly inputs: ReadonlyArray<{
    readonly txid: string;
    readonly vout: number;
    readonly satoshis: string;
  }>;
  readonly fee: string;
  readonly nextChangeIndex: number;
  readonly exposure?:
    | { readonly kind: "native-rpc" }
    | {
        readonly kind: "external-payload";
        readonly binding: EcashOperationExposureBinding;
      };
}

export interface EcashOperationLedger {
  readonly version: 1;
  readonly chainIdentifier: string;
  readonly walletAddress: string;
  readonly nextChangeIndex: number;
  readonly operations: ReadonlyArray<EcashNativeOperation>;
  /** Confirmed prior-obligation inputs. No lifecycle or signed bytes are copied here. */
  readonly consumedInputs?: ReadonlyArray<{
    readonly txid: string;
    readonly vout: number;
  }>;
  /** Public derivation and claimed-output facts only. SDK/Chronik still own coin inventory. */
  readonly stealthReceipts?: ReadonlyArray<EcashStealthReceipt>;
}

export interface EcashOperationStore {
  readonly coordinationScope: "single-realm" | "cross-process";
  /** Return committed state, or reject while a preceding failed write remains uncertain.
   * Volatile visibility is insufficient evidence of durability; a committed write whose
   * acknowledgment was lost may be reread. */
  get(walletKey: string): Promise<EcashOperationLedger | undefined>;
  /** Must complete durably or throw. No volatile fallback is permitted. A rejection may follow
   * a committed write: reread the original operation rather than treating failure as a released
   * claim. Await the commit barrier before external exposure. */
  put(walletKey: string, ledger: EcashOperationLedger): Promise<void>;
}

const hash = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const quantity = (value: unknown): value is string =>
  typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value);
const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const index = (value: unknown): value is number =>
  Number.isSafeInteger(value) &&
  Number(value) >= 0 &&
  Number(value) < 0x80000000;

/** Reject corruption visibly; never replace an unreadable obligation with an empty ledger. */
export function parseEcashOperationLedger(
  serialized: string
): EcashOperationLedger {
  const value: unknown = JSON.parse(serialized);
  if (
    !object(value) ||
    value.version !== 1 ||
    !text(value.chainIdentifier) ||
    !text(value.walletAddress) ||
    !index(value.nextChangeIndex) ||
    !Array.isArray(value.operations)
  )
    throw new Error("Invalid eCash operation ledger");
  if (value.consumedInputs !== undefined) {
    if (!Array.isArray(value.consumedInputs))
      throw new Error("Invalid eCash consumed inputs");
    const consumed = new Set<string>();
    for (const input of value.consumedInputs) {
      if (
        !object(input) ||
        !hash(input.txid) ||
        !Number.isSafeInteger(input.vout) ||
        Number(input.vout) < 0 ||
        Number(input.vout) > 0xffffffff
      )
        throw new Error("Invalid eCash consumed input");
      const key = `${input.txid}:${input.vout}`;
      if (consumed.has(key)) throw new Error("Duplicate eCash consumed input");
      consumed.add(key);
    }
  }
  if (
    value.stealthReceipts !== undefined &&
    (!Array.isArray(value.stealthReceipts) ||
      value.stealthReceipts.some(
        (receipt: unknown) =>
          !object(receipt) ||
          !object(receipt.derivation) ||
          !text(receipt.derivation.chainIdentifier) ||
          !text(receipt.derivation.identityPublicKey) ||
          !text(receipt.derivation.ephemeralPubKey) ||
          !text(receipt.publicKey) ||
          !text(receipt.address) ||
          !quantity(receipt.claimedAmount) ||
          !hash(receipt.payloadDigest) ||
          !Number.isSafeInteger(receipt.timestamp) ||
          Number(receipt.timestamp) < 0 ||
          !Array.isArray(receipt.transactions) ||
          receipt.transactions.some((raw: unknown) => typeof raw !== "string")
      ))
  )
    throw new Error("Invalid eCash stealth receipt record");
  const ids = new Set<string>();
  const claimed = new Set<string>();
  for (const operation of value.operations) {
    if (
      !object(operation) ||
      !text(operation.operationId) ||
      ids.has(operation.operationId) ||
      !object(operation.intent) ||
      !text(operation.intent.recipient) ||
      !quantity(operation.intent.value) ||
      operation.intent.value === "0" ||
      (operation.intent.maxFee !== undefined &&
        !quantity(operation.intent.maxFee)) ||
      !["prepared", "exposed", "submitted", "confirmed", "released"].includes(
        String(operation.state)
      ) ||
      !quantity(operation.fee) ||
      !index(operation.nextChangeIndex) ||
      operation.nextChangeIndex > value.nextChangeIndex ||
      !Array.isArray(operation.transactions) ||
      operation.transactions.length !== 1 ||
      operation.transactions.some(
        (tx: unknown) =>
          !object(tx) ||
          !hash(tx.txid) ||
          typeof tx.rawTransaction !== "string" ||
          !/^(?:[0-9a-f]{2})+$/.test(tx.rawTransaction)
      ) ||
      !Array.isArray(operation.inputs) ||
      operation.inputs.length === 0 ||
      operation.inputs.some(
        (input: unknown) =>
          !object(input) ||
          !hash(input.txid) ||
          !Number.isSafeInteger(input.vout) ||
          Number(input.vout) < 0 ||
          Number(input.vout) > 0xffffffff ||
          !quantity(input.satoshis) ||
          input.satoshis === "0"
      )
    )
      throw new Error("Invalid eCash operation record");
    ids.add(operation.operationId);
    if (operation.state !== "released") {
      for (const input of operation.inputs) {
        const key = `${input.txid}:${input.vout}`;
        if (claimed.has(key)) throw new Error("Overlapping eCash input claims");
        claimed.add(key);
      }
    }
    const exposure = operation.exposure;
    if (operation.state === "prepared" || operation.state === "released") {
      if (exposure !== undefined)
        throw new Error("Unexposed eCash operation has exposure");
    } else if (
      !object(exposure) ||
      (exposure.kind !== "native-rpc" && exposure.kind !== "external-payload")
    ) {
      throw new Error("Exposed eCash operation lacks binding");
    } else if (exposure.kind === "external-payload") {
      const binding = exposure.binding;
      const transactions = operation.transactions;
      if (
        !object(binding) ||
        binding.chainIdentifier !== value.chainIdentifier ||
        binding.walletAddress !== value.walletAddress ||
        !hash(binding.externalPayloadDigest) ||
        !Array.isArray(binding.transactionHashes) ||
        binding.transactionHashes.length !== operation.transactions.length ||
        binding.transactionHashes.some(
          (txid: unknown, i: number) => txid !== transactions[i].txid
        )
      )
        throw new Error("Invalid eCash operation exposure binding");
    }
  }
  // Parsing validated the complete public shape. Copying never retains mutable store aliases.
  return value as unknown as EcashOperationLedger;
}

export class InMemoryEcashOperationStore implements EcashOperationStore {
  readonly coordinationScope = "single-realm" as const;
  private readonly records = new Map<string, string>();

  async get(key: string): Promise<EcashOperationLedger | undefined> {
    const value = this.records.get(key);
    return value === undefined ? undefined : parseEcashOperationLedger(value);
  }

  async put(key: string, ledger: EcashOperationLedger): Promise<void> {
    const value = JSON.stringify(ledger);
    parseEcashOperationLedger(value);
    this.records.set(key, value);
  }
}

/** Ownership is explicit: borrowed stores are never closed by a wallet. */
export interface OwnedEcashOperationStore extends EcashOperationStore {
  readonly walletKey: string;
  close(): Promise<void>;
}
export type EcashOperationStoreFactory = (binding: {
  readonly chainIdentifier: string;
  readonly walletAddress: string;
}) => OwnedEcashOperationStore | Promise<OwnedEcashOperationStore>;
export type EcashOperationStoreOptions =
  | { operationStore: EcashOperationStore; operationStoreFactory?: never }
  | {
      operationStore?: never;
      operationStoreFactory: EcashOperationStoreFactory;
    };

export function validateEcashOperationStoreOptions(options: {
  operationStore?: EcashOperationStore;
  operationStoreFactory?: EcashOperationStoreFactory;
}): void {
  if (
    (options.operationStore !== undefined) ===
    (options.operationStoreFactory !== undefined)
  )
    throw new Error(
      "Exactly one eCash operationStore or operationStoreFactory is required"
    );
}
