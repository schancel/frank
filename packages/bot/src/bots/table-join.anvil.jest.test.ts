/**
 * INTEGRATION: the player's side of a poker table's buy-in, end to end, as the app's card runs it
 * (`joinTableWithBuyIn` / `refundTableBuyInAndWait`, `@frank/wallet/table-escrow`), against the
 * real poker bot, on GenericHTLC v2 deployed from its artifact on a real EVM node (`anvil` as
 * `monad-regtest`). Every wallet is a real typed wallet with its own journal and store.
 *
 * - Two players join from the bot's table item: each lock is sent through the wallet's
 *   contract-call path, waited for, then the structured join names it; the bot seats both. One
 *   folds; the bot pays the pot out with `batchDistribute` to the locking accounts.
 * - Joining again reuses the open lock (nothing sent twice).
 * - A third player locks and joins after the hand is dealt: the bot refuses it. Its lock is
 *   refused as a refund before the deadline and refunded after it.
 * - The included lock's note to self carries a `table-htlc-record` naming the table and the lock;
 *   it round-trips through the message-item codec, and the account's OTHER device (the same
 *   roots, its own empty storage) refunds the lock from that record alone.
 *
 * No relay: the bot's replies are captured and the players' join items handed to it as the host
 * would after decoding; each wallet's sync hook records its notes to self. Only the wallets' RPC
 * URL is redirected (to the anvil node).
 *
 * Needs an `anvil` binary: `ANVIL_BIN=/path/to/anvil`, or the `@foundry-rs/anvil` package
 * installed, or `anvil` on PATH. Without one the suite reports itself as NOT RUN.
 */
import { spawn, spawnSync, type ChildProcess } from "child_process";
import { createHash } from "crypto";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { createServer } from "net";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { ContractFactory, JsonRpcProvider, Wallet } from "ethers";
import {
  LevelBotStateStore,
  botContractCallsOf,
  type BotContext,
  type BotMessageContext,
} from "@frank/bot-framework";
import { standaloneItemBudget } from "@frank/codec";
import type {
  MessageItem,
  PokerItem,
  TableHtlcRecordItem,
} from "@frank/cashweb/types/messages";
import type { EvmChainWalletHandle } from "@frank/wallet/evm-wallet-handle";
import type { MonadRootBundle } from "@frank/wallet/evm-wallet-material";
import {
  createEvmChain,
  tableJoinSignerOf,
  tableSecretCapabilityOf,
  type EvmChainConfig,
} from "@frank/wallet/chain/evm-chain";
import { InMemoryNativeTransactionAttemptStore } from "@frank/wallet/chain/chain-wallet";
import { fixedStampDefault } from "@frank/wallet/oracle/stamp-policy.testutil";
import { readHtlcLock } from "@frank/wallet/swap-escrow";
import {
  joinTableWithBuyIn,
  refundTableBuyInAndWait,
  type TableEscrowTerms,
  type TableEscrowTiming,
} from "@frank/wallet/table-escrow";
import GenericHTLCArtifact from "../../../contracts/artifacts/GenericHTLC.json";
import { createBotMessageItemRegistry } from "../message-items";
import { PokerBot } from "./poker-bot";
import { amountsOf } from "./chain-amounts.testutil";

const mockNode = { url: "" };
jest.mock("@frank/wallet/evm-provider", () => {
  const actual = jest.requireActual("@frank/wallet/evm-provider");
  return {
    ...actual,
    createMonadJsonRpcProvider: (options: { chainId?: number | bigint }) =>
      actual.createMonadJsonRpcProvider({ rpcUrl: mockNode.url, chainId: options.chainId }),
  };
});

function findAnvil(): string | undefined {
  if (process.env.ANVIL_BIN && existsSync(process.env.ANVIL_BIN)) return process.env.ANVIL_BIN;
  try {
    const root = dirname(dirname(require.resolve("@foundry-rs/anvil/package.json")));
    const arch = process.arch === "x64" ? "amd64" : process.arch;
    const packaged = join(root, `anvil-${process.platform}-${arch}`, "bin", "anvil");
    if (existsSync(packaged)) return packaged;
  } catch {
    // Not installed as a package.
  }
  return spawnSync("anvil", ["--version"]).status === 0 ? "anvil" : undefined;
}
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });

/** Synthetic roots for this test's accounts: public test data, nobody's keys. */
function roots(name: string): MonadRootBundle {
  const root = <P extends "evm-wallet" | "identity-authentication" | "messaging-encryption">(
    purpose: P
  ) => ({
    registry: "frank-domain-roots-v1" as const,
    purpose,
    bytes: new Uint8Array(createHash("sha256").update(`table-join-anvil/${name}/${purpose}`).digest()),
  });
  return {
    evm: root("evm-wallet"),
    authentication: root("identity-authentication"),
    messaging: root("messaging-encryption"),
  };
}

/** anvil's first well-known development key: holds the node's test ether. */
const DEV_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const GAS_PRICE = 100n * 10n ** 9n;
const anvilBin = findAnvil();
if (!anvilBin)
  // eslint-disable-next-line no-console
  console.warn("NOT RUN: table-join.anvil needs an anvil binary (set ANVIL_BIN). Nothing here was exercised.");
const suite = anvilBin ? describe : describe.skip;
const FAST: TableEscrowTiming = {
  pollMs: 50,
  inclusionTimeoutMs: 20_000,
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
};

interface Party {
  name: string;
  wallet: EvmChainWalletHandle;
  main: string;
  identity: string;
  /** Every note to self the wallet handed its host, as composed. */
  notes: MessageItem[][];
}

suite("joining a poker table from the player's wallet: lock, join, play, payout, refund (anvil)", () => {
  jest.setTimeout(300_000);
  let node: ChildProcess;
  let chain: JsonRpcProvider;
  let dev: Wallet;
  let htlc: string;
  let directory: string;
  let state: LevelBotStateStore;
  const opened: EvmChainWalletHandle[] = [];
  const bots: Array<{ onStop(): Promise<void> }> = [];

  /** A wallet of `account`'s roots with its own storage (`device`): another device of the same
   * account when `device` differs. Funded with 1 ETH at its main account when `fund`. */
  async function party(account: string, device = account, fund = true): Promise<Party> {
    const notes: MessageItem[][] = [];
    const config: EvmChainConfig = {
      networkId: "monad-regtest",
      rpcChain: "monad-regtest",
      localNodeWithoutSpendRule: true,
      chainId: 20143,
      nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
      relayBaseUrl: "http://127.0.0.1:1",
      networkTag: "MONR",
      contracts: { htlc },
      stampBurnAddress: "0x000000000000000000000000000000000000dEaD",
      resolveDefaultStamp: fixedStampDefault(10n ** 15n),
      defaultTopicVoteValueWei: 1_000n,
      subAccountPoolSize: 0,
      walletStorageLocation: join(directory, device),
      emitWalletSync: async (item, record) => {
        notes.push(record ? [item, record] : [item]);
      },
    };
    const wallet = (await createEvmChain(config).createWallet(roots(account))) as EvmChainWalletHandle;
    opened.push(wallet);
    const main = (await wallet.getContractCallFunds!()).mainAddress;
    if (fund) await (await dev.sendTransaction({ to: main, value: 10n ** 18n })).wait();
    return { name: device, wallet, main, identity: wallet.identity.address.raw, notes };
  }

  beforeEach(async () => {
    const port = await freePort();
    mockNode.url = `http://127.0.0.1:${port}`;
    node = spawn(
      anvilBin!,
      ["--port", String(port), "--chain-id", "20143", "--base-fee", "0", "--gas-price", String(GAS_PRICE), "--silent"],
      { stdio: "ignore" }
    );
    chain = new JsonRpcProvider(mockNode.url, 20143, { staticNetwork: true, cacheTimeout: -1 });
    for (let attempt = 0; ; attempt++) {
      try {
        await chain.getBlockNumber();
        break;
      } catch (error) {
        if (attempt > 100) throw error;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    dev = new Wallet(DEV_KEY, chain);
    const deployed = await new ContractFactory(GenericHTLCArtifact.abi, GenericHTLCArtifact.bytecode, dev).deploy();
    await deployed.waitForDeployment();
    htlc = await deployed.getAddress();
    directory = mkdtempSync(join(tmpdir(), "frank-table-join-"));
    state = new LevelBotStateStore(join(directory, "bot-state"));
  });
  afterEach(async () => {
    for (const b of bots.splice(0)) await b.onStop();
    await state?.close().catch(() => undefined);
    for (const wallet of opened.splice(0)) await wallet.close().catch(() => undefined);
    chain?.destroy();
    node?.kill();
    rmSync(directory, { recursive: true, force: true });
  });

  function botCtx(bot: Party): BotContext {
    return {
      ...amountsOf("monad-regtest"),
      botId: "table-join-test",
      address: bot.identity,
      provider: chain,
      state,
      sendMessage: jest.fn(),
      publishTopicMessage: undefined,
      contractCalls: botContractCallsOf(bot.wallet, () => htlc),
      tableSecrets: tableSecretCapabilityOf(bot.wallet),
    } as unknown as BotContext;
  }
  async function say(b: PokerBot, ctx: BotContext, from: Party, items: MessageItem[]): Promise<MessageItem[]> {
    const reply = jest.fn(async () => ({}) as never);
    await b.onMessage({ peerAddress: from.identity, items, reply } as unknown as BotMessageContext, ctx);
    return reply.mock.calls.flatMap(call => (call as unknown as [MessageItem[]])[0]);
  }
  const text = (items: MessageItem[]) =>
    items.flatMap(i => (i.type === "text" ? [(i as { text: string }).text] : [])).join("\n");
  const pokerItem = (items: MessageItem[]) => items.find(i => i.type === "poker") as PokerItem;
  const termsOf = (table: PokerItem): TableEscrowTerms => ({
    arbiter: table.escrow!.arbiter,
    hashLock: table.escrow!.hashLock,
    buyInWei: BigInt(table.buyInWei!),
    expiresAt: BigInt(table.escrow!.expiresAt),
  });

  /** What the app's card does on "Sit at the table": the headless join, then the join item. */
  async function joinFromCard(b: PokerBot, ctx: BotContext, player: Party, table: PokerItem) {
    const lock = await joinTableWithBuyIn({
      wallet: player.wallet,
      reader: chain,
      signer: tableJoinSignerOf(player.wallet)!,
      joiner: player.identity,
      contract: htlc,
      game: "poker",
      tableId: table.tableId,
      table: termsOf(table),
      timing: FAST,
    });
    const reply = await say(b, ctx, player, [
      {
        type: "poker",
        tableId: table.tableId,
        action: "join",
        smallBlind: table.smallBlind,
        bigBlind: table.bigBlind,
        pot: 0,
        buyInLock: { lockId: lock.lockId, account: lock.account, signature: lock.signature },
      } as PokerItem,
    ]);
    return { lock, reply };
  }
  /** The `table-htlc-record` of `player`'s notes to self for `lockId`, once the wallet sent it. */
  async function recordOf(player: Party, action: "lock" | "refund", lockId: string) {
    for (let i = 0; i < 200; i++) {
      const found = player.notes
        .flat()
        .find(
          (item): item is TableHtlcRecordItem =>
            item.type === "table-htlc-record" &&
            (item as TableHtlcRecordItem).action === action &&
            (item as TableHtlcRecordItem).lockIds[0] === lockId
        );
      if (found) return found;
      await player.wallet.reobserveNativeOperations?.();
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`${player.name} never noted its ${action} of ${lockId}`);
  }

  it("two players lock and join from the table item, play a hand, and are paid out; a refused third refunds from its other device after the deadline", async () => {
    const bot = await party("bot");
    const alice = await party("alice");
    const bob = await party("bob");
    const carol = await party("carol");
    for (let i = 0; i < 4; i++) await chain.send("evm_mine", []);
    const poker = new PokerBot();
    bots.push(poker);
    const ctx = botCtx(bot);
    const table = pokerItem(await say(poker, ctx, alice, [{ type: "text", text: "/poker create" }]));
    expect(table.escrow).toBeDefined();
    const buyIn = BigInt(table.buyInWei!);

    // Lock → wait for inclusion → structured join → seated.
    const a = await joinFromCard(poker, ctx, alice, table);
    expect(text(a.reply)).toContain("joined table");
    expect(a.lock.txHash).toBeDefined();
    expect((await readHtlcLock(chain, htlc, a.lock.lockId))!.state).toBe("open");
    // The note to self names the lock and the table, and round-trips through the codec.
    const noted = await recordOf(alice, "lock", a.lock.lockId);
    expect(noted).toMatchObject({
      chainIdentifier: "monad-regtest",
      game: "poker",
      tableId: table.tableId,
      lockIds: [a.lock.lockId],
      txHash: a.lock.txHash,
    });
    const registry = createBotMessageItemRegistry();
    const { bytes } = registry.encodeItem(noted);
    expect(registry.decodeItem("table-htlc-record", bytes, { budget: standaloneItemBudget() })).toEqual({ kind: "item", item: noted });

    // Joining again reuses the open lock: nothing more is sent.
    const before = await chain.getTransactionCount(alice.main);
    const again = await joinTableWithBuyIn({
      wallet: alice.wallet,
      reader: chain,
      signer: tableJoinSignerOf(alice.wallet)!,
      joiner: alice.identity,
      contract: htlc,
      game: "poker",
      tableId: table.tableId,
      table: termsOf(table),
      timing: FAST,
    });
    expect(again.lockId).toBe(a.lock.lockId);
    expect(again.txHash).toBeUndefined();
    expect(await chain.getTransactionCount(alice.main)).toBe(before);

    const b = await joinFromCard(poker, ctx, bob, table);
    expect(text(b.reply)).toContain("joined table");
    expect(poker.getTableEscrow(table.tableId)!.seats).toHaveLength(2);

    // Play: deal, and the player to act folds; the hand settles and the pot is paid out.
    const dealt = pokerItem(await say(poker, ctx, alice, [{ type: "text", text: "/poker start" }]));
    // A third player locks after the deal: the bot refuses the join; the lock holds no seat.
    const c = await joinFromCard(poker, ctx, carol, table);
    expect(text(c.reply)).toContain("Not seated");
    expect(poker.getTableEscrow(table.tableId)!.seats).toHaveLength(2);
    expect((await readHtlcLock(chain, htlc, c.lock.lockId))!.state).toBe("open");

    const balances = { alice: await chain.getBalance(alice.main), bob: await chain.getBalance(bob.main) };
    const folder = dealt.activePlayer!.toLowerCase() === alice.identity.toLowerCase() ? alice : bob;
    const settled = await say(poker, ctx, folder, [{ type: "text", text: "/fold" }]);
    expect(text(settled)).toContain("Paid out on chain");
    for (let i = 0; i < 200; i++) {
      if ((await readHtlcLock(chain, htlc, a.lock.lockId))!.state === "withdrawn") break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect((await readHtlcLock(chain, htlc, a.lock.lockId))!.state).toBe("withdrawn");
    expect((await readHtlcLock(chain, htlc, b.lock.lockId))!.state).toBe("withdrawn");
    const gained =
      (await chain.getBalance(alice.main)) - balances.alice + ((await chain.getBalance(bob.main)) - balances.bob);
    expect(gained).toBe(2n * buyIn);

    // Carol's other device knows the lock from her note to self, and nothing else.
    const record = await recordOf(carol, "lock", c.lock.lockId);
    // One process holds one handle per account: the laptop is closed before the phone opens.
    await carol.wallet.close();
    const carolPhone = await party("carol", "carol-phone", false);
    expect(carolPhone.main).toBe(carol.main);
    const refund = () =>
      refundTableBuyInAndWait({
        wallet: carolPhone.wallet,
        reader: chain,
        contract: htlc,
        game: record.game,
        tableId: record.tableId,
        lockId: record.lockIds[0]!,
        timing: FAST,
      });
    // Before the deadline the refund is refused, and nothing is sent.
    await expect(refund()).rejects.toThrow("not past its deadline");
    await chain.send("evm_increaseTime", [24 * 60 * 60 + 60]);
    await chain.send("evm_mine", []);
    const carolBefore = await chain.getBalance(carol.main);
    const refunded = await refund();
    expect((await chain.getTransactionReceipt(refunded.txHash))!.status).toBe(1);
    expect((await readHtlcLock(chain, htlc, c.lock.lockId))!.state).toBe("refunded");
    const receipt = (await chain.getTransactionReceipt(refunded.txHash))!;
    expect((await chain.getBalance(carol.main)) - carolBefore).toBe(buyIn - receipt.gasUsed * receipt.gasPrice);
    // The refund is noted to self too.
    expect((await recordOf(carolPhone, "refund", c.lock.lockId)).txHash).toBe(refunded.txHash);
    // Asked again, the refund already made is the answer: nothing is sent twice.
    await expect(refund()).resolves.toEqual({ txHash: refunded.txHash });
  });
});
