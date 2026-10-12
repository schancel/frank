/**
 * Wallet for Bitcoin-family chains read through an Electrum server (Bitcoin, Bitcoin Cash).
 *
 * A keyring plus a flat list of coins. The keyring derives a receive chain and a change chain from
 * one account. The coin list is what the indexer reports unspent at the wallet's addresses, each
 * with the key that spends it. A send picks coins, signs one ordinary transaction, records its
 * exact bytes, and only then broadcasts.
 *
 * Who owns which fact:
 * - The chain (through the indexer) owns which outputs are unspent. The coin list is rebuilt from
 *   it on every sync and is never stored.
 * - The wallet store owns only what the chain cannot say: the next unused receive and change
 *   indices, native submission attempts, and prepared payments' exact bytes, input claims,
 *   message exposure and submission intent. Released ids and settled inputs remain recorded to
 *   prevent a retry from creating another payment or a stale indexer from reusing spent inputs.
 *   Stealth operations also retain the original recipient identity, ephemeral public descriptor
 *   and authorized fee ceiling. Confirmed receipt amounts are current queries, never cached.
 * - Imported stealth scripts persist public derivation descriptors and message claims only.
 *   Published Frank identity custody re-derives their signing capabilities; their actual coins
 *   are discovered from the indexer alongside the HD receive/change chains.
 *
 * No address is reused: change goes to the next change address, and the receive address moves on
 * once it has been paid.
 */
import {
  decodeAddress,
  deriveHdPath,
  deriveHdPrivate,
  encodeAddress,
  hdPrivateFromSeed,
  lockingScript,
  privateKeyFromBytes,
  pubkeyHashFromBytes,
  publicFromPrivate,
  parseTransaction,
  serializeTransaction,
  signAll,
  signingKey,
  transactionId,
  cryptoBackend,
  SIGHASH_ALL,
  SIGHASH_FORKID,
  BTC_TESTNET,
  BCH_TESTNET,
} from "@frank/nakamoto";
import type {
  ChainDescriptor,
  Destination,
  HdPrivateNode,
  InternalHash,
  Transaction,
  SigningKey,
} from "@frank/nakamoto";
import {
  ChainAddress,
  ChainTransaction,
  NativeFeeExceededError,
  NativeTransactionRefusedError,
  NativeTransactionSubmissionError,
  NativeWalletHandle,
  nativeTransactionAttemptKey,
  runNativeTransactionExclusive,
} from "./chain/chain-wallet";

import {
  requireCompressedStealthPoint,
  utxoStealthDestination,
  deriveUtxoStealthDestination,
} from "./utxo-stealth";
import type { UtxoStealthCustody, UtxoStealthDerivation } from "./utxo-stealth";
import type { ReceivedCoinItem } from "@frank/cashweb/types/messages";

import { randomBytes } from "@frank/crypto-box";
import {
  utxoStealthPaymentManifest,
  utxoRecipientMembers,
  observeUtxoStealthPayment,
} from "./utxo-stealth-payment";
import type { UtxoStealthOperationDescriptor } from "./utxo-stealth-payment";
import type {
  StealthPaymentIntent,
  StealthPaymentCapability,
  PreparedStealthPayment,
  StealthPaymentReceiptCapability,
  StealthPaymentReceiptClaim,
  StealthPaymentReceiptObservation,
  StealthPaymentProgress,
} from "./stealth-payment";

/** The facts needed to build a transaction on one network. */
export interface UtxoNetwork {
  /** Canonical chain identifier from docs/protocol/chains/v1.json. */
  readonly chainIdentifier: string;
  readonly descriptor: ChainDescriptor;
  /** The kind of output the wallet's own addresses are. */
  readonly ownOutput: "p2wpkh" | "p2pkh";
  readonly addressEncoding: "bech32" | "cashaddr";
  /** BIP32 account; receive addresses are `<account>/0/i`, change `<account>/1/i`. */
  readonly accountPath: string;
  readonly sighashAlgorithm: "bip143" | "forkid";
  readonly sighashType: number;
  /** Virtual size of one signed input of the wallet's own kind. */
  readonly inputVbytes: number;
  /** Virtual size of version, counts and locktime (and the segwit marker where present). */
  readonly overheadVbytes: number;
  /** Lowest fee rate the network relays, in base units per virtual byte. */
  readonly minFeeRate: bigint;
  /** Ask the indexer for a fee rate, or always pay `minFeeRate`. */
  readonly estimateFee: boolean;
  /** Outputs below this are not relayed. */
  readonly dust: bigint;
}

export const UTXO_NETWORKS: Readonly<Record<string, UtxoNetwork>> =
  Object.freeze({
    // Bitcoin testnet3: native segwit (BIP84), BIP143 signatures.
    "btc-testnet": Object.freeze({
      chainIdentifier: "btc-testnet",
      descriptor: BTC_TESTNET,
      ownOutput: "p2wpkh",
      addressEncoding: "bech32",
      accountPath: "m/84'/1'/0'",
      sighashAlgorithm: "bip143",
      sighashType: SIGHASH_ALL,
      inputVbytes: 68,
      overheadVbytes: 11,
      minFeeRate: 1n,
      estimateFee: true,
      dust: 546n,
    }),
    // Bitcoin Cash testnet3: P2PKH cashaddr (BIP44 coin 145), signatures commit to the fork id.
    "bch-testnet": Object.freeze({
      chainIdentifier: "bch-testnet",
      descriptor: BCH_TESTNET,
      ownOutput: "p2pkh",
      addressEncoding: "cashaddr",
      accountPath: "m/44'/145'/0'",
      sighashAlgorithm: "forkid",
      sighashType: SIGHASH_ALL | SIGHASH_FORKID,
      inputVbytes: 149,
      overheadVbytes: 10,
      minFeeRate: 1n,
      estimateFee: false,
      dust: 546n,
    }),
  });

/** One unspent output as an indexer reports it. */
export interface IndexedOutput {
  readonly txid: string;
  readonly vout: number;
  readonly amount: bigint;
  /** 0 or less while unconfirmed. */
  readonly height: number;
}

/** The node answered and refused the transaction: it was not broadcast by this call. */
export class UtxoBroadcastRefused extends Error {
  /** `reason` is the node's wording, when the indexer passed one on. */
  constructor(readonly reason?: string) {
    super("The network refused the transaction");
    this.name = "UtxoBroadcastRefused";
  }
}

/** What the wallet needs from an indexer. Electrum implements it in chain/electrum-indexer.ts. */
export interface UtxoIndexer {
  listUnspent(scriptPubKey: Uint8Array): Promise<readonly IndexedOutput[]>;
  /** True once the script has ever been paid, confirmed or not. */
  hasHistory(scriptPubKey: Uint8Array): Promise<boolean>;
  /** True when the indexer knows the transaction, in a block or in its mempool. */
  hasTransaction(txid: string): Promise<boolean>;
  /** Current positive inclusion height from this script's chain history; absent means pending.
   * Unlike listUnspent, this remains observable after the recipient spends the output. */
  transactionConfirmation?(
    txid: string,
    scriptPubKey: Uint8Array
  ): Promise<{ readonly height: number } | undefined>;
  /** Throws UtxoBroadcastRefused when the node answers no; anything else means unknown. */
  broadcast(rawHex: string): Promise<void>;
  /** Base units per virtual byte for prompt confirmation, when the server can estimate one. */
  feeRate(): Promise<bigint | undefined>;
}

export type UtxoCoinState = "unspent" | "pending";

/** One spendable output with its HD key or scoped custody signing capability. */
export interface UtxoCoin {
  readonly privKey?: Uint8Array;
  /** Imported stealth outputs carry only the custody's scoped signing capability. */
  readonly signer?: SigningKey;
  readonly txid: string;
  readonly vout: number;
  readonly amount: bigint;
  /** The HD address chain or imported stealth script that was paid. */
  readonly origin: "receive" | "change" | "stealth";
  /** `pending` while a recorded transaction of this wallet spends it. */
  readonly state: UtxoCoinState;
  readonly scriptPubKey: Uint8Array;
  readonly confirmed: boolean;
}

interface PendingSend {
  readonly txid: string;
  readonly raw: string;
  readonly inputs: ReadonlyArray<{
    readonly txid: string;
    readonly vout: number;
  }>;
}

/** `settled` means the indexer knows the transaction, not confirmation/finality. A host owns
 * message delivery evidence: it marks exposure before relay access and authorizes submission
 * only after delivery. Wallet opening rechecks both submission-authorized phases (`submitted`
 * and `settled`), because a transaction previously known to the indexer can disappear. */
export type UtxoPaymentPhase =
  | "prepared"
  | "exposed"
  | "submitted"
  | "settled"
  | "released";

/** A signed payment and its durable delivery/submission facts. No transport dependency. */
export interface PreparedUtxoPayment {
  readonly operationId: string;
  readonly chainIdentifier: string;
  readonly transaction: ChainTransaction & { rawTransactions: string[] };
  readonly recipient: ChainAddress;
  readonly value: bigint;
  readonly fee: bigint;
  readonly phase: UtxoPaymentPhase;
  readonly payloadDigests: readonly string[];
  readonly stealth?: UtxoStealthOperationDescriptor;
}

interface StoredUtxoPayment extends PendingSend {
  readonly operationId: string;
  readonly chainIdentifier: string;
  readonly recipient: string;
  readonly value: string;
  readonly fee: string;
  readonly phase: UtxoPaymentPhase;
  readonly payloadDigests: readonly string[];
  readonly stealth?: UtxoStealthOperationDescriptor;
}

export interface UtxoStealthReceipt {
  readonly chainIdentifier: string;
  readonly ephemeralPubKey: string;
  readonly transactions: readonly string[];
  readonly claimedAmount: bigint;
  readonly payloadDigest: string;
  readonly timestampMs: number;
  /** A recovery note may additionally require the derived address to equal this exact value. */
  readonly expectedAddress?: string;
}

export interface UtxoStealthReceiptInfo extends UtxoStealthReceipt {
  readonly address: string;
  readonly identityPublicKey: string;
  readonly publicKey: string;
}

interface StoredStealthScript {
  readonly chainIdentifier: string;
  readonly identityPublicKey: string;
  readonly ephemeralPubKey: string;
  readonly publicKey: string;
  readonly address: string;
  /** Claims and original signed bytes, not confirmed balances or settlement facts. */
  readonly receipts: ReadonlyArray<{
    readonly payloadDigest: string;
    readonly claimedAmount: string;
    readonly transactions: readonly string[];
    readonly timestampMs: number;
  }>;
}

interface StoredState {
  readonly version: 1;
  readonly stealthScripts?: readonly StoredStealthScript[];
  readonly receiveIndex: number;
  readonly changeIndex: number;
  readonly pending: readonly PendingSend[];
  /** Inputs of native transactions the indexer knows or accepted. A retired pending row must
   * not make a stale coin view in another instance selectable. This is durable spend evidence. */
  readonly consumedNativeInputs?: ReadonlyArray<{
    readonly txid: string;
    readonly vout: number;
  }>;
  /** Absent in a native-only wallet. Existing native pending records keep their meaning. */
  readonly operations?: readonly StoredUtxoPayment[];
}

/** Durable text for one wallet. `save` must not return before the text is durable. */
export interface UtxoWalletStore {
  load(): string | undefined;
  save(serialized: string): void;
}

export function memoryUtxoWalletStore(): UtxoWalletStore {
  let value: string | undefined;
  return {
    load: () => value,
    save: (serialized) => {
      value = serialized;
    },
  };
}

/** Browser storage. Throws where there is none, so a send is never recorded only in memory. */
export function browserUtxoWalletStore(key: string): UtxoWalletStore {
  const storage = () => {
    const host = globalThis as {
      localStorage?: {
        getItem(key: string): string | null;
        setItem(key: string, value: string): void;
      };
    };
    if (host.localStorage === undefined) {
      throw new Error("UTXO wallet storage is unavailable");
    }
    return host.localStorage;
  };
  const name = `frank:utxo-wallet:v1:${key}`;
  return {
    load: () => storage().getItem(name) ?? undefined,
    save: (serialized) => storage().setItem(name, serialized),
  };
}

const ADDRESS_GAP = 20;
const MAX_FEE_RATE = 500n;
const SEQUENCE_FINAL = 0xffffffff;

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function unhex(text: string): Uint8Array {
  return Uint8Array.from(Buffer.from(text, "hex"));
}

function must<T>(
  result: { ok: true; value: T } | { ok: false; error: unknown },
  what: string
): T {
  if (!result.ok) {
    const code = (result.error as { code?: string } | undefined)?.code;
    throw new Error(`${what}${code ? `: ${code}` : ""}`);
  }
  return result.value;
}

function validOutpoint(input: {
  readonly txid: string;
  readonly vout: number;
}): boolean {
  return (
    typeof input?.txid === "string" &&
    /^[a-f0-9]{64}$/.test(input.txid) &&
    Number.isSafeInteger(input.vout) &&
    input.vout >= 0 &&
    input.vout <= 0xffffffff
  );
}

function validPendingSend(send: PendingSend): boolean {
  return (
    typeof send?.txid === "string" &&
    /^[a-f0-9]{64}$/.test(send.txid) &&
    typeof send.raw === "string" &&
    /^(?:[a-f0-9]{2})+$/.test(send.raw) &&
    Array.isArray(send.inputs) &&
    send.inputs.length > 0 &&
    send.inputs.every(validOutpoint)
  );
}

function validStoredPayment(operation: StoredUtxoPayment): boolean {
  return (
    validPendingSend(operation) &&
    (operation.stealth === undefined ||
      (/^(02|03)[a-f0-9]{64}$/.test(
        operation.stealth.recipientSpendPublicKey
      ) &&
        /^(02|03)[a-f0-9]{64}$/.test(operation.stealth.ephemeralPublicKey) &&
        /^(0|[1-9][0-9]*)$/.test(operation.stealth.maxNativeFeeAtomic))) &&
    typeof operation.operationId === "string" &&
    operation.operationId.trim().length > 0 &&
    typeof operation.chainIdentifier === "string" &&
    operation.chainIdentifier.length > 0 &&
    typeof operation.recipient === "string" &&
    operation.recipient.length > 0 &&
    typeof operation.value === "string" &&
    /^[1-9][0-9]*$/.test(operation.value) &&
    typeof operation.fee === "string" &&
    /^(0|[1-9][0-9]*)$/.test(operation.fee) &&
    ["prepared", "exposed", "submitted", "settled", "released"].includes(
      operation.phase
    ) &&
    Array.isArray(operation.payloadDigests) &&
    operation.payloadDigests.every((digest) => /^[a-f0-9]{64}$/.test(digest)) &&
    (operation.phase === "prepared" || operation.phase === "released"
      ? operation.payloadDigests.length === 0
      : operation.payloadDigests.length > 0)
  );
}

function validStealthScript(script: StoredStealthScript): boolean {
  const point = (value: string) =>
    typeof value === "string" && /^(02|03)[a-f0-9]{64}$/.test(value);
  return (
    typeof script?.chainIdentifier === "string" &&
    typeof script.address === "string" &&
    point(script.identityPublicKey) &&
    point(script.ephemeralPubKey) &&
    point(script.publicKey) &&
    Array.isArray(script.receipts) &&
    script.receipts.length > 0 &&
    script.receipts.every(
      (receipt) =>
        typeof receipt?.payloadDigest === "string" &&
        /^[a-f0-9]{64}$/.test(receipt.payloadDigest) &&
        typeof receipt.claimedAmount === "string" &&
        /^[1-9][0-9]*$/.test(receipt.claimedAmount) &&
        Number.isSafeInteger(receipt.timestampMs) &&
        receipt.timestampMs >= 0 &&
        Array.isArray(receipt.transactions) &&
        receipt.transactions.length > 0 &&
        receipt.transactions.every(
          (raw: unknown) =>
            typeof raw === "string" && /^(?:[a-f0-9]{2})+$/.test(raw)
        )
    )
  );
}

function parseState(serialized: string | undefined): StoredState {
  if (serialized === undefined) {
    return { version: 1, receiveIndex: 0, changeIndex: 0, pending: [] };
  }
  const value = JSON.parse(serialized) as Partial<StoredState>;
  const index = (candidate: unknown) =>
    Number.isSafeInteger(candidate) && (candidate as number) >= 0;
  if (
    value.version !== 1 ||
    !index(value.receiveIndex) ||
    !index(value.changeIndex) ||
    !Array.isArray(value.pending) ||
    value.pending.some((send) => !validPendingSend(send)) ||
    (value.stealthScripts !== undefined &&
      (!Array.isArray(value.stealthScripts) ||
        value.stealthScripts.some((script) => !validStealthScript(script)) ||
        new Set(value.stealthScripts.map((script) => script.address)).size !==
          value.stealthScripts.length)) ||
    (value.consumedNativeInputs !== undefined &&
      (!Array.isArray(value.consumedNativeInputs) ||
        !value.consumedNativeInputs.every(validOutpoint))) ||
    (value.operations !== undefined &&
      (!Array.isArray(value.operations) ||
        value.operations.some((operation) => !validStoredPayment(operation)) ||
        new Set(value.operations.map((operation) => operation.operationId))
          .size !== value.operations.length))
  ) {
    // A record of a possibly broadcast transaction is never silently discarded.
    throw new Error(
      "Stored UTXO wallet state is not in the current format; clear this wallet's stored state to reset it"
    );
  }
  return value as StoredState;
}

/** The transaction a send would make from `coins`, before signing. */
export interface UtxoSendPlan {
  readonly inputs: readonly UtxoCoin[];
  readonly fee: bigint;
  /** Absent when the remainder is too small to be worth an output; it then goes to the fee. */
  readonly change?: bigint;
}

/**
 * Ordinary coin selection: largest first until the amount and the fee are covered. Confirmed coins
 * are used before unconfirmed ones. Only `unspent` coins are considered.
 */
export function planUtxoSend(params: {
  coins: readonly UtxoCoin[];
  value: bigint;
  recipientScript: Uint8Array;
  feeRate: bigint;
  network: UtxoNetwork;
}): UtxoSendPlan {
  const { network, value, feeRate } = params;
  if (value < network.dust) {
    throw new Error(`Amount is below the network minimum of ${network.dust}`);
  }
  const outputVbytes = (script: Uint8Array) => 9 + script.length;
  const changeScriptBytes = network.ownOutput === "p2wpkh" ? 22 : 25;
  const candidates = params.coins
    .filter((coin) => coin.state === "unspent")
    .sort((left, right) =>
      left.confirmed !== right.confirmed
        ? left.confirmed
          ? -1
          : 1
        : left.amount === right.amount
        ? 0
        : left.amount > right.amount
        ? -1
        : 1
    );
  const inputs: UtxoCoin[] = [];
  let total = 0n;
  for (const coin of candidates) {
    inputs.push(coin);
    total += coin.amount;
    const base =
      network.overheadVbytes +
      inputs.length * network.inputVbytes +
      outputVbytes(params.recipientScript);
    const feeWithChange = BigInt(base + 9 + changeScriptBytes) * feeRate;
    if (total >= value + feeWithChange + network.dust) {
      return {
        inputs,
        fee: feeWithChange,
        change: total - value - feeWithChange,
      };
    }
    const feeWithoutChange = BigInt(base) * feeRate;
    if (total >= value + feeWithoutChange) {
      // The remainder is below dust: it cannot be an output, so it is paid as fee.
      return { inputs, fee: total - value };
    }
  }
  throw new Error("Insufficient funds for this amount and its network fee");
}

export class UtxoWallet implements NativeWalletHandle {
  readonly family = "bitcoin" as const;
  readonly chainIdentifier: string;
  readonly networkId: string;
  private coinList: UtxoCoin[] = [];
  private unresolved: NativeTransactionSubmissionError | undefined;
  /** Sends this process is broadcasting right now; nobody else re-sends or settles them. */
  private readonly inFlight = new Set<string>();
  /** Bumped whenever a recorded send is dropped, so a coin read from before it is not used. */
  private settledGeneration = 0;

  private constructor(
    readonly network: UtxoNetwork,
    private readonly account: HdPrivateNode,
    private readonly indexer: UtxoIndexer,
    private store: UtxoWalletStore,
    private state: StoredState,
    private readonly stealthCustody?: UtxoStealthCustody
  ) {
    this.chainIdentifier = network.chainIdentifier;
    this.networkId = network.chainIdentifier;
  }

  /** Financial operations are available only with an explicitly scoped custody lifetime. */
  get stealthPayments(): StealthPaymentCapability | undefined {
    if (!this.stealthCustody) return undefined;
    return {
      prepare: (intent) => this.prepareStealthPayment(intent),
      list: async () => {
        this.requireStealthCustody();
        return this.exclusive(async () => {
          this.requireStealthCustody();
          return (this.state.operations ?? [])
            .filter(
              (payment) => payment.stealth && payment.phase !== "released"
            )
            .flatMap((payment) =>
              payment.payloadDigests.length > 0
                ? payment.payloadDigests.map((payloadDigest) => ({
                    operationId: payment.operationId,
                    payloadDigest,
                  }))
                : [{ operationId: payment.operationId }]
            );
        });
      },
      expose: async (binding) => {
        await this.requireStealthOperation(binding.operationId);
        await this.recordPaymentExposure(binding);
      },
      submit: async (operationId) => {
        await this.requireStealthOperation(operationId);
        await this.submitPreparedPayment(operationId);
        return this.reconcileStealthPayment(operationId);
      },
      reconcile: (operationId) => this.reconcileStealthPayment(operationId),
      release: async (operationId) => {
        await this.requireStealthOperation(operationId);
        return this.releaseUnexposedPayment(operationId);
      },
      get: async (operationId) => {
        this.requireStealthCustody();
        return this.exclusive(async () => {
          this.requireStealthCustody();
          const payment = this.findPayment(operationId);
          return payment?.stealth
            ? utxoStealthPaymentManifest(
                this.paymentView(payment),
                this.network
              )
            : undefined;
        });
      },
    };
  }

  get stealthReceipts(): StealthPaymentReceiptCapability | undefined {
    if (!this.stealthCustody) return undefined;
    return {
      record: async (claim) =>
        this.importStealthReceipt(
          this.financialReceipt(claim),
          new Uint8Array(claim.recipientDestination)
        ),
      submit: (claim) => this.submitStealthReceipt(claim),
      observe: (claim) => this.observeStealthReceipt(claim),
    };
  }

  async prepareStealthPayment(
    intent: StealthPaymentIntent
  ): Promise<PreparedStealthPayment> {
    intent = {
      ...intent,
      asset: { ...intent.asset },
      recipientSpendPublicKey: new Uint8Array(intent.recipientSpendPublicKey),
    };
    if (intent.chainIdentifier !== this.chainIdentifier)
      throw new Error("Stealth intent belongs to another chain");
    if (intent.asset.kind !== "native")
      throw new Error("UTXO stealth supports native payments only");
    if (intent.sourceAddress !== undefined)
      throw new Error("UTXO stealth does not select a source address");
    if (
      typeof intent.amountAtomic !== "bigint" ||
      intent.amountAtomic <= 0n ||
      intent.amountAtomic > 2n ** 64n - 1n ||
      typeof intent.maxNativeFeeAtomic !== "bigint" ||
      intent.maxNativeFeeAtomic < 0n ||
      intent.maxNativeFeeAtomic > 2n ** 64n - 1n
    )
      throw new Error("Invalid stealth payment amount or fee ceiling");
    if (
      typeof intent.operationId !== "string" ||
      intent.operationId.trim().length === 0
    )
      throw new Error("Invalid stealth payment operation id");
    const recipientSpendPublicKey = requireCompressedStealthPoint(
      intent.recipientSpendPublicKey
    );
    this.requireStealthCustody();
    const existing = await this.exclusive(async () =>
      this.findPayment(intent.operationId)
    );
    if (existing) {
      this.requireStealthCustody();
      if (
        !existing.stealth ||
        existing.stealth.recipientSpendPublicKey !==
          hex(recipientSpendPublicKey) ||
        existing.stealth.maxNativeFeeAtomic !==
          intent.maxNativeFeeAtomic.toString() ||
        BigInt(existing.value) !== intent.amountAtomic
      )
        throw new Error("Payment operation already has another stealth intent");
      if (existing.phase === "released")
        throw new Error("Payment operation was released");
      return utxoStealthPaymentManifest(
        this.paymentView(existing),
        this.network
      );
    }
    // A fresh scalar belongs to this new operation only. Retries read the durable public descriptor.
    let ephemeralSecret: Uint8Array;
    for (;;) {
      ephemeralSecret = randomBytes(32);
      const key = privateKeyFromBytes(ephemeralSecret, true);
      if (key.ok) {
        key.value.bytes.fill(0);
        break;
      }
      ephemeralSecret.fill(0);
    }
    let destination: ReturnType<typeof deriveUtxoStealthDestination>;
    try {
      destination = deriveUtxoStealthDestination({
        network: this.network,
        identityPublicKey: recipientSpendPublicKey,
        ephemeralSecret,
      });
    } finally {
      ephemeralSecret.fill(0);
    }
    const prepared = await this.preparePayment({
      operationId: intent.operationId,
      recipient: { raw: destination.address },
      value: intent.amountAtomic,
      maxFee: intent.maxNativeFeeAtomic,
      stealth: {
        recipientSpendPublicKey: hex(recipientSpendPublicKey),
        ephemeralPublicKey: hex(destination.derivation.ephemeralPubKey),
        maxNativeFeeAtomic: intent.maxNativeFeeAtomic.toString(),
      },
    });
    this.requireStealthCustody();
    return utxoStealthPaymentManifest(prepared, this.network);
  }

  private async requireStealthOperation(
    operationId: string
  ): Promise<StoredUtxoPayment> {
    this.requireStealthCustody();
    return this.exclusive(async () => {
      this.requireStealthCustody();
      const payment = this.requirePayment(operationId);
      if (!payment.stealth) throw new Error("Not a stealth payment operation");
      return payment;
    });
  }

  private async reconcileStealthPayment(
    operationId: string
  ): Promise<StealthPaymentProgress> {
    const payment = await this.requireStealthOperation(operationId);
    if (payment.phase === "released")
      return {
        status: "failed",
        intendedAmountAtomic: BigInt(payment.value),
        nativeFeeAtomic: BigInt(payment.fee),
      };
    if (payment.phase === "submitted" || payment.phase === "settled")
      await this.submitPreparedPayment(operationId);
    const manifest = utxoStealthPaymentManifest(
      this.paymentView(payment),
      this.network
    );
    const result = await observeUtxoStealthPayment({
      indexer: this.indexer,
      script: this.recipientScript(payment.recipient),
      members: manifest.members,
      amount: manifest.amountAtomic,
      fee: BigInt(payment.fee),
    });
    this.requireStealthCustody();
    return result;
  }

  private financialReceipt(
    claim: StealthPaymentReceiptClaim
  ): UtxoStealthReceipt {
    if (claim.chainIdentifier !== this.chainIdentifier)
      throw new Error("Stealth claim belongs to another chain");
    if (claim.asset.kind !== "native")
      throw new Error("UTXO stealth supports native receipts only");
    return {
      chainIdentifier: claim.chainIdentifier,
      ephemeralPubKey: hex(
        requireCompressedStealthPoint(claim.ephemeralPublicKey)
      ),
      transactions: [...claim.rawTransactions],
      claimedAmount: claim.amountAtomic,
      payloadDigest: claim.payloadDigest,
      timestampMs: 0,
    };
  }

  private async observeStealthReceipt(
    claim: StealthPaymentReceiptClaim
  ): Promise<StealthPaymentReceiptObservation> {
    const receipt = this.financialReceipt(claim);
    const recipientDestination = new Uint8Array(claim.recipientDestination);
    const { destination } = await this.describeStealthReceipt(receipt);
    if (hex(destination.scriptPubKey) !== hex(recipientDestination))
      throw new Error("Stealth recipient destination does not match custody");
    const members = utxoRecipientMembers(
      receipt.transactions,
      this.network,
      destination.scriptPubKey
    );
    const progress = await observeUtxoStealthPayment({
      indexer: this.indexer,
      script: destination.scriptPubKey,
      members,
      amount: receipt.claimedAmount,
    });
    this.requireStealthCustody();
    const reserved = await this.exclusive(async () => {
      this.requireStealthCustody();
      return new Set(
        [
          ...this.state.pending.flatMap((payment) => payment.inputs),
          ...(this.state.operations ?? [])
            .filter((payment) => payment.phase !== "released")
            .flatMap((payment) => payment.inputs),
          ...(this.state.consumedNativeInputs ?? []),
        ].map((input) => `${input.txid}:${input.vout}`)
      );
    });
    const outputs = await this.indexer.listUnspent(destination.scriptPubKey);
    this.requireStealthCustody();
    const claimed = new Map(
      members.map((member) => [
        `${member.txHash}:${member.vout}`,
        member.recipientAmountAtomic,
      ])
    );
    const coins = outputs.filter((output) =>
      claimed.has(`${output.txid}:${output.vout}`)
    );
    if (
      coins.some(
        (output) =>
          claimed.get(`${output.txid}:${output.vout}`) !== output.amount
      )
    )
      throw new Error("Indexer output differs from signed stealth receipt");
    return {
      ...progress,
      spendability: coins.some(
        (coin) => !reserved.has(`${coin.txid}:${coin.vout}`)
      )
        ? "spendable"
        : coins.length > 0
        ? "reserved"
        : progress.status === "pending"
        ? "pending"
        : "empty",
    };
  }

  /** Re-broadcast only an exact claim already imported durably. Never derives a new payment. */
  private async submitStealthReceipt(
    claim: StealthPaymentReceiptClaim
  ): Promise<void> {
    const receipt = this.financialReceipt(claim);
    const recipientDestination = new Uint8Array(claim.recipientDestination);
    const { destination } = await this.describeStealthReceipt(receipt);
    if (hex(destination.scriptPubKey) !== hex(recipientDestination))
      throw new Error("Stealth recipient destination does not match custody");
    await this.exclusive(async () => {
      this.requireStealthCustody();
      const script = this.state.stealthScripts?.find(
        (script) =>
          script.address === destination.address &&
          script.ephemeralPubKey === receipt.ephemeralPubKey
      );
      const saved = script?.receipts.find(
        (saved) => saved.payloadDigest === receipt.payloadDigest
      );
      if (
        !saved ||
        saved.claimedAmount !== receipt.claimedAmount.toString() ||
        JSON.stringify(saved.transactions) !==
          JSON.stringify(receipt.transactions)
      )
        throw new Error("Stealth receipt has not been recorded durably");
    });
    const members = utxoRecipientMembers(
      receipt.transactions,
      this.network,
      destination.scriptPubKey
    );
    for (const txid of new Set(members.map((member) => member.txHash))) {
      this.requireStealthCustody();
      const known = await this.indexer.hasTransaction(txid);
      this.requireStealthCustody();
      if (!known)
        await this.indexer.broadcast(
          members.find((member) => member.txHash === txid)!.rawTransaction
        );
    }
    this.requireStealthCustody();
  }

  /**
   * `seed` is the wallet domain root32 or original historical BIP39 seed64, used directly as the BIP32 seed (the same interpretation
   * the eCash wallet uses). The caller keeps ownership of it.
   */
  static async create(params: {
    network: UtxoNetwork;
    seed: Uint8Array;
    indexer: UtxoIndexer;
    /** Durable storage for this wallet, named by its first receive address. */
    storeFor: (firstAddress: string) => UtxoWalletStore;
    /** Optional, explicitly composed published Frank identity custody; never the HD domain root. */
    stealthCustody?: UtxoStealthCustody;
  }): Promise<UtxoWallet> {
    const master = must(hdPrivateFromSeed(params.seed), "Invalid wallet seed");
    const account = must(
      deriveHdPath(master, params.network.accountPath),
      "Invalid account path"
    );
    const wallet = new UtxoWallet(
      params.network,
      account,
      params.indexer,
      memoryUtxoWalletStore(),
      parseState(undefined),
      params.stealthCustody
    );
    wallet.store = params.storeFor(wallet.addressAt(0, 0));
    wallet.reload();
    // A required imported signing capability must restore before the wallet becomes active.
    await wallet.validateStealthScripts();
    await wallet.discover();
    // Finish a send a restart interrupted. If the indexer cannot be reached now, the next send
    // tries again before it signs anything.
    await wallet.finishPending().catch(() => undefined);
    // Locally prepared or merely relay-exposed payments are never paid by wallet opening.
    // Once the host authorized submission, a restart may resend only the saved bytes.
    for (const payment of wallet.state.operations ?? []) {
      if (payment.phase === "submitted" || payment.phase === "settled")
        await wallet
          .submitPreparedPayment(payment.operationId)
          .catch(() => undefined);
    }
    return wallet;
  }

  get identity(): NativeWalletHandle["identity"] {
    const address = this.addressAt(0, 0);
    return { address: { raw: address }, displayAddress: address };
  }

  /** The current coin list: every unspent output of the wallet's addresses as last synced. */
  coins(): readonly UtxoCoin[] {
    return this.coinList;
  }

  getUnresolvedNativeTransaction(): ChainTransaction | undefined {
    return this.unresolved?.transaction;
  }

  /** The next receive address that has never been paid. */
  async getReceiveAddress(): Promise<ChainAddress> {
    await this.sync();
    return { raw: this.addressAt(0, this.state.receiveIndex) };
  }

  /** What the wallet can spend now: its unspent coins, including unconfirmed change. */
  async getBalance(): Promise<bigint> {
    await this.sync();
    return this.coinList.reduce(
      (sum, coin) => (coin.state === "unspent" ? sum + coin.amount : sum),
      0n
    );
  }

  /** The fee and the number of coins a send of `value` would use right now. */
  async estimateFee(params: {
    recipient: ChainAddress;
    value: bigint;
  }): Promise<{ fee: bigint; inputCount: number }> {
    const recipientScript = this.recipientScript(params.recipient.raw);
    const feeRate = await this.feeRate();
    await this.sync();
    const plan = planUtxoSend({
      coins: this.coinList,
      value: params.value,
      recipientScript,
      feeRate,
      network: this.network,
    });
    return { fee: plan.fee, inputCount: plan.inputs.length };
  }

  /**
   * One payment. Network reads happen first and unlocked. Choosing coins, signing and recording
   * the claim is one short step under the wallet's lock, with no network wait inside it. The
   * broadcast then runs outside the lock, so another send can pick other coins meanwhile.
   *
   * `maxFee` is the fee the user reviewed: the send may pay less, never more.
   */
  async sendNative(params: {
    recipient: ChainAddress;
    value: bigint;
    maxFee?: bigint;
    onSigned?: (signed: ChainTransaction) => Promise<void>;
  }): Promise<ChainTransaction> {
    if (params.value <= 0n) {
      throw new RangeError("Transfer value must be greater than zero");
    }
    const recipientScript = this.recipientScript(params.recipient.raw);
    // Earlier sends are finished or stay claimed; either way their coins are not chosen again.
    await this.finishPending();
    const feeRate = await this.feeRate();
    await this.sync();
    const { raw, txid } = await this.exclusive(async () => {
      const plan = planUtxoSend({
        coins: this.coinList,
        value: params.value,
        recipientScript,
        feeRate,
        network: this.network,
      });
      if (params.maxFee !== undefined && plan.fee > params.maxFee) {
        throw new NativeFeeExceededError(plan.fee);
      }
      const changeIndex = this.state.changeIndex;
      const outputs = [{ value: params.value, scriptPubKey: recipientScript }];
      if (plan.change !== undefined) {
        outputs.push({
          value: plan.change,
          scriptPubKey: this.scriptAt(1, changeIndex),
        });
      }
      const signed = this.sign(plan.inputs, outputs);
      // Recorded before any byte leaves: after a crash the same transaction is sent again and
      // its inputs stay claimed. The change address is consumed with it, never reused.
      this.persist({
        ...this.state,
        changeIndex: plan.change === undefined ? changeIndex : changeIndex + 1,
        pending: [
          ...this.state.pending,
          {
            txid: signed.txid,
            raw: signed.raw,
            inputs: plan.inputs.map(({ txid, vout }) => ({ txid, vout })),
          },
        ],
      });
      this.inFlight.add(signed.txid);
      this.markPending();
      return signed;
    });
    const transaction: ChainTransaction = { txHash: txid };
    try {
      await params.onSigned?.(transaction);
      await this.indexer.broadcast(raw);
    } catch (reason) {
      if (reason instanceof UtxoBroadcastRefused) {
        // Refused outright: nothing was sent, so the coins are free again.
        await this.exclusive(async () => this.dropPending(txid));
        throw new NativeTransactionRefusedError(reason.reason);
      }
      // No answer is not a refusal. The record and its claim stay; a later send or restart
      // sends the same bytes again. Other coins remain spendable meanwhile.
      this.unresolved = new NativeTransactionSubmissionError({
        transaction: { ...transaction, rawTransactions: [raw] },
        reason,
      });
      throw this.unresolved;
    } finally {
      this.inFlight.delete(txid);
    }
    // Accepted: its inputs are spent on the indexer from now on. The record stays until the
    // indexer shows the transaction, so a lagging server cannot hand the coins out again.
    return transaction;
  }

  /** Validate a received payment claim and durably watch its owned script before mailbox
   * completion. Parsing is not chain settlement: only indexer-discovered unspent outputs count. */
  async recordStealthPayment(receipt: UtxoStealthReceipt): Promise<void> {
    return this.importStealthReceipt(receipt);
  }

  private async importStealthReceipt(
    receipt: UtxoStealthReceipt,
    expectedDestination?: Uint8Array
  ): Promise<void> {
    const { custody, identityPublicKey, destination } =
      await this.describeStealthReceipt(receipt);
    if (
      expectedDestination !== undefined &&
      hex(expectedDestination) !== hex(destination.scriptPubKey)
    )
      throw new Error("Stealth recipient destination does not match custody");
    await this.exclusive(async () => {
      custody.assertActive();
      const scripts = this.state.stealthScripts ?? [];
      const previous = scripts.find(
        (script) => script.address === destination.address
      );
      if (
        previous &&
        (previous.identityPublicKey !== hex(identityPublicKey) ||
          previous.ephemeralPubKey !== receipt.ephemeralPubKey)
      )
        throw new Error("Stealth script has another derivation");
      const saved = previous?.receipts.find(
        (entry) => entry.payloadDigest === receipt.payloadDigest
      );
      const entry = {
        payloadDigest: receipt.payloadDigest,
        claimedAmount: receipt.claimedAmount.toString(),
        transactions: [...receipt.transactions],
        timestampMs: receipt.timestampMs,
      };
      if (saved) {
        if (
          saved.claimedAmount !== entry.claimedAmount ||
          JSON.stringify(saved.transactions) !==
            JSON.stringify(entry.transactions)
        )
          throw new Error("Stealth receipt already has another payment");
        return;
      }
      const script: StoredStealthScript = {
        chainIdentifier: this.chainIdentifier,
        identityPublicKey: hex(identityPublicKey),
        ephemeralPubKey: receipt.ephemeralPubKey,
        publicKey: hex(destination.publicKey),
        address: destination.address,
        receipts: [...(previous?.receipts ?? []), entry],
      };
      this.persist({
        ...this.state,
        stealthScripts: [
          ...scripts.filter((item) => item.address !== script.address),
          script,
        ],
      });
    });
  }

  private async describeStealthReceipt(receipt: UtxoStealthReceipt) {
    if (receipt.chainIdentifier !== this.chainIdentifier)
      throw new Error("Stealth receipt belongs to another chain");
    if (receipt.claimedAmount <= 0n || receipt.claimedAmount > 2n ** 64n - 1n)
      throw new Error("Invalid stealth recipient amount");
    if (
      !/^[a-f0-9]{64}$/.test(receipt.payloadDigest) ||
      !Number.isSafeInteger(receipt.timestampMs) ||
      receipt.timestampMs < 0
    )
      throw new Error("Invalid stealth receipt origin");
    if (!/^(02|03)[a-f0-9]{64}$/.test(receipt.ephemeralPubKey))
      throw new Error("Invalid stealth ephemeral public key");
    const custody = this.requireStealthCustody();
    const identityPublicKey = requireCompressedStealthPoint(
      custody.identityPublicKey
    );
    const derivation: UtxoStealthDerivation = {
      chainIdentifier: this.chainIdentifier,
      identityPublicKey,
      ephemeralPubKey: requireCompressedStealthPoint(
        unhex(receipt.ephemeralPubKey)
      ),
    };
    const signer = await custody.deriveStealthSigner(derivation);
    custody.assertActive();
    const destination = utxoStealthDestination(this.network, signer.publicKey);
    if (
      receipt.expectedAddress !== undefined &&
      receipt.expectedAddress !== destination.address
    )
      throw new Error("Stealth recovery address does not match custody");
    this.validateReceiptTransactions(
      receipt.transactions,
      destination.scriptPubKey,
      receipt.claimedAmount
    );
    return { custody, identityPublicKey, destination };
  }

  /** Public derivation/claim facts for composition to note to self. Amounts here are claims,
   * never balances; coins()/getBalance() remain the indexer's authoritative inventory view. */
  async getStealthReceipts(): Promise<readonly UtxoStealthReceiptInfo[]> {
    return this.exclusive(async () =>
      (this.state.stealthScripts ?? []).flatMap((script) =>
        script.receipts.map((receipt) => ({
          chainIdentifier: script.chainIdentifier,
          ephemeralPubKey: script.ephemeralPubKey,
          address: script.address,
          identityPublicKey: script.identityPublicKey,
          publicKey: script.publicKey,
          claimedAmount: BigInt(receipt.claimedAmount),
          transactions: [...receipt.transactions],
          payloadDigest: receipt.payloadDigest,
          timestampMs: receipt.timestampMs,
        }))
      )
    );
  }

  /** The existing sync dispatcher calls this for a self recovery note. A complete native note
   * uses the same validation/import boundary as its original recipient message. */
  async recordReceivedCoin(note: ReceivedCoinItem): Promise<boolean> {
    if (note.chainIdentifier !== this.chainIdentifier)
      throw new Error("Stealth recovery note belongs to another chain");
    if (
      note.origin !== "stealth" ||
      !note.ephemeralPubKey ||
      !note.payloadDigest ||
      !note.transactions ||
      !/^[1-9][0-9]*$/.test(note.claimedAmountWei)
    )
      return false;
    await this.recordStealthPayment({
      chainIdentifier: note.chainIdentifier,
      ephemeralPubKey: note.ephemeralPubKey,
      transactions: note.transactions,
      claimedAmount: BigInt(note.claimedAmountWei),
      payloadDigest: note.payloadDigest,
      timestampMs: note.timestamp,
      expectedAddress: note.address,
    });
    return true;
  }

  private requireStealthCustody(): UtxoStealthCustody {
    if (!this.stealthCustody) throw new Error("Stealth custody is unavailable");
    this.stealthCustody.assertActive();
    return this.stealthCustody;
  }

  private validateReceiptTransactions(
    transactions: readonly string[],
    script: Uint8Array,
    claimed: bigint
  ): void {
    if (transactions.length === 0 || transactions.length > 16)
      throw new Error("Invalid stealth transaction set");
    let amount = 0n;
    const ids = new Set<string>();
    for (const raw of transactions) {
      if (!/^(?:[a-f0-9]{2})+$/.test(raw) || raw.length > 32768)
        throw new Error("Invalid stealth transaction bytes");
      const parsed = parseTransaction(unhex(raw), this.network.descriptor);
      if (!parsed.ok) throw new Error("Invalid stealth transaction");
      const txid = hex(
        must(
          transactionId(parsed.value, this.network.descriptor),
          "Invalid stealth transaction id"
        )
      );
      if (ids.has(txid)) throw new Error("Duplicate stealth transaction");
      ids.add(txid);
      for (const output of parsed.value.outputs)
        if (hex(output.scriptPubKey) === hex(script)) amount += output.value;
    }
    if (amount !== claimed)
      throw new Error("Stealth transaction recipient amount does not match");
  }

  private async stealthSigner(
    script: StoredStealthScript
  ): Promise<SigningKey> {
    if (script.chainIdentifier !== this.chainIdentifier)
      throw new Error("Stored stealth script belongs to another chain");
    const custody = this.requireStealthCustody();
    if (
      hex(requireCompressedStealthPoint(custody.identityPublicKey)) !==
      script.identityPublicKey
    )
      throw new Error("Stored stealth script belongs to another identity");
    const signer = await custody.deriveStealthSigner({
      chainIdentifier: this.chainIdentifier,
      identityPublicKey: unhex(script.identityPublicKey),
      ephemeralPubKey: requireCompressedStealthPoint(
        unhex(script.ephemeralPubKey)
      ),
    });
    custody.assertActive();
    const destination = utxoStealthDestination(this.network, signer.publicKey);
    if (
      hex(destination.publicKey) !== script.publicKey ||
      destination.address !== script.address
    )
      throw new Error("Stealth custody does not match stored script");
    for (const receipt of script.receipts)
      this.validateReceiptTransactions(
        receipt.transactions,
        destination.scriptPubKey,
        BigInt(receipt.claimedAmount)
      );
    return signer;
  }

  private async validateStealthScripts(): Promise<void> {
    for (const script of this.state.stealthScripts ?? [])
      await this.stealthSigner(script);
  }

  /** Signs and claims inputs durably, but exposes no bytes and makes no broadcast. The id
   * names one authorized payment; reuse with another destination or amount is refused. */
  async prepareNativePayment(params: {
    operationId: string;
    recipient: ChainAddress;
    value: bigint;
    maxFee?: bigint;
  }): Promise<PreparedUtxoPayment> {
    return this.preparePayment(params);
  }

  private async preparePayment(params: {
    operationId: string;
    recipient: ChainAddress;
    value: bigint;
    maxFee?: bigint;
    stealth?: UtxoStealthOperationDescriptor;
  }): Promise<PreparedUtxoPayment> {
    if (params.stealth) this.requireStealthCustody();
    if (params.operationId.trim().length === 0)
      throw new Error("Payment operation id must not be empty");
    if (params.value <= 0n)
      throw new RangeError("Transfer value must be greater than zero");
    const recipient = canonicalUtxoAddress(this.network, params.recipient.raw);
    if (recipient === undefined)
      throw new Error("Invalid recipient address for this network");
    const existing = await this.exclusive(async () =>
      this.findPayment(params.operationId)
    );
    const reuse = (payment: StoredUtxoPayment): PreparedUtxoPayment => {
      if (
        (params.stealth
          ? !payment.stealth ||
            payment.stealth.recipientSpendPublicKey !==
              params.stealth.recipientSpendPublicKey ||
            payment.stealth.maxNativeFeeAtomic !==
              params.stealth.maxNativeFeeAtomic
          : payment.stealth !== undefined || payment.recipient !== recipient) ||
        BigInt(payment.value) !== params.value
      )
        throw new Error(
          "Payment operation already has another recipient or amount"
        );
      if (payment.phase === "released")
        throw new Error("Payment operation was released");
      if (params.maxFee !== undefined && BigInt(payment.fee) > params.maxFee)
        throw new NativeFeeExceededError(BigInt(payment.fee));
      if (params.stealth) this.requireStealthCustody();
      return this.paymentView(payment);
    };
    if (existing) return reuse(existing);
    const feeRate = await this.feeRate();
    if (params.stealth) this.requireStealthCustody();
    await this.sync(
      params.stealth
        ? () => {
            this.requireStealthCustody();
          }
        : undefined
    );
    if (params.stealth) this.requireStealthCustody();
    return this.exclusive(async () => {
      if (params.stealth) this.requireStealthCustody();
      const saved = this.findPayment(params.operationId);
      if (saved) return reuse(saved);
      const recipientScript = this.recipientScript(recipient);
      const plan = planUtxoSend({
        coins: this.coinList,
        value: params.value,
        recipientScript,
        feeRate,
        network: this.network,
      });
      if (params.maxFee !== undefined && plan.fee > params.maxFee)
        throw new NativeFeeExceededError(plan.fee);
      const changeIndex = this.state.changeIndex;
      const outputs = [{ value: params.value, scriptPubKey: recipientScript }];
      if (plan.change !== undefined)
        outputs.push({
          value: plan.change,
          scriptPubKey: this.scriptAt(1, changeIndex),
        });
      if (params.stealth) this.requireStealthCustody();
      const signed = this.sign(plan.inputs, outputs);
      const payment: StoredUtxoPayment = {
        ...signed,
        inputs: plan.inputs.map(({ txid, vout }) => ({ txid, vout })),
        operationId: params.operationId,
        chainIdentifier: this.chainIdentifier,
        recipient,
        value: params.value.toString(),
        fee: plan.fee.toString(),
        phase: "prepared",
        payloadDigests: [],
        ...(params.stealth ? { stealth: params.stealth } : {}),
      };
      this.persist({
        ...this.state,
        changeIndex: plan.change === undefined ? changeIndex : changeIndex + 1,
        operations: [...(this.state.operations ?? []), payment],
      });
      this.markPending();
      return this.paymentView(payment);
    });
  }

  /** Called after the encrypted outbox attempt is durable and BEFORE handing its signed payment
   * to a relay. Exposure is irreversible even when delivery subsequently fails. */
  async recordPaymentExposure(params: {
    operationId: string;
    payloadDigest: string;
  }): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(params.payloadDigest))
      throw new Error("Invalid payment message payload digest");
    await this.exclusive(async () => {
      const payment = this.requirePayment(params.operationId);
      if (payment.stealth) this.requireStealthCustody();
      if (payment.phase === "released")
        throw new Error("Payment operation was released");
      if (payment.payloadDigests.includes(params.payloadDigest)) return;
      this.putPayment({
        ...payment,
        phase: payment.phase === "prepared" ? "exposed" : payment.phase,
        payloadDigests: [...payment.payloadDigests, params.payloadDigest],
      });
    });
  }

  /** The host calls this only after relay delivery is established. Records submission intent
   * before RPC, so an interruption retries these exact bytes. A refusal after message exposure
   * cannot prove the recipient/relay will never broadcast them and never releases their inputs. */
  async submitPreparedPayment(operationId: string): Promise<ChainTransaction> {
    const payment = await this.exclusive(async () => {
      const current = this.requirePayment(operationId);
      if (current.stealth) this.requireStealthCustody();
      if (current.phase === "prepared" || current.phase === "released")
        throw new Error("Payment must be exposed before submission");
      const submitted = { ...current, phase: "submitted" as const };
      this.putPayment(submitted);
      return submitted;
    });
    const transaction = this.paymentView(payment).transaction;
    try {
      if (payment.stealth) this.requireStealthCustody();
      const known = await this.indexer.hasTransaction(payment.txid);
      if (payment.stealth) this.requireStealthCustody();
      if (known) {
        // Settled means the indexer has the transaction, not confirmation or finality.
        // Keep spent outpoints excluded even if a lagging coin read lists them as unspent.
        await this.exclusive(async () => {
          if (payment.stealth) this.requireStealthCustody();
          this.putPayment({
            ...this.requirePayment(operationId),
            phase: "settled",
          });
        });
      } else {
        await this.indexer.broadcast(payment.raw);
      }
      return transaction;
    } catch (reason) {
      throw new NativeTransactionSubmissionError({ transaction, reason });
    }
  }

  /** Only a locally prepared payment can be cancelled. Its change derivation stays consumed,
   * and its id remains a tombstone so retry cannot silently authorize a second payment. */
  async releaseUnexposedPayment(operationId: string): Promise<boolean> {
    return this.exclusive(async () => {
      const payment = this.requirePayment(operationId);
      if (payment.stealth) this.requireStealthCustody();
      if (payment.phase !== "prepared") return false;
      this.putPayment({ ...payment, phase: "released" });
      this.markPending();
      return true;
    });
  }

  async getNativePayments(): Promise<readonly PreparedUtxoPayment[]> {
    return this.exclusive(async () =>
      (this.state.operations ?? []).map((payment) => this.paymentView(payment))
    );
  }

  private findPayment(operationId: string): StoredUtxoPayment | undefined {
    return this.state.operations?.find(
      (payment) => payment.operationId === operationId
    );
  }

  private requirePayment(operationId: string): StoredUtxoPayment {
    const payment = this.findPayment(operationId);
    if (!payment) throw new Error("Unknown payment operation");
    return payment;
  }

  private putPayment(payment: StoredUtxoPayment): void {
    this.persist({
      ...this.state,
      operations: (this.state.operations ?? []).map((saved) =>
        saved.operationId === payment.operationId ? payment : saved
      ),
    });
  }

  private paymentView(payment: StoredUtxoPayment): PreparedUtxoPayment {
    return {
      operationId: payment.operationId,
      chainIdentifier: payment.chainIdentifier,
      transaction: { txHash: payment.txid, rawTransactions: [payment.raw] },
      recipient: { raw: payment.recipient },
      value: BigInt(payment.value),
      fee: BigInt(payment.fee),
      phase: payment.phase,
      payloadDigests: [...payment.payloadDigests],
      ...(payment.stealth ? { stealth: { ...payment.stealth } } : {}),
    };
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    return runNativeTransactionExclusive(
      nativeTransactionAttemptKey({
        family: this.family,
        chainIdentifier: this.chainIdentifier,
        address: this.addressAt(0, 0),
      }),
      "single-realm",
      async () => {
        this.reload();
        this.markPending();
        return operation();
      }
    );
  }

  private reload(): void {
    this.state = parseState(this.store.load());
    if (
      (this.state.operations ?? []).some(
        (payment) => payment.chainIdentifier !== this.chainIdentifier
      )
    )
      throw new Error("Stored UTXO payment belongs to another chain");
    for (const payment of this.state.operations ?? [])
      if (payment.stealth)
        utxoStealthPaymentManifest(this.paymentView(payment), this.network);
  }

  private persist(next: StoredState): void {
    this.store.save(JSON.stringify(next));
    this.state = next;
  }

  private dropPending(
    txid: string,
    consumedInputs: PendingSend["inputs"] = []
  ): void {
    this.settledGeneration += 1;
    this.persist({
      ...this.state,
      pending: this.state.pending.filter((send) => send.txid !== txid),
      ...(consumedInputs.length > 0
        ? {
            consumedNativeInputs: [
              ...new Map(
                [
                  ...(this.state.consumedNativeInputs ?? []),
                  ...consumedInputs,
                ].map(
                  (input) => [`${input.txid}:${input.vout}`, input] as const
                )
              ).values(),
            ],
          }
        : {}),
    });
    this.markPending();
  }

  private markPending(): void {
    const claimed = new Set(
      [
        ...this.state.pending,
        ...(this.state.operations ?? []).filter(
          (payment) => payment.phase !== "released"
        ),
      ]
        .flatMap((send) => send.inputs)
        .concat(this.state.consumedNativeInputs ?? [])
        .map((input) => `${input.txid}:${input.vout}`)
    );
    this.coinList = this.coinList.map((coin) => ({
      ...coin,
      state: claimed.has(`${coin.txid}:${coin.vout}`) ? "pending" : "unspent",
    }));
  }

  /**
   * Settle every recorded send that is not being broadcast right now. One the indexer has was
   * broadcast. One it lacks is sent again unchanged: the same inputs cannot pay twice. A record
   * whose outcome cannot be learned stays, with its coins claimed; it blocks nothing else.
   */
  private async finishPending(): Promise<void> {
    let unresolved: NativeTransactionSubmissionError | undefined;
    const pending = await this.exclusive(async () => this.state.pending);
    for (const send of pending) {
      if (this.inFlight.has(send.txid)) continue;
      let consumed = false;
      try {
        consumed = await this.indexer.hasTransaction(send.txid);
        if (!consumed) {
          try {
            await this.indexer.broadcast(send.raw);
            consumed = true;
          } catch (reason) {
            // Refused: the node already has it, or its inputs were spent some other way.
            // Either way these bytes need no further sending. Anything else is unknown.
            if (!(reason instanceof UtxoBroadcastRefused)) throw reason;
          }
        }
      } catch (reason) {
        unresolved = new NativeTransactionSubmissionError({
          transaction: { txHash: send.txid, rawTransactions: [send.raw] },
          reason,
        });
        continue;
      }
      await this.exclusive(async () =>
        this.dropPending(send.txid, consumed ? send.inputs : [])
      );
    }
    this.unresolved = unresolved;
  }

  private async feeRate(): Promise<bigint> {
    const { minFeeRate, estimateFee } = this.network;
    if (!estimateFee) return minFeeRate;
    const estimate = await this.indexer.feeRate().catch(() => undefined);
    if (estimate === undefined || estimate < minFeeRate) return minFeeRate;
    return estimate > MAX_FEE_RATE ? MAX_FEE_RATE : estimate;
  }

  private nodeAt(chain: 0 | 1, index: number): HdPrivateNode {
    const branch = must(
      deriveHdPrivate(this.account, chain),
      "Derivation failed"
    );
    return must(deriveHdPrivate(branch, index), "Derivation failed");
  }

  private destinationAt(chain: 0 | 1, index: number): Destination {
    const key = this.nodeAt(chain, index).privateKey;
    const publicKey = must(publicFromPrivate(key), "Invalid derived key");
    const hash = must(
      pubkeyHashFromBytes(cryptoBackend.hash160(publicKey.compressed)),
      "Invalid public key hash"
    );
    return { kind: this.network.ownOutput, hash };
  }

  private scriptAt(chain: 0 | 1, index: number): Uint8Array {
    return lockingScript(this.destinationAt(chain, index));
  }

  private addressAt(chain: 0 | 1, index: number): string {
    return must(
      encodeAddress(
        this.destinationAt(chain, index),
        this.network.descriptor,
        this.network.addressEncoding
      ),
      "Address encoding failed"
    );
  }

  private recipientScript(input: string): Uint8Array {
    const destination = parseUtxoAddress(this.network, input);
    if (destination === undefined) {
      throw new Error("Invalid recipient address for this network");
    }
    return lockingScript(destination);
  }

  /** First use and restore: find how far each address chain has been used. */
  private async discover(): Promise<void> {
    const next = async (chain: 0 | 1, from: number) => {
      let used = from - 1;
      for (let index = from; index <= used + ADDRESS_GAP; index++) {
        if (await this.indexer.hasHistory(this.scriptAt(chain, index))) {
          used = index;
        }
      }
      return used + 1;
    };
    const receiveIndex = await next(0, this.state.receiveIndex);
    const changeIndex = await next(1, this.state.changeIndex);
    await this.exclusive(async () => {
      if (
        receiveIndex > this.state.receiveIndex ||
        changeIndex > this.state.changeIndex
      )
        this.persist({
          ...this.state,
          receiveIndex: Math.max(receiveIndex, this.state.receiveIndex),
          changeIndex: Math.max(changeIndex, this.state.changeIndex),
        });
    });
  }

  /**
   * Rebuild the coin list from the indexer. The reads run unlocked; the result is applied in one
   * short locked step, and thrown away if a recorded send was dropped while reading (its inputs
   * would look unspent in the older answer).
   */
  private async sync(assertActive?: () => void): Promise<void> {
    assertActive?.();
    for (let attempt = 0; attempt < 3; attempt++) {
      const snapshot = await this.exclusive(async () => this.store.load());
      const generation = this.settledGeneration;
      assertActive?.();
      const read = await this.readCoins();
      assertActive?.();
      const applied = await this.exclusive(async () => {
        assertActive?.();
        if (
          generation !== this.settledGeneration ||
          snapshot !== this.store.load()
        )
          return false;
        if (read.receiveIndex > this.state.receiveIndex) {
          this.persist({ ...this.state, receiveIndex: read.receiveIndex });
        }
        this.coinList = read.coins;
        this.markPending();
        return true;
      });
      if (applied) return;
    }
    throw new Error(
      "The wallet's coins kept changing while they were read; try again"
    );
  }

  private async readCoins(): Promise<{
    coins: UtxoCoin[];
    receiveIndex: number;
  }> {
    const coins: UtxoCoin[] = [];
    let receiveIndex = this.state.receiveIndex;
    const changeIndex = this.state.changeIndex;
    const read = async (chain: 0 | 1, index: number) => {
      const scriptPubKey = this.scriptAt(chain, index);
      const outputs = await this.indexer.listUnspent(scriptPubKey);
      if (outputs.length === 0) return false;
      const privKey = Uint8Array.from(
        this.nodeAt(chain, index).privateKey.bytes
      );
      for (const output of outputs) {
        coins.push({
          privKey,
          txid: output.txid,
          vout: output.vout,
          amount: output.amount,
          origin: chain === 0 ? "receive" : "change",
          state: "unspent",
          scriptPubKey,
          confirmed: output.height > 0,
        });
      }
      return true;
    };
    // The address on show is `receiveIndex`. Once it is paid, show the next one.
    for (let index = 0; index <= receiveIndex; index++) {
      const paid = await read(0, index);
      if (paid && index === receiveIndex) receiveIndex += 1;
    }
    for (let index = 0; index < changeIndex; index++) {
      await read(1, index);
    }
    for (const script of this.state.stealthScripts ?? []) {
      const signer = await this.stealthSigner(script);
      const scriptPubKey = utxoStealthDestination(
        this.network,
        signer.publicKey
      ).scriptPubKey;
      for (const output of await this.indexer.listUnspent(scriptPubKey)) {
        if (
          !coins.some(
            (coin) => coin.txid === output.txid && coin.vout === output.vout
          )
        )
          coins.push({
            signer,
            txid: output.txid,
            vout: output.vout,
            amount: output.amount,
            origin: "stealth",
            state: "unspent",
            scriptPubKey,
            confirmed: output.height > 0,
          });
      }
    }
    return { coins, receiveIndex };
  }

  private coinPrivateKey(coin: UtxoCoin): Uint8Array {
    if (!coin.privKey) throw new Error("Coin has no signing capability");
    return coin.privKey;
  }

  private sign(
    inputs: readonly UtxoCoin[],
    outputs: ReadonlyArray<{ value: bigint; scriptPubKey: Uint8Array }>
  ): { raw: string; txid: string } {
    const { descriptor } = this.network;
    const unsigned: Transaction = {
      version: 2,
      inputs: inputs.map((coin) => ({
        prevout: {
          txid: unhex(coin.txid).reverse() as InternalHash,
          vout: coin.vout,
        },
        scriptSig: new Uint8Array(0),
        sequence: SEQUENCE_FINAL,
      })),
      outputs,
      locktime: 0,
    };
    const signed = must(
      signAll(
        unsigned,
        inputs.map((coin, inputIndex) => ({
          inputIndex,
          signer:
            coin.signer ??
            must(
              signingKey(
                "ecdsa",
                must(
                  privateKeyFromBytes(this.coinPrivateKey(coin), true),
                  "Invalid coin key"
                )
              ),
              "Invalid signing key"
            ),
        })),
        {
          chain: descriptor,
          algorithm: this.network.sighashAlgorithm,
          sighashType: this.network.sighashType,
          spent: inputs.map((coin) => ({
            value: coin.amount,
            scriptPubKey: coin.scriptPubKey,
          })),
        }
      ),
      "Signing failed"
    );
    const raw = must(
      serializeTransaction(signed.transaction, descriptor),
      "Serialization failed"
    );
    const id = must(
      transactionId(signed.transaction, descriptor),
      "Txid failed"
    );
    return { raw: hex(raw), txid: hex(Uint8Array.from(id).reverse()) };
  }
}

/** Parse an address of `network`. Bitcoin Cash addresses may omit their `bchtest:` prefix. */
export function parseUtxoAddress(
  network: UtxoNetwork,
  input: string
): Destination | undefined {
  const text = input.trim();
  const prefix = network.descriptor.cashaddrPrefix;
  const candidates =
    prefix && !text.includes(":") ? [text, `${prefix}:${text}`] : [text];
  for (const candidate of candidates) {
    const decoded = decodeAddress(candidate, network.descriptor);
    if (!decoded.ok) continue;
    const { kind } = decoded.value.destination;
    // Outputs this wallet can pay with a standard script and size its fee for.
    if (
      kind === "p2pkh" ||
      kind === "p2sh" ||
      kind === "p2wpkh" ||
      kind === "p2wsh" ||
      kind === "p2tr"
    ) {
      return decoded.value.destination;
    }
  }
  return undefined;
}

/** The canonical text of an address of `network`, or undefined when it is not one. */
export function canonicalUtxoAddress(
  network: UtxoNetwork,
  input: string
): string | undefined {
  const text = input.trim();
  const prefix = network.descriptor.cashaddrPrefix;
  const candidates =
    prefix && !text.includes(":") ? [text, `${prefix}:${text}`] : [text];
  for (const candidate of candidates) {
    const decoded = decodeAddress(candidate, network.descriptor);
    if (decoded.ok && parseUtxoAddress(network, candidate)) {
      return decoded.value.text;
    }
  }
  return undefined;
}
