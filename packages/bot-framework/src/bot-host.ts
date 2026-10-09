import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { randomBytes } from "crypto";
import {
  JsonRpcProvider,
  Wallet,
  getAddress,
  type TransactionReceipt,
} from "ethers";

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
  MONAD_IDENTITY_DERIVATION_PATH,
  MonadIdentity,
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
} from "./types";
import { EVMNonceSequencer } from "./nonce-sequencer";
import { LevelBotStateStore } from "./state-store";
import {
  InboundOperationStore,
  inboundIdentity,
  conversationIdentity,
  type InboundIdentity,
} from "./inbound-operation-store";
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
  operations: InboundOperationStore;
  tasks: Set<Promise<void>>;
  directory: DirectoryManager;
  uninstallDirectory: () => void;
  loopGuard: LoopGuard;
  peerQueue: PeerLaneQueue;
  context: BotContext;
  lastPollTimestamp: number;
  lastAuthRecoveryMs?: number;
  inFlightDigests: Set<string>;
  evmMainPrivateKey?: string;
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
  private closing = false;
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

    const rpcUrls = this.options.rpcUrl
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const primaryRpcUrl = rpcUrls[0] || "https://testnet-rpc.monad.xyz";

    this.provider = new JsonRpcProvider(primaryRpcUrl);
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
    if (this.closing) throw new Error("Bot host is closed");
    if (this.instances.has(definition.id)) {
      throw new Error(`Bot with id "${definition.id}" is already registered`);
    }

    const botStateDir = join(this.options.stateDir, "bots", definition.id);
    mkdirSync(botStateDir, { recursive: true, mode: 0o700 });

    // Admit before root adoption, wallet opening or registration effects. A new state path
    // paired with a previously provisioned identity is not a fresh financial profile.
    const rootFile = join(botStateDir, "account-root.hex");
    const hadRoot = existsSync(rootFile);
    const hadIdentity =
      !!definition.defaultIdentityPath &&
      existsSync(definition.defaultIdentityPath);
    const hadOtherFiles = readdirSync(botStateDir).some(
      (name) => name !== "state"
    );
    const statePath = join(botStateDir, "state");
    // An empty unversioned state path is still an existing profile. Opening Level
    // creates this path, so capture its prior existence before opening it.
    const hadState = existsSync(statePath);
    const state = await LevelBotStateStore.open(statePath);
    let openedWallet: MonadChainWalletHandle | undefined;
    let openedDirectory: DirectoryManager | undefined;
    let uninstall: (() => void) | undefined;
    let operations: InboundOperationStore | undefined;
    try {
      const fresh = await InboundOperationStore.preflight(
        state,
        !hadRoot && !hadIdentity && !hadOtherFiles && !hadState
      );
      if (!fresh && !hadRoot)
        throw new Error("Bot admission root missing; preserve state");
      const rootHex = hadRoot
        ? readFileSync(rootFile, "utf8").trim()
        : randomBytes(32).toString("hex");
      if (!/^[0-9a-f]{64}$/i.test(rootHex))
        throw new Error("Bot admission root invalid; preserve state");
      if (!hadRoot)
        writeFileSync(rootFile, rootHex, { mode: 0o600, flag: "wx" });
      const accountRoot = Uint8Array.from(Buffer.from(rootHex, "hex"));
      const roots = {
        evm: deriveDomainRoot(accountRoot, "evm-wallet"),
        authentication: deriveDomainRoot(
          accountRoot,
          "identity-authentication"
        ),
        messaging: deriveDomainRoot(accountRoot, "messaging-encryption"),
      };
      accountRoot.fill(0);
      const expected = MonadIdentity.fromDomainRoot(roots.authentication);
      const network = canonicalNetworkDescriptor(
        this.options.networkTag
      ).network;
      if (this.chain.chainIdentifier !== network)
        throw new Error("Bot canonical network mismatch");
      operations = await InboundOperationStore.open(
        state,
        {
          chainIdentifier: network,
          botId: definition.id,
          subject: expected.compressedPubKey.toString("hex"),
          address: expected.address.raw.toLowerCase(),
        },
        fresh
      );
      const wallet = (await this.chain.createWallet(
        roots
      )) as MonadChainWalletHandle;
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
      if (
        this.fundingWallet &&
        this.nonceSequencer &&
        definition.id !== "faucet"
      ) {
        const receiveAddress = (await wallet.getReceiveAddress()).raw;
        const targets = [
          { addr: botAddress, label: "Identity address" },
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
      const loopGuard = new LoopGuard({
        selfAddress: botAddress,
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
        operations?.close(),
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

  private async pollAllBots(): Promise<void> {
    for (const [id, instance] of this.instances.entries()) {
      try {
        if (this.closing) return;
        instance.operations.assertOpen();
        // Independently recover already linked operations, including rows behind the mailbox cursor.
        for (const row of instance.operations.listIncomplete()) {
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
        const messages = await this.chain.directMessages.fetchSince({
          wallet: instance.wallet,
          sinceMs: instance.operations.scanFloor(instance.lastPollTimestamp),
        });
        for (const msg of messages) {
          let identity: InboundIdentity;
          try {
            identity = inboundIdentity(msg, instance.operations.owner);
          } catch {
            console.warn(
              `[bot-host] [${id}] Unsupported inbound identity; no handler admitted`
            );
            continue;
          }
          const capturedItems = structuredClone(msg.items);
          if (instance.inFlightDigests.has(identity.digest)) continue;
          if (instance.loopGuard.shouldDrop(identity.peerAddress)) continue;
          instance.inFlightDigests.add(identity.digest);
          const task = instance.peerQueue.enqueue(
            identity.peerAddress,
            async () => {
              try {
                if (
                  this.closing ||
                  !(await instance.operations.admit(identity))
                )
                  return;
                await this.dispatch(instance, identity, capturedItems);
              } catch {
                // An interrupted handler may have generated content or paid. It is never retried,
                // skipped as processed, or completed from a later wallet delivery observation.
                console.warn(
                  `[bot-host] [${id}] Inbound invocation held; preserve original operation`
                );
              } finally {
                instance.inFlightDigests.delete(identity.digest);
              }
            }
          );
          instance.tasks.add(task);
          void task.finally(() => instance.tasks.delete(task));
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
    items: MessageItem[]
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
        const result = await this.sendCanonicalMessage(
          instance.wallet,
          captured.recipient,
          captured.items,
          captured.conversationId,
          { stampValueWei: captured.stampValue },
          (digest) => instance.operations.link(identity.digest, index, digest)
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
      reply: boundReply,
    });
    try {
      let reply = await instance.definition.onMessage(msgCtx, context);
      if (!reply || !reply.length)
        reply =
          (await context.subscriptions.handleSubscriptionCommand(
            items,
            identity.peerAddress
          )) ?? undefined;
      if (reply?.length) await boundReply(reply);
    } catch {
      failed = true;
    } finally {
      accepting = false;
      await Promise.allSettled(replies);
    }
    if (failed)
      throw new Error("Bot invocation incomplete; preserve original operation");
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
    wallet: MonadChainWalletHandle,
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

    for (const [id, instance] of this.instances.entries()) {
      try {
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
