import { getAddress, getBytes, hexlify, randomBytes } from "ethers";
import type { EvmChainConfig } from "./evm-chain-config";
import type { EvmChainWalletHandle, EvmWalletHandle } from "../evm-wallet-handle";
import type { MonadWalletOperationAdmission } from "../storage/monad-wallet-bundle";
import { EvmInputAdmissionError } from "../evm-input-admission";
import type { DefaultStampQuote } from "../oracle/stamp-policy";
import {
  ActiveChain,
  DirectMessageClient,
  DirectMessagePreparationProgress,
  DirectMessageReceived,
  DirectMessageSendResult,
  TopicBroadcastClient,
  TopicPostOutcomeUnknownError,
} from "./active-chain";
import type { MessageItem, WalletSyncItem } from "@frank/cashweb/types/messages";
import { WalletSyncItemRejectedError } from "@frank/cashweb/sync-dispatcher";
import { applyWalletSyncItem } from "../sync-dispatcher";
import type { ForumMessage, ForumReadPolicy } from "../forum-model";
import { encodeForumPost } from "@frank/codec";
import { SubAccountSpendRefusedError } from "../monad-account-pool";
import { MonadAccountTxSigner } from "../monad-account-tx";
import {
  MonadTopicPostClient,
  MonadTopicPostAbandonedError,
  quoteMonadTopicBurnGasReserve,
} from "../monad-topic-post-client";
import { MonadTopicVoteClient } from "../monad-topic-vote-client";
import {
  fetchDiscoveredTopics,
  fetchMonadTopicPostView,
  fetchMonadTopicPostsSince,
} from "../monad-topic-tally-client";
import {
  CanonicalMessagingPendingError,
  installedMessageItemRegistry,
  projectOutboxMessageRecord,
} from "./monad-canonical-dm";
import { waitForSpendSpacing } from "../evm-stamp-payer";
import type { EvmBlockWatcher } from "../evm-block-watcher";
import {
  ContactPaymentReleasedError,
  defaultNativeTransactionAttemptStore,
  nativeTransactionAttemptKey,
  runNativeTransactionExclusive,
} from "./chain-wallet";
import {
  asNothingSent,
  FUNDING_FROM_MAIN,
  MainAccountBusyError,
  type MainAccountWait,
  MAX_WAITING_SELF_NOTES,
  SELF_NOTE_RETRY_MS,
  SOURCE_HELD_FOR_CONTACT_PAYMENT,
  TopicBurnPreparationError,
} from "./evm-chain-config-env";
import {
  asMonadWallet,
  canonicalDirectories,
  canonicalMessagingFor,
  canonicalStampQuoters,
  closedWallets,
  enclosingTopicAdmissions,
  mainAccountAdmissions,
  nativeOperationOwner,
  nativeOperationOwners,
  privateTopicWallets,
  receivedCoinOwners,
  reconcileNativeAdmission,
  requireLegacyMessaging,
  requireOpenWallet,
  sourceIsHeld,
  stampFundersAhead,
  walletFundingCandidates,
  walletMaterial,
  walletSendQueues,
} from "./evm-wallet-registry";

export function createEvmChainSubsystems(params: {
  config: EvmChainConfig;
  chainIdentifier: string;
  requirePeerSyncDelivery: () => void;
  contractChainIdentifier: () => string;
}) {
  const {
    config,
    chainIdentifier,
    requirePeerSyncDelivery,
    contractChainIdentifier,
  } = params;

  const mainPrivateKey = (wallet: EvmChainWalletHandle) =>
    walletMaterial.get(wallet)?.mainAccount.privateKey ??
    wallet.identity.toPrivateKeyHex();

  // The queue topic posts, votes and native sends still run their own multi-step sequences on
  // (each is recorded across several stores). Paid messages never enter it: a message claims its
  // accounts through the pool's one synchronous claim (`MonadSubAccountPool.claim`), which is
  // also what keeps these operations and messages off each other's accounts.
  const runWalletExclusive = <T>(
    wallet: EvmChainWalletHandle,
    task: (admission?: MonadWalletOperationAdmission) => Promise<T>,
    canonical = false
  ): Promise<T> => {
    requireOpenWallet(wallet);
    const run = (walletSendQueues.get(wallet) ?? Promise.resolve()).then(
      async () => {
        const owner = privateTopicWallets.get(wallet)?.walletState;
        if (!owner) return task();
        enclosingTopicAdmissions.add(wallet);
        try {
          return await (canonical
            ? owner.runCanonicalOperation(task)
            : owner.runOperation(task));
        } finally {
          enclosingTopicAdmissions.delete(wallet);
        }
      }
    );
    walletSendQueues.set(
      wallet,
      run.then(
        () => undefined,
        () => undefined
      )
    );
    return run;
  };

  const mainAccountHolder = (wallet: EvmChainWalletHandle) =>
    `${wallet.identity.address.raw.toLowerCase()}:main-account`;
  const mainAccountAddresses = (wallet: EvmChainWalletHandle) => [
    ...new Set(
      [
        walletMaterial.get(wallet)?.mainAccount.address,
        wallet.identity.address.raw,
      ].flatMap((address) =>
        address === undefined ? [] : [address.toLowerCase()]
      )
    ),
  ];
  const runningMainTasks = new WeakMap<EvmChainWalletHandle, number>();
  const blockWatchers = new WeakMap<EvmChainWalletHandle, EvmBlockWatcher>();
  const lastOwnLookMs = new WeakMap<EvmChainWalletHandle, number>();
  /** Address -> transfers signed from it outside the journal, not yet seen on chain. */
  const unjournalledTransfers = new WeakMap<
    EvmChainWalletHandle,
    Map<string, { txHash: string; nonce: number }[]>
  >();

  /** One look at the chain for each transaction this wallet's native holder signed from
   * `address` that is still undecided. Never rejects. */
  const lookAtOwnTransactions = async (
    wallet: EvmChainWalletHandle,
    address: string
  ): Promise<void> => {
    if (closedWallets.has(wallet)) return;
    await nativeOperationOwners.get(wallet)?.lookAtSource(address);
    const transfers = unjournalledTransfers.get(wallet)?.get(address) ?? [];
    for (const transfer of [...transfers]) {
      try {
        const decided =
          (await wallet.provider.getTransactionReceipt(transfer.txHash)) !==
            null ||
          (await wallet.provider.getTransactionCount(address, "latest")) >
            transfer.nonce;
        if (decided) transfers.splice(transfers.indexOf(transfer), 1);
      } catch {
        // The chain could not be read: nothing is known, the account stays held.
      }
    }
  };

  /** True while something the native holder signed from `address` is undecided. No request. */
  const ownTransactionUndecided = (
    wallet: EvmChainWalletHandle,
    address: string
  ): boolean =>
    sourceIsHeld(wallet, address) ||
    nativeOperationOwners.get(wallet)?.holdsSource(address) === true ||
    (unjournalledTransfers.get(wallet)?.get(address)?.length ?? 0) > 0;

  /**
   * Lets go of the main and identity accounts this wallet's native holder has, each as soon as
   * nothing it signed from that account is still undecided. With `look` the chain is asked first
   * (one look per undecided transaction); without it only what is already recorded counts.
   */
  const releaseSettledMainAccounts = async (
    wallet: EvmChainWalletHandle,
    look: boolean
  ): Promise<void> => {
    const pool = wallet.pool;
    if (typeof pool.accountClaimedBy !== "function") return;
    const holder = mainAccountHolder(wallet);
    // One look a second for the wallet, however many sends are waiting for the account.
    if (look) {
      const last = lastOwnLookMs.get(wallet);
      if (last !== undefined && Date.now() - last < 1_000) look = false;
      else lastOwnLookMs.set(wallet, Date.now());
    }
    for (const address of mainAccountAddresses(wallet)) {
      if (pool.accountClaimedBy(address) !== holder) continue;
      if (look) await lookAtOwnTransactions(wallet, address);
      // An operation is running under this holder right now: it lets go itself when it ends.
      if ((runningMainTasks.get(wallet) ?? 0) > 0) return;
      if (!ownTransactionUndecided(wallet, address))
        pool.releaseAccountClaim(holder, address);
    }
  };

  /**
   * Takes the main and identity accounts for the native holder, waiting its turn while an
   * earlier payment is spending one: a paid message's, or (with `waitForOwn`) a transaction this
   * holder itself signed earlier.
   */
  const holdMainAccounts = async (
    wallet: EvmChainWalletHandle,
    options: MainAccountWait = {}
  ): Promise<void> => {
    const pool = wallet.pool;
    if (typeof pool.claimAccount !== "function") {
      runningMainTasks.set(wallet, (runningMainTasks.get(wallet) ?? 0) + 1);
      return;
    }
    const holder = mainAccountHolder(wallet);
    const addresses = mainAccountAddresses(wallet);
    const others = () =>
      addresses.filter((address) => {
        const claimant = pool.accountClaimedBy(address);
        return claimant !== undefined && claimant !== holder;
      });
    const own = () =>
      options.waitForOwn === true
        ? addresses.filter((address) =>
            ownTransactionUndecided(wallet, address)
          )
        : [];
    const deadline =
      options.waitMs === undefined ? undefined : Date.now() + options.waitMs;
    let waiting = false;
    for (;;) {
      let held = others();
      // Synchronous from the look to the claim: nobody else can take one in between.
      if (held.length === 0 && own().length === 0) {
        for (const address of addresses)
          pool.restoreAccountClaim(holder, address);
        runningMainTasks.set(wallet, (runningMainTasks.get(wallet) ?? 0) + 1);
        try {
          for (const address of addresses)
            await waitForSpendSpacing(
              wallet.provider,
              address,
              config.spendSpacingBlocks
            );
        } catch (error) {
          runningMainTasks.set(wallet, runningMainTasks.get(wallet)! - 1);
          await releaseSettledMainAccounts(wallet, false);
          throw error;
        }
        return;
      }
      if (!waiting) {
        waiting = true;
        options.onWaiting?.();
      }
      if (held.length > 0) {
        const holderOfIt = pool.accountClaimedBy(held[0]!);
        if (holderOfIt !== undefined)
          await canonicalMessagingFor(wallet)
            ?.settleHolder(holderOfIt)
            .catch(() => undefined);
      } else
        for (const address of own())
          await lookAtOwnTransactions(wallet, address);
      held = others();
      if (held.length === 0 && own().length === 0) continue;
      requireOpenWallet(wallet);
      if (deadline !== undefined && Date.now() >= deadline)
        throw new MainAccountBusyError();
      const watcher = blockWatchers.get(wallet);
      const abort = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const look = watcher
        ? watcher.next(abort.signal).catch(() => undefined)
        : new Promise((resolve) => (timer = setTimeout(resolve, 1_000)));
      await Promise.race([
        ...(held.length > 0 ? [pool.accountReleased(held[0]!)] : []),
        look,
      ]);
      abort.abort();
      clearTimeout(timer);
    }
  };

  const runMainAccountExclusive = <T>(
    wallet: EvmChainWalletHandle,
    task: () => Promise<T>,
    options: MainAccountWait = {}
  ): Promise<T> => {
    let admission = mainAccountAdmissions.get(wallet);
    if (admission === undefined) {
      admission = {
        key: nativeTransactionAttemptKey({
          family: "evm",
          chainIdentifier,
          address: wallet.identity.address.raw.toLowerCase(),
        }),
        store:
          config.nativeAttemptStore ?? defaultNativeTransactionAttemptStore,
      };
      mainAccountAdmissions.set(wallet, admission);
    }
    const owner = admission;
    return runNativeTransactionExclusive(
      owner.key,
      owner.store.coordinationScope,
      async () => {
        await reconcileNativeAdmission(owner);
        await holdMainAccounts(wallet, options);
        try {
          return await task();
        } finally {
          runningMainTasks.set(wallet, runningMainTasks.get(wallet)! - 1);
          await releaseSettledMainAccounts(wallet, false);
        }
      }
    );
  };

  const runUnjournalledTransfer = <
    T extends { txHash: string; from: string; nonce: number }
  >(
    wallet: EvmChainWalletHandle,
    sign: () => Promise<T>,
    waitMs?: number
  ): Promise<T> =>
    runMainAccountExclusive(
      wallet,
      async () => {
        const sent = await sign();
        const from = sent.from.toLowerCase();
        if (mainAccountAddresses(wallet).includes(from)) {
          let transfers = unjournalledTransfers.get(wallet);
          if (!transfers)
            unjournalledTransfers.set(wallet, (transfers = new Map()));
          transfers.set(from, [
            ...(transfers.get(from) ?? []),
            { txHash: sent.txHash, nonce: sent.nonce },
          ]);
        }
        return sent;
      },
      { waitMs, waitForOwn: true }
    );

  const forumPolicy: ForumReadPolicy = {
    network:
      config.networkTag === "MON1"
        ? "monad-mainnet"
        : config.networkTag === "MONT"
        ? "monad-testnet"
        : config.networkTag === "MONR"
        ? "monad-regtest"
        : config.networkTag,
    chainId: BigInt(config.chainId),
    burnAddress: config.stampBurnAddress,
  };

  const creatorForumPolicy = (wallet: EvmWalletHandle): ForumReadPolicy => ({
    network: wallet.cborNetwork ?? forumPolicy.network,
    chainId: wallet.forumChainId ?? forumPolicy.chainId,
    burnAddress: wallet.forumBurnAddress ?? forumPolicy.burnAddress,
  });

  /** Funds (or reuses) one sub-account able to burn `voteWeightWei` in a single transaction and
   * returns its pool index for the caller to lease. */
  const prepareTopicBurnAccount = async (
    wallet: EvmChainWalletHandle,
    voteWeightWei: bigint,
    onProgress:
      | ((progress: DirectMessagePreparationProgress) => void)
      | undefined
  ): Promise<{ leaseIndex: number; leaseHolder: string }> => {
    const leaseHolder = `${wallet.identity.address.raw.toLowerCase()}:topic:${hexlify(
      randomBytes(8)
    )}`;
    const mainPrivateKeyHex = mainPrivateKey(wallet);
    const mainAccountSigner = new MonadAccountTxSigner({
      privateKey: mainPrivateKeyHex,
      provider: wallet.provider,
      httpClient: wallet.httpClient,
    });
    const mainAddress =
      walletMaterial.get(wallet)?.mainAccount.address ??
      wallet.identity.address.raw;

    try {
      onProgress?.({ stage: "checking" });

      const burnAddress = creatorForumPolicy(
        privateTopicWallets.get(wallet) ?? wallet
      ).burnAddress;
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

      const candidateGetter = walletFundingCandidates.get(wallet);
      const candidates = candidateGetter
        ? candidateGetter()
        : [
            {
              source: "main" as const,
              address: mainAddress,
              privateKey: () => mainPrivateKeyHex,
            },
          ];

      const isEligible = (address: string) =>
        !sourceIsHeld(wallet, address) &&
        (typeof wallet.pool?.accountClaimedBy !== "function" ||
          wallet.pool.accountClaimedBy(address) === undefined);

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
              retainPreparationHold: true,
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
        const preparation = await wallet.pool.prepareBurnAccount({
          mainAccountSigner: funderSigner,
          mainAccountAddress: mainAddress,
          provider: wallet.provider,
          burnValueWei: voteWeightWei,
          gasReserveWei,
          onProgress,
          claimFor: leaseHolder,
          retainPreparationHold: true,
        });
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

        const hasMain = funders.some((f) => f.source === "main");
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
            retainPreparationHold: true,
          });
        };

        const preparation = hasMain
          ? await runMainAccountExclusive(wallet, executeMultiFund, {
              ...FUNDING_FROM_MAIN,
              onWaiting: () => onProgress?.({ stage: "waiting-for-payment" }),
            })
          : await executeMultiFund();

        if (hasCoin) {
          wallet.invalidateBalanceCache?.();
        }
        return { leaseIndex: preparation.index, leaseHolder };
      }

      // 4. Fallback to mainAccountSigner within runMainAccountExclusive so deficit error is surfaced cleanly
      if (sourceIsHeld(wallet, mainAddress))
        throw new Error(SOURCE_HELD_FOR_CONTACT_PAYMENT);

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
            retainPreparationHold: true,
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
      const fundingRecorded =
        typeof wallet.pool?.records === "function" &&
        wallet.pool
          .records()
          .some(
            (record) =>
              record.funding?.hold?.operationId === leaseHolder &&
              (record.funding?.attempts.length ?? 0) > 0
          );
      throw new TopicBurnPreparationError(reason, {
        cause: err,
        fundingRecorded,
      });
    }
  };

  const settledSelfNotes = new WeakMap<object, Set<string>>();
  const waitingSelfNotes = new WeakMap<object, Map<string, number>>();
  const selfNoteRefusalIsFinal = (error: unknown): boolean => {
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
  };

  const consumeSelfNotes = async (
    wallet: EvmChainWalletHandle,
    message: DirectMessageReceived,
    onForeignWalletSync?: (item: WalletSyncItem) => Promise<void>
  ): Promise<
    | { kind: "none" }
    | { kind: "consumed"; rest: DirectMessageReceived | undefined }
    | { kind: "retry" }
  > => {
    const own = wallet.identity.address.raw.toLowerCase();
    if (
      message.senderAddress.raw.toLowerCase() !== own ||
      message.recipientAddress.raw.toLowerCase() !== own
    )
      return { kind: "none" };
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
    let settled = settledSelfNotes.get(wallet);
    if (settled === undefined)
      settledSelfNotes.set(wallet, (settled = new Set()));
    if (settled.has(digest)) return { kind: "consumed", rest };
    let waiting = waitingSelfNotes.get(wallet);
    if (waiting === undefined)
      waitingSelfNotes.set(wallet, (waiting = new Map()));
    try {
      for (const note of notes) {
        const item = note as WalletSyncItem;
        if (item.chainIdentifier === wallet.chainIdentifier)
          await applyWalletSyncItem(wallet, item);
        else {
          if (!onForeignWalletSync)
            throw new Error(
              `Wallet sync owner unavailable for ${item.chainIdentifier}`
            );
          await onForeignWalletSync(item);
        }
      }
    } catch (error) {
      if (
        notes.some(
          (note) =>
            (note as WalletSyncItem).chainIdentifier !== wallet.chainIdentifier
        )
      )
        throw error;
      const detail = error instanceof Error ? error.message : String(error);
      const since = waiting.get(digest) ?? Date.now();
      const final = selfNoteRefusalIsFinal(error);
      if (!final && Date.now() - since < SELF_NOTE_RETRY_MS) {
        if (!waiting.has(digest) && waiting.size >= MAX_WAITING_SELF_NOTES)
          waiting.delete(waiting.keys().next().value as string);
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
  };

  const recordReceivedCoins = async (
    wallet: EvmChainWalletHandle,
    messages: readonly DirectMessageReceived[]
  ): Promise<void> => {
    const owner = receivedCoinOwners.get(wallet);
    if (owner === undefined) return;
    const own = wallet.identity.address.raw.toLowerCase();
    for (const message of messages) {
      if (
        message.senderAddress.raw.toLowerCase() !== own ||
        message.recipientAddress.raw.toLowerCase() !== own
      )
        continue;
      for (const item of message.items)
        if (item.type === "received-coin")
          await applyWalletSyncItem(wallet, item).catch((error) => {
            if (!(error instanceof WalletSyncItemRejectedError)) throw error;
          });
    }
    for (const message of messages) {
      if (
        message.outbound === true ||
        message.senderAddress.raw.toLowerCase() === own
      )
        continue;
      for (const item of message.items)
        if (item.type === "stealth")
          await owner.recordStealthItem(item, {
            payloadDigest: message.payloadDigest,
            timestampMs: message.receivedTime ?? Date.now(),
          });
    }
    for (const message of messages)
      if (message.outbound !== true) await owner.recordStampPayments(message);
  };

  const directMessages: DirectMessageClient = {
    async quoteStamp(params) {
      const wallet = asMonadWallet(params.wallet, config.networkId);
      const quote = canonicalStampQuoters.get(wallet);
      if (!quote)
        throw new CanonicalMessagingPendingError(
          "Stamp affordability requires persistent typed wallet custody."
        );
      return quote({
        stampValueWei: params.stampValue,
        excludedAddresses: params.excludedAddresses,
      });
    },
    async send(params): Promise<DirectMessageSendResult> {
      const wallet = asMonadWallet(params.wallet, config.networkId);
      const canonical = canonicalMessagingFor(wallet);
      if (!canonical)
        throw new CanonicalMessagingPendingError(
          "Canonical direct messages require persistent typed wallet custody on a Monad network."
        );
      const coinOwner = receivedCoinOwners.get(wallet);
      const carried = params.items.flatMap((item) =>
        item.type === "stealth" && item.ephemeralPubKey
          ? [item.ephemeralPubKey.replace(/^0x/, "").toLowerCase()]
          : []
      );
      if (coinOwner === undefined || carried.length === 0)
        return canonical.send(params);
      const endSend = await coinOwner.beginContactSend(carried);
      let result: DirectMessageSendResult;
      try {
        result = await canonical.send({
          ...params,
          onBeforeExposure: async (payloadDigest) => {
            await coinOwner.contactMessageAttempted(carried, payloadDigest);
            await params.onBeforeExposure?.(payloadDigest);
          },
        });
      } catch (error) {
        endSend();
        if (
          error instanceof Error &&
          error.message === SOURCE_HELD_FOR_CONTACT_PAYMENT &&
          (await coinOwner.releaseUnsentContactPayments(carried))
        )
          throw new ContactPaymentReleasedError();
        throw error;
      } finally {
        endSend();
      }
      void coinOwner.contactMessageDelivered(result.payloadDigest);
      return result;
    },

    async deliveryOf(params) {
      const wallet = asMonadWallet(params.wallet, config.networkId);
      const canonical = canonicalMessagingFor(wallet);
      if (!canonical)
        throw new CanonicalMessagingPendingError(
          "Canonical direct messages require persistent typed wallet custody on a Monad network."
        );
      return canonical.deliveryOf(params);
    },

    async attemptOf(params) {
      const wallet = asMonadWallet(params.wallet, config.networkId);
      const canonical = canonicalMessagingFor(wallet);
      if (!canonical)
        throw new CanonicalMessagingPendingError(
          "Canonical direct messages require persistent typed wallet custody on a Monad network."
        );
      return canonical.attemptOf(params);
    },

    async unattributedAttempts(params) {
      const wallet = asMonadWallet(params.wallet, config.networkId);
      const canonical = canonicalMessagingFor(wallet);
      if (!canonical)
        throw new CanonicalMessagingPendingError(
          "Canonical direct messages require persistent typed wallet custody on a Monad network."
        );
      return canonical.unattributedAttempts(params);
    },

    async resolveUnattributedAttempts(params) {
      const wallet = asMonadWallet(params.wallet, config.networkId);
      const canonical = canonicalMessagingFor(wallet);
      if (!canonical)
        throw new CanonicalMessagingPendingError(
          "Canonical direct messages require persistent typed wallet custody on a Monad network."
        );
      await canonical.resolveUnattributedAttempts(params);
    },

    async reconcileAttempts(params) {
      const wallet = asMonadWallet(params.wallet, config.networkId);
      const canonical = canonicalMessagingFor(wallet);
      if (!canonical)
        throw new CanonicalMessagingPendingError(
          "Canonical direct messages require persistent typed wallet custody on a Monad network."
        );
      const statuses = await canonical.reconcileAttempts(params);
      const coinOwner = receivedCoinOwners.get(wallet);
      for (const [digest, status] of Object.entries(statuses))
        if (status === "delivered") void coinOwner?.contactMessageDelivered(digest);
      return statuses;
    },

    async fundAhead(params) {
      const wallet = asMonadWallet(params.wallet, config.networkId);
      const fund = stampFundersAhead.get(wallet);
      if (!fund) return { outcome: "unavailable", fundingTxHashes: [] };
      return fund();
    },

    async discardAttempt(params) {
      try {
        const wallet = asMonadWallet(params.wallet, config.networkId);
        const canonical = canonicalMessagingFor(wallet);
        if (canonical && typeof (canonical as any).discardAttempt === "function") {
          await (canonical as any).discardAttempt(params);
        }
      } catch {
        // Discard is best-effort when wallet or canonical messaging is unavailable
      }
    },

    async defaultStampQuote(params): Promise<DefaultStampQuote> {
      const wallet = asMonadWallet(params.wallet, config.networkId);
      const canonical = canonicalMessagingFor(wallet);
      if (!canonical)
        return {
          status: "unavailable",
          chainIdentifier: contractChainIdentifier(),
          reason: "unsupported",
        };
      return canonical.defaultStampQuote();
    },

    async minimumStamp(params) {
      const wallet = asMonadWallet(params.wallet, config.networkId);
      const canonical = canonicalMessagingFor(wallet);
      if (!canonical) throw new CanonicalMessagingPendingError();
      return canonical.minimumStamp();
    },

    chainHealth(params) {
      const wallet = asMonadWallet(params.wallet, config.networkId);
      return canonicalMessagingFor(wallet)?.chainHealth() ?? { reachable: true };
    },

    paymentsOf(params) {
      const wallet = asMonadWallet(params.wallet, config.networkId);
      return canonicalMessagingFor(wallet)?.paymentsOf(params.payloadDigest);
    },
    paymentSummaryOf(params) {
      const wallet = asMonadWallet(params.wallet, config.networkId);
      return canonicalMessagingFor(wallet)?.paymentSummaryOf(params.payloadDigest);
    },

    async scanAuthenticatedMailbox(params) {
      const wallet = asMonadWallet(params.wallet, chainIdentifier);
      if (wallet.chainIdentifier !== chainIdentifier)
        throw new Error("Authenticated mailbox requires canonical chain affinity");
      const sinceMs = params.sinceMs;
      const canonical = canonicalMessagingFor(wallet);
      if (!canonical) throw new CanonicalMessagingPendingError();
      const directory = canonicalDirectories.get(wallet);
      if (directory && directory.network !== chainIdentifier)
        throw new Error("Authenticated mailbox directory has a foreign chain");
      const result = await canonical.scanAuthenticatedMailbox({ wallet, sinceMs });
      asMonadWallet(wallet, chainIdentifier);
      if (
        wallet.chainIdentifier !== chainIdentifier ||
        canonicalMessagingFor(wallet) !== canonical ||
        canonicalDirectories.get(wallet) !== directory
      )
        throw new Error("Authenticated mailbox session changed during scan");
      return result;
    },

    async fetchSince(params): Promise<DirectMessageReceived[]> {
      const wallet = asMonadWallet(params.wallet, config.networkId);
      const canonical = canonicalMessagingFor(wallet);
      if (!canonical)
        throw new CanonicalMessagingPendingError(
          "Canonical direct messages require persistent typed wallet custody on a Monad network."
        );
      const received: DirectMessageReceived[] = [];
      {
        const coinOwner = receivedCoinOwners.get(wallet);
        const scan = coinOwner?.mailboxScan();
        let canonicalReceived: DirectMessageReceived[];
        if (coinOwner === undefined || scan === undefined || scan.complete) {
          canonicalReceived = await canonical.fetchSince(params);
          await recordReceivedCoins(wallet, canonicalReceived);
        } else {
          let truncated = false;
          let scannedUntil = scan.sinceMs;
          if (params.sinceMs > scan.sinceMs) {
            const earlier = await canonical.fetchSince({
              wallet: params.wallet,
              sinceMs: scan.sinceMs,
              onTruncated: () => {
                truncated = true;
              },
            });
            await recordReceivedCoins(wallet, earlier);
            scannedUntil = earlier.reduce(
              (latest, message) => Math.max(latest, message.receivedTime ?? 0),
              scannedUntil
            );
          }
          const earlierComplete = !truncated;
          canonicalReceived = await canonical.fetchSince({
            ...params,
            onTruncated: (reason) => {
              truncated = true;
              params.onTruncated?.(reason);
            },
          });
          await recordReceivedCoins(wallet, canonicalReceived);
          await coinOwner.recordMailboxScan({
            complete: !truncated,
            sinceMs: earlierComplete
              ? canonicalReceived.reduce(
                  (latest, message) =>
                    Math.max(latest, message.receivedTime ?? 0),
                  Math.max(scannedUntil, params.sinceMs)
                )
              : scannedUntil,
          });
        }
        for (const msg of canonicalReceived) {
          const taken = await consumeSelfNotes(
            wallet,
            msg,
            params.onForeignWalletSync
          );
          if (taken.kind === "none") received.push(msg);
          else if (taken.kind === "retry")
            params.onIncompleteTimestamp?.(msg.receivedTime);
          else if (taken.rest !== undefined) received.push(taken.rest);
          else
            params.onQuarantinedTimestamp?.(
              msg.receivedTime,
              msg.payloadDigest
            );
        }
      }

      received.sort((a, b) => (a.receivedTime ?? 0) - (b.receivedTime ?? 0));
      await recordReceivedCoins(wallet, received);
      void receivedCoinOwners.get(wallet)?.resumeContactPayments();
      void receivedCoinOwners.get(wallet)?.noteCoins();
      void receivedCoinOwners.get(wallet)?.checkPendingCoins();
      return received;
    },

    async listRecoveredStampPayments({ wallet }) {
      const monadWallet = asMonadWallet(wallet, config.networkId);
      requireLegacyMessaging(monadWallet);
      return [];
    },

    async sweepRecoveredStampPayment({ wallet }) {
      const monadWallet = asMonadWallet(wallet, config.networkId);
      requireLegacyMessaging(monadWallet);
      throw new Error("No legacy recovered stamp payment found");
    },

    subscribeMailboxStream(params) {
      const wallet = asMonadWallet(params.wallet, config.networkId);
      const canonical = canonicalMessagingFor(wallet);
      if (canonical?.subscribeMailboxStream) {
        let active = true;
        const unsubscribe = canonical.subscribeMailboxStream({
          ...params,
          onRecord: async (record, lease) => {
            if (!active || !lease.isLive()) return;
            requireOpenWallet(wallet);
            if (
              record.items.some(
                (item) =>
                  item.type === "stealth" || item.type === "received-coin"
              )
            )
              await recordReceivedCoins(wallet, [record]);
            if (!active || !lease.isLive()) return;
            requireOpenWallet(wallet);
            const taken = await consumeSelfNotes(wallet, record);
            if (!active || !lease.isLive()) return;
            requireOpenWallet(wallet);
            if (taken.kind === "none") await params.onRecord(record);
            else if (taken.kind === "consumed" && taken.rest !== undefined)
              await params.onRecord(taken.rest);
          },
        });
        return () => {
          active = false;
          unsubscribe();
        };
      }
      return () => {};
    },
  };

  const nativeTransfers: ActiveChain["nativeTransfers"] = {
    async getBalance({ wallet }): Promise<bigint> {
      asMonadWallet(wallet, config.networkId);
      return wallet.getBalance();
    },

    async send({
      wallet,
      recipient,
      value,
      onSigned,
      mainAccountWaitMs,
    }): Promise<{ txHash: string }> {
      asMonadWallet(wallet, config.networkId);
      requirePeerSyncDelivery();
      return wallet.sendNative({
        recipient,
        value,
        onSigned,
        mainAccountWaitMs,
      });
    },

    async getTransactionStatus({ wallet, transaction }) {
      const monadWallet = asMonadWallet(wallet, config.networkId);
      const receipt = await monadWallet.provider.getTransactionReceipt(
        transaction.txHash
      );
      if (receipt) return receipt.status === 0 ? "failed" : "confirmed";
      const known = await monadWallet.provider.getTransaction(
        transaction.txHash
      );
      return known ? "pending" : "unknown";
    },

    async sendLegacy({
      wallet,
      recipient,
      value,
      onProgress,
      onSigned,
      mainAccountWaitMs,
    }) {
      const owned = asMonadWallet(wallet, config.networkId);
      requirePeerSyncDelivery();
      nativeOperationOwner(owned);
      return owned.sendLegacy!({
        recipient,
        value,
        onProgress,
        onSigned,
        mainAccountWaitMs,
      });
    },
    async estimateLegacyFee({ wallet, recipient, value }) {
      return nativeOperationOwner(
        asMonadWallet(wallet, config.networkId)
      ).estimateLegacyFee(recipient, value);
    },

    async sendToContact({ wallet, ...params }) {
      return asMonadWallet(wallet, config.networkId).sendToContact!(params);
    },
  };

  const runTopicExclusive = <T>(
    wallet: EvmChainWalletHandle,
    task: (topicWallet: EvmWalletHandle) => Promise<T>
  ): Promise<T> =>
    runWalletExclusive(wallet, async (admission) => {
      enclosingTopicAdmissions.add(wallet);
      try {
        const topicWallet = privateTopicWallets.get(wallet) ?? wallet;
        if (!topicWallet.walletState)
          throw new Error(
            "Canonical topics require coherent wallet persistence"
          );
        return await task(
          admission === undefined
            ? topicWallet
            : {
                ...topicWallet,
                walletState:
                  topicWallet.walletState.delegateAdmission(admission),
                walletOperationAdmission: admission,
              }
        );
      } finally {
        enclosingTopicAdmissions.delete(wallet);
      }
    });

  const reconcileTopicOperations = async (
    wallet: EvmWalletHandle,
    admission?: MonadWalletOperationAdmission
  ) => {
    await new MonadTopicPostClient(wallet).resumePendingOperations(admission);
    await new MonadTopicVoteClient(wallet).resumePendingOperations(admission);
  };

  const topics: TopicBroadcastClient = {
    async reconcileOperations(params) {
      const wallet = asMonadWallet(params.wallet, config.networkId);
      await runTopicExclusive(wallet, async (topicWallet) => {
        await topicWallet.walletState!.runOperation((admission) =>
          reconcileTopicOperations(topicWallet, admission)
        );
      });
    },
    async post(params): Promise<{ payloadDigest: string }> {
      const wallet = asMonadWallet(params.wallet, config.networkId);
      return runTopicExclusive(wallet, async (topicWallet) => {
        const client = new MonadTopicPostClient(topicWallet);
        const policy = creatorForumPolicy(topicWallet);
        return topicWallet.walletState!.runOperation(async (admission) => {
          await reconcileTopicOperations(topicWallet, admission);
          if (
            params.direction !== "up" ||
            params.voteWeightWei < 1n ||
            params.voteWeightWei > 9223372036854775807n
          )
            throw new Error(
              "Canonical post burn must be up and within 1..i64::MAX"
            );
          const timestampMs = Date.now();
          if (params.entries.length > 0) {
            encodeForumPost({
              network: policy.network,
              topic: params.topic,
              entries: params.entries,
              parentHash: params.parentDigest
                ? getBytes(`0x${params.parentDigest}`)
                : undefined,
              authored: {
                seconds: BigInt(Math.floor(timestampMs / 1000)),
                nanoseconds: (timestampMs % 1000) * 1000000,
              },
            });
          }
          const burn = await prepareTopicBurnAccount(
            wallet,
            params.voteWeightWei,
            params.onPreparationProgress
          );
          const result = await client
            .submitTopicPost(
              {
                topic: params.topic,
                entries: params.entries,
                timestampMs,
                parentPostHash: params.parentDigest
                  ? getBytes(`0x${params.parentDigest}`)
                  : undefined,
                direction: params.direction,
                burnAddress: policy.burnAddress,
                voteWeightWei: params.voteWeightWei,
                ...burn,
              },
              admission
            )
            .finally(() => wallet.pool.releaseClaim(burn.leaseHolder))
            .catch((err: unknown) => {
              if (err instanceof MonadTopicPostAbandonedError) {
                throw new TopicPostOutcomeUnknownError(err.message, err);
              }
              return asNothingSent(err);
            });
          return { payloadDigest: result.payloadHashHex };
        });
      });
    },

    async vote(params): Promise<void> {
      const wallet = asMonadWallet(params.wallet, config.networkId);
      await runTopicExclusive(wallet, async (topicWallet) => {
        const client = new MonadTopicVoteClient(topicWallet);
        const policy = creatorForumPolicy(topicWallet);
        await topicWallet.walletState!.runOperation(async (admission) => {
          await reconcileTopicOperations(topicWallet, admission);
          if (
            (params.direction !== "up" && params.direction !== "down") ||
            params.voteWeightWei < 1n ||
            params.voteWeightWei > 9223372036854775807n
          )
            throw new Error("Canonical vote burn must be within 1..i64::MAX");
          const targetPayloadHash = getBytes(`0x${params.payloadDigest}`);
          if (targetPayloadHash.length !== 32)
            throw new Error("Canonical vote requires a T1 digest");
          const burn = await prepareTopicBurnAccount(
            wallet,
            params.voteWeightWei,
            params.onPreparationProgress
          );
          await client
            .castVote(
              {
                targetPayloadHash,
                direction: params.direction,
                burnAddress: policy.burnAddress,
                voteWeightWei: params.voteWeightWei,
                ...burn,
              },
              admission
            )
            .finally(() => wallet.pool.releaseClaim(burn.leaseHolder))
            .catch(asNothingSent);
        });
      });
    },

    async fetchByTopic(params): Promise<ForumMessage[]> {
      const wallet = params.wallet
        ? asMonadWallet(params.wallet, config.networkId)
        : undefined;
      return fetchMonadTopicPostsSince({
        relayBaseUrl: wallet?.relayBaseUrl ?? config.relayBaseUrl,
        topic: params.topic,
        sinceMs: params.sinceMs,
        policy: wallet
          ? creatorForumPolicy(privateTopicWallets.get(wallet) ?? wallet)
          : forumPolicy,
      });
    },

    async fetchOne(payloadDigest): Promise<ForumMessage | undefined> {
      return fetchMonadTopicPostView({
        relayBaseUrl: config.relayBaseUrl,
        payloadHashHex: payloadDigest,
        policy: forumPolicy,
      });
    },
    async discoverTopics() {
      return fetchDiscoveredTopics({
        relayBaseUrl: config.relayBaseUrl,
        policy: forumPolicy,
      });
    },
  };

  return {
    runWalletExclusive,
    runMainAccountExclusive,
    runUnjournalledTransfer,
    releaseSettledMainAccounts,
    blockWatchers,
    mainAccountHolder,
    forumPolicy,
    directMessages,
    nativeTransfers,
    topics,
  };
}
