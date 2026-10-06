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
  type MonadChainWalletHandle,
} from "@frank/wallet/chain/monad-chain";
import {
  fetchMonadProfilesSince,
  decodeProfileBytes,
} from "@frank/wallet/monad-identity";

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

  getScheduler(): BotScheduler {
    return this.scheduler;
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
      fundingPrivateKeyHex:
        options.fundingPrivateKeyHex ??
        process.env.E2E_DEMO_MAIN_WALLET_PRIVATE_KEY ??
        "",
      stampValueWei:
        options.stampValueWei ??
        envConfig.defaultStampValueWei ??
        10_000_000_000_000_000n,
      pollIntervalMs: options.pollIntervalMs ?? 3000,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? 30 * 60 * 1000,
      watchRegistrations: options.watchRegistrations ?? true,
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
      directory as unknown as Parameters<typeof installCanonicalDirectory>[1]
    );

    // 5. Register Frank metadata profile on relay
    const profile = definition.getProfile();
    await RelayProfileManager.registerProfile({
      relayBaseUrl: this.options.relayBaseUrl,
      identity: wallet.identity,
      label: definition.id,
      profile,
    });

    // 6. Wire up loop guard and peer queue
    const loopGuard = new LoopGuard({
      selfAddress: botAddress,
    });
    const peerQueue = new PeerLaneQueue();

    // 7. Assemble BotContext
    const subscriptions = new LevelSubscriptionManager(
      state.sublevel("subscriptions"),
      async (recipientAddress: string, items: MessageItem[]) => {
        return this.chain.directMessages.send({
          wallet,
          recipient: toChainAddress(recipientAddress),
          items,
        });
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

      sendMessage: async (recipientAddress: string, items) => {
        return this.chain.directMessages.send({
          wallet,
          recipient: toChainAddress(recipientAddress),
          items,
        });
      },

      sendDirectMessage: async (recipientAddress: string, items) => {
        return this.chain.directMessages.send({
          wallet,
          recipient: toChainAddress(recipientAddress),
          items,
        });
      },

      onNewUserRegistered: (cb) => {
        this.registrationListeners.add(cb);
      },

      sendTransfer: async ({ to, valueWei }) => {
        if (!this.fundingWallet || !this.nonceSequencer) {
          throw new Error(
            "No funding wallet configured on BotHost for native transfers"
          );
        }
        return this.nonceSequencer.withNonce(async (nonce) => {
          const tx = await this.fundingWallet!.sendTransaction({
            to,
            value: valueWei,
            nonce,
          });
          return { txHash: tx.hash };
        });
      },

      buildAndSignTransfer: async ({ to, valueWei }) => {
        if (!this.fundingWallet || !this.nonceSequencer) {
          throw new Error(
            "No funding wallet configured on BotHost for native transfers"
          );
        }
        return this.nonceSequencer.withNonce(async (nonce) => {
          const populated = await this.fundingWallet!.populateTransaction({
            to,
            value: valueWei,
            nonce,
          });
          const rawTx = await this.fundingWallet!.signTransaction(populated);
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

      getBalance: async (): Promise<bigint> => {
        return this.provider.getBalance(botAddress);
      },
    };

    const instance: ActiveBotInstance = {
      definition,
      wallet,
      state,
      directory,
      uninstallDirectory,
      loopGuard,
      peerQueue,
      context,
      lastPollTimestamp: Date.now() - 60_000,
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
    this.pollTimer.unref();

    // Start registration watcher if enabled
    if (this.options.watchRegistrations) {
      this.lastRegistrationPollMs = Date.now() - 3600_000;
      this.registrationTimer = setInterval(() => {
        void this.pollRegistrations();
      }, 5000);
      this.registrationTimer.unref();
    }

    // Start background event scheduler
    this.scheduler.start();

    console.log(
      `[bot-host] FrankBotHost started (${this.instances.size} bots running)`
    );
  }

  private async pollAllBots(): Promise<void> {
    for (const [id, instance] of this.instances.entries()) {
      try {
        const messages = await this.chain.directMessages.fetchSince({
          wallet: instance.wallet,
          sinceMs: instance.lastPollTimestamp,
        });

        for (const msg of messages) {
          instance.lastPollTimestamp = Math.max(
            instance.lastPollTimestamp,
            msg.receivedTime + 1
          );

          // 1. Idempotency check on payload digest
          const digestKey = `digest:${msg.payloadDigest}`;
          const alreadyProcessed = await instance.state.get(digestKey);
          if (alreadyProcessed) continue;

          // 2. Loop guard check (echoes, denylists, bot peers)
          const sender = msg.senderAddress.raw;
          const dropReason = instance.loopGuard.shouldDrop(sender);
          if (dropReason) continue;

          // 3. Dispatch in per-peer serialized queue
          void instance.peerQueue.enqueue(sender, async () => {
            const msgCtx: BotMessageContext = {
              conversationId: sender,
              peerAddress: sender,
              peerSubject: msg.payloadDigest,
              timestampMs: msg.receivedTime,
              payloadDigest: msg.payloadDigest,
              items: msg.items,
              reply: async (replyItems) => {
                await instance.context.sendMessage(sender, replyItems);
                instance.loopGuard.recordReply(sender);
              },
            };

            try {
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
                await instance.context.sendMessage(sender, reply);
                instance.loopGuard.recordReply(sender);
              }
              await instance.state.put(digestKey, String(Date.now()));
            } catch (err) {
              console.error(`[bot-host] Error in bot ${id}.onMessage:`, err);
            }
          });
        }
      } catch (err: unknown) {
        // Polling errors are transient; log and resume next tick
      }
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

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

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
