import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import {
  JsonRpcProvider,
  Wallet,
  getAddress,
  type TransactionReceipt,
} from "ethers";

import {
  DirectMessageAlreadyAttemptedError,
  isDirectMessageNotAttempted,
  type ActiveChain,
} from "@frank/wallet/chain/active-chain";
import {
  createEvmChain,
  installCanonicalDirectory,
  loadMonadChainConfigFromEnv,
} from "@frank/wallet/chain/monad-chain";
import type { EvmChainWalletHandle } from "@frank/wallet/evm-wallet-handle";

import {
  fetchMonadProfilesSince,
  decodeProfileBytes,
  MONAD_IDENTITY_DERIVATION_PATH,
} from "@frank/wallet/monad-identity";
import { bip32MasterFromDomainRoot } from "@frank/wallet/bip32-domain-root";
import { canonicalNetworkDescriptor } from "@frank/cashweb/relay/canonical-dm-transport";
import {
  MonadMailboxAuthError,
  MonadMailboxRetryableError,
} from "@frank/cashweb/relay/monad-mailbox-client";
import type { MessageItem } from "@frank/cashweb/types/messages";
import { installMessageItemRegistry } from "@frank/wallet/chain/monad-canonical-dm";
import { createDefaultMessageItemRegistry } from "@frank/wallet/message-item-plugins/default-registry";
import { pluginCapabilitiesNotYetAvailable } from "@frank/wallet/message-item-plugins/registry";
import type {
  DirectMessageSendResult,
  StampPaymentInfo,
} from "@frank/wallet/chain/active-chain";

import {
  toChainAddress,
  type BotContext,
  type BotHostOptions,
  type BotMessageContext,
  type BotSendOptions,
  type FrankBotDefinition,
  type NewUserEvent,
  type PreparedReply,
} from "./types";
import { EVMNonceSequencer } from "./nonce-sequencer";
import { LevelBotStateStore } from "./state-store";
import {
  InboundOperationStore,
  inboundIdentity,
  inboundOrder,
  conversationIdentity,
  replyMessageId,
  type InboundIdentity,
} from "./inbound-operation-store";
import { admitBotProfile } from "./bot-profile-admission";
import { DirectoryManager } from "./directory-manager";
import { RelayProfileManager } from "./relay-profile-manager";
import { LoopGuard } from "./loop-guard";
import { PeerLaneQueue } from "./peer-queue";
import { LevelSubscriptionManager } from "./subscription-manager";
import { BotScheduler } from "./scheduler";

// A retained message that fetches stop returning is never dropped on a guess; it waits. Twenty
// default poll intervals is past any brief relay or directory lapse and soon enough to act on.
const UNMATCHED_WARN_MS = 60_000;

// A reply a handler sends itself and the wallet refused without attempting is sent again on later
// polls: this many sends in all, then the handler is told it failed. A waiting reply keeps its
// handler suspended and its peer's lane occupied, so the bound is short. Five polls is past an
// earlier payment settling or a directory lookup recovering.
const MAX_REPLY_SENDS = 5;

// A stored reply is sent again on every poll until it is delivered, but not for ever: after this
// long it is given up, at error level, and its conversation goes on.
const REPLY_GIVE_UP_MS = 60 * 60_000;

/** What a peer is told when its message could not be handled, so it is never met with silence. */
export const FAILED_REPLY_TEXT =
  "Sorry, I couldn't handle that message just now. Please send it again.";

// The account a bot pays transfers (game payouts) from: topped up from the shared funding wallet
// when it holds less than the first amount, up to the second. Defaults; see `BotHostOptions`.
// 0.3 / 0.5 MON: above the largest payout the games advertise (about 0.25 MON), and ten bots
// starting from nothing draw under 10 MON.
const TOP_UP_BELOW_WEI = 300_000_000_000_000_000n;
const TOP_UP_TO_WEI = 500_000_000_000_000_000n;
// What bot top-ups leave in the shared funding wallet: the faucet pays its grants from the same
// wallet and keeps this reserve itself (`FAUCET_MIN_RESERVE_WEI`, 0.1 MON when unset; the
// faucet's own default lives in packages/bot/faucet-core.ts and must stay the same figure).
const FUNDING_RESERVE_WEI = 100_000_000_000_000_000n;
// The account a bot's wallet pays message stamps from spends far less.
const STAMP_TOP_UP_BELOW_WEI = 100_000_000_000_000_000n;
const STAMP_TOP_UP_TO_WEI = 500_000_000_000_000_000n;
// How long a look at a message's payment transactions may take before the reply is stamped as
// if nothing was confirmed. Short: the reply does not wait for a slow node.
const PAYMENT_CHECK_MS = 3_000;
// Balances are looked at this often, and a failed top-up is tried again this soon.
const TOP_UP_CHECK_MS = 30_000;
// After a top-up was sent, none is sent for this long, whatever the balance reads meanwhile.
const TOP_UP_INTERVAL_MS = 5 * 60_000;
const TOP_UP_RECEIPT_MS = 60_000;

// One relay or wallet question of a poll may take this long. Past it that bot's poll ends with
// an error and its next poll starts afresh; the other bots never waited for it.
const POLL_CALL_TIMEOUT_MS = 30_000;

/** `call`, or a rejection naming `what` once it has taken `limitMs`. */
function bounded<T>(
  call: Promise<T>,
  what: string,
  limitMs: number
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} took over ${limitMs / 1000}s`)),
      limitMs
    );
    timer.unref?.();
  });
  return Promise.race([call, late]).finally(() => clearTimeout(timer));
}

/** A bot's own account cannot pay for a transaction its handler asked for. Nothing was signed or
 * sent. The host tops the account up on its poll, a bounded amount at a time; the payout is the
 * handler's to keep and make again once the balance covers it. */
export class BotBalanceShortError extends Error {
  constructor(
    readonly botId: string,
    readonly balanceWei: bigint,
    readonly neededWei: bigint
  ) {
    super(
      `Bot "${botId}" holds ${balanceWei} wei and this transaction needs ${neededWei}. Nothing was sent; it can be made again after the bot's account is topped up.`
    );
    this.name = "BotBalanceShortError";
  }
}

/** An account the shared funding wallet keeps topped up: to `toWei` when under `belowWei`. */
interface FundingTarget {
  addr: string;
  label: string;
  belowWei: bigint;
  toWei: bigint;
}

/** A replies-per-peer budget as configured: unset, or a non-negative integer. Anything else is a
 * configuration error, never silently the default. */
function replyBudget(
  value: number | string | undefined,
  name: string
): number | undefined {
  if (value === undefined) return undefined;
  const budget = typeof value === "number" ? value : Number(value);
  if (
    !Number.isSafeInteger(budget) ||
    budget < 0 ||
    String(value).trim() === ""
  )
    throw new Error(`${name} must be a non-negative integer, got "${value}"`);
  return budget;
}

interface ActiveBotInstance {
  definition: FrankBotDefinition;
  wallet: EvmChainWalletHandle;
  state: LevelBotStateStore;
  operations: InboundOperationStore;
  tasks: Set<Promise<unknown>>;
  directory: DirectoryManager;
  uninstallDirectory: () => void;
  loopGuard: LoopGuard;
  peerQueue: PeerLaneQueue;
  context: BotContext;
  lastPollTimestamp: number;
  /** This bot's poll pass, while one runs. */
  polling?: Promise<void>;
  lastAuthRecoveryMs?: number;
  inFlightDigests: Set<string>;
  /** Deferred digests no fetch has returned: when first missed, and when last warned. Log only. */
  unmatched: Map<string, { since: number; warned: number }>;
  /** Peers that reached the reply budget: whether their profile says they are a bot. */
  botPeers: Map<string, boolean>;
  /** Stored replies whose failed send was already logged. */
  sendWarned: Set<string>;
  /** A retry pass over unsent stored replies is running. */
  retrying: boolean;
  /** The row the last retry pass ended on; the next pass starts after it. */
  refused?: string;
  /** The accounts the shared funding wallet keeps topped up. */
  fundingTargets: FundingTarget[];
  /** What each unfinished message was confirmed to have paid, once looked up. */
  confirmedPaid: Map<string, bigint>;
  toppingUp: boolean;
  /** No balance is read before this time. */
  nextTopUpMs: number;
  /** Direct replies waiting for this bot's next poll pass before they are sent again. */
  pollWaiters: Set<() => void>;
  evmMainPrivateKey?: string;
}

export class FrankBotHost {
  private readonly options: Required<
    Omit<BotHostOptions, "maxRepliesPerPeer">
  > &
    Pick<BotHostOptions, "maxRepliesPerPeer">;
  private readonly provider: JsonRpcProvider;
  private readonly chain: ActiveChain;
  private readonly fundingWallet?: Wallet;
  private readonly nonceSequencer?: EVMNonceSequencer;
  private readonly instances = new Map<string, ActiveBotInstance>();
  /** Bots whose fund-ahead failure was already logged. */
  private readonly fundAheadWarned = new Set<string>();
  /** Bots whose wallet-wide retry is failing; warned when it starts failing, not every poll. */
  private readonly walletRetryWarned = new Set<string>();
  private readonly registrationListeners = new Set<
    (user: NewUserEvent) => void | Promise<void>
  >();

  private running = false;
  private closing = false;
  /** Aborted when the host starts stopping; handlers hand it to what they wait on. */
  private readonly stopController = new AbortController();
  private pollTimer?: NodeJS.Timeout;
  private registrationTimer?: NodeJS.Timeout;
  private lastRegistrationPollMs = 0;
  private readonly scheduler = new BotScheduler();
  private stopPromise?: Promise<void>;
  private resolveStop?: () => void;

  getScheduler(): BotScheduler {
    return this.scheduler;
  }

  get fundingWalletAddress(): string | undefined {
    return this.fundingWallet?.address;
  }

  constructor(options: BotHostOptions) {
    const envConfig = loadMonadChainConfigFromEnv();
    const networkTag =
      options.networkTag ?? (envConfig.networkTag as "MONT" | "MON1") ?? "MONT";
    const relayBaseUrl = options.relayBaseUrl ?? envConfig.relayBaseUrl;
    const rpcUrl =
      options.rpcUrl ??
      process.env.MONAD_RPC_URL ??
      "https://testnet-rpc.monad.xyz";

    this.options = {
      relayBaseUrl,
      networkTag,
      stateDir:
        options.stateDir ??
        process.env.BOT_STATE_DIR ??
        join(homedir(), ".frank-bots"),
      rpcUrl,
      fundingPrivateKeyHex: (() => {
        if (options.fundingPrivateKeyHex) return options.fundingPrivateKeyHex;
        if (process.env.E2E_DEMO_MAIN_WALLET_PRIVATE_KEY)
          return process.env.E2E_DEMO_MAIN_WALLET_PRIVATE_KEY;
        const candidates = [
          process.env.FRANK_DEMO_FAUCET_WALLET_JSON,
          process.env.E2E_DEMO_MAIN_WALLET_JSON,
        ].filter(Boolean) as string[];
        for (const raw of candidates) {
          const resolvedPaths = [
            raw,
            resolve(process.cwd(), raw),
            resolve(__dirname, "../../..", raw),
            resolve(__dirname, "../../../..", raw),
          ];
          for (const p of resolvedPaths) {
            if (existsSync(p)) {
              try {
                const parsed = JSON.parse(readFileSync(p, "utf8"));
                const key = parsed.privateKey ?? parsed.privateKeyHex;
                if (key) return key;
              } catch {
                // ignore invalid file
              }
            }
          }
        }
        return "";
      })(),
      stampValueWei:
        options.stampValueWei ??
        envConfig.defaultStampValueWei ??
        10_000_000_000_000_000n,
      minStampValueWei:
        options.minStampValueWei ??
        BigInt(process.env.CASHWEB_STAMP_MIN_BURN_VALUE_WEI || "1000000000000"),
      pollIntervalMs: options.pollIntervalMs ?? 3000,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? 30 * 60 * 1000,
      watchRegistrations: options.watchRegistrations ?? true,
      unrefTimers: options.unrefTimers ?? false,
      maxRepliesPerPeer: replyBudget(
        options.maxRepliesPerPeer ??
          (process.env.FRANK_BOT_MAX_REPLIES_PER_PEER || undefined),
        options.maxRepliesPerPeer === undefined
          ? "FRANK_BOT_MAX_REPLIES_PER_PEER"
          : "maxRepliesPerPeer"
      ),
      replyGiveUpMs: options.replyGiveUpMs ?? REPLY_GIVE_UP_MS,
      callTimeoutMs: options.callTimeoutMs ?? POLL_CALL_TIMEOUT_MS,
      topUpBelowWei:
        options.topUpBelowWei ??
        BigInt(process.env.FRANK_BOT_TOP_UP_BELOW_WEI || TOP_UP_BELOW_WEI),
      topUpToWei:
        options.topUpToWei ??
        BigInt(process.env.FRANK_BOT_TOP_UP_TO_WEI || TOP_UP_TO_WEI),
      fundingReserveWei:
        options.fundingReserveWei ??
        BigInt(process.env.FAUCET_MIN_RESERVE_WEI || FUNDING_RESERVE_WEI),
    };

    if (this.options.topUpToWei <= this.options.topUpBelowWei)
      throw new Error(
        `Bot top-up target (${this.options.topUpToWei} wei, FRANK_BOT_TOP_UP_TO_WEI) must be greater than its threshold (${this.options.topUpBelowWei} wei, FRANK_BOT_TOP_UP_BELOW_WEI)`
      );

    const cursorFile = join(this.options.stateDir, "registration-cursor.json");
    if (existsSync(cursorFile)) {
      try {
        const saved = JSON.parse(readFileSync(cursorFile, "utf8"));
        if (typeof saved.sinceMs === "number") {
          this.lastRegistrationPollMs = saved.sinceMs;
        }
      } catch {
        // ignore invalid file
      }
    }

    const rpcUrls = this.options.rpcUrl
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const primaryRpcUrl = rpcUrls[0] || "https://testnet-rpc.monad.xyz";

    this.provider = new JsonRpcProvider(primaryRpcUrl);
    this.chain = createEvmChain({
      ...envConfig,
      relayBaseUrl: this.options.relayBaseUrl,
      networkTag: this.options.networkTag,
      walletStorageLocation: join(this.options.stateDir, "chain-storage"),
      defaultStampValueWei: this.options.stampValueWei,
    });

    if (this.options.fundingPrivateKeyHex) {
      this.fundingWallet = new Wallet(
        this.options.fundingPrivateKeyHex,
        this.provider
      );
      this.nonceSequencer = new EVMNonceSequencer(
        this.provider,
        this.fundingWallet.address
      );
      console.log(
        `[bot-host] initialized shared funding wallet: ${this.fundingWallet.address}`
      );
    }
  }

  /** Registers several bots on this host, one after another. A bot that cannot be built or
   * registered is reported by name and left out; the others are registered and served. Each
   * entry is a definition or a function that makes one, so a bot whose own construction fails
   * (a missing setting) is held to the same rule. Returns the ids that failed. */
  async registerAll(
    bots: readonly (FrankBotDefinition | (() => FrankBotDefinition))[]
  ): Promise<string[]> {
    const failed: string[] = [];
    for (const [index, entry] of bots.entries()) {
      let name = `#${index + 1}`;
      try {
        const definition = typeof entry === "function" ? entry() : entry;
        name = definition.id;
        await this.register(definition);
      } catch (error) {
        failed.push(name);
        console.error(
          `[bot-host] Bot "${name}" could not be started and is left out; the other bots keep running:`,
          error instanceof Error ? error.message : error
        );
      }
    }
    return failed;
  }

  async register(definition: FrankBotDefinition): Promise<void> {
    if (this.closing) throw new Error("Bot host is closed");
    if (this.instances.has(definition.id)) {
      throw new Error(`Bot with id "${definition.id}" is already registered`);
    }

    // Admit before root adoption, wallet opening or registration effects. A new state path
    // paired with a previously provisioned identity is not a fresh financial profile.
    const network = canonicalNetworkDescriptor(this.options.networkTag).network;
    if (this.chain.chainIdentifier !== network)
      throw new Error("Bot canonical network mismatch");
    const { botStateDir, state, operations, roots } = await admitBotProfile({
      stateDir: this.options.stateDir,
      botId: definition.id,
      identityPath: definition.defaultIdentityPath,
      network,
    });
    let openedWallet: EvmChainWalletHandle | undefined;
    let openedDirectory: DirectoryManager | undefined;
    let uninstall: (() => void) | undefined;
    try {
      const wallet = (await this.chain.createWallet(
        roots
      )) as EvmChainWalletHandle;
      openedWallet = wallet;
      if (
        wallet.identity.address.raw.toLowerCase() !==
          operations.owner.address ||
        Buffer.from(wallet.identity.compressedPubKey).toString("hex") !==
          operations.owner.subject
      )
        throw new Error("Bot wallet admission binding mismatch");
      const botAddress = wallet.identity.address.raw;
      const botSubject = operations.owner.subject;
      const evmMainPrivateKey = bip32MasterFromDomainRoot(
        roots.evm,
        "evm-wallet"
      ).derivePath(MONAD_IDENTITY_DERIVATION_PATH).privateKey;

      // 4. Open and publish Open Directory entry
      const directory = DirectoryManager.create({
        handle: wallet,
        networkTag: this.options.networkTag,
        relayBaseUrl: this.options.relayBaseUrl,
        location: join(botStateDir, "directory"),
      });

      openedDirectory = directory;
      if (directory.network !== operations.owner.chainIdentifier)
        throw new Error("Bot directory network mismatch");
      await directory.publishWithRetry(definition.id);
      directory.startHeartbeat(this.options.heartbeatIntervalMs);

      // Install canonical directory so chain.directMessages routes through canonical directory
      const removeDirectory = installCanonicalDirectory(
        wallet,
        directory.rawDirectory
      );
      // The message-item plugins this bot's wallet sends and receives with.
      const removeMessageItems = installMessageItemRegistry(
        wallet,
        createDefaultMessageItemRegistry(pluginCapabilitiesNotYetAvailable)
      );
      const uninstallDirectory = () => {
        removeDirectory();
        removeMessageItems();
      };
      uninstall = uninstallDirectory;

      // 5. Register Frank metadata profile on relay
      const profile = definition.getProfile();
      await RelayProfileManager.registerProfile({
        relayBaseUrl: this.options.relayBaseUrl,
        identity: wallet.identity,
        label: definition.id,
        profile,
        network: directory.network,
      });

      // 6. Fund the bot from the shared funding wallet, if there is one. The same top-up runs
      // again on the poll whenever a balance has fallen under the threshold.
      // The faucet sends its grants straight from the funding wallet, so its identity address
      // needs nothing; its messages are still paid from its own receive address.
      const fundingTargets: FundingTarget[] = this.fundingWallet
        ? [
            ...(definition.id === "faucet"
              ? []
              : [
                  {
                    // Pays the bot's transfers: `sendTransfer`, a game's payouts.
                    addr: botAddress,
                    label: "Identity address",
                    belowWei: this.options.topUpBelowWei,
                    toWei: this.options.topUpToWei,
                  },
                ]),
            {
              // Pays the stamps on the bot's messages.
              addr: (await wallet.getReceiveAddress()).raw,
              label: "EVM main account",
              belowWei: STAMP_TOP_UP_BELOW_WEI,
              toWei: STAMP_TOP_UP_TO_WEI,
            },
          ].filter(
            // One account under two names is topped up once, by the larger rule (the first).
            (target, index, all) =>
              all.findIndex(
                (other) =>
                  other.addr.toLowerCase() === target.addr.toLowerCase()
              ) === index
          )
        : [];
      // A payout larger than the threshold can find the account holding less than it owes
      // and above the threshold, where no top-up follows. Said at start, by name.
      if (
        definition.maxPayoutWei !== undefined &&
        (!this.fundingWallet ||
          definition.maxPayoutWei > this.options.topUpBelowWei)
      )
        console.warn(
          `[bot-host] Bot "${definition.id}" can owe a single payout of ${
            definition.maxPayoutWei
          } wei, but ${
            this.fundingWallet
              ? `its account is only topped up when under ${this.options.topUpBelowWei} wei: raise FRANK_BOT_TOP_UP_BELOW_WEI (and FRANK_BOT_TOP_UP_TO_WEI) to at least that payout`
              : "no funding wallet is configured to top its account up"
          }. Such a payout can fail until the account is funded.`
        );
      await this.fundBot(definition.id, fundingTargets);

      // 7. Wire up loop guard and peer queue
      // The operator's setting first, then what the bot declares, then the guard's default.
      const loopGuard = new LoopGuard({
        selfAddress: botAddress,
        maxRepliesPerPeer:
          this.options.maxRepliesPerPeer ??
          replyBudget(
            definition.maxRepliesPerPeer,
            `Bot "${definition.id}" maxRepliesPerPeer`
          ),
      });
      const peerQueue = new PeerLaneQueue();

      // Transactions from the bot's own key are built one at a time: two built at once would
      // read the same pending nonce.
      const ownTransactions = new EVMNonceSequencer(this.provider, botAddress);

      // 8. Assemble BotContext
      const subscriptions = new LevelSubscriptionManager(
        state.sublevel("subscriptions"),
        async (recipientAddress: string, items: MessageItem[]) => {
          return this.sendCanonicalMessage(wallet, recipientAddress, items);
        }
      );

      const context: BotContext = {
        botId: definition.id,
        address: botAddress,
        subject: botSubject,
        relayBaseUrl: this.options.relayBaseUrl,
        networkTag: this.options.networkTag,
        provider: this.provider,
        state,
        subscriptions,
        stopping: this.stopController.signal,

        lookupPeer: (addr: string) => directory.lookupPeer(addr),

        sendMessage: async (
          recipientAddress: string,
          items,
          conversationId?: string,
          options?: BotSendOptions
        ) => {
          return this.sendCanonicalMessage(
            wallet,
            recipientAddress,
            items,
            conversationId,
            options
          );
        },

        sendDirectMessage: async (
          recipientAddress: string,
          items,
          conversationId?: string,
          options?: BotSendOptions
        ) => {
          return this.sendCanonicalMessage(
            wallet,
            recipientAddress,
            items,
            conversationId,
            options
          );
        },

        onNewUserRegistered: (cb) => {
          this.registrationListeners.add(cb);
        },

        sendTransaction: async ({ to, data, valueWei = 0n }) => {
          if (
            definition.id === "faucet" &&
            this.fundingWallet &&
            this.nonceSequencer
          ) {
            return this.nonceSequencer.withNonce(async (nonce) => {
              const tx = await this.fundingWallet!.sendTransaction({
                to,
                data: data ?? "0x",
                value: valueWei,
                nonce,
              });
              return { txHash: tx.hash };
            });
          }

          return ownTransactions.runExclusive(async () => {
          const botWallet = new Wallet(
            wallet.identity.toPrivateKeyHex(),
            this.provider
          );
          const botBalance = await this.provider.getBalance(botAddress);
          const feeData = await this.provider.getFeeData();
          const gasPrice = feeData.gasPrice ?? 1_000_000_000n;
          const gasLimit = data && data !== "0x" ? 250_000n : 21_000n;
          const needed = valueWei + gasLimit * gasPrice;

          // A bot pays from its own balance. A handler cannot make the shared funding wallet
          // pay: that wallet only makes the host's bounded top-up, on the poll.
          if (botBalance < needed)
            throw new BotBalanceShortError(definition.id, botBalance, needed);

          let tx: any;
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              const nextNonce = await this.provider.getTransactionCount(
                botAddress,
                "pending"
              );
              tx = await botWallet.sendTransaction({
                to,
                data: data ?? "0x",
                value: valueWei,
                nonce: nextNonce,
              });
              break;
            } catch (err: any) {
              const isNonceError =
                String(err).includes("nonce") ||
                String(err).includes("NONCE_EXPIRED") ||
                err?.code === "NONCE_EXPIRED";
              if (isNonceError && attempt < 3) {
                await new Promise((r) => setTimeout(r, 600 * attempt));
                continue;
              }
              throw err;
            }
          }
          return { txHash: tx.hash };
          });
        },

        sendTransfer: async ({ to, valueWei }) => {
          return context.sendTransaction({ to, data: "0x", valueWei });
        },

        buildAndSignTransfer: async ({ to, valueWei }) => {
          if (
            definition.id === "faucet" &&
            this.fundingWallet &&
            this.nonceSequencer
          ) {
            return this.nonceSequencer.withNonce(async (nonce) => {
              const populated = await this.fundingWallet!.populateTransaction({
                to,
                value: valueWei,
                nonce,
              });
              const rawTx = await this.fundingWallet!.signTransaction(
                populated
              );
              const txHash = (await this.provider.broadcastTransaction(rawTx))
                .hash;
              return { rawTx, txHash };
            });
          }

          return ownTransactions.runExclusive(async () => {
          const botWallet = new Wallet(
            wallet.identity.toPrivateKeyHex(),
            this.provider
          );
          const botBalance = await this.provider.getBalance(botAddress);
          const feeData = await this.provider.getFeeData();
          const gasPrice = feeData.gasPrice ?? 1_000_000_000n;
          const gasLimit = 21_000n;
          const needed = valueWei + gasLimit * gasPrice;

          // A bot pays from its own balance. A handler cannot make the shared funding wallet
          // pay: that wallet only makes the host's bounded top-up, on the poll.
          if (botBalance < needed)
            throw new BotBalanceShortError(definition.id, botBalance, needed);

          const populated = await botWallet.populateTransaction({
            to,
            value: valueWei,
          });
          const rawTx = await botWallet.signTransaction(populated);
          const txHash = (await this.provider.broadcastTransaction(rawTx)).hash;
          return { rawTx, txHash };
          });
        },

        waitForReceipt: async (
          txHash: string,
          timeoutMs = 60_000
        ): Promise<TransactionReceipt | null> => {
          return this.provider.waitForTransaction(txHash, 1, timeoutMs);
        },

        attemptStatus: async (payloadDigest: string) =>
          (
            await this.chain.directMessages.reconcileAttempts({
              wallet,
              payloadDigests: [payloadDigest],
            })
          )[payloadDigest] ?? "unknown",

        getBalance: async (address?: string): Promise<bigint> => {
          if (address) {
            return this.provider.getBalance(address);
          }
          if (definition.id === "faucet" && this.fundingWallet) {
            return this.provider.getBalance(this.fundingWallet.address);
          }
          return this.provider.getBalance(botAddress);
        },

        publishTopicMessage: async ({ topic, entries, voteWeightWei }) => {
          return this.chain.topics.post({
            wallet,
            topic,
            entries,
            direction: "up",
            voteWeightWei: voteWeightWei ?? this.options.stampValueWei,
          });
        },
      };

      // A transfer that fails, for whatever reason, is said at error level here, whatever the
      // handler then does with the rejection: money a bot owed was not sent.
      const transfers = context as {
        -readonly [K in "sendTransaction" | "buildAndSignTransfer"]: BotContext[K];
      };
      for (const name of ["sendTransaction", "buildAndSignTransfer"] as const) {
        const inner = transfers[name] as (params: {
          to: string;
          valueWei?: bigint;
        }) => Promise<never>;
        transfers[name] = (async (params: { to: string; valueWei?: bigint }) => {
          try {
            return await inner(params);
          } catch (error) {
            console.error(
              `[bot-host] [${definition.id}] TRANSFER FAILED: ${
                params.valueWei ?? 0n
              } wei to ${params.to} was not sent:`,
              error instanceof Error ? error.message : error
            );
            throw error;
          }
        }) as never;
      }

      let savedCursor = 0;
      try {
        const cursorStr = await state.get("cursor:lastPollTimestamp");
        if (cursorStr) savedCursor = parseInt(cursorStr, 10);
      } catch {
        // ignore
      }

      const instance: ActiveBotInstance = {
        definition,
        wallet,
        state,
        operations,
        tasks: new Set(),
        directory,
        uninstallDirectory,
        loopGuard,
        peerQueue,
        context,
        lastPollTimestamp:
          savedCursor > 0 ? savedCursor : Date.now() - 24 * 3600_000,
        inFlightDigests: new Set<string>(),
        unmatched: new Map(),
        botPeers: new Map(),
        sendWarned: new Set<string>(),
        retrying: false,
        fundingTargets,
        confirmedPaid: new Map(),
        toppingUp: false,
        nextTopUpMs: Date.now() + TOP_UP_CHECK_MS,
        pollWaiters: new Set(),
        evmMainPrivateKey,
      };

      this.instances.set(definition.id, instance);

      if (definition.schedules) {
        for (const schedule of definition.schedules) {
          this.scheduler.register(definition.id, schedule, context);
        }
      }

      if (definition.onStart) {
        await definition.onStart(context);
      }
      console.log(
        `[bot-host] Bot "${definition.id}" is ready at address ${botAddress}`
      );
    } catch (error) {
      this.instances.delete(definition.id);
      uninstall?.();
      await Promise.allSettled([
        operations.close(),
        openedDirectory?.close(),
        openedWallet?.close(),
      ]);
      await state.close();
      throw error;
    }
  }

  async start(): Promise<void> {
    if (this.closing) throw new Error("Bot host is closed");
    if (this.running) return;
    this.running = true;

    // Set up shutdown hooks
    const shutdown = async () => {
      console.log("\n[bot-host] shutting down hosted bots...");
      await this.stop();
      process.exit(0);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);

    // Start message polling loop
    console.log(
      `[bot-host] Polling messages (/message/monad/inbox) every ${this.options.pollIntervalMs}ms`
    );
    this.pollTimer = setInterval(() => {
      void this.pollAllBots();
    }, this.options.pollIntervalMs);

    // Start registration watcher if enabled
    if (this.options.watchRegistrations) {
      if (typeof this.lastRegistrationPollMs !== "number") {
        this.lastRegistrationPollMs = 0;
      }
      void this.pollRegistrations();
      this.registrationTimer = setInterval(() => {
        void this.pollRegistrations();
      }, 5000);
    }

    if (this.options.unrefTimers) {
      this.pollTimer.unref();
      if (this.registrationTimer) this.registrationTimer.unref();
    }

    // Start background event scheduler
    this.scheduler.start();

    console.log(
      `[bot-host] FrankBotHost started (${this.instances.size} bots running)`
    );
  }

  async waitUntilStopped(): Promise<void> {
    if (!this.running) return;
    if (!this.stopPromise) {
      this.stopPromise = new Promise((resolve) => {
        this.resolveStop = resolve;
      });
    }
    return this.stopPromise;
  }

  /** One poll pass of every bot. Each bot polls on its own: a relay call that hangs or fails for
   * one bot holds only that bot. Single flight per bot: a tick that finds a bot's pass still
   * running joins it instead of starting a second one. Resolves when every pass has ended. */
  private pollAllBots(): Promise<void> {
    return Promise.all(
      [...this.instances.entries()].map(
        ([id, instance]) =>
          (instance.polling ??= this.pollOnce(id, instance).finally(() => {
            instance.polling = undefined;
          }))
      )
    ).then(() => undefined);
  }

  /**
   * Asks the wallet to fund the next message's sender accounts ahead of time, if its chain has
   * such accounts. Not awaited: the wallet runs one pass at a time and answers at once when the
   * accounts are ready. A failure is the wallet's to resume and is logged once per bot.
   */
  private fundAhead(id: string, instance: ActiveBotInstance): void {
    const failed = (error: unknown) => {
      if (this.fundAheadWarned.has(id)) return;
      this.fundAheadWarned.add(id);
      console.warn(
        `[bot-host] [${id}] Funding ahead failed; replies fund their own accounts:`,
        error instanceof Error ? error.message : error
      );
    };
    try {
      void this.chain.directMessages
        .fundAhead?.({ wallet: instance.wallet })
        .catch(failed);
    } catch (error) {
      failed(error);
    }
  }

  /** Tops up, from the shared funding wallet, each of a bot's accounts that holds less than the
   * threshold. "sent": a funding transaction was handed to the node. "failed": an account could
   * not be looked at or funded; nothing is lost, the next call tries again. */
  private async fundBot(
    id: string,
    targets: readonly FundingTarget[]
  ): Promise<"sent" | "idle" | "failed"> {
    if (!this.fundingWallet || !this.nonceSequencer) return "idle";
    let outcome: "sent" | "idle" | "failed" = "idle";
    for (const target of targets) {
      let sent = false;
      try {
        const bal = await this.provider.getBalance(target.addr);
        if (bal >= target.belowWei) continue;
        const funderBal = await this.provider.getBalance(
          this.fundingWallet.address
        );
        // Up to the target, and never into the funding wallet's reserve.
        const wanted = target.toWei - bal;
        const spare = funderBal - this.options.fundingReserveWei;
        const fundAmount = wanted < spare ? wanted : spare;
        if (fundAmount <= 10_000_000_000_000_000n) {
          outcome = outcome === "sent" ? "sent" : "failed";
          console.error(
            `[bot-host] FUNDING WALLET EXHAUSTED: ${this.fundingWallet.address} holds ${funderBal} wei, of which ${this.options.fundingReserveWei} is the reserve left for the faucet. ${target.label} (${target.addr}) of bot ${id} was not topped up`
          );
          continue;
        }
        // The shared sequence is held only while the transfer is built and handed to the
        // node, never while it is mined: one slow transfer must not stall every bot's top-up
        // and the faucet.
        const tx = await this.nonceSequencer.withNonce((nonce) =>
          this.fundingWallet!.sendTransaction({
            to: target.addr,
            value: fundAmount,
            nonce,
          })
        );
        sent = true;
        outcome = "sent";
        try {
          await tx.wait(1, TOP_UP_RECEIPT_MS);
        } catch (waitError) {
          // Not seen mined in time: it may still land, or the node may have dropped it. The
          // next transfer takes its nonce from the node's pending count, which says which.
          this.nonceSequencer.resetNonce();
          throw waitError;
        }
        console.log(
          `[bot-host] Topped up ${target.label} (${target.addr}) of bot ${id}`
        );
      } catch (fundErr) {
        if (!sent && outcome !== "sent") outcome = "failed";
        console.warn(
          `[bot-host] Failed funding ${target.label} (${target.addr}) of bot ${id}; it is tried again on a later poll:`,
          fundErr instanceof Error ? fundErr.message : fundErr
        );
      }
    }
    return outcome;
  }

  /** The poll's top-up: every reply is paid from the bot's own account, so a bot funded only at
   * registration runs dry. Not awaited. One at a time for a bot, balances read at most every
   * `TOP_UP_CHECK_MS`, and nothing sent for `TOP_UP_INTERVAL_MS` after a top-up went out. */
  private topUp(id: string, instance: ActiveBotInstance): void {
    if (
      !this.fundingWallet ||
      instance.toppingUp ||
      Date.now() < instance.nextTopUpMs
    )
      return;
    instance.toppingUp = true;
    void this.fundBot(id, instance.fundingTargets)
      .catch(() => "failed" as const)
      .then((outcome) => {
        instance.toppingUp = false;
        instance.nextTopUpMs =
          Date.now() +
          (outcome === "sent" ? TOP_UP_INTERVAL_MS : TOP_UP_CHECK_MS);
      });
  }

  /** A write to the bot's journal failed, and the bot answers nothing while that stands. Said
   * at error level on every poll it lasts, and mended by reading the journal back from disk:
   * a row whose write landed is then seen as written, one whose write did not is as it was, and
   * the poll goes on to finish both. Throws, by name, while the journal cannot be read. */
  private async recoverJournal(
    id: string,
    instance: ActiveBotInstance
  ): Promise<void> {
    console.error(
      `[bot-host] BOT "${id}" IS NOT ANSWERING: a write to its message journal failed. Reading the journal back from disk...`
    );
    try {
      await instance.operations.recover();
    } catch (error) {
      throw new Error(
        `Bot "${id}" still cannot read its message journal and answers nothing; check the disk under its state directory, then restart it (${
          error instanceof Error ? error.message : error
        })`
      );
    }
    // `recover` resolved: the journal was read AND took a write again.
    console.error(
      `[bot-host] Bot "${id}" read its message journal back, wrote to it again, and is answering`
    );
  }

  private async pollOnce(
    id: string,
    instance: ActiveBotInstance
  ): Promise<void> {
    {
      try {
        if (this.closing) return;
        if (instance.operations.isFaulted) await this.recoverJournal(id, instance);
        instance.operations.assertOpen();
        this.topUp(id, instance);
        // Stored replies the wallet already holds an attempt for: the wallet sends the same
        // bytes again and says what became of them. Rows behind the mailbox cursor included.
        let asked = false;
        // Whether a question to the wallet failed in this poll: then nothing is funded ahead.
        let held = false;
        const now = Date.now();
        for (const row of instance.operations.listStarted()) {
          if (this.closing) return;
          if (instance.inFlightDigests.has(row.digest)) continue;
          if (!row.reply) {
            // Started, no handler running and nothing owed: a restart interrupted its handler.
            void this.track(instance, row, () =>
              this.finishInterrupted(instance, row.digest)
            );
            continue;
          }
          const outbound = row.reply.digest;
          // Not with the wallet yet: sent by the retry pass below.
          if (!outbound) continue;
          asked = true;
          let status: string;
          try {
            status =
              (
                await bounded(
                  this.chain.directMessages.reconcileAttempts({
                    wallet: instance.wallet,
                    payloadDigests: [outbound],
                  }),
                  "Asking the wallet about a reply",
          this.options.callTimeoutMs
                )
              )[outbound] ?? "unknown";
          } catch (error) {
            held = true;
            instance.operations.assertOpen(); // a failed journal write faults admission, not just recovery
            console.warn(
              `[bot-host] [${id}] The wallet could not be asked about the reply to ${row.peerAddress}; asked again on the next poll:`,
              error instanceof Error ? error.message : error
            );
            // Not known this poll. The bound below still applies: a question that keeps failing
            // must not keep its conversation waiting for ever.
            status = "unknown";
          }
          if (status === "delivered")
            void this.track(instance, row, () =>
              this.finish(instance, row.digest, true)
            );
          else if (status === "dead")
            void this.track(instance, row, () =>
              this.giveUp(instance, row.digest, "the relay ended its delivery")
            );
          else if (now - row.reply.since >= this.options.replyGiveUpMs)
            void this.track(instance, row, () =>
              this.giveUp(
                instance,
                row.digest,
                "it was paid for but not delivered in time; the wallet keeps its payment and may still deliver it"
              )
            );
        }
        if (this.closing) return;
        // A paid reply this host has no incomplete row for any more is still the wallet's to
        // finish. The wallet retries every unresolved payment it holds whichever ones it is asked
        // about, so when no row asked, ask about none: the same exact bytes are sent again, never
        // a new payment, and with nothing unresolved the wallet makes no request. Not while a
        // handler is sending: its send settles the wallet's earlier payments first, and this
        // poll would only wait behind it. Never at registration.
        if (!asked && instance.inFlightDigests.size === 0) {
          try {
            await bounded(
              this.chain.directMessages.reconcileAttempts({
                wallet: instance.wallet,
                payloadDigests: [],
              }),
              "Retrying the wallet's earlier payments",
          this.options.callTimeoutMs
            );
            this.walletRetryWarned.delete(id);
          } catch (error) {
            held = true;
            if (!this.walletRetryWarned.has(id)) {
              this.walletRetryWarned.add(id);
              console.warn(
                `[bot-host] [${id}] Earlier reply payments could not be retried; preserve state:`,
                error instanceof Error ? error.message : error
              );
            }
          }
          if (this.closing) return;
        }
        // Native transfers this wallet broadcast and nothing has seen confirm: the wallet looks
        // again, within its own request bound (none when nothing is pending). Not awaited, and
        // its failure is not this poll's; a handle without the method has nothing to do.
        try {
          void instance.wallet
            .reobserveNativeOperations?.()
            .catch(() => undefined);
        } catch {
          /* Nothing to do. */
        }
        // Sender accounts for the next reply, funded between polls so that reply does not wait
        // for its own funding (#1235). Here, after this poll's recovery, and never at
        // registration: the wallet moves nothing by being opened. Not in a poll whose recovery
        // failed: until the wallet's earlier payments have been looked at, nothing new is funded.
        if (!held) this.fundAhead(id, instance);
        const messages = await bounded(
          this.chain.directMessages.fetchSince({
            wallet: instance.wallet,
            sinceMs: instance.operations.scanFloor(instance.lastPollTimestamp),
          }),
          "Reading the mailbox",
          this.options.callTimeoutMs
        );
        const accepted: {
          identity: InboundIdentity;
          items: MessageItem[];
          stampValueWei: bigint;
          paymentTxHashes: string[];
          stampPayments: readonly StampPaymentInfo[];
        }[] = [];
        for (const msg of messages) {
          // The scan also returns what this bot sent; that is not inbound work.
          if (msg.outbound) continue;
          try {
            accepted.push({
              identity: inboundIdentity(msg, instance.operations.owner),
              items: structuredClone(msg.items),
              // Only what the wallet read from the delivered stamp payments; anything else is
              // "nothing was paid", never a value taken from the message's own content.
              stampValueWei:
                typeof msg.stampValueWei === "bigint" && msg.stampValueWei > 0n
                  ? msg.stampValueWei
                  : 0n,
              paymentTxHashes: (msg.stampPayments ?? []).map(
                (payment) => payment.txHash
              ),
              stampPayments: structuredClone(msg.stampPayments ?? []),
            });
          } catch {
            console.warn(
              `[bot-host] [${id}] Unsupported inbound identity; no handler admitted`
            );
          }
        }
        // Retain every identity, in handling order, before any handler of this batch can run:
        // a later message must not move the cursor past one that is not durable yet.
        accepted.sort((a, b) => inboundOrder(a.identity, b.identity));
        const fetched = new Map<string, (typeof accepted)[number]>();
        for (const entry of accepted) {
          const { identity } = entry;
          // Finished earlier and read again because an older message still pins the scan.
          if (await instance.operations.finished(identity.digest)) continue;
          if (!instance.operations.get(identity.digest)) {
            let drop = instance.loopGuard.shouldDrop(identity.peerAddress);
            // The reply budget exists to end two bots answering each other for ever. A person
            // is never limited: only a peer whose own profile says it is a bot.
            if (
              drop === "rate-limited" &&
              !(await this.peerIsBot(instance, identity.peerAddress))
            )
              drop = null;
            if (drop === "rate-limited")
              this.noticeRateLimited(instance, identity);
            if (drop) continue;
          }
          let outcome: "retained" | "known" | "finished";
          try {
            outcome = await instance.operations.retain(identity);
          } catch {
            instance.operations.assertOpen(); // a failed journal write holds the whole pass
            console.warn(
              `[bot-host] [${id}] Inbound retention held; preserve state`
            );
            continue;
          }
          if (outcome === "finished") continue;
          fetched.set(identity.digest, entry);
        }
        for (const row of instance.operations.listDeferred()) {
          const match = fetched.get(row.digest);
          if (!match) {
            const seen = instance.unmatched.get(row.digest) ?? {
              since: now,
              warned: now,
            };
            instance.unmatched.set(row.digest, seen);
            if (now - seen.warned >= UNMATCHED_WARN_MS) {
              seen.warned = now;
              console.warn(
                `[bot-host] [${id}] Retained inbound ${
                  row.digest
                } not returned by any fetch for ${Math.floor(
                  (now - seen.since) / 1000
                )}s; it stays deferred and keeps pinning the scan`
              );
            }
            continue;
          }
          instance.unmatched.delete(row.digest);
          // Start, handler, storing its reply and the first send are one task. Once the start write has
          // committed the handler runs, even if stop() landed meanwhile: stop() drains it.
          void this.track(instance, row, async () => {
            if (this.closing) return;
            // What a reply may carry is settled before the handler starts and kept with the
            // row, so a reply owed after a restart is stamped the same.
            const paidWei = await this.confirmedPaidWei(instance, match);
            if (!(await instance.operations.start(match.identity, paidWei)))
              return;
            instance.confirmedPaid.delete(row.digest);
            // The retained identity, not this fetch's relay time, is the invocation's.
            await this.dispatch(instance, row, { ...match, paidWei });
          });
        }
        this.retryReplies(instance);
      } catch (err: unknown) {
        // A bot that cannot use its journal is not a passing warning.
        (instance.operations.isFaulted ? console.error : console.warn)(
          `[bot-host] Failed polling messages for bot "${id}":`,
          err
        );
        const errObj = err as
          | { code?: string; status?: number; message?: string }
          | null
          | undefined;
        const isMailboxDesync =
          err instanceof MonadMailboxAuthError ||
          err instanceof MonadMailboxRetryableError ||
          errObj?.code === "mailbox_auth_failed" ||
          errObj?.code === "canonical_mailbox_unavailable" ||
          errObj?.status === 401 ||
          errObj?.status === 404 ||
          errObj?.status === 503 ||
          (typeof errObj?.message === "string" &&
            (errObj.message.includes("canonical_mailbox_unavailable") ||
              errObj.message.includes("mailbox_auth_failed") ||
              errObj.message.includes("Recipient is not registered")));

        if (isMailboxDesync) {
          const now = Date.now();
          const lastRecovery = instance.lastAuthRecoveryMs ?? 0;
          if (now - lastRecovery >= 10_000) {
            await this.autoHealBotRegistration(id, instance, err);
          }
        }
      } finally {
        this.wakeReplies(instance);
      }
    }
  }

  /** Whether the peer's published profile says it is a bot. Asked only for a peer that has used
   * up the reply budget, and remembered once answered. A profile that cannot be read counts as
   * a person: the bot answers. */
  private async peerIsBot(
    instance: ActiveBotInstance,
    peerAddress: string
  ): Promise<boolean> {
    const known = instance.botPeers.get(peerAddress);
    if (known !== undefined) return known;
    let profile;
    try {
      profile = await instance.directory.lookupPeer(peerAddress);
    } catch {
      return false;
    }
    if (!profile) return false;
    const isBot = profile.isBot === true;
    instance.botPeers.set(peerAddress, isBot);
    return isBot;
  }

  /** Resolves once this bot's next poll pass has ended, or at once when the host is stopping. */
  private nextPoll(instance: ActiveBotInstance): Promise<void> {
    if (this.closing) return Promise.resolve();
    return new Promise((resolve) => instance.pollWaiters.add(resolve));
  }

  private wakeReplies(instance: ActiveBotInstance): void {
    const waiters = [...instance.pollWaiters];
    instance.pollWaiters.clear();
    for (const wake of waiters) wake();
  }

  /** Sends one reply a running handler makes itself. A send the wallet refused with its
   * not-attempted label, having reported no attempt, created nothing: the same reply is sent
   * again after the next poll pass. The handler stays suspended in its `reply()` meanwhile, so
   * nothing it did before runs twice and what it does with the result runs once. Every other
   * rejection, and the last of `MAX_REPLY_SENDS` refusals, rejects to the handler, which may
   * catch it and go on. `linked` is called once the wallet holds an attempt for the reply. */
  private async sendReply(
    instance: ActiveBotInstance,
    inbound: InboundIdentity,
    captured: {
      recipient: string;
      conversationId?: string;
      stampValue: bigint;
      messageId?: string;
      items: MessageItem[];
    },
    linked: () => Promise<void>
  ): Promise<DirectMessageSendResult> {
    for (let sends = 1; ; sends++) {
      let reported = false;
      try {
        const result = await this.sendCanonicalMessage(
          instance.wallet,
          captured.recipient,
          captured.items,
          captured.conversationId,
          { stampValueWei: captured.stampValue, messageId: captured.messageId },
          () => {
            reported = true;
            return linked();
          }
        );
        if (!reported) await linked();
        return result;
      } catch (error) {
        // The wallet's label is about this one call and is read from this rejection, here.
        if (!isDirectMessageNotAttempted(error) || reported) throw error;
        if (sends >= MAX_REPLY_SENDS) {
          console.error(
            `[bot-host] [${instance.definition.id}] Reply to ${inbound.peerAddress} for message ${inbound.messageId} refused ${sends} times without an attempt`
          );
          throw error;
        }
        if (sends === 1)
          console.warn(
            `[bot-host] [${instance.definition.id}] Reply to ${inbound.peerAddress} for message ${inbound.messageId} refused before any attempt; sending it again on later polls`
          );
        await this.nextPoll(instance);
        if (this.closing) throw new Error("Bot invocation is no longer active");
      }
    }
  }

  /** Says, once per hour for each bot peer, that its messages are not being handled: one log line
   * and one plain text to the peer, in the conversation it wrote in. The message itself is not
   * retained or handled. The notice is outside the reply budget and is never repeated inside the
   * window, whether or not it could be sent, so it cannot keep two bots answering each other:
   * the guard still stops the exchange. A budget of zero means never reply, and says nothing. */
  private noticeRateLimited(
    instance: ActiveBotInstance,
    identity: InboundIdentity
  ): void {
    if (!instance.loopGuard.noticeDue(identity.peerAddress)) return;
    const id = instance.definition.id;
    const limit = instance.loopGuard.limit;
    console.warn(
      `[bot-host] [${id}] Reply limit reached for ${identity.peerAddress} (${limit} per hour); its messages are not handled until the hour's window frees`
    );
    if (limit === 0 || this.closing) return;
    const notice = this.sendCanonicalMessage(
      instance.wallet,
      identity.peerAddress,
      [
        {
          type: "text",
          text: `Slow down: you have had ${limit} replies from me in the last hour, which is my limit for one account. Messages you send now may go unanswered. Please try again later.`,
        },
      ],
      identity.conversationId,
      { stampValueWei: this.replyStampWei(0n) }
    ).then(
      () => undefined,
      () =>
        console.warn(
          `[bot-host] [${id}] Reply-limit notice to ${identity.peerAddress} was not sent`
        )
    );
    instance.tasks.add(notice);
    void notice.finally(() => instance.tasks.delete(notice));
  }

  /** Runs `work` as the one tracked task of an inbound digest, on its peer's lane. A second
   * request for a digest is dropped while one runs; stop() drains every task. */
  private track<T>(
    instance: ActiveBotInstance,
    row: { digest: string; peerAddress: string },
    work: () => Promise<T>
  ): Promise<T | undefined> | undefined {
    if (instance.inFlightDigests.has(row.digest)) return undefined;
    instance.inFlightDigests.add(row.digest);
    const task = instance.peerQueue.enqueue(row.peerAddress, async () => {
      try {
        return await work();
      } catch (error) {
        // The row stays as it is. A later poll finds it with no task running and finishes it:
        // a stored reply is sent again, anything else is answered with the failure text.
        console.error(
          `[bot-host] [${instance.definition.id}] Handling of a message from ${row.peerAddress} was interrupted; a later poll finishes it:`,
          error instanceof Error ? error.message : error
        );
        return undefined;
      } finally {
        instance.inFlightDigests.delete(row.digest);
      }
    });
    instance.tasks.add(task);
    void task.finally(() => instance.tasks.delete(task));
    return task;
  }

  /** What a message is CONFIRMED to have paid: the amount its delivery states, if every one of
   * its payment transactions is mined and succeeded; otherwise nothing. The relay may deliver a
   * message before its payments confirm, and a sender can sign payments from empty accounts,
   * so the stated amount alone is never matched.
   *
   * It does not wait: a payment not confirmed when the message is handled counts as nothing,
   * and the reply goes out at once with the minimum stamp. A node that cannot be asked, or
   * does not answer in `PAYMENT_CHECK_MS`, counts the same.
   *
   * THE ONE PLACE that decides this. SWITCH HERE to the wallet's own "has this message's
   * payment landed" call when it exists; this uses `nativeTransfers.getTransactionStatus`. */
  private async confirmedPaidWei(
    instance: ActiveBotInstance,
    message: {
      identity: InboundIdentity;
      stampValueWei: bigint;
      paymentTxHashes: string[];
    }
  ): Promise<bigint> {
    // At or under the minimum the reply carries the minimum anyway: nothing to look up.
    if (
      message.stampValueWei <= this.options.minStampValueWei ||
      !message.paymentTxHashes.length
    )
      return 0n;
    const known = instance.confirmedPaid.get(message.identity.digest);
    if (known !== undefined) return known;
    try {
      const statuses = await bounded(
        Promise.all(
          message.paymentTxHashes.map((txHash) =>
            this.chain.nativeTransfers.getTransactionStatus({
              wallet: instance.wallet,
              transaction: { txHash },
            })
          )
        ),
        "Checking a message's payment",
        PAYMENT_CHECK_MS
      );
      if (!statuses.every((status) => status === "confirmed")) return 0n;
    } catch {
      return 0n;
    }
    instance.confirmedPaid.set(message.identity.digest, message.stampValueWei);
    return message.stampValueWei;
  }

  /** The stamp a bot puts on what it sends in answer to a message, when the handler names no
   * amount: what the sender is confirmed to have paid with that message (`confirmedPaidWei`),
   * and never more, so answering can never pay out more than came in. Never above the bot's
   * configured stamp either.
   *
   * A message that paid nothing confirmed, or less than the relay accepts for a paid message,
   * is answered at the relay's minimum. SWITCH HERE to 0n (no stamp at all) once the wallet's
   * unpaid send has landed. */
  private replyStampWei(paidWei: bigint): bigint {
    const { stampValueWei, minStampValueWei } = this.options;
    if (paidWei < minStampValueWei)
      return minStampValueWei < stampValueWei ? minStampValueWei : stampValueWei;
    return paidWei < stampValueWei ? paidWei : stampValueWei;
  }

  /** Stores the one text reply the host owes for a message and sends it, stamped by
   * `replyStampWei` of what the message paid. A text the store refuses (empty, too long, not
   * well-formed) is replaced by the failure text. */
  private async owe(
    instance: ActiveBotInstance,
    digest: string,
    text: string,
    paidWei: bigint
  ): Promise<void> {
    const stamp = this.replyStampWei(paidWei).toString();
    try {
      await instance.operations.stageReply(digest, text, stamp, Date.now());
    } catch {
      instance.operations.assertOpen(); // a failed journal write holds everything
      if (instance.operations.get(digest)?.reply) return;
      console.error(
        `[bot-host] [${instance.definition.id}] The reply for ${digest} could not be stored; the peer is told its message failed`
      );
      await instance.operations.stageReply(
        digest,
        FAILED_REPLY_TEXT,
        stamp,
        Date.now()
      );
    }
    await this.deliver(instance, digest);
  }

  /** Sends the stored reply of a message. Every send of it, in any process lifetime, carries the
   * same message identity, and the wallet makes at most one payment for one identity: a send
   * that failed before the wallet journalled a payment (no funds, no directory entry, an earlier
   * payment still open) paid nothing and is simply made again; once the wallet holds an attempt
   * it answers with that attempt, which the poll then reconciles. "waiting": still owed. */
  private async deliver(
    instance: ActiveBotInstance,
    digest: string
  ): Promise<"waiting" | undefined> {
    const row = instance.operations.get(digest);
    if (this.closing || row?.phase !== "started" || !row.reply)
      return undefined;
    // With the wallet already: the poll asks the wallet what became of it.
    if (row.reply.digest) return undefined;
    if (Date.now() - row.reply.since >= this.options.replyGiveUpMs) {
      await this.giveUp(
        instance,
        digest,
        "it could not be sent in time; nothing was paid for it"
      );
      return undefined;
    }
    const text = await instance.operations.replyText(digest);
    try {
      // Bounded like the poll's other calls: a send that hangs must not hold this peer's lane
      // and the retry pass. The call left behind cannot lead to a second payment: the next
      // send carries the same message identity, the wallet runs sends one at a time, and it
      // answers the repeat with the first attempt or refuses it while that one is unresolved.
      await bounded(
        this.chain.directMessages.send({
          wallet: instance.wallet,
          recipient: toChainAddress(row.peerAddress),
          items: [{ type: "text", text }],
          conversationId: row.conversationId,
          messageId: replyMessageId(instance.operations.owner, digest),
          stampValue: BigInt(row.reply.stampValue),
          onAttemptCreated: (outbound) =>
            // The row may be finished by the time an abandoned call reports.
            instance.operations.linkReply(digest, outbound).catch(() => {}),
        }),
        "Sending a reply",
          this.options.callTimeoutMs
      );
    } catch (error) {
      instance.operations.assertOpen(); // a failed journal write holds everything
      if (error instanceof DirectMessageAlreadyAttemptedError)
        await instance.operations.linkReply(digest, error.payloadDigest);
      if (instance.operations.get(digest)?.reply?.digest) return undefined;
      if (!instance.sendWarned.has(digest)) {
        instance.sendWarned.add(digest);
        console.warn(
          `[bot-host] [${instance.definition.id}] Reply to ${row.peerAddress} for message ${row.messageId} was not sent; nothing was paid and it is sent again on later polls:`,
          error instanceof Error ? error.message : error
        );
      }
      return "waiting";
    }
    await this.finish(instance, digest, true);
    return undefined;
  }

  /** Finishes a started message: its row goes and the scan cursor moves past it. */
  private async finish(
    instance: ActiveBotInstance,
    digest: string,
    delivered: boolean
  ): Promise<void> {
    const row = instance.operations.get(digest);
    if (row?.phase !== "started") return;
    const committedCursor = await instance.operations.complete(
      digest,
      Math.max(instance.lastPollTimestamp, row.receivedTime + 1)
    );
    instance.lastPollTimestamp = Math.max(
      instance.lastPollTimestamp,
      committedCursor
    );
    instance.sendWarned.delete(digest);
    if (delivered) instance.loopGuard.recordReply(row.peerAddress);
  }

  /** Stops trying to deliver a stored reply, and says so where an operator sees it. */
  private async giveUp(
    instance: ActiveBotInstance,
    digest: string,
    why: string
  ): Promise<void> {
    const row = instance.operations.get(digest);
    if (row?.phase !== "started") return;
    console.error(
      `[bot-host] [${instance.definition.id}] Giving up on the reply to ${row.peerAddress} for message ${row.messageId}: ${why}`
    );
    await this.finish(instance, digest, false);
  }

  /** A started message with no handler running and no stored reply: a restart interrupted its
   * handler. The handler is not run again, since it may have acted already. If a reply of its
   * own reached the wallet, the wallet finishes delivering it; otherwise the peer is told. */
  private async finishInterrupted(
    instance: ActiveBotInstance,
    digest: string
  ): Promise<void> {
    const row = instance.operations.get(digest);
    if (this.closing || row?.phase !== "started" || row.reply) return;
    console.error(
      `[bot-host] [${instance.definition.id}] Handling of message ${row.messageId} from ${row.peerAddress} was interrupted`
    );
    if (row.replied) await this.finish(instance, digest, false);
    else
      await this.owe(instance, digest, FAILED_REPLY_TEXT, BigInt(row.paid ?? "0"));
  }

  /** Sends stored replies that are not with the wallet yet. One tracked pass at a time, in
   * handling order starting after the row the previous pass ended on, each send on its peer's
   * lane, ending at the first that still cannot be sent: one extra wallet call per poll while
   * the wallet cannot send, and a reply that cannot be sent for its own recipient is overtaken
   * by the others. */
  private retryReplies(instance: ActiveBotInstance): void {
    if (instance.retrying) return;
    const waiting = instance.operations
      .listStarted()
      .filter((row) => row.reply && !row.reply.digest);
    if (!waiting.length) return;
    const next =
      waiting.findIndex((row) => row.digest === instance.refused) + 1;
    instance.retrying = true;
    const pass = (async () => {
      try {
        for (const row of [...waiting.slice(next), ...waiting.slice(0, next)]) {
          if (this.closing) return;
          instance.operations.assertOpen();
          const outcome = await this.track(instance, row, () =>
            this.deliver(instance, row.digest)
          );
          if (outcome === "waiting") {
            instance.refused = row.digest;
            return;
          }
        }
        instance.refused = undefined;
      } catch {
        // A faulted journal: nothing further is sent by this process.
      } finally {
        instance.retrying = false;
      }
    })();
    instance.tasks.add(pass);
    void pass.finally(() => instance.tasks.delete(pass));
  }

  /**
   * Auto-heals a bot's registration when the relay loses its directory entry
   * (e.g. relay wiped, RocksDB reset, or transient cluster partition).
   *
   * Re-publishes the Open Directory entry (which automatically re-uploads retained
   * signed revisions via handOver if the relay is blank) and re-registers Frank profile metadata.
   */
  async autoHealBotRegistration(
    id: string,
    instance: ActiveBotInstance,
    cause?: unknown
  ): Promise<boolean> {
    const reason =
      cause instanceof Error
        ? cause.message
        : (cause as { code?: string })?.code ?? "mailbox_desync";
    console.info(
      `[bot-host] Detected mailbox/directory desync for bot "${id}" (${reason}); auto-healing directory entry and profile on relay...`
    );
    instance.lastAuthRecoveryMs = Date.now();
    let healed = false;
    try {
      await instance.directory.publish();
      console.info(
        `[bot-host] Successfully auto-healed directory entry on relay for bot "${id}"`
      );
      healed = true;
    } catch (dirErr) {
      console.warn(
        `[bot-host] Failed auto-healing directory entry for bot "${id}":`,
        dirErr
      );
    }
    try {
      await RelayProfileManager.registerProfile({
        relayBaseUrl: this.options.relayBaseUrl,
        identity: instance.wallet.identity,
        label: instance.definition.id,
        profile: instance.definition.getProfile(),
        force: true,
        network: instance.directory.network,
      });
      console.info(
        `[bot-host] Successfully re-registered profile on relay for bot "${id}"`
      );
    } catch (recoveryErr) {
      console.warn(
        `[bot-host] Failed re-registering profile for bot "${id}":`,
        recoveryErr
      );
    }
    return healed;
  }

  async autoHealBot(id: string, cause?: unknown): Promise<boolean> {
    const instance = this.instances.get(id);
    if (!instance) return false;
    return this.autoHealBotRegistration(id, instance, cause);
  }

  async autoHealAll(): Promise<void> {
    for (const [id, instance] of this.instances.entries()) {
      await this.autoHealBotRegistration(id, instance, "manual_heal");
    }
  }

  private saveRegistrationCursor(): void {
    try {
      mkdirSync(this.options.stateDir, { recursive: true });
      const cursorFile = join(
        this.options.stateDir,
        "registration-cursor.json"
      );
      writeFileSync(
        cursorFile,
        JSON.stringify({
          sinceMs: this.lastRegistrationPollMs,
          updatedAt: Date.now(),
        })
      );
    } catch {
      // non-fatal
    }
  }

  private async pollRegistrations(): Promise<void> {
    const hasInterestedBots = Array.from(this.instances.values()).some(
      (inst) => typeof inst.definition.onNewUser === "function"
    );
    if (!hasInterestedBots && this.registrationListeners.size === 0) return;

    try {
      const profiles = await fetchMonadProfilesSince({
        relayBaseUrl: this.options.relayBaseUrl,
        sinceMs: this.lastRegistrationPollMs,
      });

      for (const entry of profiles) {
        let decoded: ReturnType<typeof decodeProfileBytes> | undefined;
        try {
          decoded = decodeProfileBytes(entry.rawBytes, {
            expectedAddress: entry.address,
          });
        } catch {
          continue;
        }

        const registeredAt = decoded.timestampMs || Date.now();
        this.lastRegistrationPollMs = Math.max(
          this.lastRegistrationPollMs,
          registeredAt + 1
        );
        this.saveRegistrationCursor();

        const event: NewUserEvent = {
          address: entry.address,
          registeredAtMs: registeredAt,
          profile: {
            name: decoded.name,
            bio: decoded.bio,
            avatar: decoded.avatar,
            bot: decoded.bot,
          },
        };

        // 1. Dispatch to registered bots implementing onNewUser
        for (const [id, instance] of this.instances.entries()) {
          if (typeof instance.definition.onNewUser !== "function") continue;

          const dropReason = instance.loopGuard.shouldDrop(
            entry.address,
            decoded.bot
          );
          if (dropReason) continue;

          const greetedKey = `greeted:${entry.address.toLowerCase()}`;
          const alreadyGreeted = await instance.state.get(greetedKey);
          if (alreadyGreeted) continue;

          // Durably record claim before sending to guarantee at-most-once greeting
          await instance.state.put(greetedKey, String(Date.now()));

          try {
            if (id !== "faucet") {
              await new Promise((r) =>
                setTimeout(r, 1000 + Math.floor(Math.random() * 4000))
              );
            }
            await instance.definition.onNewUser(event, instance.context);
          } catch (err) {
            console.error(`[bot-host] error in bot "${id}".onNewUser:`, err);
            await instance.state.del(greetedKey).catch(() => {});
          }
        }

        // 2. Dispatch to custom listeners
        for (const listener of this.registrationListeners) {
          try {
            await listener(event);
          } catch (err) {
            console.error("[bot-host] error in registration listener:", err);
          }
        }
      }
    } catch {
      // Ignore transient polling failure
    }
  }

  private async dispatch(
    instance: ActiveBotInstance,
    identity: InboundIdentity,
    {
      items,
      stampValueWei,
      stampPayments,
      paidWei,
    }: {
      items: MessageItem[];
      stampValueWei: bigint;
      stampPayments: readonly StampPaymentInfo[];
      paidWei: bigint;
    }
  ): Promise<void> {
    const replies: Promise<DirectMessageSendResult>[] = [];
    let accepting = true;
    // Whether the wallet holds an attempt for a reply this handler sent itself.
    let linked = false;
    const send: BotContext["sendMessage"] = (
      recipient,
      items,
      conversationId,
      options
    ) => {
      if (!accepting || this.closing)
        return Promise.reject(new Error("Bot invocation is no longer active"));
      // Snapshot caller-owned values before any asynchronous work. A send that fails rejects to
      // the handler and to nothing else: a handler that catches it can still send.
      const reply = this.sendReply(
        instance,
        identity,
        {
          recipient: getAddress(recipient).toLowerCase(),
          conversationId:
            conversationId === undefined
              ? undefined
              : conversationIdentity(conversationId),
          // An amount the handler names (a payout) is the handler's. Anything else it sends
          // while answering this message carries the reply stamp.
          stampValue:
            options?.stampValueWei ?? this.replyStampWei(paidWei),
          messageId: options?.messageId,
          items: structuredClone(items),
        },
        async () => {
          linked = true;
          await instance.operations.markReplied(identity.digest);
        }
      );
      replies.push(reply);
      void reply.catch(() => undefined);
      return reply;
    };
    const owner = instance.operations.owner;
    const network = canonicalNetworkDescriptor(instance.context.networkTag);
    if (
      network.network !== owner.chainIdentifier ||
      instance.context.subject !== owner.subject ||
      getAddress(instance.context.address).toLowerCase() !== owner.address
    )
      throw new Error("Bot invocation context does not match admitted owner");
    const context: BotContext = Object.freeze({
      ...instance.context,
      address: owner.address,
      subject: owner.subject,
      networkTag: network.tag,
      sendMessage: send,
      sendDirectMessage: send,
    });
    const boundReply: BotMessageContext["reply"] = async (items, options) => {
      const result = await send(
        identity.peerAddress,
        items,
        identity.conversationId,
        options
      );
      instance.loopGuard.recordReply(identity.peerAddress);
      return result;
    };
    const msgCtx: BotMessageContext = Object.freeze({
      conversationId: identity.conversationId,
      peerAddress: identity.peerAddress,
      peerSubject: identity.peerSubject,
      payloadDigest: identity.digest,
      timestampMs: identity.receivedTime,
      items,
      stampValueWei,
      stampPayments,
      reply: boundReply,
    });
    let prepared: PreparedReply | undefined;
    let threw = false;
    try {
      const returned = await instance.definition.onMessage(msgCtx, context);
      if (returned && !Array.isArray(returned)) {
        // A stored reply is the invocation's only reply; it gets no subscription fallback.
        if (replies.length)
          throw new Error("Prepared reply returned after a direct reply");
        prepared = returned;
      } else {
        let reply = returned || undefined;
        if (!reply || !reply.length)
          reply =
            (await context.subscriptions.handleSubscriptionCommand(
              items,
              identity.peerAddress
            )) ?? undefined;
        if (reply?.length) await boundReply(reply);
      }
    } catch (error) {
      threw = true;
      prepared = undefined;
      console.error(
        `[bot-host] [${instance.definition.id}] Handler failed for message ${identity.messageId} from ${identity.peerAddress}:`,
        error instanceof Error ? error.message : error
      );
    } finally {
      accepting = false;
      await Promise.allSettled(replies);
    }
    // A handler is run once. One that failed having sent nothing leaves the peer a plain
    // failure reply, stored and delivered like any other; one that sent something is finished,
    // and the wallet completes what it sent.
    if (prepared)
      return this.owe(instance, identity.digest, prepared.text, paidWei);
    if (threw && !linked)
      return this.owe(instance, identity.digest, FAILED_REPLY_TEXT, paidWei);
    await this.finish(instance, identity.digest, false);
  }

  private async sendCanonicalMessage(
    wallet: EvmChainWalletHandle,
    recipientAddress: string,
    items: MessageItem[],
    conversationId?: string,
    options?: BotSendOptions,
    onAttemptCreated?: (digest: string) => Promise<void>
  ): Promise<DirectMessageSendResult> {
    const instance = [...this.instances.values()].find(
      (value) => value.wallet === wallet
    );
    if (!instance || this.closing)
      throw new Error("Bot send admission unavailable");
    instance.operations.assertOpen();
    return this.chain.directMessages.send({
      wallet,
      recipient: toChainAddress(recipientAddress),
      items,
      conversationId:
        conversationId === undefined
          ? undefined
          : conversationIdentity(conversationId),
      stampValue: options?.stampValueWei ?? this.options.stampValueWei,
      ...(options?.messageId ? { messageId: options.messageId } : {}),
      onAttemptCreated,
    });
  }

  async stop(): Promise<void> {
    if (!this.running && this.instances.size === 0) return;
    this.closing = true;
    this.running = false;
    this.stopController.abort();

    if (this.resolveStop) {
      this.resolveStop();
      this.resolveStop = undefined;
      this.stopPromise = undefined;
    }

    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.registrationTimer) clearInterval(this.registrationTimer);
    this.scheduler.stop();
    // A reply waiting for a poll that will not come is released, and its handler told so.
    for (const instance of this.instances.values()) this.wakeReplies(instance);

    // An in-flight relay or wallet call is waited for, never abandoned. A handler's own slow
    // call (a model request) is the handler's to end, on the `stopping` signal.
    await Promise.allSettled(
      [...this.instances.values()].map((instance) => instance.polling)
    );
    for (const [id, instance] of this.instances.entries()) {
      try {
        while (instance.tasks.size)
          await Promise.allSettled([...instance.tasks]);
        await instance.operations.close();
        if (instance.definition.onStop) {
          await instance.definition.onStop(instance.context);
        }
      } catch {
        console.warn(
          `[bot-host] Stop hook failed for "${id}"; original operations remain retained`
        );
      } finally {
        instance.uninstallDirectory();
        const closed = await Promise.allSettled([
          instance.directory.close(),
          instance.state.close(),
          instance.wallet.close(),
        ]);
        if (closed.some((result) => result.status === "rejected"))
          console.warn(`[bot-host] Close failed for "${id}"; preserve state`);
      }
    }
    this.instances.clear();
  }
}
