import { CANONICAL_DM_MAX_TRANSACTIONS } from "@frank/cashweb/relay/canonical-dm-transport";
import { type Provider, type Wallet } from "ethers";
import {
  DirectMessageStampBelowFeeError,
} from "./chain/active-chain";
import { EvmBlockWatcher } from "./evm-block-watcher";
import { EvmStampPayer, waitForSpendSpacing } from "./evm-stamp-payer";
import type { EvmCoinList } from "./evm-coin-list";
import { EvmCoinListSync, type CoinListSource } from "./evm-coin-list-sync";
import {
  evmWalletInternals,
} from "./evm-wallet";
import type { EvmChainWalletHandle } from "./evm-wallet-handle";
import { BurnNotSentError } from "./evm-account-lease";
import {
  type EvmSubAccountPool as MonadSubAccountPool,
} from "./evm-account-pool";
import { MonadAccountTxSigner } from "./evm-account-tx";
import type { MonadHttpClient } from "./evm-http";
import type { MonadIdentity } from "./evm-identity";
import { MonadCanonicalStampClient } from "./evm-stamp-client";
import type { MonadWalletMaterial } from "./evm-wallet-material";
import { type EvmCoin, type RecordStore } from "./storage/evm-coin-store";
import type {
  EvmWalletOperationAdmission,
  EvmWalletPersistenceBundle,
} from "./storage/evm-wallet-bundle";

/**
 * How an operation waits for the main or identity account while an earlier payment from it has
 * not been seen on chain. By default it waits its turn, however long that is.
 */
export interface MainAccountWait {
  /** Give up after this long with {@link MainAccountBusyError}. Default: no limit. */
  waitMs?: number;
  /** Called once when the operation starts to wait. */
  onWaiting?: () => void;
  /**
   * For a spender the native journal does not record (a funding pass, a transfer to a
   * contact): also wait while a transaction the native holder itself signed from the account
   * is undecided. Journal operations leave this off: the journal's own rule refuses a second
   * transaction over an undecided one at once, and a resume is the one driving it.
   */
  waitForOwn?: boolean;
  /** Specific account addresses to claim/wait on instead of both main and identity. */
  addresses?: readonly string[];
}

/**
 * The caller's own deadline passed while the main account was still spent by an earlier payment
 * the chain has not shown. Nothing was signed; the same call can be made again.
 */
export class MainAccountBusyError extends Error {
  constructor() {
    super(
      "The main account is still spent by an earlier payment the chain has not shown, and the wait given for it ran out. Nothing was signed."
    );
    this.name = "MainAccountBusyError";
  }
}

export class TopicBurnPreparationError extends Error {
  constructor(
    reason: string,
    options?: { cause?: unknown; stage?: "preparing" | "signing" }
  ) {
    super(
      options?.stage === "signing"
        ? `Could not build the burn (${reason}). Nothing was sent, and the funded account is kept. ` +
            "It is safe to try again."
        : `Could not prepare an account to burn from (${reason}). Nothing was sent. ` +
            "It is safe to try again: a funding transaction that was already sent is reused, not repeated."
    );
    this.name = "TopicBurnPreparationError";
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/**
 * A burn that failed while being built/signed (RPC hiccup after the account was funded) sent
 * nothing and left the funded account available: report it with the same "nothing sent, safe to
 * retry" message as a failed preparation. Every other error passes through untouched.
 */
export function asNothingSent(err: unknown): never {
  if (err instanceof BurnNotSentError) {
    throw new TopicBurnPreparationError(err.message, {
      cause: err,
      stage: "signing",
    });
  }
  throw err;
}

export interface InstallEvmStampCoordinatorParams {
  readonly wallet: EvmChainWalletHandle;
  readonly topicOwner: EvmWalletPersistenceBundle;
  readonly canonicalRoles: NonNullable<MonadWalletMaterial["canonicalRoles"]>;
  readonly installedNetworkTag: "MONT" | "MON1" | "MONR";
  readonly networkId: string;
  readonly mainAccount: Wallet;
  readonly identity: MonadIdentity;
  readonly pool: MonadSubAccountPool;
  readonly provider: Provider;
  readonly httpClient: MonadHttpClient;
  readonly coinStore: RecordStore<EvmCoin>;
  /** The wallet's coin list for this chain (`EvmCoinList`), open. */
  readonly coinList: EvmCoinList;
  readonly readCoins: () => Promise<void>;
  readonly invalidateCoinsRead: () => void;
  readonly spendSpacingBlocks?: number;
  readonly paymentPollIntervalMs?: number;
  readonly reserveBalanceWei?: bigint;
  readonly sourceIsHeld: (wallet: object, address: string) => boolean;
  readonly sourceHeldRefusalMessage: string;
  readonly requireOpenWallet: (wallet: EvmChainWalletHandle) => void;
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
 * Installs canonical stamp client creation, stamp quoting, and funding-attempt recovery onto `wallet`'s internals, and returns the created `EvmStampPayer`.
 */
export function installEvmStampCoordinator(
  params: InstallEvmStampCoordinatorParams
): EvmStampPayer {
  const {
    wallet,
    topicOwner,
    canonicalRoles,
    installedNetworkTag,
    networkId,
    mainAccount,
    identity,
    pool,
    provider,
    httpClient,
    coinStore,
    coinList,
    readCoins,
    invalidateCoinsRead,
    spendSpacingBlocks,
    paymentPollIntervalMs,
    reserveBalanceWei,
    sourceIsHeld,
    sourceHeldRefusalMessage,
    requireOpenWallet,
    runWalletExclusive,
    runMainAccountExclusive,
  } = params;
  const walletInternals = evmWalletInternals(wallet);

  walletInternals.canonicalClientFactory = () => {
    requireOpenWallet(wallet);
    return new MonadCanonicalStampClient({
      ...wallet,
      walletState: topicOwner,
      canonicalRoles,
      installedNetworkTag,
      runCanonicalExclusive: (task) =>
        runWalletExclusive(
          wallet,
          (admission) => {
            if (admission === undefined) {
              throw new Error("Canonical operation lifetime is unavailable");
            }
            return task(admission);
          },
          true
        ),
    });
  };

  pool.attachFunderSpacing((address, spendValueWei) =>
    waitForSpendSpacing(provider, address, spendSpacingBlocks, {
      reserveBalanceWei,
      spendValueWei,
    })
  );
  const blockWatcher = new EvmBlockWatcher({
    provider,
    ...(paymentPollIntervalMs === undefined
      ? {}
      : { intervalMs: paymentPollIntervalMs }),
  });
  walletInternals.blockWatcher = blockWatcher;

  // The wallet's coin list: every account it may pay a stamp from, with its key, at its nonce.
  // Learned from the chain off the send path; a send reads none of it from the chain.
  const listedPoolStatuses = new Set(["available", "spent", "retired"]);
  const coinListSync = new EvmCoinListSync({
    list: coinList,
    provider,
    watcher: blockWatcher,
    ...(spendSpacingBlocks === undefined ? {} : { spendSpacingBlocks }),
    sources: () => {
      const sources: CoinListSource[] = [
        {
          account: mainAccount.address.toLowerCase(),
          origin: "root",
          privateKey: () => mainAccount.privateKey,
        },
      ];
      if (
        identity.address.raw.toLowerCase() !==
        mainAccount.address.toLowerCase()
      )
        sources.push({
          account: identity.address.raw.toLowerCase(),
          origin: "identity",
          privateKey: () => identity.toPrivateKeyHex(),
        });
      for (const record of pool.records()) {
        const account = record.address.toLowerCase();
        // A funded row, or a spent one whose later coin only the list holds.
        if (
          record.status === "available" ||
          (listedPoolStatuses.has(record.status) &&
            coinList.latestOf(account) !== undefined)
        )
          sources.push({
            account,
            origin: "deterministic",
            privateKey: () => pool.privateKeyOf(record.index),
          });
      }
      for (const coin of coinStore.all()) {
        const account = coin.address.toLowerCase();
        if (
          coin.state === "unspent" ||
          (coin.state === "spent" && coinList.latestOf(account) !== undefined)
        )
          sources.push({
            account,
            origin: "stealth",
            privateKey: () => coin.privateKey,
          });
      }
      return sources;
    },
  });
  walletInternals.coinList = coinList;
  walletInternals.coinListSync = coinListSync;
  // What other spenders do to these accounts makes the list's coin of them stale: it is read
  // again before it is chosen (by the next payment the list does not cover, or a quote). No
  // request is made here: a wallet nobody uses reads nothing.
  pool.onChange((change) => {
    if (change.kind === "record") {
      coinListSync.markDirty(change.record.address);
      return;
    }
    const ownedByHolder = coinList
      .all()
      .some(
        (coin) =>
          coin.account === change.address && coin.holder === change.holder
      );
    if (!ownedByHolder) coinListSync.markDirty(change.address);
  });

  const stampPayer = new EvmStampPayer({
    pool,
    coins: coinList,
    sync: coinListSync,
    provider,
    httpClient,
    watcher: blockWatcher,
    spendSpacingBlocks,
    reserveBalanceWei,
    accountHeld: (address) => sourceIsHeld(wallet, address),
    canSelectAccount: (address, nonce) => {
      const selectable =
        topicOwner.nativeJournal!.canSelect(address, nonce) &&
        walletInternals.nativeOperationOwner?.holdsSource(address) !== true;
      const received = coinStore.get(address.toLowerCase());
      return selectable && received?.state !== "failed";
    },
    heldRefusal: () => new Error(sourceHeldRefusalMessage),
  });
  walletInternals.canonicalStampQuoter = (input) =>
    topicOwner.runLifetime(async () => {
      if (input.stampValueWei > 0n) {
        const minimum = await stampPayer.minimumPaymentWei();
        if (input.stampValueWei < minimum) {
          throw new DirectMessageStampBelowFeeError(
            input.stampValueWei,
            minimum
          );
        }
      }
      const quote = await stampPayer.quote({
        ...input,
        maxPayments: CANONICAL_DM_MAX_TRANSACTIONS,
      });
      topicOwner.assertOpen();
      const common = {
        chainIdentifier: networkId,
        stampValueAtomic: quote.stampValueWei,
        spendableCapacityAtomic: quote.capacityWei,
      };
      return quote.status === "available"
        ? {
            ...common,
            status: "available",
            maximumNativeFeeAtomic: quote.maximumFeeWei,
          }
        : { ...common, status: "insufficient" };
    });

  // Recovery only: finish transactions authorized before proactive funding was removed.
  // This path cannot derive a destination, prepare a new operation, or sign new bytes.
  let recovery: Promise<void> | undefined;
  walletInternals.recoverStampFunding = () => recovery ??= topicOwner.runLifetime(async () => {
    if (pool.records().some(record => record.status === "funding")) {
      await pool.recoverLegacyFundingAttempts({
        mainAccountSigner: new MonadAccountTxSigner({
          privateKey: mainAccount.privateKey, provider, httpClient,
        }),
      });
    }
    const prefix = "evm-transaction-set:stamp-fund-ahead-";
    for (const row of topicOwner.nativeJournal!.list()) {
      if (row.cancelled || row.kind !== "transaction-set" || !row.preparationId?.startsWith(prefix)) continue;
      const id = row.preparationId.slice("evm-transaction-set:".length);
      await wallet.transactionSetLifecycle!.observe(id, provider);
      await wallet.transactionSetLifecycle!.replay(id, { payments: true });
    }
  }).finally(() => { recovery = undefined; });

  return stampPayer;
}
