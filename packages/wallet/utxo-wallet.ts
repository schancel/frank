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
 *   indices, and a signed transaction that was handed to the network without a known outcome.
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
} from "@frank/nakamoto";
import {
  ChainAddress,
  ChainTransaction,
  NativeTransactionRefusedError,
  NativeTransactionSubmissionError,
  NativeWalletHandle,
} from "./chain/chain-wallet";

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
  /** Throws UtxoBroadcastRefused when the node answers no; anything else means unknown. */
  broadcast(rawHex: string): Promise<void>;
  /** Base units per virtual byte for prompt confirmation, when the server can estimate one. */
  feeRate(): Promise<bigint | undefined>;
}

export type UtxoCoinState = "unspent" | "pending";

/** One spendable output and the key that spends it. */
export interface UtxoCoin {
  readonly privKey: Uint8Array;
  readonly txid: string;
  readonly vout: number;
  readonly amount: bigint;
  /** Which of the wallet's two address chains was paid. */
  readonly origin: "receive" | "change";
  /** `pending` while a recorded transaction of this wallet spends it. */
  readonly state: UtxoCoinState;
  readonly scriptPubKey: Uint8Array;
  readonly confirmed: boolean;
}

interface PendingSend {
  readonly txid: string;
  readonly raw: string;
  readonly inputs: ReadonlyArray<{ readonly txid: string; readonly vout: number }>;
}

interface StoredState {
  readonly version: 1;
  readonly receiveIndex: number;
  readonly changeIndex: number;
  readonly pending: readonly PendingSend[];
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
    value.pending.some(
      (send) =>
        typeof send?.txid !== "string" ||
        typeof send.raw !== "string" ||
        !Array.isArray(send.inputs)
    )
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
      return { inputs, fee: feeWithChange, change: total - value - feeWithChange };
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
  private queue: Promise<void> = Promise.resolve();
  private coinList: UtxoCoin[] = [];
  private unresolved: NativeTransactionSubmissionError | undefined;

  private constructor(
    readonly network: UtxoNetwork,
    private readonly account: HdPrivateNode,
    private readonly indexer: UtxoIndexer,
    private store: UtxoWalletStore,
    private state: StoredState
  ) {
    this.chainIdentifier = network.chainIdentifier;
    this.networkId = network.chainIdentifier;
  }

  /**
   * `seed` is the 32-byte wallet root, used directly as the BIP32 seed (the same interpretation
   * the eCash wallet uses). The caller keeps ownership of it.
   */
  static async create(params: {
    network: UtxoNetwork;
    seed: Uint8Array;
    indexer: UtxoIndexer;
    /** Durable storage for this wallet, named by its first receive address. */
    storeFor: (firstAddress: string) => UtxoWalletStore;
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
      parseState(undefined)
    );
    wallet.store = params.storeFor(wallet.addressAt(0, 0));
    wallet.state = parseState(wallet.store.load());
    await wallet.discover();
    // Finish a send a restart interrupted. If the indexer cannot be reached now, the next send
    // tries again before it signs anything.
    await wallet.exclusive(() => wallet.finishPending()).catch(() => undefined);
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
    return this.exclusive(async () => {
      await this.sync();
      return { raw: this.addressAt(0, this.state.receiveIndex) };
    });
  }

  /** What the wallet can spend now: its unspent coins, including unconfirmed change. */
  async getBalance(): Promise<bigint> {
    return this.exclusive(async () => {
      await this.sync();
      return this.coinList.reduce(
        (sum, coin) => (coin.state === "unspent" ? sum + coin.amount : sum),
        0n
      );
    });
  }

  /** The fee and the number of coins a send of `value` would use right now. */
  async estimateFee(params: {
    recipient: ChainAddress;
    value: bigint;
  }): Promise<{ fee: bigint; inputCount: number }> {
    return this.exclusive(async () => {
      await this.sync();
      const plan = planUtxoSend({
        coins: this.coinList,
        value: params.value,
        recipientScript: this.recipientScript(params.recipient.raw),
        feeRate: await this.feeRate(),
        network: this.network,
      });
      return { fee: plan.fee, inputCount: plan.inputs.length };
    });
  }

  async sendNative(params: {
    recipient: ChainAddress;
    value: bigint;
    onSigned?: (signed: ChainTransaction) => Promise<void>;
  }): Promise<ChainTransaction> {
    return this.exclusive(async () => {
      if (params.value <= 0n) {
        throw new RangeError("Transfer value must be greater than zero");
      }
      const recipientScript = this.recipientScript(params.recipient.raw);
      // Never sign a second payment while an earlier one may still land.
      await this.finishPending();
      if (this.unresolved !== undefined) throw this.unresolved;
      await this.sync();
      const plan = planUtxoSend({
        coins: this.coinList,
        value: params.value,
        recipientScript,
        feeRate: await this.feeRate(),
        network: this.network,
      });
      const changeIndex = this.state.changeIndex;
      const outputs = [{ value: params.value, scriptPubKey: recipientScript }];
      if (plan.change !== undefined) {
        outputs.push({
          value: plan.change,
          scriptPubKey: this.scriptAt(1, changeIndex),
        });
      }
      const { raw, txid } = this.sign(plan.inputs, outputs);
      const transaction: ChainTransaction = { txHash: txid };
      // Recorded before any byte leaves: after a crash the same transaction is sent again and
      // its inputs stay claimed. The change address is consumed with it, never reused.
      this.persist({
        ...this.state,
        changeIndex:
          plan.change === undefined ? changeIndex : changeIndex + 1,
        pending: [
          ...this.state.pending,
          {
            txid,
            raw,
            inputs: plan.inputs.map(({ txid, vout }) => ({ txid, vout })),
          },
        ],
      });
      this.markPending();
      await params.onSigned?.(transaction);
      try {
        await this.indexer.broadcast(raw);
      } catch (reason) {
        if (reason instanceof UtxoBroadcastRefused) {
          // Refused outright: nothing was sent, so the coins are free again.
          this.dropPending(txid);
          throw new NativeTransactionRefusedError(reason.reason);
        }
        // No answer is not a refusal. Keep the record; the next send or restart finishes it.
        this.unresolved = new NativeTransactionSubmissionError({
          transaction: { ...transaction, rawTransactions: [raw] },
          reason,
        });
        throw this.unresolved;
      }
      // Accepted: its inputs are spent on the indexer from now on. Keep the record until the
      // indexer shows the transaction, so a lagging server cannot hand the coins out again.
      return transaction;
    });
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation);
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private persist(next: StoredState): void {
    this.store.save(JSON.stringify(next));
    this.state = next;
  }

  private dropPending(txid: string): void {
    this.persist({
      ...this.state,
      pending: this.state.pending.filter((send) => send.txid !== txid),
    });
    this.markPending();
  }

  private markPending(): void {
    const claimed = new Set(
      this.state.pending.flatMap((send) =>
        send.inputs.map((input) => `${input.txid}:${input.vout}`)
      )
    );
    this.coinList = this.coinList.map((coin) => ({
      ...coin,
      state: claimed.has(`${coin.txid}:${coin.vout}`) ? "pending" : "unspent",
    }));
  }

  /**
   * Settle every recorded send. One the indexer has was broadcast. One it lacks is sent again
   * unchanged: the same inputs cannot pay twice. A record stays only while the outcome cannot be
   * learned, and then no new payment is signed.
   */
  private async finishPending(): Promise<void> {
    this.unresolved = undefined;
    for (const send of this.state.pending) {
      try {
        if (!(await this.indexer.hasTransaction(send.txid))) {
          await this.indexer.broadcast(send.raw);
        }
      } catch (reason) {
        if (!(reason instanceof UtxoBroadcastRefused)) {
          this.unresolved = new NativeTransactionSubmissionError({
            transaction: { txHash: send.txid, rawTransactions: [send.raw] },
            reason,
          });
          return;
        }
        // Refused now: its inputs were spent some other way, so it can never be accepted.
      }
      this.dropPending(send.txid);
    }
  }

  private async feeRate(): Promise<bigint> {
    const { minFeeRate, estimateFee } = this.network;
    if (!estimateFee) return minFeeRate;
    const estimate = await this.indexer.feeRate().catch(() => undefined);
    if (estimate === undefined || estimate < minFeeRate) return minFeeRate;
    return estimate > MAX_FEE_RATE ? MAX_FEE_RATE : estimate;
  }

  private nodeAt(chain: 0 | 1, index: number): HdPrivateNode {
    const branch = must(deriveHdPrivate(this.account, chain), "Derivation failed");
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
    if (
      receiveIndex !== this.state.receiveIndex ||
      changeIndex !== this.state.changeIndex
    ) {
      this.persist({ ...this.state, receiveIndex, changeIndex });
    }
  }

  /** Rebuild the coin list from the indexer. */
  private async sync(): Promise<void> {
    const coins: UtxoCoin[] = [];
    let receiveIndex = this.state.receiveIndex;
    const read = async (chain: 0 | 1, index: number) => {
      const scriptPubKey = this.scriptAt(chain, index);
      const outputs = await this.indexer.listUnspent(scriptPubKey);
      if (outputs.length === 0) return false;
      const privKey = Uint8Array.from(this.nodeAt(chain, index).privateKey.bytes);
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
    for (let index = 0; index < this.state.changeIndex; index++) {
      await read(1, index);
    }
    if (receiveIndex !== this.state.receiveIndex) {
      this.persist({ ...this.state, receiveIndex });
    }
    this.coinList = coins;
    this.markPending();
    // A recorded send the indexer now shows needs no record any more.
    for (const send of this.state.pending) {
      const spent = send.inputs.every(
        (input) =>
          !coins.some(
            (coin) => coin.txid === input.txid && coin.vout === input.vout
          )
      );
      if (
        spent &&
        (await this.indexer.hasTransaction(send.txid).catch(() => false))
      ) {
        this.dropPending(send.txid);
      }
    }
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
          signer: must(
            signingKey(
              "ecdsa",
              must(privateKeyFromBytes(coin.privKey, true), "Invalid coin key")
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
    const id = must(transactionId(signed.transaction, descriptor), "Txid failed");
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
