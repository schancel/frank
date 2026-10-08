import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomBytes, createHash } from "crypto";
import { JsonRpcProvider, Wallet, type TransactionReceipt } from "ethers";
import axios from "axios";

import { deriveDomainRoot } from "@frank/domain-roots";
import type { ActiveChain } from "@frank/wallet/chain/active-chain";
import {
  createMonadChain,
  installCanonicalDirectory,
  loadMonadChainConfigFromEnv,
  serializeMessageItems,
  type MonadChainWalletHandle,
} from "@frank/wallet/chain/monad-chain";
import {
  fetchMonadProfilesSince,
  decodeProfileBytes,
  fetchMonadIdentityPubKey,
} from "@frank/wallet/monad-identity";
import { buildEnvelope } from "@frank/cashweb/relay/monad-message-envelope";
import {
  MonadMailboxAuthError,
  MonadMailboxRetryableError,
} from "@frank/cashweb/relay/monad-mailbox-client";
import type { MessageItem } from "@frank/cashweb/types/messages";
import {
  MonadStampClient,
  quoteMonadStampPaymentGasReserve,
} from "@frank/wallet/monad-stamp-client";
import { MonadAccountTxSigner } from "@frank/wallet/monad-account-tx";
import { MonadHttpClient } from "@frank/wallet/monad-http";
import type { DirectMessageSendResult } from "@frank/wallet/chain/active-chain";

import {
  toChainAddress,
  type BotContext,
  type BotHostOptions,
  type BotMessageContext,
  type DirectoryPeerInfo,
  type FrankBotDefinition,
  type NewUserEvent,
} from "./types";
import { EVMNonceSequencer } from "./nonce-sequencer";
import { LevelBotStateStore } from "./state-store";
import { DirectoryManager } from "./directory-manager";
import { RelayProfileManager } from "./relay-profile-manager";
import { LoopGuard } from "./loop-guard";
import { PeerLaneQueue } from "./peer-queue";
import { LevelSubscriptionManager } from "./subscription-manager";
import { BotScheduler } from "./scheduler";

interface ActiveBotInstance {
  definition: FrankBotDefinition;
  wallet: MonadChainWalletHandle;
  state: LevelBotStateStore;
  directory: DirectoryManager;
  uninstallDirectory: () => void;
  loopGuard: LoopGuard;
  peerQueue: PeerLaneQueue;
  context: BotContext;
  lastPollTimestamp: number;
  lastAuthRecoveryMs?: number;
  inFlightDigests: Set<string>;
}

export class FrankBotHost {
  private readonly options: Required<BotHostOptions>;
  private readonly provider: JsonRpcProvider;
  private readonly chain: ActiveChain;
  private readonly fundingWallet?: Wallet;
  private readonly nonceSequencer?: EVMNonceSequencer;
  private readonly instances = new Map<string, ActiveBotInstance>();
  private readonly registrationListeners = new Set<
    (user: NewUserEvent) => void | Promise<void>
  >();

  private running = false;
  private pollTimer?: NodeJS.Timeout;
  private registrationTimer?: NodeJS.Timeout;
  private lastRegistrationPollMs = 0;
  private readonly scheduler = new BotScheduler();
  private readonly walletSendQueues = new WeakMap<
    MonadChainWalletHandle,
    Promise<any>
  >();
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
        const jsonPath =
          process.env.FRANK_DEMO_FAUCET_WALLET_JSON ??
          process.env.E2E_DEMO_MAIN_WALLET_JSON;
        if (jsonPath && existsSync(jsonPath)) {
          try {
            const parsed = JSON.parse(readFileSync(jsonPath, "utf8"));
            return parsed.privateKey ?? parsed.privateKeyHex ?? "";
          } catch {
            return "";
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

    this.provider = new JsonRpcProvider(this.options.rpcUrl);
    this.chain = createMonadChain({
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
    if (this.instances.has(definition.id)) {
      throw new Error(`Bot with id "${definition.id}" is already registered`);
    }

    const botStateDir = join(this.options.stateDir, "bots", definition.id);
    mkdirSync(botStateDir, { recursive: true, mode: 0o700 });

    // 1. Load or generate bot account root (32 bytes secret)
    const rootFile = join(botStateDir, "account-root.hex");
    let rootHex: string;
    if (existsSync(rootFile)) {
      rootHex = readFileSync(rootFile, "utf8").trim();
    } else if (
      definition.defaultIdentityPath &&
      existsSync(definition.defaultIdentityPath)
    ) {
      try {
        const idData = JSON.parse(
          readFileSync(definition.defaultIdentityPath, "utf8")
        );
        if (typeof idData.privateKeyHex === "string") {
          rootHex = createHash("sha256")
            .update(idData.privateKeyHex)
            .digest("hex");
          writeFileSync(rootFile, rootHex, { mode: 0o600 });
          console.log(
            `[bot-host] Migrated existing identity from ${definition.defaultIdentityPath} into durable account root`
          );
        } else {
          rootHex = randomBytes(32).toString("hex");
          writeFileSync(rootFile, rootHex, { mode: 0o600 });
        }
      } catch {
        rootHex = randomBytes(32).toString("hex");
        writeFileSync(rootFile, rootHex, { mode: 0o600 });
      }
    } else {
      rootHex = randomBytes(32).toString("hex");
      writeFileSync(rootFile, rootHex, { mode: 0o600 });
    }
    const accountRoot = Uint8Array.from(Buffer.from(rootHex, "hex"));

    // 2. Open persistent typed wallet for canonical messaging
    const wallet = (await this.chain.createWallet({
      evm: deriveDomainRoot(accountRoot, "evm-wallet"),
      authentication: deriveDomainRoot(accountRoot, "identity-authentication"),
      messaging: deriveDomainRoot(accountRoot, "messaging-encryption"),
    })) as MonadChainWalletHandle;

    const botAddress = wallet.identity.address.raw;
    const botSubject = Buffer.from(wallet.identity.compressedPubKey).toString(
      "hex"
    );

    // 3. Open LevelDB state store
    const state = await LevelBotStateStore.open(join(botStateDir, "state"));

    // 4. Open and publish Open Directory entry
    const directory = DirectoryManager.create({
      handle: wallet,
      networkTag: this.options.networkTag,
      relayBaseUrl: this.options.relayBaseUrl,
      location: join(botStateDir, "directory"),
    });

    await directory.publishWithRetry(definition.id);
    directory.startHeartbeat(this.options.heartbeatIntervalMs);

    // Install canonical directory so chain.directMessages routes through canonical directory
    const uninstallDirectory = installCanonicalDirectory(
      wallet,
      directory.rawDirectory
    );

    // 5. Register Frank metadata profile on relay
    const profile = definition.getProfile();
    await RelayProfileManager.registerProfile({
      relayBaseUrl: this.options.relayBaseUrl,
      identity: wallet.identity,
      label: definition.id,
      profile,
    });

    // 6. Fund bot identity if shared funding wallet is present
    if (
      this.fundingWallet &&
      this.nonceSequencer &&
      definition.id !== "faucet"
    ) {
      try {
        const botBalance = await this.provider.getBalance(botAddress);
        if (botBalance < 100_000_000_000_000_000n) {
          const mainBalance = await this.provider.getBalance(
            this.fundingWallet.address
          );
          const fundAmount =
            mainBalance > 1_000_000_000_000_000_000n
              ? 500_000_000_000_000_000n
              : mainBalance / 4n;
          if (fundAmount > 10_000_000_000_000_000n) {
            await this.nonceSequencer.withNonce(async (nonce) => {
              const tx = await this.fundingWallet!.sendTransaction({
                to: botAddress,
                value: fundAmount,
                nonce,
              });
              await tx.wait();
            });
          }
        }
        const receiveAddress = (await wallet.getReceiveAddress()).raw;
        if (receiveAddress.toLowerCase() !== botAddress.toLowerCase()) {
          const receiveBalance = await this.provider.getBalance(receiveAddress);
          if (receiveBalance < 100_000_000_000_000_000n) {
            const mainBalance = await this.provider.getBalance(
              this.fundingWallet.address
            );
            const fundAmount =
              mainBalance > 1_000_000_000_000_000_000n
                ? 500_000_000_000_000_000n
                : mainBalance / 4n;
            if (fundAmount > 10_000_000_000_000_000n) {
              await this.nonceSequencer.withNonce(async (nonce) => {
                const tx = await this.fundingWallet!.sendTransaction({
                  to: receiveAddress,
                  value: fundAmount,
                  nonce,
                });
                await tx.wait();
              });
            }
          }
        }
      } catch (err) {
        console.warn(
          `[bot-host] Failed initial funding for bot ${definition.id}:`,
          err
        );
      }
    }

    // 7. Wire up loop guard and peer queue
    const loopGuard = new LoopGuard({
      selfAddress: botAddress,
    });
    const peerQueue = new PeerLaneQueue();

    // 8. Assemble BotContext
    const subscriptions = new LevelSubscriptionManager(
      state.sublevel("subscriptions"),
      async (recipientAddress: string, items: MessageItem[]) => {
        return this.sendMessageWithFallback(wallet, recipientAddress, items);
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

      sendMessage: async (recipientAddress: string, items, conversationId?: string) => {
        return this.sendMessageWithFallback(wallet, recipientAddress, items, conversationId);
      },

      sendDirectMessage: async (recipientAddress: string, items, conversationId?: string) => {
        return this.sendMessageWithFallback(wallet, recipientAddress, items, conversationId);
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

        if (botBalance < needed && this.fundingWallet && this.nonceSequencer) {
          const topUp = needed - botBalance + 5_000_000_000_000_000_000n;
          await this.nonceSequencer.withNonce(async (nonce) => {
            const tx = await this.fundingWallet!.sendTransaction({
              to: botAddress,
              value: topUp,
              nonce,
            });
            await tx.wait();
          });
        }

        const tx = await botWallet.sendTransaction({
          to,
          data: data ?? "0x",
          value: valueWei,
        });
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
            const rawTx = await this.fundingWallet!.signTransaction(populated);
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

        if (botBalance < needed && this.fundingWallet && this.nonceSequencer) {
          const topUp = needed - botBalance + 5_000_000_000_000_000_000n;
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
      directory,
      uninstallDirectory,
      loopGuard,
      peerQueue,
      context,
      lastPollTimestamp:
        savedCursor > 0 ? savedCursor : Date.now() - 24 * 3600_000,
      inFlightDigests: new Set<string>(),
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
  }

  async start(): Promise<void> {
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
      this.lastRegistrationPollMs = Date.now() - 3600_000;
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

  private async pollAllBots(): Promise<void> {
    for (const [id, instance] of this.instances.entries()) {
      try {
        const messages = await this.chain.directMessages.fetchSince({
          wallet: instance.wallet,
          sinceMs: instance.lastPollTimestamp,
        });

        if (messages.length > 0) {
          console.log(
            `[bot-host] [${id}] Polled ${messages.length} message(s)`
          );
        }

        for (const msg of messages) {
          // 1. Idempotency check on payload digest (both in-flight and stored)
          if (instance.inFlightDigests.has(msg.payloadDigest)) {
            continue;
          }
          const digestKey = `digest:${msg.payloadDigest}`;
          const alreadyProcessed = await instance.state.get(digestKey);
          if (alreadyProcessed) {
            instance.lastPollTimestamp = Math.max(
              instance.lastPollTimestamp,
              msg.receivedTime + 1
            );
            void instance.state.put(
              "cursor:lastPollTimestamp",
              String(instance.lastPollTimestamp)
            );
            continue;
          }

          // 2. Loop guard check (echoes, denylists, bot peers)
          const sender = msg.senderAddress.raw;
          const dropReason = instance.loopGuard.shouldDrop(sender);
          if (dropReason) {
            console.log(
              `[bot-host] [${id}] Dropped message from ${sender}: ${dropReason}`
            );
            instance.lastPollTimestamp = Math.max(
              instance.lastPollTimestamp,
              msg.receivedTime + 1
            );
            void instance.state.put(
              "cursor:lastPollTimestamp",
              String(instance.lastPollTimestamp)
            );
            continue;
          }

          console.log(
            `[bot-host] [${id}] Enqueuing message from ${sender} (digest: ${msg.payloadDigest.slice(
              0,
              10
            )}..., items: ${msg.items.map((i) => i.type).join(",")})`
          );

          instance.inFlightDigests.add(msg.payloadDigest);

          // 3. Dispatch in per-peer serialized queue
          void instance.peerQueue.enqueue(sender, async () => {
            const msgCtx: BotMessageContext = {
              conversationId: msg.conversationId || sender,
              peerAddress: sender,
              peerSubject: msg.payloadDigest,
              timestampMs: msg.receivedTime,
              payloadDigest: msg.payloadDigest,
              items: msg.items,
              reply: async (replyItems) => {
                await instance.context.sendMessage(
                  sender,
                  replyItems,
                  msg.conversationId
                );
                instance.loopGuard.recordReply(sender);
              },
            };

            try {
              if (await instance.state.get(digestKey)) {
                return;
              }
              let reply = await instance.definition.onMessage(
                msgCtx,
                instance.context
              );
              if (!reply || reply.length === 0) {
                const subReply =
                  await instance.context.subscriptions.handleSubscriptionCommand(
                    msg.items,
                    sender
                  );
                if (subReply) {
                  reply = subReply;
                }
              }
              if (Array.isArray(reply) && reply.length > 0) {
                await instance.context.sendMessage(
                  sender,
                  reply,
                  msg.conversationId
                );
                instance.loopGuard.recordReply(sender);
              }
              await instance.state.put(digestKey, String(Date.now()));
              instance.lastPollTimestamp = Math.max(
                instance.lastPollTimestamp,
                msg.receivedTime + 1
              );
              await instance.state.put(
                "cursor:lastPollTimestamp",
                String(instance.lastPollTimestamp)
              );
            } catch (err) {
              console.error(`[bot-host] Error in bot ${id}.onMessage:`, err);
            } finally {
              instance.inFlightDigests.delete(msg.payloadDigest);
            }
          });
        }
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
      }
    }
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
            await instance.definition.onNewUser(event, instance.context);
          } catch (err) {
            console.error(`[bot-host] error in bot "${id}".onNewUser:`, err);
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

  private async sendMessageWithFallback(
    wallet: MonadChainWalletHandle,
    recipientAddress: string,
    items: MessageItem[],
    conversationId?: string
  ): Promise<DirectMessageSendResult> {
    try {
      const res = await this.chain.directMessages.send({
        wallet,
        recipient: toChainAddress(recipientAddress),
        items,
        conversationId,
      });
      console.log(
        `[bot-host] Canonical send to ${recipientAddress} succeeded (digest: ${res.payloadDigest.slice(
          0,
          10
        )}...)`
      );
      return res;
    } catch (err) {
      console.warn(
        `[bot-host] Canonical send to ${recipientAddress} failed, falling back to standard send:`,
        err
      );
      return this.sendStandardDirectMessage(wallet, recipientAddress, items);
    }
  }

  private async sendStandardDirectMessage(
    wallet: MonadChainWalletHandle,
    recipientAddress: string,
    items: MessageItem[]
  ): Promise<DirectMessageSendResult> {
    const prev = this.walletSendQueues.get(wallet) ?? Promise.resolve();
    const run = prev.then(async () => {
      const toPubKey = await fetchMonadIdentityPubKey({
        relayBaseUrl: this.options.relayBaseUrl,
        address: recipientAddress,
      });
      if (!toPubKey) {
        throw new Error(
          `No registered profile or pubkey for ${recipientAddress}`
        );
      }

      const fundingPrivateKeyHex =
        this.options.fundingPrivateKeyHex || wallet.identity.toPrivateKeyHex();

      const mainAccountSigner = new MonadAccountTxSigner({
        privateKey: fundingPrivateKeyHex,
        provider: this.provider,
        httpClient: new MonadHttpClient({ rpcUrl: this.options.rpcUrl }),
      });

      const gasReserveWei = await quoteMonadStampPaymentGasReserve({
        signer: mainAccountSigner,
        recipientPublicKey: toPubKey,
      });

      await wallet.pool.prepareStampInventory({
        mainAccountSigner,
        provider: this.provider,
        stampValueWei: this.options.stampValueWei,
        gasReserveWei,
      });

      const envelope = buildEnvelope({
        fromAddress: wallet.identity.address.raw,
        fromPrivateKey: wallet.identity.toNakamotoPrivateKey(),
        toAddress: recipientAddress,
        toPubKey,
        plaintext: serializeMessageItems(items),
        networkTag: this.options.networkTag,
      });

      const stampClient = new MonadStampClient({
        pool: wallet.pool,
        leaseManager: wallet.leaseManager,
        provider: this.provider,
        httpClient:
          wallet.httpClient ??
          new MonadHttpClient({ rpcUrl: this.options.rpcUrl }),
        changePool: wallet.changePool,
        relayBaseUrl: this.options.relayBaseUrl,
      });

      const res = await stampClient.submitStampedMessage({
        encryptedPayload: envelope,
        recipientPublicKey: toPubKey,
        stampValueWei: this.options.stampValueWei,
        waitForLease: {
          timeoutMs: 30_000,
          pollIntervalMs: 250,
        },
      });

      return {
        payloadDigest: res.payloadHashHex,
        stampValueWei: this.options.stampValueWei,
        stampPayments: res.txHashes.map((h) => ({
          txHash: h,
          destinationAddress: recipientAddress,
          valueWei: this.options.stampValueWei,
        })),
        preparationTxHashes: [],
      };
    });
    this.walletSendQueues.set(
      wallet,
      run.catch(() => {})
    );
    return run;
  }

  async stop(): Promise<void> {
    if (!this.running && this.instances.size === 0) return;
    const wasRunning = this.running;
    this.running = false;

    if (this.resolveStop) {
      this.resolveStop();
      this.resolveStop = undefined;
      this.stopPromise = undefined;
    }

    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.registrationTimer) clearInterval(this.registrationTimer);
    this.scheduler.stop();

    for (const [id, instance] of this.instances.entries()) {
      try {
        if (instance.definition.onStop) {
          await instance.definition.onStop(instance.context);
        }
        instance.uninstallDirectory();
        await instance.directory.close();
        await instance.state.close();
        await instance.wallet.close();
        console.log(`[bot-host] stopped bot "${id}" cleanly`);
      } catch (err) {
        console.error(`[bot-host] error stopping bot "${id}":`, err);
      }
    }
    this.instances.clear();
  }
}
