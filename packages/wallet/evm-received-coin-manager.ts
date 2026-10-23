import {
  Interface,
  Transaction,
  computeAddress,
  formatUnits,
  getAddress,
  getBytes,
  hexlify,
  keccak256,
  randomBytes,
  toUtf8Bytes,
  type Provider,
  type Wallet,
} from "ethers";
import type {
  MessageItem,
  ReceivedCoinItem,
  StealthItem,
  WalletSyncItem,
} from "@frank/cashweb/types/messages";
import { WalletSyncItemRejectedError } from "@frank/cashweb/sync-dispatcher";
import {
  DirectMessageAlreadyAttemptedError,
  type DirectMessageClient,
  type DirectMessageReceived,
} from "./chain/active-chain";
import {
  ContactPaymentFailedError,
  ContactPaymentPendingError,
  ContactPaymentReleasedError,
  ContactPaymentTooLargeError,
  MAX_STEALTH_ITEM_AMOUNT,
  NativeTransactionSubmissionError,
  type ContactSendParams,
  type ContactSendResult,
  type PreparedContactPayment,
  type ReceivedCoinSweep,
} from "./chain/chain-wallet";
import type { EvmLegacyConsolidator } from "./chain/evm-legacy-consolidator";
import {
  configuredEvmStealthToken,
  createEvmStealthPayments,
  type EvmStealthPreparation,
} from "./chain/evm-stealth-payments";
import {
  CanonicalMessagingPendingError,
  CanonicalRecipientNotPublishedError,
  createCooperativeBatchYielder,
  installedMessageItemRegistry,
  projectOutboxMessageRecord,
} from "./chain/canonical-dm";
import {
  EvmInputAdmissionError,
  nativeAdmissionJournal,
} from "./evm-input-admission";
import { evmWalletInternals, type ReceivedCoinOwner } from "./evm-wallet";
import type { EvmChainWalletHandle } from "./evm-wallet-handle";
import {
  SubAccountSpendRefusedError,
  type MonadSubAccountPool,
} from "./evm-account-pool";
import { fetchMonadProfile, type MonadIdentity } from "./evm-identity";
import {
  deriveEvmStealthAddress,
  deriveEvmStealthPrivateKey,
  evmStealthItem,
  stealthCoinFromItem,
  stealthItemTransfer,
} from "./evm-stealth";
import type { MonadWalletMaterial } from "./evm-wallet-material";
import { DefaultStampUnavailableError } from "./oracle/stamp-policy";
import type {
  StealthPaymentReceiptCapability,
  StealthPaymentReceiptClaim,
} from "./stealth-payment";
import {
  applyStoredNativeCoinObservation,
  markStoredEvmCoinNoted,
  messagePaymentOf,
  pendingCoinDue,
  receivedCoinNoteOf,
  receivedErc20Payments,
  receivedPaymentOf,
  recordStoredEvmCoin,
  refreshStoredEvmErc20Position,
  refreshStoredEvmNativePaymentSet,
  registerStoredEvmErc20Payment,
  registerStoredEvmNativePaymentSet,
  spendableCoins,
  type ContactPayment,
  type EvmCoin,
  type EvmCoinTransfer,
  type EvmErc20Reader,
  type RecordStore,
} from "./storage/evm-coin-store";
import type { EvmNativeSource } from "./storage/evm-native-operation-journal";
import type {
  EvmWalletOperationAdmission,
  EvmWalletPersistenceBundle,
} from "./storage/evm-wallet-bundle";
import { applyWalletSyncItem } from "./sync-dispatcher";
import type { MainAccountWait } from "./evm-fund-ahead";

/** The most pending coins one background pass asks the chain about. */
export const PENDING_COIN_PROBES_PER_PASS = 8;
/**
 * How long the wallet waits before asking the chain a second time whether a received payment's
 * transfer really can never land.
 */
export const TRANSFER_FAILURE_RECHECK_MS = 2_000;
/** How long `sweepReceivedCoins` waits for its sweep to be included before answering `pending`. */
export const SWEEP_INCLUSION_WAIT_MS = 10_000;
/**
 * How long a received note from this wallet's own key that could not be applied is tried again
 * (and so kept in the reader's replay window) before it is passed. In memory: it starts over when
 * the wallet is reopened.
 */
export const SELF_NOTE_RETRY_MS = 10 * 60_000;
const MAX_WAITING_SELF_NOTES = 256;

/**
 * Per wallet: the accounts (lower case) a signed transfer is held on while its message is being
 * delivered. Nothing else may take such an account's next nonce: not a native send or a sweep
 * (the journal refuses those), and not a funding transfer (which reads the nonce from the node,
 * so it asks here first).
 */
export function sourceIsHeld(wallet: object, address: string): boolean {
  return (
    evmWalletInternals(wallet)
      .heldTransferSources?.()
      .has(address.toLowerCase()) ?? false
  );
}

/** Why a funding transfer was refused: its source is held by a payment to a contact. */
export const SOURCE_HELD_FOR_CONTACT_PAYMENT =
  "These funds are held for a payment to a contact whose message is being delivered";

function selfNoteRefusalIsFinal(error: unknown): boolean {
  if (error instanceof WalletSyncItemRejectedError) return true;
  if (error instanceof SubAccountSpendRefusedError) {
    if (error.code === "no-applier") return false;
    if (error.code !== "held") return true;
    return /compacted terminal checkpoint|another spend checkpoint/.test(
      error.message
    );
  }
  return (
    error instanceof EvmInputAdmissionError &&
    error.reason === "invalid-provenance"
  );
}

export async function consumeEvmSelfNotes(
  wallet: EvmChainWalletHandle,
  message: DirectMessageReceived,
  onForeignWalletSync?: (item: WalletSyncItem) => Promise<void>
): Promise<
  | { kind: "none" }
  | { kind: "consumed"; rest: DirectMessageReceived | undefined }
  | { kind: "retry" }
> {
  const own = wallet.identity.address.raw.toLowerCase();
  if (
    message.senderAddress.raw.toLowerCase() !== own ||
    message.recipientAddress.raw.toLowerCase() !== own
  ) {
    return { kind: "none" };
  }
  const isWalletNote = (item: MessageItem) =>
    item.type === "wallet-sync" || item.type === "received-coin";
  if (!message.items.some(isWalletNote)) return { kind: "none" };
  const notes = message.items.filter((item) => item.type === "wallet-sync");
  const others = message.items.filter((item) => !isWalletNote(item));
  const itemRegistry = installedMessageItemRegistry(wallet);
  const rawRest =
    others.length > 0 ? { ...message, items: others } : undefined;
  const rest =
    rawRest !== undefined && itemRegistry !== undefined
      ? projectOutboxMessageRecord(rawRest, itemRegistry)
      : rawRest;
  const digest = message.payloadDigest;
  const internals = evmWalletInternals(wallet);
  const settled = internals.settledSelfNotes;
  if (settled.has(digest)) return { kind: "consumed", rest };
  const waiting = internals.waitingSelfNotes;
  try {
    for (const note of notes) {
      const item = note as WalletSyncItem;
      if (item.chainIdentifier === wallet.chainIdentifier) {
        await applyWalletSyncItem(wallet, item);
      } else {
        if (!onForeignWalletSync) {
          throw new Error(
            `Wallet sync owner unavailable for ${item.chainIdentifier}`
          );
        }
        await onForeignWalletSync(item);
      }
    }
  } catch (error) {
    if (
      notes.some(
        (note) =>
          (note as WalletSyncItem).chainIdentifier !== wallet.chainIdentifier
      )
    ) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    const since = waiting.get(digest) ?? Date.now();
    const final = selfNoteRefusalIsFinal(error);
    if (!final && Date.now() - since < SELF_NOTE_RETRY_MS) {
      if (!waiting.has(digest) && waiting.size >= MAX_WAITING_SELF_NOTES) {
        waiting.delete(waiting.keys().next().value as string);
      }
      waiting.set(digest, since);
      return { kind: "retry" };
    }
    console.warn(
      `[wallet-sync] a note this wallet wrote to itself was not applied and is passed (${digest}; ${
        final ? "refused" : "still failing after the retry window"
      }): ${detail}`
    );
  }
  waiting.delete(digest);
  settled.add(digest);
  return { kind: "consumed", rest };
}

export async function recordEvmReceivedCoins(
  wallet: EvmChainWalletHandle,
  messages: readonly DirectMessageReceived[]
): Promise<void> {
  const owner = evmWalletInternals(wallet).receivedCoinOwner;
  if (owner === undefined) return;
  const own = wallet.identity.address.raw.toLowerCase();
  const batchYielder = createCooperativeBatchYielder();
  let started = false;
  const yieldIfNeeded = async () => {
    if (started) {
      await batchYielder.maybeYield();
    } else {
      started = true;
    }
  };
  for (const message of messages) {
    if (
      message.senderAddress.raw.toLowerCase() !== own ||
      message.recipientAddress.raw.toLowerCase() !== own
    ) {
      continue;
    }
    for (const item of message.items) {
      if (item.type === "received-coin") {
        await yieldIfNeeded();
        await applyWalletSyncItem(wallet, item).catch((error) => {
          if (!(error instanceof WalletSyncItemRejectedError)) throw error;
        });
      }
    }
  }
  for (const message of messages) {
    if (
      message.outbound === true ||
      message.senderAddress.raw.toLowerCase() === own
    ) {
      continue;
    }
    for (const item of message.items) {
      if (item.type === "stealth") {
        await yieldIfNeeded();
        await owner.recordStealthItem(item, {
          payloadDigest: message.payloadDigest,
          timestampMs: message.receivedTime ?? Date.now(),
        });
      }
    }
  }
  for (const message of messages) {
    if (message.outbound !== true) {
      if ((message.stampPayments?.length ?? 0) > 0) {
        await yieldIfNeeded();
      }
      await owner.recordStampPayments(message);
    }
  }
}

export interface EvmReceivedCoinAndContactManagerParams {
  readonly chainIdentifier: string;
  readonly chainId: number | bigint;
  readonly networkTag: string;
  readonly relayBaseUrl: string;
  readonly forumNetwork: string;
  readonly nativeDecimals: number;
  readonly unit: string;
  readonly identityKey: string;
  readonly identity: MonadIdentity;
  readonly mainAccount: Wallet;
  readonly material: MonadWalletMaterial;
  readonly pool: MonadSubAccountPool;
  readonly provider: Provider;
  readonly coinStore: RecordStore<EvmCoin>;
  readonly paymentStore: RecordStore<ContactPayment>;
  readonly scanState: RecordStore<{ complete: boolean; sinceMs: number }>;
  readonly preparations: RecordStore<EvmStealthPreparation>;
  readonly getWallet: () => EvmChainWalletHandle;
  readonly getTopicOwner: () => EvmWalletPersistenceBundle;
  readonly getSources: () => Promise<EvmNativeSource[]>;
  readonly coinSource: (coin: EvmCoin) => EvmNativeSource;
  readonly invalidateBalanceRead: () => void;
  readonly requireOpenWallet: (wallet: EvmChainWalletHandle) => void;
  readonly canonicalMessagingFor: (wallet: EvmChainWalletHandle) => unknown;
  readonly directMessages: DirectMessageClient;
  readonly runWalletExclusive: <T>(
    wallet: EvmChainWalletHandle,
    task: (admission?: EvmWalletOperationAdmission) => Promise<T>,
    canonical?: boolean
  ) => Promise<T>;
  readonly runMainAccountExclusive: <T>(
    wallet: EvmChainWalletHandle,
    task: () => Promise<T>,
    options?: MainAccountWait
  ) => Promise<T>;
}

/**
 * Encapsulates received-coin scanning, ERC-20 / native stealth payment capabilities, self-note
 * emission, coin sweeping, and the contact-payment lifecycle for an `EvmWallet`.
 */
export function createEvmReceivedCoinAndContactManager(
  params: EvmReceivedCoinAndContactManagerParams
) {
  const {
    chainIdentifier,
    chainId,
    networkTag,
    relayBaseUrl,
    forumNetwork,
    nativeDecimals,
    unit,
    identityKey,
    identity,
    mainAccount,
    material,
    pool,
    provider,
    coinStore,
    paymentStore,
    scanState,
    preparations,
    getWallet,
    getTopicOwner,
    getSources,
    coinSource,
    invalidateBalanceRead,
    requireOpenWallet,
    canonicalMessagingFor,
    directMessages,
    runWalletExclusive,
    runMainAccountExclusive,
  } = params;
  const nativeChainId = BigInt(chainId);

  const financialAbi = new Interface([
    "function transfer(address to,uint256 amount) returns (bool)",
    "function balanceOf(address owner) view returns (uint256)",
    "event Transfer(address indexed from,address indexed to,uint256 value)",
  ]);

  const assertFinancialActive = (): void => {
    if (evmWalletInternals(getWallet()).closed) {
      throw new Error("Wallet financial session is closed");
    }
  };

  const erc20Reader: EvmErc20Reader = {
    call: ({ to, data, blockTag }) => provider.call({ to, data, blockTag }),
    getBlock: (tag) => provider.getBlock(tag),
    getTransactionReceipt: (hash) => provider.getTransactionReceipt(hash),
  };

  const tokenBalance = async (
    contract: string,
    address: string
  ): Promise<bigint> => {
    const encoded = await provider.call({
      to: contract,
      data: financialAbi.encodeFunctionData("balanceOf", [address]),
    });
    assertFinancialActive();
    if (!/^0x[0-9a-fA-F]{64}$/.test(encoded)) {
      throw new Error("Invalid ERC20 balance response");
    }
    return BigInt(encoded);
  };

  const verifiedFinancialReceipt = async (
    raw: string,
    recipientAddress: string,
    maximumBlock?: number
  ): Promise<bigint | undefined> => {
    const tx = Transaction.from(raw);
    const receipt = await provider.getTransactionReceipt(tx.hash!);
    assertFinancialActive();
    if (
      receipt === null ||
      (maximumBlock !== undefined && receipt.blockNumber > maximumBlock)
    ) {
      return undefined;
    }
    const block = await provider.getBlock(receipt.blockNumber);
    assertFinancialActive();
    if (
      receipt.hash.toLowerCase() !== tx.hash ||
      receipt.from.toLowerCase() !== tx.from!.toLowerCase() ||
      receipt.to?.toLowerCase() !== tx.to!.toLowerCase()
    ) {
      throw new Error("Invalid ERC20 receipt inclusion");
    }
    if (!block?.hash) {
      throw new Error("Financial receipt canonical block unavailable");
    }
    if (block.hash.toLowerCase() !== receipt.blockHash.toLowerCase()) {
      if (maximumBlock !== undefined) return undefined;
      throw new Error("Invalid ERC20 receipt inclusion");
    }
    if (receipt.status === 0) return 0n;
    if (receipt.status !== 1) throw new Error("Invalid ERC20 receipt status");
    if (
      tx.data === "0x" &&
      tx.to?.toLowerCase() === recipientAddress.toLowerCase()
    ) {
      return tx.value;
    }
    let value = 0n;
    const indexes = new Set<number>();
    for (const log of receipt.logs) {
      if (
        log.address.toLowerCase() !== tx.to!.toLowerCase() ||
        log.topics[0]?.toLowerCase() !==
          financialAbi.getEvent("Transfer")!.topicHash.toLowerCase()
      ) {
        continue;
      }
      if (
        indexes.has(log.index) ||
        !Number.isSafeInteger(log.index) ||
        log.index < 0 ||
        log.topics.length !== 3 ||
        !/^0x[0-9a-fA-F]{64}$/.test(log.data)
      ) {
        throw new Error("Invalid ERC20 receipt membership");
      }
      indexes.add(log.index);
      const event = financialAbi.decodeEventLog("Transfer", log.data, [
        ...log.topics,
      ]);
      if (
        getAddress(event.from).toLowerCase() === tx.from!.toLowerCase() &&
        getAddress(event.to).toLowerCase() === recipientAddress.toLowerCase()
      ) {
        value += BigInt(event.value);
      }
    }
    return value;
  };

  const refreshNativeSetCoin = async (coin: EvmCoin, replay = false) => {
    const atMs = Date.now();
    let retryFailure: unknown;
    const result = await refreshStoredEvmNativePaymentSet(
      coinStore,
      coin.address,
      {
        chainIdentifier,
        ephemeralPubKey: coin.ephemeralPubKey!,
        rawTransactions: coin.transactions.map((raw) => "0x" + raw),
        amountWei: BigInt(coin.claimedAmountWei),
        payloadDigest: coin.payloadDigest!,
      },
      async (address, raws) => {
        const head = await provider.getBlock("latest");
        assertFinancialActive();
        if (!head?.hash) {
          throw new Error("Native receipt snapshot block unavailable");
        }
        const amounts = await Promise.all(
          raws.map((raw) =>
            verifiedFinancialReceipt(raw, address, head.number)
          )
        );
        if (replay) {
          for (let index = 0; index < raws.length; index++) {
            if (amounts[index] !== undefined) continue;
            try {
              assertFinancialActive();
              const response = await provider.broadcastTransaction(
                raws[index]!
              );
              if (
                response.hash.toLowerCase() !==
                Transaction.from(raws[index]!).hash
              ) {
                throw new Error("Unexpected native receipt retry hash");
              }
            } catch (error) {
              retryFailure ??= error;
            }
          }
        }
        const balanceWei = await provider.getBalance(address, head.number);
        const checked = await provider.getBlock(head.number);
        assertFinancialActive();
        if (checked?.hash?.toLowerCase() !== head.hash.toLowerCase()) {
          throw new Error(
            "Native receipt snapshot changed; retry original set"
          );
        }
        return { balanceWei, receivedAmountsWei: amounts };
      },
      atMs
    );
    assertFinancialActive();
    if (!result.applied) {
      throw new Error("Native receipt observation changed; retry original set");
    }
    if (retryFailure !== undefined) throw retryFailure;
    return result;
  };

  const transferOf = async (
    coin: EvmCoin
  ): Promise<{ transfer: EvmCoinTransfer; valueWei?: bigint }> => {
    if (coin.transactions.length === 0) return { transfer: "none" };
    const transfer = stealthItemTransfer(
      coin.transactions,
      coin.address,
      nativeChainId
    );
    if (transfer === undefined) return { transfer: "unseen" };
    const included = async (): Promise<
      { transfer: EvmCoinTransfer; valueWei?: bigint } | undefined
    > => {
      const receipt = await provider.getTransactionReceipt(transfer.txHash);
      if (receipt === null) return undefined;
      if (transfer.valueWei !== undefined) {
        return receipt.status === 1
          ? { transfer: "included", valueWei: transfer.valueWei }
          : { transfer: "failed" };
      }
      const named = await provider.getTransaction(transfer.txHash);
      if (named?.to?.toLowerCase() !== coin.address) {
        return { transfer: "none" };
      }
      return receipt.status === 1
        ? { transfer: "included", valueWei: named.value }
        : { transfer: "failed" };
    };
    const mined = await included();
    if (mined !== undefined) return mined;
    if (coin.state === "failed") return { transfer: "failed" };
    if (transfer.rawTransaction === undefined) {
      return {
        transfer:
          (await provider.getTransaction(transfer.txHash)) !== null
            ? "seen"
            : "unseen",
      };
    }
    try {
      await provider.broadcastTransaction(transfer.rawTransaction);
      return { transfer: "seen" };
    } catch {
      if ((await provider.getTransaction(transfer.txHash)) !== null) {
        return (await included()) ?? { transfer: "seen" };
      }
      const signed = Transaction.from(transfer.rawTransaction);
      const used = await provider.getTransactionCount(signed.from!);
      if (used <= signed.nonce) return { transfer: "unseen" };
      const now = await included();
      if (now !== undefined) return now;
      await new Promise((resolve) =>
        setTimeout(resolve, TRANSFER_FAILURE_RECHECK_MS)
      );
      if ((await provider.getTransaction(transfer.txHash)) !== null) {
        return (await included()) ?? { transfer: "seen" };
      }
      return (await included()) ?? { transfer: "failed" };
    }
  };

  let coinsReadAtMs = 0;
  let pendingTurn = 0;
  let readingCoins: Promise<void> | undefined;
  let coinPasses: Promise<unknown> = Promise.resolve();

  const invalidateCoinsRead = (): void => {
    coinsReadAtMs = 0;
  };

  const readCoinsPass = (options: {
    pendingOnly?: boolean;
    only?: ReadonlySet<string>;
    strict?: boolean;
  }): Promise<void> => {
    const run = coinPasses.then(() => readCoinsPassNow(options));
    coinPasses = run.catch(() => undefined);
    return run;
  };

  const readCoinsPassNow = async (options: {
    pendingOnly?: boolean;
    only?: ReadonlySet<string>;
    strict?: boolean;
  }): Promise<void> => {
    const wallet = getWallet();
    let hadError = false;
    const all = coinStore
      .all()
      .filter(
        (coin) => options.only === undefined || options.only.has(coin.address)
      );
    const now = Date.now();
    const nativeSet = (coin: EvmCoin) =>
      coin.origin === "stealth" && coin.transactions.length > 1;
    const pending = all.filter(
      (coin) =>
        (nativeSet(coin) &&
          (options.only !== undefined || pendingCoinDue(coin, now))) ||
        (coin.state === "pending" &&
          (options.only !== undefined || pendingCoinDue(coin, now))) ||
        (coin.state === "failed" &&
          !options.pendingOnly &&
          (options.only !== undefined || pendingCoinDue(coin, now)))
    );
    const probed =
      options.only !== undefined ||
      pending.length <= PENDING_COIN_PROBES_PER_PASS
        ? pending
        : Array.from(
            { length: PENDING_COIN_PROBES_PER_PASS },
            (_, i) => pending[(pendingTurn + i) % pending.length]!
          );
    if (probed.length < pending.length) {
      pendingTurn = (pendingTurn + probed.length) % pending.length;
    }
    const counted = options.pendingOnly
      ? []
      : all.filter((coin) => coin.state === "unspent" && !nativeSet(coin));
    const targets = [...probed, ...counted];
    const BATCH_SIZE = 16;
    let anyBalanceChanged = false;
    for (let offset = 0; offset < targets.length; offset += BATCH_SIZE) {
      if (evmWalletInternals(wallet).closed) return;
      const batch = targets.slice(offset, offset + BATCH_SIZE);
      await Promise.all(
        batch.map(async (coin) => {
          if (evmWalletInternals(wallet).closed) return;
          try {
            if (nativeSet(coin)) {
              const before = coinStore.get(coin.address);
              await refreshNativeSetCoin(coin, true);
              const after = coinStore.get(coin.address);
              if (
                before?.state !== after?.state ||
                before?.amountWei !== after?.amountWei
              ) {
                anyBalanceChanged = true;
              }
              return;
            }
            const [read, balanceWei] = await Promise.all([
              coin.state === "unspent"
                ? Promise.resolve(undefined)
                : transferOf(coin),
              provider.getBalance(coin.address),
            ]);
            const current = coinStore.get(coin.address);
            if (current === undefined || evmWalletInternals(wallet).closed) {
              return;
            }
            const updated = await applyStoredNativeCoinObservation(
              coinStore,
              coin.address,
              {
                balanceWei,
                transfer: read?.transfer,
                transferValueWei: read?.valueWei,
                atMs: Date.now(),
              }
            );
            if (
              current.state !== updated.state ||
              current.amountWei !== updated.amountWei
            ) {
              anyBalanceChanged = true;
            }
          } catch (error) {
            if (options.strict) throw error;
            hadError = true;
          }
        })
      );
    }
    if (anyBalanceChanged) {
      invalidateBalanceRead();
    }
    if (!hadError && !options.pendingOnly && options.only === undefined) {
      coinsReadAtMs = Date.now();
    }
  };

  const readCoins = (maxAgeMs = 0): Promise<void> => {
    if (maxAgeMs > 0 && Date.now() - coinsReadAtMs < maxAgeMs) {
      return Promise.resolve();
    }
    readingCoins ??= readCoinsPass({}).finally(() => {
      readingCoins = undefined;
    });
    return readingCoins;
  };

  const recordCoin = async (coin: EvmCoin): Promise<void> => {
    await recordStoredEvmCoin(coinStore, coin);
    coinsReadAtMs = 0;
    invalidateBalanceRead();
  };

  const nativeOwner = (): EvmLegacyConsolidator => {
    const wallet = getWallet();
    requireOpenWallet(wallet);
    const owner = evmWalletInternals(wallet).nativeOperationOwner;
    if (!owner) throw new Error("Wallet has no durable native-operation owner");
    return owner;
  };

  const signedTransferTo = (address: string) =>
    getTopicOwner()
      .nativeJournal!.list()
      .find(
        (row) =>
          !row.cancelled &&
          row.recipient === address &&
          row.members.length === 1 &&
          row.members[0]!.signed
      );

  const newMessageId = (): string => {
    const bytes = randomBytes(16);
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = hexlify(bytes).slice(2);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(
      12,
      16
    )}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };

  const openedAtMs = Date.now();
  const transferMember = (payment: ContactPayment) =>
    payment.operationId === undefined
      ? undefined
      : getTopicOwner()
          .nativeJournal!.list()
          .find((row) => row.operationId === payment.operationId)?.members[0];
  const transferIncluded = (payment: ContactPayment): boolean =>
    transferMember(payment)?.observation.state === "included-success";

  const holdsItsSource = (payment: ContactPayment): boolean =>
    (payment.state === "prepared" || payment.state === "failed") &&
    !transferIncluded(payment);

  let financialPaymentsInstance: ReturnType<typeof createEvmStealthPayments> | undefined;

  const heldForItsMessage = (operationId: string): boolean =>
    (financialPaymentsInstance?.holdsForHost(operationId) ?? false) ||
    paymentStore
      .all()
      .some(
        (payment) =>
          payment.operationId === operationId && holdsItsSource(payment)
      );

  let exposure: Promise<unknown> = Promise.resolve();
  const exposureExclusive = <T>(task: () => Promise<T>): Promise<T> => {
    const run = exposure.then(task);
    exposure = run.catch(() => undefined);
    return run;
  };

  const inFlight = new Map<string, number>();

  const cancelReleasedTransfer = async (
    payment: ContactPayment
  ): Promise<void> => {
    const wallet = getWallet();
    const row =
      (payment.operationId === undefined
        ? undefined
        : getTopicOwner()
            .nativeJournal!.list()
            .find((r) => r.operationId === payment.operationId)) ??
      signedTransferTo(payment.stealthAddress);
    if (row === undefined || row.cancelled) return;
    await runWalletExclusive(wallet, (admission) =>
      nativeOwner().releaseUnexposed(row.operationId, admission)
    );
  };

  const releaseContactPayment = (stealthAddress: string): Promise<boolean> =>
    exposureExclusive(async () => {
      const payment = paymentStore.get(stealthAddress);
      if (
        payment === undefined ||
        (payment.state !== "prepared" && payment.state !== "planned") ||
        payment.payloadDigest !== undefined ||
        inFlight.has(payment.ephemeralPubKey)
      ) {
        return false;
      }
      const {
        rawTransaction: _raw,
        txHash: _hash,
        ...withoutBytes
      } = payment;
      const released: ContactPayment = {
        ...withoutBytes,
        state: "released",
      };
      await paymentStore.put(stealthAddress, released);
      await cancelReleasedTransfer(payment);
      return true;
    });

  const broadcastContactTransfer = async (
    payment: ContactPayment
  ): Promise<ContactPayment> => {
    const wallet = getWallet();
    const operationId = payment.operationId!;
    await runWalletExclusive(wallet, (admission) =>
      runMainAccountExclusive(wallet, () =>
        nativeOwner().resumeOperation(operationId, admission)
      )
    ).catch(() => undefined);
    invalidateBalanceRead();
    const member = getTopicOwner()
      .nativeJournal!.list()
      .find((row) => row.operationId === operationId)?.members[0];
    if (member?.observation.state !== "included-success") return payment;
    const paid: ContactPayment = { ...payment, state: "paid" };
    await paymentStore.put(payment.stealthAddress, paid);
    return paid;
  };

  let contactQueue: Promise<unknown> = Promise.resolve();
  const contactExclusive = <T>(task: () => Promise<T>): Promise<T> => {
    const run = contactQueue.then(task);
    contactQueue = run.catch(() => undefined);
    return run;
  };

  const itemOf = (payment: ContactPayment): StealthItem =>
    evmStealthItem({
      networkTag,
      ephemeralPubKey: getBytes(`0x${payment.ephemeralPubKey}`),
      rawTransaction: payment.rawTransaction!,
      amountWei: BigInt(payment.valueWei),
      memo: payment.memo,
    });

  const finishContactPayment = async (
    stealthAddress: string,
    onProgress?: ContactSendParams["onProgress"],
    takeOver = false
  ): Promise<ContactPayment> => {
    const wallet = getWallet();
    let payment = paymentStore.get(stealthAddress);
    if (payment === undefined) {
      throw new Error("No such payment to a contact");
    }
    if (payment.state === "planned" && payment.stampValueWei === undefined) {
      throw new Error(
        "Contact payment has no captured stamp amount; unsupported development journal format. Recover the signed payment before resetting its application records."
      );
    }
    if (payment.state === "planned") {
      const row = signedTransferTo(stealthAddress);
      if (row === undefined) {
        await paymentStore.delete(stealthAddress);
        throw new Error("The payment was never signed. Nothing was sent.");
      }
      payment = {
        ...payment,
        state: "prepared",
        operationId: row.operationId,
        rawTransaction: row.members[0]!.signed!.rawTransaction,
        txHash: row.members[0]!.signed!.transactionHash,
      };
      await paymentStore.put(stealthAddress, payment);
    }
    if (payment.state === "failed") {
      throw new ContactPaymentFailedError(
        payment.messageId,
        payment.failure ?? "ended"
      );
    }
    if (payment.state === "delivered") {
      return broadcastContactTransfer(payment);
    }
    if (payment.state !== "prepared") return payment;
    if (payment.stampValueWei === undefined) {
      throw new Error(
        "Contact payment has no captured stamp amount; unsupported development journal format. Recover the signed payment before resetting its application records."
      );
    }
    const stampValue = BigInt(payment.stampValueWei);
    if (payment.deliveredBy === "host") {
      if (payment.payloadDigest === undefined) return payment;
      const status = await directMessages
        .reconcileAttempts({
          wallet,
          payloadDigests: [payment.payloadDigest],
        })
        .then(
          (statuses) => statuses[payment!.payloadDigest!],
          () => "live" as const
        );
      if (status === "delivered") {
        payment = { ...payment, state: "delivered" };
        await paymentStore.put(stealthAddress, payment);
        return broadcastContactTransfer(payment);
      }
      if (
        !(status === "dead" || status === "unknown") ||
        !(takeOver || payment.createdAtMs < openedAtMs)
      ) {
        return payment;
      }
      payment = {
        ...payment,
        deliveredBy: "wallet",
        messageId: newMessageId(),
      };
      await paymentStore.put(stealthAddress, payment);
    }
    onProgress?.({ stage: "delivering", txHash: payment.txHash });
    let payloadDigest: string;
    try {
      payloadDigest = (
        await directMessages.send({
          wallet,
          recipient: { raw: getAddress(payment.recipientAddress) },
          items: [itemOf(payment)],
          messageId: payment.messageId,
          ...(payment.conversationId === undefined
            ? {}
            : { conversationId: payment.conversationId }),
          stampValue,
        })
      ).payloadDigest;
    } catch (error) {
      if (!(error instanceof DirectMessageAlreadyAttemptedError)) {
        throw error;
      }
      const status = (
        await directMessages.reconcileAttempts({
          wallet,
          payloadDigests: [error.payloadDigest],
        })
      )[error.payloadDigest];
      if (status === "dead") {
        const failure = "the relay ended the message";
        await paymentStore.put(stealthAddress, {
          ...payment,
          state: "failed",
          payloadDigest: error.payloadDigest,
          failure,
        });
        throw new ContactPaymentFailedError(payment.messageId, failure);
      }
      if (status !== "delivered") throw error;
      payloadDigest = error.payloadDigest;
    }
    payment = { ...payment, state: "delivered", payloadDigest };
    await paymentStore.put(stealthAddress, payment);
    onProgress?.({ stage: "broadcasting", txHash: payment.txHash });
    return broadcastContactTransfer(payment);
  };

  const payContact = async (
    contactParams: ContactSendParams,
    hostDelivers: boolean
  ): Promise<ContactSendResult | PreparedContactPayment> => {
    const wallet = getWallet();
    requireOpenWallet(wallet);
    if (!canonicalMessagingFor(wallet)) {
      throw new CanonicalMessagingPendingError(
        "Contact payments require canonical direct messaging."
      );
    }
    if (contactParams.value <= 0n) {
      throw new RangeError("Transfer value must be positive");
    }
    if (contactParams.value > MAX_STEALTH_ITEM_AMOUNT) {
      throw new ContactPaymentTooLargeError(
        `This payment is larger than a single contact payment can carry (about ${formatUnits(
          MAX_STEALTH_ITEM_AMOUNT,
          nativeDecimals
        ).slice(0, 4)} ${unit}); send it in parts`
      );
    }
    const recipientAddress = getAddress(
      contactParams.recipient.raw
    ).toLowerCase();
    if (recipientAddress === identityKey) {
      throw new Error("A payment to a contact needs another account");
    }
    contactParams.onProgress?.({ stage: "resolving-keys" });
    let spendKey: Uint8Array | undefined;
    let recipientStampKey: Uint8Array | undefined;
    const directory = evmWalletInternals(wallet).canonicalDirectory;
    if (directory !== undefined) {
      const peer = await directory.peerCurrent({
        address: contactParams.recipient.raw,
      });
      if (!peer) {
        throw new CanonicalRecipientNotPublishedError(
          contactParams.recipient.raw
        );
      }
      spendKey = getBytes(`0x${peer.subject}`);
      recipientStampKey = peer.current.stampKey.keyBytes;
    } else {
      spendKey = (
        await fetchMonadProfile({
          relayBaseUrl,
          address: { raw: contactParams.recipient.raw },
        })
      )?.pubKey;
    }
    if (
      spendKey === undefined ||
      computeAddress(hexlify(spendKey)).toLowerCase() !== recipientAddress
    ) {
      throw new Error("The contact has no published key for this address");
    }
    let stampWei = contactParams.stampValue;
    if (stampWei === undefined) {
      const quote = await directMessages.defaultStampQuote!({ wallet });
      if (quote.status === "unavailable") {
        throw new DefaultStampUnavailableError(quote);
      }
      stampWei = quote.amount;
    }
    if ((await wallet.getBalance()) < contactParams.value + stampWei) {
      throw new RangeError(
        "Insufficient funds for the payment and its message stamp"
      );
    }
    contactParams.onProgress?.({ stage: "deriving-stealth" });
    const destination = deriveEvmStealthAddress({
      recipientSpendPubKey: spendKey,
    });
    const stealthAddress = destination.stealthAddress.toLowerCase();
    return contactExclusive(async () => {
      requireOpenWallet(wallet);
      const messageId = newMessageId();
      await paymentStore.put(stealthAddress, {
        messageId,
        stealthAddress,
        ephemeralPubKey: hexlify(destination.ephemeralPubKey).slice(2),
        recipientAddress,
        valueWei: contactParams.value.toString(),
        ...(contactParams.memo ? { memo: contactParams.memo } : {}),
        ...(contactParams.conversationId === undefined
          ? {}
          : { conversationId: contactParams.conversationId }),
        stampValueWei: stampWei.toString(),
        state: "planned",
        deliveredBy: hostDelivers ? "host" : "wallet",
        createdAtMs: Date.now(),
      });
      contactParams.onProgress?.({ stage: "signing" });
      try {
        await runWalletExclusive(wallet, (admission) =>
          runMainAccountExclusive(wallet, () =>
            nativeOwner().signNative(
              { recipient: { raw: stealthAddress }, value: contactParams.value },
              admission
            )
          )
        );
      } catch (error) {
        if (signedTransferTo(stealthAddress) === undefined) {
          await paymentStore.delete(stealthAddress);
          throw error;
        }
      }
      let payment: ContactPayment;
      try {
        payment = await finishContactPayment(
          stealthAddress,
          contactParams.onProgress
        );
      } catch (error) {
        const saved = paymentStore.get(stealthAddress);
        if (
          error instanceof ContactPaymentFailedError ||
          error instanceof ContactPaymentReleasedError ||
          saved === undefined
        ) {
          throw error;
        }
        throw new ContactPaymentPendingError(
          saved.messageId,
          saved.txHash,
          error
        );
      }
      if (hostDelivers) {
        return {
          item: itemOf(payment),
          stampValue: stampWei,
          txHash: payment.txHash!,
          stealthAddress: destination.stealthAddress,
          value: contactParams.value,
        };
      }
      contactParams.onProgress?.({ stage: "confirmed", txHash: payment.txHash });
      return {
        txHash: payment.txHash!,
        stealthAddress: destination.stealthAddress,
        value: contactParams.value,
        messageId: payment.messageId,
        payloadDigest: payment.payloadDigest!,
      };
    });
  };

  let resumingContactPayments: Promise<void> | undefined;
  const resumeContactPayments = (): Promise<void> => {
    const wallet = getWallet();
    resumingContactPayments ??= contactExclusive(async () => {
      for (const listed of paymentStore.all()) {
        if (evmWalletInternals(wallet).closed) return;
        let payment = listed;
        if (payment.state === "released") {
          await cancelReleasedTransfer(payment).catch(() => undefined);
          continue;
        }
        if (
          payment.state !== "planned" &&
          payment.state !== "prepared" &&
          payment.state !== "delivered" &&
          payment.state !== "failed"
        ) {
          continue;
        }
        if (
          payment.deliveredBy === "host" &&
          payment.state === "prepared" &&
          payment.payloadDigest === undefined &&
          payment.createdAtMs < openedAtMs
        ) {
          await releaseContactPayment(payment.stealthAddress).catch(
            () => undefined
          );
          continue;
        }
        const operationId = payment.operationId;
        if (
          operationId !== undefined &&
          payment.state !== "delivered" &&
          payment.payloadDigest !== undefined
        ) {
          await getTopicOwner()
            .runLifetime((lifetime) =>
              nativeOwner().observe(operationId, 0, lifetime)
            )
            .catch(() => undefined);
          if (transferIncluded(payment)) {
            payment = { ...payment, state: "paid" };
            await paymentStore.put(payment.stealthAddress, payment);
            continue;
          }
        }
        if (payment.state !== "failed") {
          await finishContactPayment(payment.stealthAddress).catch(
            () => undefined
          );
        }
      }
    })
      .catch(() => undefined)
      .finally(() => {
        resumingContactPayments = undefined;
      });
    return resumingContactPayments;
  };

  const settleContactPayment = (
    ephemeralPubKey: string
  ): Promise<ContactPayment["state"] | "none"> =>
    contactExclusive(async () => {
      const wallet = getWallet();
      requireOpenWallet(wallet);
      const key = ephemeralPubKey.replace(/^0x/, "").toLowerCase();
      const found = paymentStore
        .all()
        .find((row) => row.ephemeralPubKey === key);
      if (found === undefined) return "none";
      const address = found.stealthAddress;
      if (await releaseContactPayment(address)) return "released";
      let payment = paymentStore.get(address)!;
      if (payment.state === "failed") {
        const { failure: _failure, payloadDigest: _digest, ...rest } = payment;
        payment = {
          ...rest,
          deliveredBy: "wallet",
          messageId: newMessageId(),
          state: "prepared",
        };
        await paymentStore.put(address, payment);
      }
      if (
        payment.state === "planned" ||
        payment.state === "prepared" ||
        payment.state === "delivered"
      ) {
        await finishContactPayment(address, undefined, true).catch(
          () => undefined
        );
      }
      return paymentStore.get(address)?.state ?? "none";
    });

  const retryContactPayment = async (messageId: string): Promise<void> => {
    const payment = paymentStore
      .all()
      .find((row) => row.messageId === messageId);
    if (payment === undefined) {
      throw new Error("No such payment to a contact");
    }
    await settleContactPayment(payment.ephemeralPubKey);
  };

  const recordStampCoin: ReceivedCoinOwner["recordStampCoin"] = (stamp) =>
    recordCoin({
      address: stamp.address.toLowerCase(),
      privateKey: stamp.privateKey,
      origin: "stamp",
      state: "pending",
      amountWei: "0",
      claimedAmountWei: stamp.valueWei.toString(),
      transactions: [stamp.transaction.replace(/^0x/, "").toLowerCase()],
      payloadDigest: stamp.payloadDigest.replace(/^0x/, "").toLowerCase(),
      childIndex: stamp.childIndex,
      ...(stamp.stampSharedPoint === undefined
        ? {}
        : {
            stampSharedPoint: stamp.stampSharedPoint
              .replace(/^0x/, "")
              .toLowerCase(),
          }),
      discoveredAtMs: stamp.timestampMs,
    });

  const recordReceivedCoin = async (
    note: ReceivedCoinItem
  ): Promise<boolean> => {
    const address = note.address.toLowerCase();
    const transactions = (note.transactions ?? []).map((entry) =>
      entry.replace(/^0x/, "").toLowerCase()
    );
    let coin: EvmCoin | undefined;
    if (note.origin === "stealth") {
      if (note.ephemeralPubKey === undefined) return false;
      coin = stealthCoinFromItem({
        item: {
          ephemeralPubKey: note.ephemeralPubKey,
          transactions,
          amount: 0,
          amountWei: note.claimedAmountWei,
        },
        recipientSpendSecret: identity.toPrivateKeyHex(),
        payloadDigest: note.payloadDigest,
        discoveredAtMs: note.timestamp,
      });
    } else {
      const roles = material.canonicalRoles;
      if (
        roles === undefined ||
        note.stampSharedPoint === undefined ||
        note.childIndex === undefined
      ) {
        return false;
      }
      const sharedPoint = note.stampSharedPoint
        .replace(/^0x/, "")
        .toLowerCase();
      const privateKey = roles.stampChildPrivateKey({
        network: forumNetwork,
        sharedPoint: getBytes(`0x${sharedPoint}`),
        childIndex: note.childIndex,
        address,
      });
      if (privateKey !== undefined) {
        coin = {
          address,
          privateKey,
          origin: "stamp",
          state: "pending",
          amountWei: "0",
          claimedAmountWei: note.claimedAmountWei,
          transactions,
          ...(note.payloadDigest === undefined
            ? {}
            : {
                payloadDigest: note.payloadDigest
                  .replace(/^0x/, "")
                  .toLowerCase(),
              }),
          childIndex: note.childIndex,
          stampSharedPoint: sharedPoint,
          discoveredAtMs: note.timestamp,
        };
      }
    }
    if (coin === undefined || coin.address !== address) return false;
    const known = coinStore.get(address);
    if (known === undefined) {
      await recordCoin({ ...coin, notedAtMs: Date.now() });
    } else if (known.notedAtMs === undefined) {
      await markStoredEvmCoinNoted(coinStore, address, Date.now());
    }
    return true;
  };

  const noteFailures = new Set<string>();
  let notingCoins: Promise<void> | undefined;
  const noteCoins = (): Promise<void> => {
    const wallet = getWallet();
    notingCoins ??= (async () => {
      if (scanState.get("scan")?.complete !== true) return;
      const waiting = coinStore
        .all()
        .filter((coin) => coin.notedAtMs === undefined)
        .map((coin) => coin.address);
      for (const address of [
        ...waiting.filter((entry) => !noteFailures.has(entry)),
        ...waiting.filter((entry) => noteFailures.has(entry)),
      ]) {
        if (evmWalletInternals(wallet).closed) return;
        const coin = coinStore.get(address);
        if (coin === undefined || coin.notedAtMs !== undefined) continue;
        const note = receivedCoinNoteOf(coin, chainIdentifier);
        if (note === undefined) continue;
        try {
          await directMessages.send({
            wallet,
            recipient: { raw: getAddress(identity.address.raw) },
            items: [note],
            stampValue: 0n,
            messageId: getBytes(
              keccak256(
                toUtf8Bytes(`frank-received-coin:${chainIdentifier}:${address}`)
              )
            ).slice(0, 16),
          });
        } catch {
          noteFailures.delete(address);
          noteFailures.add(address);
          return;
        }
        noteFailures.delete(address);
        const current = coinStore.get(address);
        if (current !== undefined && current.notedAtMs === undefined) {
          await markStoredEvmCoinNoted(coinStore, address, Date.now());
        }
      }
    })()
      .catch(() => undefined)
      .finally(() => {
        notingCoins = undefined;
      });
    return notingCoins;
  };

  const sweepReceivedCoins = async (sweepParams: {
    payloadDigests: readonly string[];
  }): Promise<Record<string, ReceivedCoinSweep>> => {
    const wallet = getWallet();
    requireOpenWallet(wallet);
    const asked = sweepParams.payloadDigests.map((digest) => ({
      digest,
      bare: digest.replace(/^0x/, "").toLowerCase(),
    }));
    const wanted = new Set(asked.map((entry) => entry.bare));
    const coinsOf = () =>
      coinStore
        .all()
        .filter(
          (coin) =>
            coin.payloadDigest !== undefined && wanted.has(coin.payloadDigest)
        );
    const mainAddress = mainAccount.address.toLowerCase();
    const live = () =>
      coinsOf().filter(
        (coin) => coin.state === "pending" || coin.state === "unspent"
      );
    let failure: string | undefined;
    const left = new Set<string>();
    const heldByOthers = new Set<string>();
    const sweptAlready = (address: string): boolean =>
      getTopicOwner()
        .nativeJournal!.list()
        .some(
          (row) =>
            !row.cancelled &&
            row.recipient === mainAddress &&
            row.members.some(
              (member) =>
                member.source.address === address &&
                member.observation.state === "included-success"
            )
        );
    const sweepOf = (address: string) =>
      getTopicOwner()
        .nativeJournal!.list()
        .find(
          (row) =>
            !row.cancelled &&
            row.recipient === mainAddress &&
            row.members.some(
              (member) =>
                member.source.address === address &&
                member.observation.state !== "included-success" &&
                member.observation.state !== "included-revert"
            )
        );
    if (live().length > 0) {
      try {
        await readCoinsPass({
          only: new Set(live().map((coin) => coin.address)),
          strict: true,
        });
        const owner = nativeOwner();
        const until = Date.now() + SWEEP_INCLUSION_WAIT_MS;
        for (;;) {
          const unspent = spendableCoins(live()).filter(
            (coin) =>
              !left.has(coin.address) &&
              !heldByOthers.has(coin.address) &&
              !sweptAlready(coin.address)
          );
          if (unspent.length === 0) break;
          const carried = new Set(
            unspent.flatMap((coin) => {
              const row = sweepOf(coin.address);
              return row === undefined ? [] : [row.operationId];
            })
          );
          const fresh = unspent.filter(
            (coin) => sweepOf(coin.address) === undefined
          );
          let waiting = false;
          for (const operationId of carried) {
            await runWalletExclusive(wallet, (admission) =>
              runMainAccountExclusive(wallet, () =>
                owner.resumeOperation(operationId, admission)
              )
            ).catch((error) => {
              if (!(error instanceof NativeTransactionSubmissionError)) {
                throw error;
              }
              waiting = true;
            });
          }
          if (fresh.length > 0) {
            await runWalletExclusive(wallet, (admission) =>
              runMainAccountExclusive(wallet, () =>
                owner.sweepSources(
                  {
                    sources: fresh.map(coinSource),
                    recipient: { raw: mainAddress },
                  },
                  admission
                )
              )
            ).then(
              (swept) => {
                for (const address of swept.left) left.add(address);
                for (const address of swept.held) heldByOthers.add(address);
                if (swept.pending) waiting = true;
              },
              (error) => {
                if (!(error instanceof NativeTransactionSubmissionError)) {
                  throw error;
                }
                waiting = true;
              }
            );
          }
          invalidateBalanceRead();
          await readCoinsPass({
            only: new Set(unspent.map((coin) => coin.address)),
            strict: true,
          });
          if (!waiting || Date.now() >= until) break;
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          if (evmWalletInternals(wallet).closed) break;
        }
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
    }
    const answers: Record<string, ReceivedCoinSweep> = {};
    for (const { digest, bare } of asked) {
      const coins = coinStore
        .all()
        .filter((coin) => coin.payloadDigest === bare);
      const moved = coins.some((coin) => sweptAlready(coin.address));
      const held = coins.filter(
        (coin) =>
          (coin.state === "unspent" &&
            !left.has(coin.address) &&
            !sweptAlready(coin.address)) ||
          (coin.state === "pending" &&
            (coin.transferSeen === true || failure !== undefined))
      );
      if (held.length === 0) {
        answers[digest] = { outcome: moved ? "swept" : "none" };
      } else if (
        failure === undefined &&
        held.every(
          (coin) =>
            coin.state === "unspent" && sweepOf(coin.address) !== undefined
        )
      ) {
        answers[digest] = {
          outcome: "pending",
          reason: "The sweep is broadcast and not in a block yet",
        };
      } else {
        answers[digest] = {
          outcome: "failed",
          reason:
            failure ??
            (held.some((coin) => coin.state === "pending")
              ? "A payment of this message is not on the chain yet"
              : held.some((coin) => heldByOthers.has(coin.address))
              ? "Another operation of this wallet is spending from these coins"
              : "The coins could not be moved"),
        };
      }
    }
    return answers;
  };

  const installStealthAndContactOwners = async (): Promise<void> => {
    const wallet = getWallet();
    const topicOwner = getTopicOwner();
    const owner = evmWalletInternals(wallet).nativeOperationOwner!;

    const financialPayments = createEvmStealthPayments({
      chainIdentifier,
      nativeChainId,
      coordinationKey: JSON.stringify(topicOwner.nativeJournal!.binding),
      refreshJournal: async (id) => {
        await topicOwner.runLifetime((lifetime) =>
          nativeAdmissionJournal(
            topicOwner.inputAdmission,
            lifetime
          ).refreshPreparation(id)
        );
      },
      store: preparations,
      assertActive: assertFinancialActive,
      derive: (recipientSpendPubKey) =>
        deriveEvmStealthAddress({ recipientSpendPubKey }),
      quoteNative: async (_amountWei) => {
        await wallet.refreshTransactionSetInventory?.();
        assertFinancialActive();
        const preparer = wallet.transactionSetPreparer;
        const coins = evmWalletInternals(wallet).coinList;
        if (!preparer || !coins) throw new Error("Shared native transaction preparation is unavailable");
        const policy = preparer.transactionSetPolicy();
        const available = coins.all().filter(coin => coin.state === "unspent" && (coin.spendableFromBlock === undefined || coin.spendableFromBlock <= policy.head));
        const balance = available.reduce((sum, coin) => sum + coin.valueWei, 0n);
        const maximumFee = BigInt(available.length) * (policy.paymentGasLimit("0x") + BigInt(policy.maxChangeOutputs) * policy.changeGasLimit) * policy.gasPriceWei;
        return { nativeBalanceAtomic: balance, assetBalanceAtomic: balance, estimatedNativeFeeAtomic: maximumFee };
      },
      constructNativePayment: async (request) => {
        const preparer = wallet.transactionSetPreparer;
        if (!preparer) throw new Error("Shared native transaction preparation is unavailable");
        await wallet.refreshTransactionSetInventory?.();
        await topicOwner.runLifetime(() => preparer.constructTransactionSet(request));
        const row = preparer.getOperation(request.operationId);
        if (!row) throw new Error("Prepared native operation was not retained");
        return row;
      },
      operations: () => topicOwner.nativeJournal!.list(),
      signIndependentPayment: (signParams) =>
        topicOwner.runLifetime((lifetime) =>
          owner.signIndependentPayment(signParams, lifetime)
        ),
      submit: (id) => {
        const row = topicOwner.nativeJournal!.get(id);
        if (row.kind === "transaction-set") return topicOwner.runLifetime(() => wallet.transactionSetLifecycle!.replay(row.preparationId!.slice("evm-transaction-set:".length), { payments: true }));
        return topicOwner.runLifetime(lifetime => owner.resumeIndependentPayment(id, lifetime));
      },
      observe: (id) =>
        topicOwner.runLifetime(async (lifetime) => {
          const row = topicOwner.nativeJournal!.get(id);
          if (row.kind === "transaction-set") return wallet.transactionSetLifecycle!.observe(row.preparationId!.slice("evm-transaction-set:".length), provider);
          for (
            let index = 0;
            index < topicOwner.nativeJournal!.get(id).members.length;
            index++
          ) {
            await owner.observe(id, index, lifetime);
          }
        }),
      release: (id) =>
        topicOwner.runLifetime(async lifetime => {
          const operation = topicOwner.nativeJournal!.get(id)
          if (operation?.kind === 'transaction-set') {
            if (!wallet.transactionSetPreparer)
              throw new Error('Shared transaction-set release is unavailable')
            await wallet.transactionSetPreparer.releaseUnexposed(id)
            return
          }
          await owner.releaseUnexposed(id, lifetime)
        }),
      async quote(input) {
        if (input.asset.kind !== "erc20") throw new Error("Native quotes use the shared inventory snapshot");
        const contractAddress = input.asset.contractAddress;
        const requested = input.sourceAddress === undefined ? undefined : getAddress(input.sourceAddress).toLowerCase();
        const owned = [...new Map((await getSources()).map(source => [source.address, source])).values()];
        if (requested !== undefined && !owned.some(source => source.address === requested)) throw new Error("Requested financial source is not owned");
        const inspect = requested === undefined ? owned.filter(source => source.kind !== "spend" && source.kind !== "change") : owned.filter(source => source.address === requested);
        let lacksGas = false;
        const inspected = await Promise.all(inspect.map(async source => {
          if (sourceIsHeld(wallet, source.address) || owner.holdsSource(source.address)) return null;
          const [native, balance] = await Promise.all([provider.getBalance(source.address), tokenBalance(contractAddress, source.address)]);
          assertFinancialActive();
          if (balance <= 0n) return null;
          if (native === 0n) { lacksGas = true; return null; }
          return { source, balance };
        }));
        const candidates = inspected.filter((item): item is NonNullable<typeof item> => item !== null);
        candidates.sort((a, b) => a.source.kind === "main" && b.source.kind !== "main" ? 1 : b.source.kind === "main" && a.source.kind !== "main" ? -1 : a.balance === b.balance ? a.source.address.localeCompare(b.source.address) : a.balance < b.balance ? -1 : 1);
        const sources: { sourceAddress: string; recipientAmountAtomic: bigint; nativeBalanceAtomic: bigint; assetBalanceAtomic: bigint; estimatedNativeFeeAtomic: bigint }[] = [];
        let remaining = input.amountAtomic;
        const allocate = async (ordered: typeof candidates) => {
          sources.length = 0;
          remaining = input.amountAtomic;
          for (const candidate of ordered) {
            if (remaining === 0n || sources.length === 16) break;
            const amount = candidate.balance < remaining ? candidate.balance : remaining;
            const fact = (await topicOwner.runLifetime(lifetime => owner.quoteIndependentPayment({ kind: "contract", recipient: { raw: contractAddress }, members: [{ sourceAddress: candidate.source.address, value: 0n, data: financialAbi.encodeFunctionData("transfer", [input.recipientAddress, amount]) }] }, lifetime))).sources[0]!;
            if (fact.nativeBalanceAtomic < fact.estimatedNativeFeeAtomic) { lacksGas = true; continue; }
            sources.push({ ...fact, recipientAmountAtomic: amount, assetBalanceAtomic: candidate.balance });
            remaining -= amount;
          }
        };
        await allocate(candidates);
        if (remaining > 0n && sources.length === 16) await allocate([...candidates].sort((a, b) => a.balance === b.balance ? candidates.indexOf(a) - candidates.indexOf(b) : a.balance > b.balance ? -1 : 1));
        assertFinancialActive();
        if (remaining > 0n) throw new RangeError(sources.length === 16 ? "Payment cannot fit the 16-member limit" : lacksGas ? "ERC20 payment needs native gas at owned sources" : "Insufficient unreserved payment funds");
        return { sources };
      },
      tokenBalance,
      tokenReceipt: verifiedFinancialReceipt,
    });

    financialPaymentsInstance = financialPayments;
    await financialPayments.recoverReleases();

    const snapshotReceiptClaim = (
      claim: StealthPaymentReceiptClaim
    ): StealthPaymentReceiptClaim => ({
      ...claim,
      asset: { ...claim.asset },
      ephemeralPublicKey: new Uint8Array(claim.ephemeralPublicKey),
      recipientDestination: new Uint8Array(claim.recipientDestination),
      rawTransactions: claim.rawTransactions.map((raw) => {
        if (
          typeof raw !== "string" ||
          raw.length > 32768 ||
          !/^(?:[0-9a-f]{2})+$/.test(raw)
        ) {
          throw new Error("Invalid financial receipt transaction bytes");
        }
        return `0x${raw}`;
      }),
    });

    const verifyReceiptClaim = (claim: StealthPaymentReceiptClaim): EvmCoin => {
      assertFinancialActive();
      if (
        claim.chainIdentifier !== chainIdentifier ||
        claim.amountAtomic <= 0n ||
        claim.rawTransactions.length < 1 ||
        claim.rawTransactions.length > 16 ||
        claim.amountAtomic >= 1n << 256n ||
        !/^[0-9a-fA-F]{64}$/.test(claim.payloadDigest)
      ) {
        throw new Error("Invalid financial receipt claim");
      }
      const derived = deriveEvmStealthPrivateKey({
        recipientSpendSecret: identity.toPrivateKeyHex(),
        ephemeralPubKey: claim.ephemeralPublicKey,
      });
      if (claim.recipientDestination.length !== 20) {
        throw new Error("EVM receipt destination must be 20 bytes");
      }
      const address = getAddress(
        hexlify(claim.recipientDestination)
      ).toLowerCase();
      if (derived.stealthAddress.toLowerCase() !== address) {
        throw new Error("Receipt account is not owned by this wallet");
      }
      const hashes = new Set<string>(),
        sourceNonces = new Set<string>();
      let intended = 0n;
      for (const raw of claim.rawTransactions) {
        const tx = Transaction.from(raw);
        if (
          !tx.isSigned() ||
          tx.chainId !== nativeChainId ||
          hashes.has(tx.hash!)
        ) {
          throw new Error(
            "Receipt transaction chain/signature/duplicate mismatch"
          );
        }
        const sourceNonce = `${tx.from!.toLowerCase()}:${tx.nonce}`;
        if (sourceNonces.has(sourceNonce)) {
          throw new Error("Duplicate receipt source nonce");
        }
        sourceNonces.add(sourceNonce);
        hashes.add(tx.hash!);
        if (claim.asset.kind === "native") {
          if (
            tx.to?.toLowerCase() !== address ||
            tx.value <= 0n ||
            tx.data !== "0x"
          ) {
            throw new Error("Native receipt differs from exact claim");
          }
          intended += tx.value;
        } else {
          const contract = configuredEvmStealthToken(
            chainIdentifier,
            claim.asset.contractAddress
          );
          const decoded = financialAbi.decodeFunctionData("transfer", tx.data);
          const value = BigInt(decoded[1]);
          if (
            tx.to?.toLowerCase() !== contract ||
            tx.value !== 0n ||
            value <= 0n ||
            getAddress(decoded[0]).toLowerCase() !== address ||
            financialAbi
              .encodeFunctionData("transfer", [address, value])
              .toLowerCase() !== tx.data.toLowerCase()
          ) {
            throw new Error("ERC20 receipt differs from exact claim");
          }
          intended += value;
        }
      }
      if (intended !== claim.amountAtomic) {
        throw new Error("Receipt transaction set differs from intended amount");
      }
      return {
        address,
        privateKey: derived.stealthPrivateKey,
        origin: "stealth",
        state: "pending",
        amountWei: "0",
        claimedAmountWei:
          claim.asset.kind === "native" ? claim.amountAtomic.toString() : "0",
        transactions:
          claim.asset.kind === "native"
            ? claim.rawTransactions.map((raw) => raw.slice(2).toLowerCase())
            : [],
        ephemeralPubKey: hexlify(claim.ephemeralPublicKey).slice(2),
        payloadDigest: claim.payloadDigest.toLowerCase(),
        discoveredAtMs: Date.now(),
      };
    };

    const recordFinancialReceipt = async (
      input: StealthPaymentReceiptClaim
    ): Promise<void> => {
      const claim = snapshotReceiptClaim(input);
      const coin = verifyReceiptClaim(claim);
      await recordStoredEvmCoin(coinStore, coin);
      assertFinancialActive();
      if (claim.asset.kind === "native") {
        await registerStoredEvmNativePaymentSet(coinStore, coin.address, {
          chainIdentifier,
          ephemeralPubKey: coin.ephemeralPubKey!,
          rawTransactions: claim.rawTransactions,
          amountWei: claim.amountAtomic,
          payloadDigest: claim.payloadDigest,
        });
      } else {
        for (const raw of claim.rawTransactions) {
          await registerStoredEvmErc20Payment(coinStore, coin.address, {
            chainIdentifier,
            contractAddress: claim.asset.contractAddress,
            rawTransaction: raw,
            amountBaseUnits: BigInt(
              financialAbi.decodeFunctionData(
                "transfer",
                Transaction.from(raw).data
              )[1]
            ),
            payloadDigest: claim.payloadDigest,
            discoveredAtMs: coin.discoveredAtMs,
          });
        }
      }
      coinsReadAtMs = 0;
    };

    const requireRecordedReceipt = (
      claim: StealthPaymentReceiptClaim
    ): void => {
      const account = verifyReceiptClaim(claim);
      const known = coinStore.get(account.address);
      if (
        !known ||
        known.privateKey !== account.privateKey ||
        known.ephemeralPubKey !== account.ephemeralPubKey ||
        known.origin !== "stealth"
      ) {
        throw new Error("Receipt account derivation was not durably recorded");
      }
      const persisted =
        claim.asset.kind === "native"
          ? JSON.stringify(known.transactions) ===
              JSON.stringify(
                claim.rawTransactions.map((raw) => raw.slice(2))
              ) &&
            known.payloadDigest === claim.payloadDigest.toLowerCase() &&
            known.claimedAmountWei === claim.amountAtomic.toString()
          : claim.rawTransactions.every((raw) =>
              known.erc20Positions
                ?.find(
                  (position) =>
                    position.contractAddress ===
                    configuredEvmStealthToken(
                      chainIdentifier,
                      claim.asset.kind === "erc20"
                        ? claim.asset.contractAddress
                        : ""
                    )
                )
                ?.claims.some(
                  (entry) =>
                    entry.txHash === Transaction.from(raw).hash &&
                    entry.rawTransaction === raw &&
                    entry.amountBaseUnits ===
                      BigInt(
                        financialAbi.decodeFunctionData(
                          "transfer",
                          Transaction.from(raw).data
                        )[1]
                      ).toString() &&
                    entry.payloadDigests.includes(
                      claim.payloadDigest.toLowerCase()
                    )
                )
            );
      if (!persisted) {
        throw new Error(
          "Receipt claim must be durably recorded before submission"
        );
      }
    };

    Object.assign(wallet, {
      stealthPayments: financialPayments,
      stealthReceipts: {
        record: recordFinancialReceipt,
        async submit(input: StealthPaymentReceiptClaim) {
          const claim = snapshotReceiptClaim(input);
          requireRecordedReceipt(claim);
          let failure: unknown;
          for (const raw of claim.rawTransactions) {
            try {
              assertFinancialActive();
              const sent = await provider.broadcastTransaction(raw);
              assertFinancialActive();
              if (sent.hash.toLowerCase() !== Transaction.from(raw).hash) {
                throw new Error("Unexpected received transaction hash");
              }
            } catch (error) {
              failure ??= error;
            }
          }
          if (failure !== undefined) throw failure;
        },
        async observe(input: StealthPaymentReceiptClaim) {
          const claim = snapshotReceiptClaim(input);
          requireRecordedReceipt(claim);
          const address = getAddress(
            hexlify(claim.recipientDestination)
          ).toLowerCase();
          const balance = await provider.getBalance(address);
          assertFinancialActive();
          const reserved =
            sourceIsHeld(wallet, address) || owner.holdsSource(address);
          if (claim.asset.kind === "native") {
            if (claim.rawTransactions.length > 1) {
              const result = await refreshNativeSetCoin(
                coinStore.get(address)!
              );
              return {
                status:
                  result.complete &&
                  result.verifiedReceivedAmountWei === claim.amountAtomic
                    ? "succeeded"
                    : result.verifiedReceivedAmountWei > 0n
                    ? "partial"
                    : result.allFailed
                    ? "failed"
                    : "pending",
                intendedAmountAtomic: claim.amountAtomic,
                verifiedReceivedAmountAtomic: result.verifiedReceivedAmountWei,
                spendability:
                  BigInt(result.coin.amountWei) === 0n
                    ? "empty"
                    : reserved
                    ? "reserved"
                    : result.verifiedReceivedAmountWei === 0n
                    ? "pending"
                    : "spendable",
              };
            }

            const received = await verifiedFinancialReceipt(
              claim.rawTransactions[0]!,
              address
            );
            assertFinancialActive();
            await applyStoredNativeCoinObservation(coinStore, address, {
              balanceWei: balance,
              transfer:
                received === undefined
                  ? "unseen"
                  : received === 0n
                  ? "failed"
                  : "included",
              ...(received === undefined ? {} : { transferValueWei: received }),
              atMs: Date.now(),
            });
            return {
              status:
                received === undefined
                  ? "pending"
                  : received === 0n
                  ? "failed"
                  : received === claim.amountAtomic
                  ? "succeeded"
                  : "partial",
              intendedAmountAtomic: claim.amountAtomic,
              ...(received === undefined
                ? {}
                : { verifiedReceivedAmountAtomic: received }),
              spendability:
                balance === 0n
                  ? "empty"
                  : reserved
                  ? "reserved"
                  : received === undefined
                  ? "pending"
                  : "spendable",
            };
          }
          const refreshed = await refreshStoredEvmErc20Position(
            coinStore,
            address,
            {
              chainIdentifier,
              contractAddress: claim.asset.contractAddress,
              reader: erc20Reader,
              atMs: Date.now(),
            }
          );
          assertFinancialActive();
          if (!refreshed.applied) {
            throw new Error("ERC20 observation changed; retry current receipt");
          }
          const contractAddress = claim.asset.contractAddress.toLowerCase();
          const positionBalance = BigInt(
            refreshed.coin.erc20Positions!.find(
              (position) => position.contractAddress === contractAddress
            )!.balanceBaseUnits
          );
          const fees = await provider.getFeeData();
          const gas =
            balance === 0n || positionBalance === 0n
              ? 0n
              : await provider.estimateGas({
                  from: address,
                  to: claim.asset.contractAddress,
                  value: 0n,
                  data: financialAbi.encodeFunctionData("transfer", [
                    material.mainAccount.address,
                    positionBalance < claim.amountAtomic
                      ? positionBalance
                      : claim.amountAtomic,
                  ]),
                });
          assertFinancialActive();
          const price = fees.maxFeePerGas ?? fees.gasPrice;
          if (price === null) {
            throw new Error("Native fee observation unavailable");
          }
          const allPayments = receivedErc20Payments(refreshed.coin, {
            nativeBalanceWei: balance,
            requiredNativeFeeWei: (gas * price * 115n) / 100n,
            reserved,
          });
          const payments = claim.rawTransactions.map((raw) =>
            allPayments.find(
              (item) =>
                item.txHash === Transaction.from(raw).hash &&
                item.contractAddress === contractAddress
            )
          );
          if (payments.some((payment) => payment === undefined)) {
            throw new Error("ERC20 receipt claim unavailable");
          }
          const received = payments.reduce(
            (sum, payment) => sum + payment!.receivedAmountBaseUnits,
            0n
          );
          const allKnown = payments.every(
            (payment) =>
              payment!.status === "received" ||
              payment!.status === "partial" ||
              payment!.status === "failed"
          );
          return {
            status:
              allKnown && received === claim.amountAtomic
                ? "succeeded"
                : received > 0n ||
                  (allKnown &&
                    !payments.every((payment) => payment!.status === "failed"))
                ? "partial"
                : payments.every((payment) => payment!.status === "failed")
                ? "failed"
                : "pending",
            intendedAmountAtomic: claim.amountAtomic,
            verifiedReceivedAmountAtomic: received,
            spendability:
              positionBalance === 0n
                ? "empty"
                : reserved
                ? "reserved"
                : payments.some(
                    (payment) => payment!.spendability === "needs-native-gas"
                  )
                ? "needs-native-gas"
                : payments.some(
                    (payment) => payment!.spendability === "spendable"
                  )
                ? "spendable"
                : "pending",
          };
        },
      } satisfies StealthPaymentReceiptCapability,
    });

    const walletInternals = evmWalletInternals(wallet);
    walletInternals.heldTransferSources = () => {
      const held = financialPayments.heldSources();
      for (const payment of paymentStore.all()) {
        if (!holdsItsSource(payment)) continue;
        const source = transferMember(payment)?.source.address;
        if (source !== undefined) held.add(source);
      }
      return held;
    };

    walletInternals.receivedCoinOwner = {
      recordStampCoin,
      async recordStampPayments(message) {
        const roles = material.canonicalRoles;
        if (
          roles === undefined ||
          message.stampSharedPoint === undefined ||
          message.recipientAddress.raw.toLowerCase() !== identityKey
        ) {
          return;
        }
        for (const payment of message.stampPayments) {
          if (payment.childIndex === undefined) continue;
          const address = payment.destinationAddress.toLowerCase();
          if (coinStore.get(address) !== undefined) continue;
          const privateKey = roles.stampChildPrivateKey({
            network: forumNetwork,
            sharedPoint: getBytes(`0x${message.stampSharedPoint}`),
            childIndex: payment.childIndex,
            address,
          });
          if (privateKey === undefined) continue;
          await recordStampCoin({
            address,
            privateKey,
            childIndex: payment.childIndex,
            stampSharedPoint: message.stampSharedPoint,
            payloadDigest: message.payloadDigest,
            valueWei: payment.valueWei,
            transaction: payment.rawTx ?? payment.txHash,
            timestampMs: message.receivedTime ?? Date.now(),
          });
        }
      },
      noteCoins,
      checkPendingCoins: () =>
        readCoinsPass({ pendingOnly: true }).catch(() => undefined),
      async recordStealthItem(item, origin) {
        if ((item.networkTag ?? item.chainId) !== networkTag) return;
        const coin = stealthCoinFromItem({
          item,
          recipientSpendSecret: identity.toPrivateKeyHex(),
          payloadDigest: origin.payloadDigest,
          discoveredAtMs: origin.timestampMs,
        });
        if (coin !== undefined) await recordCoin(coin);
      },
      resumeContactPayments,
      retryContactPayment,
      mailboxScan: () =>
        scanState.get("scan") ?? { complete: false, sinceMs: 0 },
      recordMailboxScan: (progress) => scanState.put("scan", progress),
      beginContactSend: (ephemeralPubKeys) =>
        exposureExclusive(async () => {
          for (const payment of paymentStore.all()) {
            if (
              payment.state === "released" &&
              ephemeralPubKeys.includes(payment.ephemeralPubKey)
            ) {
              throw new ContactPaymentReleasedError();
            }
          }
          for (const key of ephemeralPubKeys) {
            inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
          }
          let ended = false;
          return () => {
            if (ended) return;
            ended = true;
            for (const key of ephemeralPubKeys) {
              const left = (inFlight.get(key) ?? 1) - 1;
              if (left > 0) inFlight.set(key, left);
              else inFlight.delete(key);
            }
          };
        }),
      contactMessageAttempted: (ephemeralPubKeys, payloadDigest) =>
        exposureExclusive(async () => {
          for (const payment of paymentStore.all()) {
            if (!ephemeralPubKeys.includes(payment.ephemeralPubKey)) continue;
            if (payment.state === "released") {
              throw new ContactPaymentReleasedError();
            }
            if (
              payment.state === "prepared" &&
              payment.payloadDigest !== payloadDigest
            ) {
              await paymentStore.put(payment.stealthAddress, {
                ...payment,
                payloadDigest,
              });
            }
          }
        }),
      async releaseUnsentContactPayments(ephemeralPubKeys) {
        let released = false;
        for (const payment of paymentStore.all()) {
          if (ephemeralPubKeys.includes(payment.ephemeralPubKey)) {
            released =
              (await releaseContactPayment(payment.stealthAddress)) || released;
          }
        }
        return released;
      },
      contactMessageDelivered: (payloadDigest) =>
        contactExclusive(async () => {
          for (const payment of paymentStore.all()) {
            if (
              walletInternals.closed ||
              payment.deliveredBy !== "host" ||
              (payment.state !== "prepared" && payment.state !== "failed") ||
              payment.payloadDigest !== payloadDigest
            ) {
              continue;
            }
            const delivered: ContactPayment = {
              ...payment,
              state: "delivered",
            };
            await paymentStore.put(payment.stealthAddress, delivered);
            await broadcastContactTransfer(delivered);
          }
        }).catch(() => undefined),
    };
  };

  return {
    readCoins,
    readCoinsPass,
    invalidateCoinsRead,
    heldForItsMessage,
    holdsItsSource,
    installStealthAndContactOwners,
    getReceivedPayments: () =>
      coinStore.all().map((coin) => receivedPaymentOf(coin)),
    refreshReceivedPayments: async () => {
      requireOpenWallet(getWallet());
      await readCoins();
      return coinStore.all().map((coin) => receivedPaymentOf(coin));
    },
    getMessagePayment: (payloadDigest: string) =>
      messagePaymentOf(coinStore.all(), payloadDigest),
    checkMessagePayment: async (payloadDigest: string) => {
      requireOpenWallet(getWallet());
      const digest = payloadDigest.replace(/^0x/, "").toLowerCase();
      const pending = coinStore
        .all()
        .filter(
          (coin) =>
            coin.payloadDigest === digest &&
            (coin.state === "pending" ||
              (coin.origin === "stealth" && coin.transactions.length > 1))
        );
      if (pending.length > 0) {
        await readCoinsPass({
          only: new Set(pending.map((coin) => coin.address)),
        });
      }
      return messagePaymentOf(coinStore.all(), digest);
    },
    sweepReceivedCoins,
    recordReceivedCoin,
    noteCoins,
    getContactPayments: () =>
      paymentStore.all().map((payment) => ({
        messageId: payment.messageId,
        ephemeralPubKey: payment.ephemeralPubKey,
        recipientAddress: payment.recipientAddress,
        valueWei: BigInt(payment.valueWei),
        state: payment.state,
        holdsFunds: holdsItsSource(payment),
        ...(payment.txHash ? { txHash: payment.txHash } : {}),
        ...(payment.failure ? { failure: payment.failure } : {}),
      })),
    sendToContact: (sendParams: ContactSendParams) =>
      payContact(sendParams, false) as Promise<ContactSendResult>,
    prepareContactPayment: (sendParams: ContactSendParams) =>
      payContact(sendParams, true) as Promise<PreparedContactPayment>,
    resumeContactPayments,
    settleContactPayment,
    retryContactPayment,
  };
}
