import { CANONICAL_DM_MAX_TRANSACTIONS } from "@frank/cashweb/relay/canonical-dm-transport";
import { type Provider, type Wallet } from "ethers";
import {
  DirectMessageStampBelowFeeError,
} from "./chain/active-chain";
import type { EvmBlockWatcher } from "./evm-block-watcher";
import { EvmStampPayer, waitForSpendSpacing } from "./evm-stamp-payer";
import type { EvmCoinList } from "./evm-coin-list";
import type { EvmCoinListSync } from "./evm-coin-list-sync";
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
import { MonadCanonicalStampClient } from "./evm-stamp-client";
import type { MonadWalletMaterial } from "./evm-wallet-material";
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
  readonly pool: MonadSubAccountPool;
  readonly provider: Provider;
  readonly httpClient: MonadHttpClient;
  /** The wallet's coin list for this chain (`EvmCoinList`), open. */
  readonly coinList: EvmCoinList;
  readonly coinListSync: EvmCoinListSync;
  readonly blockWatcher: EvmBlockWatcher;
  readonly spendSpacingBlocks?: number;
  readonly reserveBalanceWei?: bigint;
  readonly sourceIsHeld: (wallet: object, address: string) => boolean;
  readonly sourceHeldRefusalMessage: string;
  readonly requireOpenWallet: (wallet: EvmChainWalletHandle) => void;
  readonly runWalletExclusive: <T>(
    wallet: EvmChainWalletHandle,
    task: (admission?: EvmWalletOperationAdmission) => Promise<T>,
    canonical?: boolean
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
    pool,
    provider,
    httpClient,
    coinList,
    coinListSync,
    blockWatcher,
    spendSpacingBlocks,
    reserveBalanceWei,
    sourceIsHeld,
    sourceHeldRefusalMessage,
    requireOpenWallet,
    runWalletExclusive,
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
  // Quotes and construction share one chain-observation owner, including legacy keys.
  walletInternals.blockWatcher = blockWatcher;
  walletInternals.coinList = coinList;
  walletInternals.coinListSync = coinListSync;

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
      return selectable;
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
