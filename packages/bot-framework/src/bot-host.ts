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
import type { DirectMessageSendResult } from "@frank/wallet/chain/active-chain";

import {
  toChainAddress,
  type BotContext,
  type BotHostOptions,
  type BotMessageContext,
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

// A direct reply the wallet refused without attempting is sent again on later polls: this many
// sends in all, then it is held. A waiting reply keeps its handler suspended and its peer's lane
// occupied, and the wallet puts the same label on refusals that never clear (an item type it
// cannot carry, a recipient with no directory entry), so the bound is short. Five polls is past
// an earlier payment settling or a directory lookup recovering.
const MAX_REPLY_SENDS = 5;

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
  lastAuthRecoveryMs?: number;
  inFlightDigests: Set<string>;
  /** Deferred digests no fetch has returned: when first missed, and when last warned. Log only. */
  unmatched: Map<string, { since: number; warned: number }>;
  /** Prepared replies this process found held (changed plugin key, unreadable staged content). */
  held: Set<string>;
  /** A retry pass over refused first sends is running. */
  retrying: boolean;
  /** The row whose first send the last retry pass ended on; the next pass starts after it. */
  refused?: string;
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
  private readonly registrationListeners = new Set<
    (user: NewUserEvent) => void | Promise<void>
  >();

  private running = false;
  private closing = false;
  private pollTimer?: NodeJS.Timeout;
  private polling?: Promise<void>;
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
    };

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
      const uninstallDirectory = installCanonicalDirectory(
        wallet,
        directory.rawDirectory
      );
      uninstall = uninstallDirectory;

      // 5. Register Frank metadata profile on relay
      const profile = definition.getProfile();
      await RelayProfileManager.registerProfile({
        relayBaseUrl: this.options.relayBaseUrl,
        identity: wallet.identity,
        label: definition.id,
        profile,
      });

      // 6. Fund bot identity if shared funding wallet is present
      if (this.fundingWallet && this.nonceSequencer) {
        const receiveAddress = (await wallet.getReceiveAddress()).raw;
        // The faucet sends its grants straight from the funding wallet, so its identity address
        // needs nothing; its messages are still paid from its own receive address.
        const targets = [
          ...(definition.id === "faucet"
            ? []
            : [{ addr: botAddress, label: "Identity address" }]),
          { addr: receiveAddress, label: "EVM main account" },
        ];
        for (const target of targets) {
          try {
            const bal = await this.provider.getBalance(target.addr);
            if (bal < 100_000_000_000_000_000n) {
              const funderBal = await this.provider.getBalance(
                this.fundingWallet.address
              );
              const fundAmount =
                funderBal > 1_000_000_000_000_000_000n
                  ? 500_000_000_000_000_000n
                  : funderBal / 4n;
              if (fundAmount > 10_000_000_000_000_000n) {
                await this.nonceSequencer.withNonce(async (nonce) => {
                  const tx = await this.fundingWallet!.sendTransaction({
                    to: target.addr,
                    value: fundAmount,
                    nonce,
                  });
                  await tx.wait();
                });
              }
            }
          } catch (fundErr) {
            console.warn(
              `[bot-host] Failed initial funding for ${target.label} (${target.addr}) of bot ${definition.id}:`,
              fundErr
            );
          }
        }
      }

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

        lookupPeer: (addr: string) => directory.lookupPeer(addr),

        sendMessage: async (
          recipientAddress: string,
          items,
          conversationId?: string,
          options?: { stampValueWei?: bigint }
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
          options?: { stampValueWei?: bigint }
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

          const botWallet = new Wallet(
            wallet.identity.toPrivateKeyHex(),
            this.provider
          );
          const botBalance = await this.provider.getBalance(botAddress);
          const feeData = await this.provider.getFeeData();
          const gasPrice = feeData.gasPrice ?? 1_000_000_000n;
          const gasLimit = data && data !== "0x" ? 250_000n : 21_000n;
          const needed = valueWei + gasLimit * gasPrice;

          if (
            botBalance < needed &&
            this.fundingWallet &&
            this.nonceSequencer
          ) {
            const topUp = needed - botBalance + 50_000_000_000_000_000n;
            await this.nonceSequencer.withNonce(async (nonce) => {
              const tx = await this.fundingWallet!.sendTransaction({
                to: botAddress,
                value: topUp,
                nonce,
              });
              await tx.wait();
            });
          }

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

          const botWallet = new Wallet(
            wallet.identity.toPrivateKeyHex(),
            this.provider
          );
          const botBalance = await this.provider.getBalance(botAddress);
          const feeData = await this.provider.getFeeData();
          const gasPrice = feeData.gasPrice ?? 1_000_000_000n;
          const gasLimit = 21_000n;
          const needed = valueWei + gasLimit * gasPrice;

          if (
            botBalance < needed &&
            this.fundingWallet &&
            this.nonceSequencer
          ) {
            const topUp = needed - botBalance + 50_000_000_000_000_000n;
            await this.nonceSequencer.withNonce(async (nonce) => {
              const tx = await this.fundingWallet!.sendTransaction({
                to: botAddress,
                value: topUp,
                nonce,
              });
              await tx.wait();
            });
          }

          const populated = await botWallet.populateTransaction({
            to,
            value: valueWei,
          });
          const rawTx = await botWallet.signTransaction(populated);
          const txHash = (await this.provider.broadcastTransaction(rawTx)).hash;
          return { rawTx, txHash };
        },

        waitForReceipt: async (
          txHash: string,
          timeoutMs = 60_000
        ): Promise<TransactionReceipt | null> => {
          return this.provider.waitForTransaction(txHash, 1, timeoutMs);
        },

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
        held: new Set<string>(),
        retrying: false,
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

  // Single-flight: an overlapping tick joins the running pass, and stop() can await it.
  private pollAllBots(): Promise<void> {
    this.polling ??= this.pollOnce().finally(() => {
      this.polling = undefined;
    });
    return this.polling;
  }

  private async pollOnce(): Promise<void> {
    for (const [id, instance] of this.instances.entries()) {
      try {
        if (this.closing) return;
        instance.operations.assertOpen();
        // Independently recover already linked operations, including rows behind the mailbox cursor.
        for (const row of instance.operations.listIncomplete()) {
          if (this.closing) return;
          if (instance.inFlightDigests.has(row.digest)) continue;
          const payloadDigests = row.replies.flatMap((call) =>
            call.digest ? [call.digest] : []
          );
          if (!payloadDigests.length) continue;
          try {
            const observations =
              await this.chain.directMessages.reconcileAttempts({
                wallet: instance.wallet,
                payloadDigests,
              });
            for (let index = 0; index < row.replies.length; index++) {
              const digest = row.replies[index].digest;
              if (digest)
                await instance.operations.observe(
                  row.digest,
                  index,
                  digest,
                  observations[digest] ?? "unknown"
                );
            }
          } catch {
            instance.operations.assertOpen(); // a failed journal write faults admission, not just recovery
            console.warn(
              `[bot-host] [${id}] Original reply recovery held; preserve state`
            );
          }
        }
        if (this.closing) return;
        // A prepared reply observed delivered commits its plugin value and completes.
        for (const row of instance.operations.listIncomplete())
          if (row.prepared && row.replies[0]?.observation === "delivered")
            void this.track(instance, row, () =>
              this.completePrepared(instance, row.digest)
            );
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
        const messages = await this.chain.directMessages.fetchSince({
          wallet: instance.wallet,
          sinceMs: instance.operations.scanFloor(instance.lastPollTimestamp),
        });
        const accepted: {
          identity: InboundIdentity;
          items: MessageItem[];
          stampValueWei: bigint;
        }[] = [];
        for (const msg of messages) {
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
        let full = false;
        for (const entry of accepted) {
          const { identity } = entry;
          // At capacity nothing later is retained, but rows retained earlier are still matched.
          if (!instance.operations.get(identity.digest)) {
            if (full) continue;
            const drop = instance.loopGuard.shouldDrop(identity.peerAddress);
            if (drop === "rate-limited")
              this.noticeRateLimited(instance, identity);
            if (drop) continue;
          }
          let outcome: "retained" | "known" | "full";
          try {
            outcome = await instance.operations.retain(identity);
          } catch {
            instance.operations.assertOpen(); // a failed journal write holds the whole pass
            console.warn(
              `[bot-host] [${id}] Inbound retention held; preserve state`
            );
            continue;
          }
          if (outcome === "full") {
            full = true;
            console.warn(
              `[bot-host] [${id}] Inbound retention full; later messages are not retained`
            );
            continue;
          }
          fetched.set(identity.digest, entry);
        }
        const now = Date.now();
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
          // Start, handler, prepare and first send are one task. Once the start write has
          // committed the handler runs, even if stop() landed meanwhile: stop() drains it.
          void this.track(instance, row, async () => {
            if (
              this.closing ||
              !(await instance.operations.start(match.identity))
            )
              return;
            // The retained identity, not this fetch's relay time, is the invocation's.
            await this.dispatch(instance, row, match);
          });
        }
        this.retryFirstSends(instance);
      } catch (err: unknown) {
        console.warn(
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

  /** Sends one journaled direct reply of a running invocation. A send the wallet refused with
   * its not-attempted label, having reported no attempt, created nothing: the same reply, in the
   * same slot, is sent again after the next poll pass. The handler stays suspended in its
   * `reply()` meanwhile, so nothing it did before runs twice and what it does with the result
   * runs once. Every other rejection, and the last of `MAX_REPLY_SENDS` refusals, rejects as
   * before: the slot stays as it is, the invocation is held and nothing is sent again. The wait
   * is process memory: a host that stops meanwhile leaves the invocation held. */
  private async sendReply(
    instance: ActiveBotInstance,
    inbound: string,
    index: number,
    captured: {
      recipient: string;
      conversationId?: string;
      stampValue: bigint;
      items: MessageItem[];
    }
  ): Promise<DirectMessageSendResult> {
    for (let sends = 1; ; sends++) {
      let reported = false;
      try {
        return await this.sendCanonicalMessage(
          instance.wallet,
          captured.recipient,
          captured.items,
          captured.conversationId,
          { stampValueWei: captured.stampValue },
          (digest) => {
            reported = true;
            return instance.operations.link(inbound, index, digest);
          }
        );
      } catch (error) {
        // The wallet's label is about this one call and is read from this rejection, here.
        if (!isDirectMessageNotAttempted(error) || reported) throw error;
        if (sends >= MAX_REPLY_SENDS) {
          console.error(
            `[bot-host] [${instance.definition.id}] Reply to ${inbound} refused ${sends} times without an attempt; the message is held and will not be answered`
          );
          throw error;
        }
        if (sends === 1)
          console.warn(
            `[bot-host] [${instance.definition.id}] Reply to ${inbound} refused before any attempt; sending it again on later polls`
          );
        await this.nextPoll(instance);
        if (this.closing) throw new Error("Bot invocation is no longer active");
      }
    }
  }

  /** Says, once per hour for each peer, that its messages are not being handled: one log line
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
      identity.conversationId
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
      } catch {
        // An interrupted handler may have generated content or paid. It is never retried,
        // skipped as processed, or completed from a later wallet delivery observation.
        console.warn(
          `[bot-host] [${instance.definition.id}] Inbound invocation held; preserve original operation`
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

  /** Sends a prepared reply that has no slot: the only state a send starts from. The slot is
   * persisted first, so a crash inside the wallet can never lead to a second send. It is taken
   * back, leaving the staged answer to be sent later, only when the wallet labelled this very
   * call as not attempted and reported no attempt during it. */
  private async sendPrepared(
    instance: ActiveBotInstance,
    digest: string
  ): Promise<"refused" | undefined> {
    const row = instance.operations.get(digest);
    if (
      this.closing ||
      instance.held.has(digest) ||
      row?.phase !== "started" ||
      !row.prepared ||
      row.replies.length
    )
      return undefined;
    // Everything that can refuse runs before the slot is persisted. Between that write and the
    // wallet call nothing may throw: an unlabelled refusal there would hold the reply for good.
    const recipient = toChainAddress(row.peerAddress);
    const stampValue = BigInt(row.prepared.stampValue);
    let text: string;
    try {
      text = await instance.operations.beginPreparedReply(digest);
    } catch {
      instance.operations.assertOpen(); // a failed journal write holds everything
      instance.held.add(digest);
      console.warn(
        `[bot-host] [${instance.definition.id}] Prepared reply for ${digest} held before sending; its commit key changed or its staged content is unreadable`
      );
      return undefined;
    }
    let reported = false;
    let result: DirectMessageSendResult;
    try {
      result = await this.chain.directMessages.send({
        wallet: instance.wallet,
        recipient,
        items: [{ type: "text", text }],
        conversationId: row.conversationId,
        stampValue,
        onAttemptCreated: (outbound) => {
          reported = true;
          return instance.operations.link(digest, 0, outbound);
        },
      });
    } catch (error) {
      // The wallet's label is about this one call and is read from this rejection, here.
      const notAttempted = isDirectMessageNotAttempted(error);
      if (!notAttempted || reported) {
        // Linked: reconciled on later polls. Unlinked: held, never sent again.
        console.warn(
          `[bot-host] [${instance.definition.id}] Prepared reply for ${digest} not delivered yet; preserve original operation`
        );
        return undefined;
      }
      await instance.operations.retractReply(digest);
      return "refused";
    }
    // A send result cannot substitute for the durable pre-submission callback.
    if (
      instance.operations.get(digest)?.replies[0]?.digest !==
      result.payloadDigest
    )
      throw new Error("Bot reply has no matching durable attempt");
    await instance.operations.observe(
      digest,
      0,
      result.payloadDigest,
      "delivered"
    );
    await this.completePrepared(instance, digest);
    return undefined;
  }

  /** Commits the plugin value and completes the row, once its own reply is recorded delivered. */
  private async completePrepared(
    instance: ActiveBotInstance,
    digest: string
  ): Promise<void> {
    const row = instance.operations.get(digest);
    if (
      instance.held.has(digest) ||
      row?.phase !== "started" ||
      !row.prepared ||
      row.replies[0]?.observation !== "delivered"
    )
      return;
    let committedCursor: number;
    try {
      committedCursor = await instance.operations.complete(
        digest,
        Math.max(instance.lastPollTimestamp, row.receivedTime + 1)
      );
    } catch {
      instance.operations.assertOpen(); // a failed journal write holds everything
      instance.held.add(digest);
      console.warn(
        `[bot-host] [${instance.definition.id}] Reply for ${digest} delivered but its commit is held; the commit key changed or the staged value is unreadable, nothing was overwritten`
      );
      return;
    }
    instance.lastPollTimestamp = Math.max(
      instance.lastPollTimestamp,
      committedCursor
    );
    instance.loopGuard.recordReply(row.peerAddress);
  }

  /** Retries first sends the wallet refused. One tracked pass at a time, in handling order
   * starting after the row the previous pass ended on, each send on its peer's lane, ending at
   * the first refusal: one extra wallet call per poll, and a row refused for its own recipient
   * is overtaken. No lock and no queue: while the wallet refuses, the answers stay staged. */
  private retryFirstSends(instance: ActiveBotInstance): void {
    if (instance.retrying) return;
    const waiting = instance.operations
      .listIncomplete()
      .filter(
        (row) =>
          row.prepared && !row.replies.length && !instance.held.has(row.digest)
      )
      .sort(inboundOrder);
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
            this.sendPrepared(instance, row.digest)
          );
          if (outcome === "refused") {
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
    { items, stampValueWei }: { items: MessageItem[]; stampValueWei: bigint }
  ): Promise<void> {
    const replies: Promise<DirectMessageSendResult>[] = [];
    let accepting = true;
    let failed = false;
    const send: BotContext["sendMessage"] = (
      recipient,
      items,
      conversationId,
      options
    ) => {
      if (!accepting || failed || this.closing)
        return Promise.reject(new Error("Bot invocation is no longer active"));
      // Snapshot caller-owned values before any asynchronous journal work.
      const captured = {
        recipient: getAddress(recipient).toLowerCase(),
        conversationId:
          conversationId === undefined
            ? undefined
            : conversationIdentity(conversationId),
        stampValue: options?.stampValueWei ?? this.options.stampValueWei,
        items: structuredClone(items),
      };
      const reply = (async () => {
        const index = await instance.operations.beginReply(identity.digest, {
          recipient: captured.recipient,
          conversationId: captured.conversationId,
          stampValue: captured.stampValue.toString(),
        });
        const result = await this.sendReply(
          instance,
          identity.digest,
          index,
          captured
        );
        // A send result cannot substitute for the durable pre-submission callback.
        if (
          instance.operations.get(identity.digest)?.replies[index].digest !==
          result.payloadDigest
        )
          throw new Error("Bot reply has no matching durable attempt");
        await instance.operations.observe(
          identity.digest,
          index,
          result.payloadDigest,
          "delivered"
        );
        return result;
      })();
      replies.push(reply);
      void reply.catch(() => {
        failed = true;
      });
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
      reply: boundReply,
    });
    let prepared: PreparedReply | undefined;
    try {
      const returned = await instance.definition.onMessage(msgCtx, context);
      if (returned && !Array.isArray(returned)) {
        // A prepared reply is the invocation's only reply; it gets no subscription fallback.
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
    } catch {
      failed = true;
    } finally {
      accepting = false;
      await Promise.allSettled(replies);
    }
    if (failed)
      throw new Error("Bot invocation incomplete; preserve original operation");
    if (prepared) {
      // Durable before it is first sent; the stamp is authorised once, here. The row completes
      // and the loop guard counts the reply when the commit lands, now or on a later poll.
      await instance.operations.prepare(
        identity.digest,
        prepared,
        this.options.stampValueWei.toString()
      );
      await this.sendPrepared(instance, identity.digest);
      return;
    }
    const cursor = Math.max(
      instance.lastPollTimestamp,
      identity.receivedTime + 1
    );
    const committedCursor = await instance.operations.complete(
      identity.digest,
      cursor
    );
    instance.lastPollTimestamp = Math.max(
      instance.lastPollTimestamp,
      committedCursor
    );
  }

  private async sendCanonicalMessage(
    wallet: EvmChainWalletHandle,
    recipientAddress: string,
    items: MessageItem[],
    conversationId?: string,
    options?: { stampValueWei?: bigint },
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
      onAttemptCreated,
    });
  }

  async stop(): Promise<void> {
    if (!this.running && this.instances.size === 0) return;
    this.closing = true;
    this.running = false;

    if (this.resolveStop) {
      this.resolveStop();
      this.resolveStop = undefined;
      this.stopPromise = undefined;
    }

    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.registrationTimer) clearInterval(this.registrationTimer);
    this.scheduler.stop();
    // A reply waiting for a poll that will not come is released, and its invocation held.
    for (const instance of this.instances.values()) this.wakeReplies(instance);

    // No time bound: an in-flight relay, wallet or model call is waited for, never abandoned.
    await this.polling?.catch(() => undefined);
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
