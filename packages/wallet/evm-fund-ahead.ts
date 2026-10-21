import { CANONICAL_DM_MAX_TRANSACTIONS } from "@frank/cashweb/relay/canonical-dm-transport";
import { hexlify, randomBytes, type Provider, type Wallet } from "ethers";
import {
  DirectMessageStampBelowFeeError,
  type DirectMessageFundAheadResult,
  type DirectMessagePreparationProgress,
  type NativeWalletHandle,
} from "./chain/active-chain";
import { EvmBlockWatcher } from "./evm-block-watcher";
import { EvmStampPayer, waitForSpendSpacing } from "./evm-stamp-payer";
import type { EvmCoinList } from "./evm-coin-list";
import { EvmCoinListSync, type CoinListSource } from "./evm-coin-list-sync";
import {
  evmWalletInternals,
  type CanonicalInventoryFunder,
} from "./evm-wallet";
import type { EvmChainWalletHandle, EvmWalletHandle } from "./evm-wallet-handle";
import { BurnNotSentError } from "./evm-account-lease";
import {
  FundAheadRefusedError,
  STAMP_PAIR_TRANSFERS,
  type EvmSubAccountPool as MonadSubAccountPool,
} from "./evm-account-pool";
import { MonadAccountTxSigner } from "./evm-account-tx";
import type { MonadHttpClient } from "./evm-http";
import type { MonadIdentity } from "./evm-identity";
import { MonadCanonicalStampClient } from "./evm-stamp-client";
import { quoteMonadTopicBurnGasReserve } from "./evm-topic-post-client";
import type { MonadWalletMaterial } from "./evm-wallet-material";
import { spendableCoins, type EvmCoin, type RecordStore } from "./storage/evm-coin-store";
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
 * A funding pass signs from the main account outside the native journal: it waits for whatever
 * the wallet signed from that account earlier, a native operation's transaction included.
 */
export const FUNDING_FROM_MAIN: MainAccountWait = { waitForOwn: true };

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

export const FUND_AHEAD_BACKOFF_MIN_MS = 4_000;
export const FUND_AHEAD_BACKOFF_MAX_MS = 240_000;

/** The main account was just read: more money than the last pass saw ends its wait. */
export function noteMainBalanceForFundAhead(
  wallet: object,
  balanceWei: bigint
): void {
  const internals = evmWalletInternals(wallet);
  const waiting = internals.fundAheadBackoff;
  if (
    waiting?.mainBalanceWei !== undefined &&
    balanceWei > waiting.mainBalanceWei
  ) {
    internals.fundAheadBackoff = undefined;
  }
}

/**
 * Funds receipt-confirmed single-use sender accounts for one canonical stamp of `stampValueWei`,
 * from the wallet's own EVM main account, through the same pool machinery and owner admission as
 * every other inventory preparation. The accounts are left free for whichever message claims
 * them. Returns the funding transaction hashes (empty when inventory already sufficed).
 */
export function prepareCanonicalStampInventory(
  wallet: NativeWalletHandle,
  input: Parameters<CanonicalInventoryFunder>[0]
): Promise<string[]> {
  const internals = evmWalletInternals(wallet);
  const fund = internals.canonicalInventoryFunder;
  if (!fund || internals.closed) {
    throw new Error(
      "Canonical inventory requires live typed persistent custody"
    );
  }
  return fund(input);
}

/**
 * Preparing the account that will burn a topic post/vote failed before anything was posted. The
 * pool's funding is record-before-broadcast, so retrying resumes an already-sent funding
 * transaction instead of sending another; the message says so because the caller shows it as is.
 */
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

export interface PrepareEvmTopicBurnAccountParams {
  readonly wallet: EvmChainWalletHandle;
  readonly voteWeightWei: bigint;
  readonly onProgress?: (progress: DirectMessagePreparationProgress) => void;
  readonly mainPrivateKey: (wallet: EvmChainWalletHandle) => string;
  readonly creatorBurnAddress: (wallet: EvmWalletHandle) => string;
  readonly sourceIsHeld: (wallet: object, address: string) => boolean;
  readonly sourceHeldRefusalMessage: string;
  /** The holder `runMainAccountExclusive` claims funding accounts under. Its own claim does
   * not make an account ineligible: the exclusive run waits for its own earlier transfer. */
  readonly mainAccountHolder: (wallet: EvmChainWalletHandle) => string;
  readonly runMainAccountExclusive: <T>(
    wallet: EvmChainWalletHandle,
    task: () => Promise<T>,
    options?: MainAccountWait
  ) => Promise<T>;
}

/**
 * Funds (or reuses) one sub-account able to burn `voteWeightWei` in a single transaction and
 * returns its pool index for the caller to lease. Admission conservatively holds reuse too:
 * even its fee quote signs with the main account. See `MonadSubAccountPool.prepareBurnAccount`.
 */
export async function prepareEvmTopicBurnAccount(
  params: PrepareEvmTopicBurnAccountParams
): Promise<{ leaseIndex: number; leaseHolder: string }> {
  const {
    wallet,
    voteWeightWei,
    onProgress,
    mainPrivateKey,
    creatorBurnAddress,
    sourceIsHeld,
    sourceHeldRefusalMessage,
    mainAccountHolder,
    runMainAccountExclusive,
  } = params;
  const leaseHolder = `${wallet.identity.address.raw.toLowerCase()}:topic:${hexlify(
    randomBytes(8)
  )}`;
  const mainPrivateKeyHex = mainPrivateKey(wallet);
  const mainAccountSigner = new MonadAccountTxSigner({
    privateKey: mainPrivateKeyHex,
    provider: wallet.provider,
    httpClient: wallet.httpClient,
  });
  const internals = evmWalletInternals(wallet);
  const mainAddress =
    internals.material?.mainAccount.address ?? wallet.identity.address.raw;

  try {
    onProgress?.({ stage: "checking" });

    const burnAddress = creatorBurnAddress(
      internals.privateTopicWallet ?? wallet
    );
    const gasReserveWei = await quoteMonadTopicBurnGasReserve({
      signer: mainAccountSigner,
      burnAddress,
    });

    const feeData =
      typeof wallet.provider?.getFeeData === "function"
        ? await wallet.provider.getFeeData().catch(() => undefined)
        : undefined;
    const gasPrice = feeData?.maxFeePerGas ?? feeData?.gasPrice ?? 0n;
    const fundingGasLimit =
      typeof wallet.provider?.estimateGas === "function"
        ? await wallet.provider
            .estimateGas({ from: mainAddress, to: mainAddress, value: 1n })
            .catch(() => 21000n)
        : 21000n;
    const fundingGasFee = fundingGasLimit * gasPrice;
    const requiredTotalWei = voteWeightWei + gasReserveWei + fundingGasFee;
    const neededTargetBalance = voteWeightWei + gasReserveWei;

    const getBal = async (addr: string) =>
      typeof wallet.provider?.getBalance === "function"
        ? await wallet.provider.getBalance(addr, "pending").catch(() => 0n)
        : 0n;

    const candidateGetter = internals.fundingCandidates;
    const candidates = candidateGetter
      ? candidateGetter()
      : [
          {
            source: "main" as const,
            address: mainAddress,
            privateKey: () => mainPrivateKeyHex,
          },
        ];

    const isEligible = (address: string) => {
      if (sourceIsHeld(wallet, address)) return false;
      if (typeof wallet.pool?.accountClaimedBy !== "function") return true;
      const claimant = wallet.pool.accountClaimedBy(address);
      return claimant === undefined || claimant === mainAccountHolder(wallet);
    };

    // 1. Check mainAccount first (if not held and balance >= requiredTotalWei -> fast path)
    const mainCandidate = candidates.find((c) => c.source === "main");
    let mainBalance = 0n;
    if (mainCandidate && isEligible(mainCandidate.address)) {
      mainBalance = await getBal(mainCandidate.address);
    }

    if (
      mainCandidate &&
      isEligible(mainCandidate.address) &&
      mainBalance >= requiredTotalWei
    ) {
      const preparation = await runMainAccountExclusive(
        wallet,
        async () => {
          return wallet.pool.prepareBurnAccount({
            mainAccountSigner,
            mainAccountAddress: mainAddress,
            provider: wallet.provider,
            burnValueWei: voteWeightWei,
            gasReserveWei,
            onProgress,
            claimFor: leaseHolder,
          });
        },
        {
          ...FUNDING_FROM_MAIN,
          onWaiting: () => onProgress?.({ stage: "waiting-for-payment" }),
        }
      );
      return { leaseIndex: preparation.index, leaseHolder };
    }

    // 2. If mainAccount balance < requiredTotalWei, check remaining candidates (identity, then received coins)
    const otherCandidates = candidates.filter((c) => c.source !== "main");
    let singleChosen: (typeof candidates)[number] | undefined;
    const candidateBalances = new Map<string, bigint>();
    if (mainCandidate) {
      candidateBalances.set(mainCandidate.address.toLowerCase(), mainBalance);
    }

    for (const candidate of otherCandidates) {
      if (!isEligible(candidate.address)) continue;
      const bal = await getBal(candidate.address);
      candidateBalances.set(candidate.address.toLowerCase(), bal);
      if (bal >= requiredTotalWei) {
        singleChosen = candidate;
        break;
      }
    }

    if (singleChosen !== undefined) {
      const funderSigner = new MonadAccountTxSigner({
        privateKey: singleChosen.privateKey(),
        provider: wallet.provider,
        httpClient: wallet.httpClient,
      });
      // The funder is claimed like the main account is: no stamp payment or other spender
      // signs from it at the same nonce while the funding transfer is out.
      const preparation = await runMainAccountExclusive(
        wallet,
        () =>
          wallet.pool.prepareBurnAccount({
            mainAccountSigner: funderSigner,
            mainAccountAddress: mainAddress,
            provider: wallet.provider,
            burnValueWei: voteWeightWei,
            gasReserveWei,
            onProgress,
            claimFor: leaseHolder,
          }),
        {
          ...FUNDING_FROM_MAIN,
          addresses: [singleChosen.address],
          onWaiting: () => onProgress?.({ stage: "waiting-for-payment" }),
        }
      );
      if (singleChosen.source === "coin") {
        wallet.invalidateBalanceCache?.();
      }
      return { leaseIndex: preparation.index, leaseHolder };
    }

    // 3. Multi-transaction aggregation across candidates
    const contributableCandidates: Array<{
      candidate: (typeof candidates)[number];
      capacity: bigint;
    }> = [];

    for (const candidate of candidates) {
      if (!isEligible(candidate.address)) continue;
      let bal = candidateBalances.get(candidate.address.toLowerCase());
      if (bal === undefined) {
        bal = await getBal(candidate.address);
        candidateBalances.set(candidate.address.toLowerCase(), bal);
      }
      if (bal > fundingGasFee) {
        contributableCandidates.push({
          candidate,
          capacity: bal - fundingGasFee,
        });
      }
    }

    contributableCandidates.sort((a, b) =>
      a.capacity > b.capacity ? -1 : 1
    );

    let remaining = neededTargetBalance;
    const selectedFunders: Array<{
      candidate: (typeof candidates)[number];
      amountWei: bigint;
    }> = [];

    for (const item of contributableCandidates) {
      if (remaining === 0n) break;
      const contribution =
        item.capacity < remaining ? item.capacity : remaining;
      if (contribution <= 0n) continue;
      selectedFunders.push({
        candidate: item.candidate,
        amountWei: contribution,
      });
      remaining -= contribution;
    }

    if (remaining === 0n && selectedFunders.length > 0) {
      const funders = selectedFunders.map((f) => ({
        signer: new MonadAccountTxSigner({
          privateKey: f.candidate.privateKey(),
          provider: wallet.provider,
          httpClient: wallet.httpClient,
        }),
        amountWei: f.amountWei,
        source: f.candidate.source,
      }));

      const hasCoin = funders.some((f) => f.source === "coin");

      const executeMultiFund = async () => {
        return wallet.pool.prepareBurnAccount({
          mainAccountSigner: funders[0].signer,
          mainAccountAddress: mainAddress,
          funders,
          provider: wallet.provider,
          burnValueWei: voteWeightWei,
          gasReserveWei,
          onProgress,
          claimFor: leaseHolder,
        });
      };

      // Every funder is claimed for the funding, not only the main account.
      const preparation = await runMainAccountExclusive(
        wallet,
        executeMultiFund,
        {
          ...FUNDING_FROM_MAIN,
          addresses: selectedFunders.map((f) => f.candidate.address),
          onWaiting: () => onProgress?.({ stage: "waiting-for-payment" }),
        }
      );

      if (hasCoin) {
        wallet.invalidateBalanceCache?.();
      }
      return { leaseIndex: preparation.index, leaseHolder };
    }

    // 4. Fallback to mainAccountSigner within runMainAccountExclusive so deficit error is surfaced cleanly
    if (sourceIsHeld(wallet, mainAddress)) {
      throw new Error(sourceHeldRefusalMessage);
    }

    const preparation = await runMainAccountExclusive(
      wallet,
      async () => {
        return wallet.pool.prepareBurnAccount({
          mainAccountSigner,
          mainAccountAddress: mainAddress,
          provider: wallet.provider,
          burnValueWei: voteWeightWei,
          gasReserveWei,
          onProgress,
          claimFor: leaseHolder,
        });
      },
      {
        ...FUNDING_FROM_MAIN,
        onWaiting: () => onProgress?.({ stage: "waiting-for-payment" }),
      }
    );
    return { leaseIndex: preparation.index, leaseHolder };
  } catch (err) {
    const reason =
      typeof (err as { shortMessage?: unknown })?.shortMessage === "string"
        ? (err as { shortMessage: string }).shortMessage
        : err instanceof Error
        ? err.message
        : String(err);
    throw new TopicBurnPreparationError(reason, { cause: err });
  }
}

export interface InstallEvmStampFundAheadCoordinatorParams {
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
  /** See `EvmChainConfig.changeSplit`. */
  readonly changeSplit?: boolean;
  readonly stampFundingTargetWei?: bigint;
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
 * Installs canonical stamp client creation, stamp inventory preparation, stamp quoting, and
 * background fund-ahead onto `wallet`'s internals, and returns the created `EvmStampPayer`.
 */
export function installEvmStampFundAheadCoordinator(
  params: InstallEvmStampFundAheadCoordinatorParams
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
    changeSplit,
    stampFundingTargetWei,
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

  const defaultGasReserveWei = BigInt(21_000) * BigInt(2_000_000_000);
  const stampPaymentFeeReserve = async (): Promise<bigint> => {
    try {
      const feeData = await provider.getFeeData();
      const feePerGas = feeData.maxFeePerGas ?? feeData.gasPrice;
      if (feePerGas !== null && feePerGas !== undefined) {
        return BigInt(21_000) * feePerGas;
      }
    } catch {
      /* The fixed reserve below is the answer without a quote. */
    }
    return defaultGasReserveWei;
  };

  const transferFeeNow = async () => {
    const fee = await provider.getFeeData();
    return 21_000n * (fee.gasPrice ?? fee.maxFeePerGas ?? 0n);
  };

  const fundStampAccounts = (input: {
    stampValueWei: bigint;
    feeReserveWei?: bigint;
    onProgress?: (progress: DirectMessagePreparationProgress) => void;
  }) =>
    topicOwner.runLifetime(async () => {
      walletInternals.fundAheadBackoff = undefined;
      const feeReserveWei =
        input.feeReserveWei ?? (await stampPaymentFeeReserve());
      let fundingPrivateKey = mainAccount.privateKey;
      const mainHeld = sourceIsHeld(wallet, mainAccount.address);
      try {
        const coinNeedWei =
          input.stampValueWei +
          BigInt(2 * STAMP_PAIR_TRANSFERS) * defaultGasReserveWei;
        const mainBal = mainHeld
          ? 0n
          : await provider.getBalance(mainAccount.address);
        if (
          mainBal < coinNeedWei &&
          identity.address.raw.toLowerCase() !==
            mainAccount.address.toLowerCase()
        ) {
          const identBal = await provider.getBalance(identity.address.raw);
          if (
            identBal > mainBal &&
            !sourceIsHeld(wallet, identity.address.raw)
          ) {
            fundingPrivateKey = identity.toPrivateKeyHex();
          }
        }
        if (
          mainBal < coinNeedWei &&
          fundingPrivateKey === mainAccount.privateKey
        ) {
          await readCoins();
          const funded = spendableCoins(coinStore.all())
            .filter((coin) => BigInt(coin.amountWei) >= coinNeedWei)
            .sort((a, b) =>
              BigInt(a.amountWei) > BigInt(b.amountWei) ? -1 : 1
            );
          for (const coin of funded) {
            const nonce = await provider.getTransactionCount(coin.address);
            if (!topicOwner.nativeJournal!.canSelect(coin.address, nonce)) {
              continue;
            }
            fundingPrivateKey = coin.privateKey;
            invalidateCoinsRead();
            break;
          }
        }
      } catch {}
      if (mainHeld && fundingPrivateKey === mainAccount.privateKey) {
        throw new Error(sourceHeldRefusalMessage);
      }
      const mainAccountSigner = new MonadAccountTxSigner({
        privateKey: fundingPrivateKey,
        provider,
        httpClient,
      });
      return runMainAccountExclusive(
        wallet,
        async () =>
          pool.prepareStampInventory({
            mainAccountSigner,
            provider,
            stampValueWei: input.stampValueWei,
            gasReserveWei: feeReserveWei,
            minimumPaymentWei: transferFeeNow,
            onProgress: input.onProgress,
          }),
        { ...FUNDING_FROM_MAIN, addresses: [mainAccountSigner.address] }
      );
    });

  const prepareInventory: CanonicalInventoryFunder = async ({
    stampValueWei,
    onProgress,
  }) => (await fundStampAccounts({ stampValueWei, onProgress })).fundingTxHashes;
  walletInternals.canonicalInventoryFunder = prepareInventory;

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
    ...(changeSplit === undefined ? {} : { changeSplit }),
    onPoolCoinsClaimed: () => {
      walletInternals.fundAheadBackoff = undefined;
    },
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

  const stampValueAhead = stampFundingTargetWei ?? 10_000_000_000_000_000n;
  const reserveCeilingWei =
    stampValueAhead > defaultGasReserveWei
      ? stampValueAhead
      : defaultGasReserveWei;
  const maxValueAheadWei =
    stampValueAhead + BigInt(STAMP_PAIR_TRANSFERS) * reserveCeilingWei;
  const notFunded = (reason: string): DirectMessageFundAheadResult => ({
    outcome: "not-funded",
    fundingTxHashes: [],
    reason,
  });

  const fundAheadPass = (): Promise<DirectMessageFundAheadResult> =>
    topicOwner.runLifetime(async () => {
      let mainBalanceWei: bigint | undefined;
      let result: DirectMessageFundAheadResult;
      try {
        const unresolved = pool
          .records()
          .some((record) => record.status === "funding");
        if (
          !unresolved &&
          (await pool.hasStampInventory({
            provider,
            stampValueWei: stampValueAhead,
            feeReserveWei: 0n,
            maxCacheAgeMs: Infinity,
          }))
        ) {
          return { outcome: "ready", fundingTxHashes: [] };
        }
        if (sourceIsHeld(wallet, mainAccount.address)) {
          return notFunded("source-held");
        }
        if (!unresolved) {
          mainBalanceWei = await provider.getBalance(mainAccount.address);
        }
        if (
          mainBalanceWei !== undefined &&
          mainBalanceWei < stampValueAhead
        ) {
          result = notFunded("insufficient-funds");
        } else {
          const mainAccountSigner = new MonadAccountTxSigner({
            privateKey: mainAccount.privateKey,
            provider,
            httpClient,
          });
          const preparation = await runMainAccountExclusive(
            wallet,
            async () =>
              pool.fundStampInventoryAhead({
                mainAccountSigner,
                provider,
                stampValueWei: stampValueAhead,
                gasReserveWei: stampPaymentFeeReserve,
                maxValueWei: maxValueAheadWei,
                minimumPaymentWei: transferFeeNow,
              }),
            { ...FUNDING_FROM_MAIN, addresses: [mainAccount.address] }
          );
          result = {
            outcome:
              preparation.fundingTxHashes.length > 0 ? "funded" : "ready",
            fundingTxHashes: preparation.fundingTxHashes,
          };
        }
      } catch (error) {
        result = notFunded(
          error instanceof FundAheadRefusedError
            ? error.code
            : error instanceof Error
            ? error.message
            : String(error)
        );
      }
      if (result.outcome !== "funded") {
        const last = walletInternals.fundAheadBackoff;
        walletInternals.fundAheadBackoff = {
          result,
          delayMs:
            last !== undefined && last.result.reason === result.reason
              ? Math.min(last.delayMs * 2, FUND_AHEAD_BACKOFF_MAX_MS)
              : FUND_AHEAD_BACKOFF_MIN_MS,
          startedAtMs: Date.now(),
          mainBalanceWei,
        };
      } else {
        walletInternals.fundAheadBackoff = undefined;
      }
      return result;
    });

  let fundingAhead: Promise<DirectMessageFundAheadResult> | undefined;
  walletInternals.stampFunderAhead = () => {
    const waiting = walletInternals.fundAheadBackoff;
    const waited = Date.now() - (waiting?.startedAtMs ?? 0);
    if (waiting && waited >= 0 && waited < waiting.delayMs) {
      return Promise.resolve(waiting.result);
    }
    fundingAhead ??= fundAheadPass().finally(() => {
      fundingAhead = undefined;
    });
    return fundingAhead;
  };

  return stampPayer;
}
