/**
 * The Lotus v2 wallet: a keyring plus a flat coin list, spending with native v7 transactions.
 * A peer of the eCash (`EcashWallet`) and Electrum (`UtxoWallet`) adapters; regtest only.
 *
 * Who owns which fact:
 * - The chain owns which outputs are unspent; the coin list is rebuilt from Chronik `/v2` on
 *   every sync and never restored from storage for selection. `/v2` is confirmed-only, so only
 *   mined coins are ever selected.
 * - The store owns what the chain cannot say: the next receive and change indices, every send
 *   this wallet signed (exact bytes and the coins it claims) until that send is mined, and the
 *   coins known spent by a mined send (so a lagging index cannot offer them again).
 *
 * A send reads the chain unlocked, then chooses, signs and records in one short critical
 * section with no network wait, and broadcasts outside it. Two sends never choose one coin. A
 * broadcast whose outcome is unknown keeps its record and claim; the same bytes are sent again
 * by the next send, balance read or wallet open, never a new payment. A refusal frees the coins.
 *
 * Owner rule (2026-11-19): native v7 transactions are rejected outside regtest. The wallet
 * opens only for a registry row of kind `lotus` on network `regtest`; any other identifier is
 * refused with {@link LotusV2UnsupportedNetworkError} before a key is derived.
 */
import {
  deriveHdPath,
  deriveHdPrivate,
  hdPrivateFromSeed,
  type HdPrivateNode,
} from "@frank/nakamoto";

import {
  type ChainAddress,
  type ChainTransaction,
  NativeFeeExceededError,
  NativeTransactionRefusedError,
  NativeTransactionSubmissionError,
  type NativeWalletHandle,
  nativeTransactionAttemptKey,
  runNativeTransactionExclusive,
} from "../chain/chain-wallet";
import { getChainRegistryEntry } from "../chain/chains-registry";
import { recordWalletFailure } from "../wallet-failure";
import { LotusV2BroadcastRefused, type LotusV2Indexer } from "./chronik";
import {
  branchLeaf,
  decodeAddress,
  encodeKeyhashAddress,
  keyhashOf,
  keyhashProgram,
  LotusV2UnsupportedNetworkError,
  type LotusV2Network,
  nativeTransactionSize,
  signNativeTransaction,
  toHex,
  xOnlyPublicKey,
} from "./native";

/** BIP44 account under the Bitcoin-family domain root: SLIP-44 coin type 10605 (Lotus). */
export const LOTUS_V2_ACCOUNT_PATH = "m/44'/10605'/0'";
/** Atoms per byte of the complete signed transaction: the node's minimum relay fee. */
export const LOTUS_V2_FEE_PER_BYTE = 1n;
/** No output below this is made (the node's candidate dust limit). */
export const LOTUS_V2_DUST_ATOMS = 546n;
const ADDRESS_GAP = 20;

/** The network a registry row lets the wallet build for, or an explicit refusal. */
export function lotusV2NetworkOf(chainIdentifier: string): LotusV2Network {
  const entry = getChainRegistryEntry(chainIdentifier);
  if (
    !entry ||
    entry.family !== "bitcoin" ||
    entry.kind !== "lotus" ||
    entry.network !== "regtest"
  )
    throw new LotusV2UnsupportedNetworkError(chainIdentifier);
  return "regtest";
}

export interface LotusV2WalletStore {
  load(): string | undefined;
  /** Must not return before the text is durable. */
  save(serialized: string): void;
}

export function memoryLotusV2WalletStore(): LotusV2WalletStore {
  let value: string | undefined;
  return { load: () => value, save: (text) => void (value = text) };
}

/** Browser storage. Throws where there is none, so a send is never recorded only in memory. */
export function browserLotusV2WalletStore(key: string): LotusV2WalletStore {
  const storage = () => {
    const host = globalThis as {
      localStorage?: { getItem(k: string): string | null; setItem(k: string, v: string): void };
    };
    if (!host.localStorage) throw new Error("Lotus wallet storage is unavailable");
    return host.localStorage;
  };
  const name = `frank:lotus-v2-wallet:v1:${key}`;
  return {
    load: () => storage().getItem(name) ?? undefined,
    save: (text) => storage().setItem(name, text),
  };
}

interface Outpoint {
  readonly txid: string;
  readonly outIdx: number;
}

interface PendingSend {
  readonly txid: string;
  readonly raw: string;
  readonly inputs: readonly Outpoint[];
}

interface StoredState {
  readonly version: 1;
  readonly chainIdentifier: string;
  readonly receiveIndex: number;
  readonly changeIndex: number;
  /** Signed sends not yet seen mined. Their inputs are claimed. */
  readonly pending: readonly PendingSend[];
  /** Inputs of mined sends: never selectable again, whatever an index says. */
  readonly consumedInputs: readonly Outpoint[];
}

const outpointKey = (o: Outpoint) => `${o.txid}:${o.outIdx}`;

function validOutpoint(o: unknown): o is Outpoint {
  const v = o as Outpoint;
  return (
    typeof v === "object" &&
    v !== null &&
    typeof v.txid === "string" &&
    /^[0-9a-f]{64}$/.test(v.txid) &&
    Number.isInteger(v.outIdx) &&
    v.outIdx >= 0
  );
}

function parseState(text: string | undefined, chainIdentifier: string): StoredState {
  if (text === undefined)
    return { version: 1, chainIdentifier, receiveIndex: 0, changeIndex: 0, pending: [], consumedInputs: [] };
  const state = JSON.parse(text) as StoredState;
  if (
    state.version !== 1 ||
    !Number.isSafeInteger(state.receiveIndex) ||
    state.receiveIndex < 0 ||
    !Number.isSafeInteger(state.changeIndex) ||
    state.changeIndex < 0 ||
    !Array.isArray(state.pending) ||
    !state.pending.every(
      (send) =>
        /^[0-9a-f]{64}$/.test(send.txid) &&
        typeof send.raw === "string" &&
        Array.isArray(send.inputs) &&
        send.inputs.every(validOutpoint)
    ) ||
    !Array.isArray(state.consumedInputs) ||
    !state.consumedInputs.every(validOutpoint)
  )
    throw new Error(
      "Unsupported Lotus wallet record; reset this development wallet's local storage (frank:lotus-v2-wallet:v1:*)"
    );
  if (state.chainIdentifier !== chainIdentifier)
    throw new Error("Stored Lotus wallet record belongs to another chain");
  return state;
}

/** One spendable coin with the key that spends it. */
export interface LotusV2Coin {
  readonly txid: string;
  readonly outIdx: number;
  readonly value: bigint;
  readonly origin: "receive" | "change";
  /** `pending` while a recorded send of this wallet claims it. */
  readonly state: "unspent" | "pending";
  readonly secret: Uint8Array;
}

export interface LotusV2SendPlan {
  readonly inputs: readonly LotusV2Coin[];
  readonly fee: bigint;
  /** Absent when the remainder is below dust; it then goes to the fee. */
  readonly change?: bigint;
}

/** Largest coins first until value and fee are covered. Only `unspent` coins are considered. */
export function planLotusV2Send(coins: readonly LotusV2Coin[], value: bigint): LotusV2SendPlan {
  if (value < LOTUS_V2_DUST_ATOMS)
    throw new RangeError(`Amount is below the network minimum of ${LOTUS_V2_DUST_ATOMS} atoms`);
  const candidates = coins
    .filter((coin) => coin.state === "unspent")
    .sort((a, b) => (a.value === b.value ? 0 : a.value > b.value ? -1 : 1));
  const inputs: LotusV2Coin[] = [];
  let total = 0n;
  for (const coin of candidates) {
    inputs.push(coin);
    total += coin.value;
    const feeWithChange = BigInt(nativeTransactionSize(inputs.length, 2)) * LOTUS_V2_FEE_PER_BYTE;
    if (total >= value + feeWithChange + LOTUS_V2_DUST_ATOMS)
      return { inputs, fee: feeWithChange, change: total - value - feeWithChange };
    const feeWithout = BigInt(nativeTransactionSize(inputs.length, 1)) * LOTUS_V2_FEE_PER_BYTE;
    if (total >= value + feeWithout) return { inputs, fee: total - value };
  }
  throw recordWalletFailure(new Error("Insufficient funds for this amount and its network fee"), {
    diagnosis: "insufficient-funds",
  });
}

export class LotusV2Wallet implements NativeWalletHandle {
  readonly family = "bitcoin" as const;
  readonly chainIdentifier: string;
  readonly networkId: string;
  private coinList: LotusV2Coin[] = [];
  private unresolved: NativeTransactionSubmissionError | undefined;
  /** Sends this process is broadcasting right now; nobody else re-sends them meanwhile. */
  private readonly inFlight = new Set<string>();
  private discovered = false;
  private state: StoredState;

  private constructor(
    readonly network: LotusV2Network,
    chainIdentifier: string,
    private readonly account: HdPrivateNode,
    private readonly indexer: LotusV2Indexer,
    private store: LotusV2WalletStore
  ) {
    this.chainIdentifier = chainIdentifier;
    this.networkId = chainIdentifier;
    this.state = parseState(undefined, chainIdentifier);
  }

  /**
   * `seed` is the wallet domain root32 (`ecash-bch-wallet`, the Bitcoin-family root) or the
   * original BIP39 seed64, used as the BIP32 seed. The caller keeps ownership of it.
   */
  static async create(params: {
    chainIdentifier: string;
    seed: Uint8Array;
    indexer: LotusV2Indexer;
    /** Durable storage for this wallet, named by its first receive address. */
    storeFor: (firstAddress: string) => LotusV2WalletStore;
    /** The operator checkpoint of this regtest run; the node must have this block. */
    checkpoint: { readonly height: number; readonly hash: string };
  }): Promise<LotusV2Wallet> {
    const network = lotusV2NetworkOf(params.chainIdentifier);
    const hash = await params.indexer.blockHash(params.checkpoint.height);
    if (hash !== params.checkpoint.hash)
      throw new Error(
        `The Lotus node is not on the checkpoint chain (block ${params.checkpoint.height} is ${hash})`
      );
    const master = hdPrivateFromSeed(params.seed);
    if (!master.ok) throw new Error("Invalid wallet seed");
    const account = deriveHdPath(master.value, LOTUS_V2_ACCOUNT_PATH);
    if (!account.ok) throw new Error("Invalid account path");
    const wallet = new LotusV2Wallet(
      network,
      params.chainIdentifier,
      account.value,
      params.indexer,
      memoryLotusV2WalletStore()
    );
    wallet.store = params.storeFor(wallet.addressAt(0, 0));
    wallet.reload();
    // A restart finishes what it interrupted: the same recorded bytes, never a new payment.
    // An unreachable indexer must not refuse the wallet; the next send tries again first.
    await wallet.ensureDiscovered().catch(() => undefined);
    await wallet.finishPending().catch(() => undefined);
    return wallet;
  }

  get identity(): NativeWalletHandle["identity"] {
    const address = this.addressAt(0, 0);
    return { address: { raw: address }, displayAddress: address };
  }

  /** The coin list as last synced, with claims applied. */
  coins(): readonly LotusV2Coin[] {
    return this.coinList;
  }

  /** Recorded sends not yet seen mined (txid and the coins they claim). */
  pendingSends(): readonly PendingSend[] {
    this.reload();
    return this.state.pending;
  }

  getUnresolvedNativeTransaction(): ChainTransaction | undefined {
    return this.unresolved?.transaction;
  }

  async retryUnresolvedNativeTransaction(): Promise<ChainTransaction> {
    const unresolved = this.unresolved;
    if (!unresolved) throw new Error("No unresolved Lotus transaction");
    await this.finishPending();
    if (this.unresolved) throw this.unresolved;
    return { txHash: unresolved.transaction.txHash };
  }

  localReceiveAddress(): ChainAddress {
    return { raw: this.addressAt(0, this.state.receiveIndex) };
  }

  async getReceiveAddress(): Promise<ChainAddress> {
    await this.sync();
    return { raw: this.addressAt(0, this.state.receiveIndex) };
  }

  /** Mined, unclaimed coins. A pending send's change is counted once it is mined. */
  async getBalance(): Promise<bigint> {
    await this.finishPending().catch(() => undefined);
    await this.sync();
    return this.coinList.reduce((sum, coin) => (coin.state === "unspent" ? sum + coin.value : sum), 0n);
  }

  async estimateFee(params: { recipient: ChainAddress; value: bigint }): Promise<bigint> {
    this.recipientRoot(params.recipient.raw);
    await this.sync();
    return planLotusV2Send(this.coinList, params.value).fee;
  }

  /** `confirmed`/`pending` from the node; `unknown` while it lacks the transaction. */
  async getNativeTransactionStatus(
    transaction: ChainTransaction
  ): Promise<"confirmed" | "failed" | "pending" | "unknown"> {
    try {
      return await this.indexer.transactionState(transaction.txHash);
    } catch {
      return "unknown";
    }
  }

  /**
   * One payment. `maxFee` is the fee the user reviewed: the send may pay less, never more.
   * `onSigned` runs after the bytes are durably recorded and before they are broadcast.
   */
  async sendNative(params: {
    recipient: ChainAddress;
    value: bigint;
    maxFee?: bigint;
    minimumRemainingBalance?: bigint;
    onSigned?: (signed: ChainTransaction) => Promise<void>;
  }): Promise<ChainTransaction> {
    if (params.minimumRemainingBalance !== undefined)
      throw new Error("Minimum native reserve is unsupported by this wallet");
    if (params.value <= 0n) throw new RangeError("Transfer value must be greater than zero");
    const recipientRoot = this.recipientRoot(params.recipient.raw);
    // Earlier sends are finished or stay claimed; either way their coins are not chosen again.
    await this.finishPending();
    await this.sync();
    const signed = await this.exclusive(async () => {
      const plan = planLotusV2Send(this.coinList, params.value);
      if (params.maxFee !== undefined && plan.fee > params.maxFee)
        throw new NativeFeeExceededError(plan.fee);
      const changeIndex = this.state.changeIndex;
      const outputs = [{ value: params.value, root: recipientRoot }];
      if (plan.change !== undefined)
        outputs.push({ value: plan.change, root: this.rootAt(1, changeIndex) });
      const tx = signNativeTransaction({
        network: this.network,
        inputs: plan.inputs.map((coin) => ({
          txid: coin.txid,
          outIdx: coin.outIdx,
          value: coin.value,
          secret: coin.secret,
        })),
        outputs,
      });
      // Recorded before any byte leaves: after a crash the same bytes are sent again and the
      // inputs stay claimed. The change address is consumed with it, never reused.
      this.persist({
        ...this.state,
        changeIndex: plan.change === undefined ? changeIndex : changeIndex + 1,
        pending: [
          ...this.state.pending,
          { txid: tx.txid, raw: tx.raw, inputs: plan.inputs.map(({ txid, outIdx }) => ({ txid, outIdx })) },
        ],
      });
      this.inFlight.add(tx.txid);
      this.markClaims();
      return tx;
    });
    const transaction: ChainTransaction = { txHash: signed.txid, rawTransactions: [signed.raw] };
    try {
      await params.onSigned?.(transaction);
      await this.indexer.broadcast(signed.raw);
    } catch (reason) {
      if (reason instanceof LotusV2BroadcastRefused) {
        // Refused outright: nothing was accepted, so the coins are free again.
        await this.exclusive(async () => this.dropPending(signed.txid, false));
        throw new NativeTransactionRefusedError(reason.reason);
      }
      this.unresolved = new NativeTransactionSubmissionError({ transaction, reason });
      throw this.unresolved;
    } finally {
      this.inFlight.delete(signed.txid);
    }
    return transaction;
  }

  /**
   * Settle every recorded send not being broadcast right now. Mined: its inputs become
   * consumed and the record goes. In the mempool: it stays (claims held) until mined. Unknown
   * to the node: the same bytes are sent again; a refusal then means its inputs went some other
   * way, so the claim is released. A send whose outcome cannot be learned stays claimed.
   */
  private async finishPending(): Promise<void> {
    let unresolved: NativeTransactionSubmissionError | undefined;
    const pending = await this.exclusive(async () => this.state.pending);
    for (const send of pending) {
      if (this.inFlight.has(send.txid)) continue;
      try {
        const state = await this.indexer.transactionState(send.txid);
        if (state === "confirmed") {
          await this.exclusive(async () => this.dropPending(send.txid, true));
          continue;
        }
        if (state === "pending") continue;
        try {
          await this.indexer.broadcast(send.raw);
        } catch (reason) {
          if (!(reason instanceof LotusV2BroadcastRefused)) throw reason;
          // The node lacks it and refuses it: one of its coins was spent elsewhere (or it can
          // never be valid). Re-read before releasing, in case it was mined meanwhile.
          if ((await this.indexer.transactionState(send.txid)) === "unknown")
            await this.exclusive(async () => this.dropPending(send.txid, false));
        }
      } catch (reason) {
        unresolved = new NativeTransactionSubmissionError({
          transaction: { txHash: send.txid, rawTransactions: [send.raw] },
          reason,
        });
      }
    }
    this.unresolved = unresolved;
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
        this.markClaims();
        return operation();
      }
    );
  }

  private reload(): void {
    this.state = parseState(this.store.load(), this.chainIdentifier);
  }

  private persist(next: StoredState): void {
    this.store.save(JSON.stringify(next));
    this.state = next;
  }

  private dropPending(txid: string, mined: boolean): void {
    const send = this.state.pending.find((row) => row.txid === txid);
    if (!send) return;
    const consumed = mined
      ? [...new Map([...this.state.consumedInputs, ...send.inputs].map((o) => [outpointKey(o), o])).values()]
      : this.state.consumedInputs;
    this.persist({
      ...this.state,
      pending: this.state.pending.filter((row) => row.txid !== txid),
      consumedInputs: consumed,
    });
    this.markClaims();
  }

  private claimed(): Set<string> {
    return new Set(
      [...this.state.pending.flatMap((send) => send.inputs), ...this.state.consumedInputs].map(outpointKey)
    );
  }

  private markClaims(): void {
    const claimed = this.claimed();
    this.coinList = this.coinList.map((coin) => ({
      ...coin,
      state: claimed.has(outpointKey(coin)) ? "pending" : "unspent",
    }));
  }

  private nodeAt(chain: 0 | 1, index: number): HdPrivateNode {
    const branch = deriveHdPrivate(this.account, chain);
    if (!branch.ok) throw new Error("Derivation failed");
    const node = deriveHdPrivate(branch.value, index);
    if (!node.ok) throw new Error("Derivation failed");
    return node.value;
  }

  private secretAt(chain: 0 | 1, index: number): Uint8Array {
    return Uint8Array.from(this.nodeAt(chain, index).privateKey.bytes);
  }

  private keyhashAt(chain: 0 | 1, index: number): Uint8Array {
    return keyhashOf(xOnlyPublicKey(this.secretAt(chain, index)));
  }

  private rootAt(chain: 0 | 1, index: number): string {
    return toHex(branchLeaf(keyhashProgram(this.keyhashAt(chain, index))));
  }

  private addressAt(chain: 0 | 1, index: number): string {
    return encodeKeyhashAddress(this.network, this.keyhashAt(chain, index));
  }

  /** The branch root to pay; any address of another network is refused. */
  private recipientRoot(input: string): string {
    try {
      return decodeAddress(this.network, input.trim()).root;
    } catch (error) {
      if (error instanceof LotusV2UnsupportedNetworkError) throw error;
      throw new Error(
        `Invalid Lotus recipient address: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async ensureDiscovered(): Promise<void> {
    if (this.discovered) return;
    const next = async (chain: 0 | 1, from: number) => {
      let used = from - 1;
      for (let index = from; index <= used + ADDRESS_GAP; index++)
        if (await this.indexer.hasHistory(this.rootAt(chain, index))) used = index;
      return used + 1;
    };
    const receiveIndex = await next(0, this.state.receiveIndex);
    const changeIndex = await next(1, this.state.changeIndex);
    await this.exclusive(async () => {
      if (receiveIndex > this.state.receiveIndex || changeIndex > this.state.changeIndex)
        this.persist({
          ...this.state,
          receiveIndex: Math.max(receiveIndex, this.state.receiveIndex),
          changeIndex: Math.max(changeIndex, this.state.changeIndex),
        });
    });
    this.discovered = true;
  }

  /** Rebuild the coin list; reads unlocked, applied in one short locked step. */
  private async sync(): Promise<void> {
    await this.ensureDiscovered();
    const coins: LotusV2Coin[] = [];
    let receiveIndex = this.state.receiveIndex;
    const changeIndex = this.state.changeIndex;
    const read = async (chain: 0 | 1, index: number) => {
      const found = await this.indexer.listUnspent(this.rootAt(chain, index));
      if (found.length === 0) return false;
      const secret = this.secretAt(chain, index);
      for (const coin of found)
        coins.push({
          txid: coin.txid,
          outIdx: coin.outIdx,
          value: coin.value,
          origin: chain === 0 ? "receive" : "change",
          state: "unspent",
          secret,
        });
      return true;
    };
    // The address on show is `receiveIndex`; once it is paid, show the next one.
    for (let index = 0; index <= receiveIndex; index++)
      if ((await read(0, index)) && index === receiveIndex) receiveIndex += 1;
    for (let index = 0; index < changeIndex; index++) await read(1, index);
    await this.exclusive(async () => {
      if (receiveIndex > this.state.receiveIndex)
        this.persist({ ...this.state, receiveIndex });
      this.coinList = coins;
      this.markClaims();
    });
  }
}
