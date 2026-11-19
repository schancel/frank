/**
 * INTEGRATION: a poker and a liars-dice table's buy-in escrow on GenericHTLC v2, deployed from its
 * compiled artifact on a real EVM node (`anvil` as `monad-regtest`, chain ID 20143), with real
 * wallets on both sides: the bot (arbiter) and two players are typed wallets opened from their
 * own roots, and every chain call goes through each wallet's contract-call path
 * (`sendContractCall`, the native operation journal, a `table-htlc` record).
 *
 * - A player locks its buy-in (`lockTableBuyIn`) with the terms the bot's table item states and
 *   joins naming that lock, signed by the locking account for its identity; the bot checks the
 *   signature, reads the lock on chain and seats it. A text join, a lock that is not on chain, a
 *   lock with other terms, a join naming a lock id the terms do not give, or another identity
 *   naming someone else's lock are refused, and nobody is seated by them.
 * - Joins arriving together are seated one at a time; a join the game refuses records no seat.
 * - Every end of a game settles, a turn timeout included; a poker table deals one escrowed hand.
 * - Settling pays the pot out with `batchDistribute` from the bot's main account, using the
 *   table preimage the bot derives from its own account; the payouts land on the accounts the
 *   players locked from.
 * - A bot that never settles leaves each player its refund from the deadline on
 *   (`refundTableBuyIn`), and not before.
 * - A settlement whose send fails is retried in the background as written.
 * - A bot restarted from the same account and state store derives the same preimage and still
 *   settles, without startup waiting for it: a table whose game is gone gets its buy-ins back; a
 *   settlement written down but never sent is sent as written (the winner is paid), not
 *   recomputed.
 *
 * Real: the node, the contract, signing, the wallets, their journals and Level stores, the bot's
 * Level state store. No relay: the bots' replies are captured, and players' join items are handed
 * to the bot as the host would after decoding (each wallet's sync hook records notes to self).
 * Only the wallets' RPC URL is redirected (to the anvil node).
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
import { ContractFactory, JsonRpcProvider, Wallet, sha256 } from "ethers";
import {
  LevelBotStateStore,
  botContractCallsOf,
  type BotContext,
  type BotMessageContext,
} from "@frank/bot-framework";
import type {
  LiarsDiceItem,
  MessageItem,
  PokerItem,
  TableEscrowItemTerms,
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
import { encodeHtlcLock, readHtlcLock, HTLC_NATIVE_TOKEN } from "@frank/wallet/swap-escrow";
import {
  lockTableBuyIn,
  refundTableBuyIn,
  tableBuyInLockId,
  type TableEscrowTerms,
} from "@frank/wallet/table-escrow";
import GenericHTLCArtifact from "../../../contracts/artifacts/GenericHTLC.json";
import { PokerBot } from "./poker-bot";
import { LiarsDiceBot } from "./liars-dice-bot";
import { TABLE_MAIN_ACCOUNT_WAIT_MS, TableEscrows, type TableEscrowRecord } from "./table-htlc";
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

/** Synthetic roots for this test's three accounts: public test data, nobody's keys. */
function roots(name: string): MonadRootBundle {
  const root = <P extends "evm-wallet" | "identity-authentication" | "messaging-encryption">(
    purpose: P
  ) => ({
    registry: "frank-domain-roots-v1" as const,
    purpose,
    bytes: new Uint8Array(createHash("sha256").update(`table-htlc-anvil/${name}/${purpose}`).digest()),
  });
  return {
    evm: root("evm-wallet"),
    authentication: root("identity-authentication"),
    messaging: root("messaging-encryption"),
  };
}

/** anvil's first well-known development key: holds the node's test ether. */
const DEV_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
/** monad-regtest's registry minimum gas price (docs/protocol/chains/v1.json). */
const GAS_PRICE = 100n * 10n ** 9n;
const BUY_IN = 10n ** 17n;
const anvilBin = findAnvil();
if (!anvilBin)
  // eslint-disable-next-line no-console
  console.warn("NOT RUN: table-htlc.anvil needs an anvil binary (set ANVIL_BIN). Nothing here was exercised.");
const suite = anvilBin ? describe : describe.skip;

interface Party {
  name: string;
  open(): Promise<EvmChainWalletHandle>;
  wallet: EvmChainWalletHandle;
  main: string;
  /** The identity address it messages from. */
  identity: string;
}

suite("game table buy-in escrow on GenericHTLC v2, real wallets on a real EVM node (anvil)", () => {
  jest.setTimeout(300_000);
  let node: ChildProcess;
  let chain: JsonRpcProvider;
  let dev: Wallet;
  let htlc: string;
  let directory: string;
  let bot: Party;
  let alice: Party;
  let bob: Party;
  let state: LevelBotStateStore;
  const opened: EvmChainWalletHandle[] = [];
  const bots: Array<{ onStop(): Promise<void> }> = [];
  /** A bot stopped after the test, so no background retry outlives it. */
  const started = <B extends { onStop(): Promise<void> }>(b: B): B => {
    bots.push(b);
    return b;
  };

  async function party(name: string): Promise<Party> {
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
      walletStorageLocation: join(directory, name),
      emitWalletSync: async () => undefined,
    };
    const open = async () => {
      const wallet = (await createEvmChain(config).createWallet(roots(name))) as EvmChainWalletHandle;
      opened.push(wallet);
      return wallet;
    };
    const wallet = await open();
    const main = (await wallet.getContractCallFunds!()).mainAddress;
    await (await dev.sendTransaction({ to: main, value: 10n ** 18n })).wait();
    return { name, open, wallet, main, identity: wallet.identity.address.raw };
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
    directory = mkdtempSync(join(tmpdir(), "frank-table-htlc-"));
    bot = await party("bot");
    alice = await party("alice");
    bob = await party("bob");
    for (let i = 0; i < 4; i++) await chain.send("evm_mine", []);
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

  /** The bot's context as its host builds it: the wallet's contract calls and table secret. */
  function botCtx(wallet = bot.wallet, store = state): BotContext {
    return {
      ...amountsOf("monad-regtest"),
      botId: "table-test",
      address: bot.identity,
      provider: chain,
      state: store,
      sendMessage: jest.fn(),
      publishTopicMessage: undefined,
      contractCalls: botContractCallsOf(wallet, () => htlc),
      tableSecrets: tableSecretCapabilityOf(wallet),
    } as unknown as BotContext;
  }

  type Bot = { onMessage(m: BotMessageContext, c: BotContext): Promise<unknown> };
  /** One message to the bot from `from`; the items it replied with. */
  async function say(b: Bot, ctx: BotContext, from: Party, items: MessageItem[]): Promise<MessageItem[]> {
    const reply = jest.fn(async () => ({}) as never);
    await b.onMessage(
      { peerAddress: from.identity, items, reply } as unknown as BotMessageContext,
      ctx
    );
    return reply.mock.calls.flatMap(call => (call as unknown as [MessageItem[]])[0]);
  }
  const text = (items: MessageItem[]) =>
    items.flatMap(i => (i.type === "text" ? [(i as { text: string }).text] : [])).join("\n");
  const tableItem = <T extends PokerItem | LiarsDiceItem>(items: MessageItem[], type: T["type"]) =>
    items.find(i => i.type === type) as T;
  const termsOf = (escrow: TableEscrowItemTerms, buyInWei: string): TableEscrowTerms => ({
    arbiter: escrow.arbiter,
    hashLock: escrow.hashLock,
    buyInWei: BigInt(buyInWei),
    expiresAt: BigInt(escrow.expiresAt),
  });
  const balance = (address: string) => chain.getBalance(address);
  async function included(txHash: string) {
    for (let i = 0; i < 200; i++) {
      const receipt = await chain.getTransactionReceipt(txHash);
      if (receipt) return receipt;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`${txHash} was never included`);
  }

  /** The player's side of joining: lock the buy-in through its wallet, then the join item. */
  async function lockAndJoinItem(
    player: Party,
    type: "poker" | "liars-dice",
    table: PokerItem | LiarsDiceItem
  ): Promise<{ item: MessageItem; lockId: string; signature: string }> {
    const locked = await lockTableBuyIn({
      wallet: player.wallet,
      signer: tableJoinSignerOf(player.wallet)!,
      joiner: player.identity,
      contract: htlc,
      game: type,
      tableId: table.tableId,
      table: termsOf(table.escrow!, table.buyInWei!),
    });
    expect((await included(locked.call.txHash)).status).toBe(1);
    expect(locked.account.toLowerCase()).toBe(player.main.toLowerCase());
    const buyInLock = { lockId: locked.lockId, account: locked.account, signature: locked.signature };
    const item =
      type === "poker"
        ? ({ type, tableId: table.tableId, action: "join", smallBlind: 10, bigBlind: 20, pot: 0, buyInLock } as PokerItem)
        : ({ type, tableId: table.tableId, action: "join", buyInLock } as LiarsDiceItem);
    return { item, lockId: locked.lockId, signature: locked.signature };
  }

  /** `player`'s signed authorization for `joiner` to sit with `lockId` at `table`. */
  const authorize = (player: Party, type: "poker" | "liars-dice", tableId: string, lockId: string, joiner = player.identity) =>
    tableJoinSignerOf(player.wallet)!.signTableJoin({ contract: htlc, game: type, tableId, lockId, joiner });

  it("poker: two players lock and are seated; the settled hand pays the pot out by chip stack", async () => {
    const poker = new PokerBot();
    const ctx = botCtx();
    const created = tableItem<PokerItem>(await say(poker, ctx, alice, [{ type: "text", text: "/poker create" }]), "poker");
    expect(created.escrow!.arbiter.toLowerCase()).toBe(bot.main.toLowerCase());
    expect(created.buyInWei).toBe(BUY_IN.toString());
    // The hash lock is the sha256 of the preimage the bot's own account derives for this table.
    const preimage = tableSecretCapabilityOf(bot.wallet)!.tablePreimage({
      game: "poker",
      tableId: Buffer.from(created.tableId, "hex"),
    });
    expect(sha256(preimage)).toBe(created.escrow!.hashLock);

    const locks: string[] = [];
    for (const player of [alice, bob]) {
      const { item, lockId } = await lockAndJoinItem(player, "poker", created);
      const replied = await say(poker, ctx, player, [item]);
      expect(text(replied)).toContain("joined table");
      locks.push(lockId);
    }
    expect(poker.getTableEscrow(created.tableId)!.seats.map(s => s.lockId)).toEqual(locks);
    expect(await balance(htlc)).toBe(2n * BUY_IN);

    const dealt = tableItem<PokerItem>(await say(poker, ctx, alice, [{ type: "text", text: "/poker start" }]), "poker");
    const folder = dealt.activePlayer!.toLowerCase() === alice.identity.toLowerCase() ? alice : bob;
    const winner = folder === alice ? bob : alice;
    const before = { winner: await balance(winner.main), folder: await balance(folder.main) };
    const settled = await say(poker, ctx, folder, [{ type: "text", text: "/fold" }]);
    expect(text(settled)).toContain("Paid out on chain");

    const record = poker.getTableEscrow(created.tableId)!;
    const txHash = record.settlement!.txHash!;
    expect((await included(txHash)).status).toBe(1);
    for (const id of locks) {
      const lock = await readHtlcLock(chain, htlc, id);
      expect(lock!.state).toBe("withdrawn");
      expect(lock!.preimage).toBe("0x" + Buffer.from(preimage).toString("hex"));
    }
    const paid = new Map(record.settlement!.payouts.map(p => [p.recipient.toLowerCase(), BigInt(p.amountWei)]));
    expect([...paid.values()].reduce((a, b) => a + b, 0n)).toBe(2n * BUY_IN);
    // Stacks 1010 / 990 after the blinds: the pot splits the same way, onto the locking accounts.
    expect(paid.get(winner.main.toLowerCase())).toBe((2n * BUY_IN * 1010n) / 2000n);
    expect(paid.get(folder.main.toLowerCase())).toBe((2n * BUY_IN * 990n) / 2000n);
    expect((await balance(winner.main)) - before.winner).toBe(paid.get(winner.main.toLowerCase()));
    expect((await balance(folder.main)) - before.folder).toBe(paid.get(folder.main.toLowerCase()));
    expect(await balance(htlc)).toBe(0n);
    // Sent from the bot's main account: the lock's recipient, the only one that may distribute.
    expect((await chain.getTransaction(txHash))!.from.toLowerCase()).toBe(bot.main.toLowerCase());
  });

  it("liars-dice: a text join, a missing lock, other terms or a wrong lock id seat nobody; the right lock does", async () => {
    const dice = new LiarsDiceBot();
    const ctx = botCtx();
    const created = tableItem<LiarsDiceItem>(await say(dice, ctx, alice, [{ type: "text", text: "/table create 0.1" }]), "liars-dice");
    const terms = termsOf(created.escrow!, created.buyInWei!);
    const join = (buyInLock?: { lockId: string; account: string; signature: string }) =>
      say(dice, ctx, alice, [
        { type: "liars-dice", tableId: created.tableId, action: "join", ...(buyInLock ? { buyInLock } : {}) } as LiarsDiceItem,
      ]);
    const seats = () => dice.getTableEscrow(created.tableId)!.seats.length;

    expect(text(await say(dice, ctx, alice, [{ type: "text", text: "/table join" }]))).toContain("join from the app");
    expect(text(await join())).toContain("join from the app");
    // The id the terms give, but nothing locked there.
    const expectedId = tableBuyInLockId(terms, alice.main);
    const signed = (lockId: string) => authorize(alice, "liars-dice", created.tableId, lockId);
    expect(text(await join({ lockId: expectedId, account: alice.main, signature: signed(expectedId) }))).toContain("not on chain");
    // A lock with another amount (one wei more), through the same wallet path.
    const other = encodeHtlcLock(htlc, {
      recipient: terms.arbiter,
      refundAddress: alice.main,
      token: HTLC_NATIVE_TOKEN,
      amount: terms.buyInWei + 1n,
      hashLock: terms.hashLock,
      expiresAt: terms.expiresAt,
    });
    const { htlcTableCallOf } = await import("@frank/wallet/swap-escrow");
    const otherId = htlcTableCallOf(alice.main, other.data).lockIds[0]!;
    const sent = await alice.wallet.sendContractCall!({
      to: { raw: other.to },
      data: other.data,
      value: other.value,
      record: { kind: "table-htlc", action: "lock", game: "liars-dice", tableId: created.tableId, lockIds: [otherId] },
    });
    expect((await included(sent.txHash)).status).toBe(1);
    expect((await readHtlcLock(chain, htlc, otherId))!.state).toBe("open");
    expect(text(await join({ lockId: otherId, account: alice.main, signature: signed(otherId) }))).toContain("does not have this table's terms");
    // The right id claimed for another account: Alice's signature is not that account's.
    expect(text(await join({ lockId: expectedId, account: bob.main, signature: signed(expectedId) }))).toContain("not yours");
    // Bob signing for himself an id the terms give Alice's account.
    expect(
      text(await join({ lockId: expectedId, account: bob.main, signature: authorize(bob, "liars-dice", created.tableId, expectedId, alice.identity) }))
    ).toContain("does not have this table's terms");
    expect(seats()).toBe(0);
    // A record that is not its call is refused before anything is signed.
    await expect(
      alice.wallet.sendContractCall!({
        to: { raw: other.to },
        data: other.data,
        value: other.value,
        record: { kind: "table-htlc", action: "refund", game: "liars-dice", tableId: created.tableId, lockIds: [otherId] },
      })
    ).rejects.toMatchObject({ code: "invalid", validation: "record" });

    const { item, lockId, signature } = await lockAndJoinItem(alice, "liars-dice", created);
    expect(lockId).toBe(expectedId);
    // Front-running: Bob reads Alice's lock off the chain and names it, with her signature (for
    // her identity) or with his own over it. Neither seats him.
    expect(text(await say(dice, ctx, bob, [{ ...item }]))).toContain("not yours");
    const bobSigned = authorize(bob, "liars-dice", created.tableId, lockId);
    expect(
      text(
        await say(dice, ctx, bob, [
          { type: "liars-dice", tableId: created.tableId, action: "join", buyInLock: { lockId, account: alice.main, signature: bobSigned } } as LiarsDiceItem,
        ])
      )
    ).toContain("not yours");
    // Alice's signature letting Bob sit with her lock is hers to give, for another table it is not.
    const elsewhere = authorize(alice, "liars-dice", "ab".repeat(16), lockId, bob.identity);
    expect(
      text(
        await say(dice, ctx, bob, [
          { type: "liars-dice", tableId: created.tableId, action: "join", buyInLock: { lockId, account: alice.main, signature: elsewhere } } as LiarsDiceItem,
        ])
      )
    ).toContain("not yours");
    expect(seats()).toBe(0);
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(text(await say(dice, ctx, alice, [item]))).toContain("joined table");
    expect(seats()).toBe(1);
    // The same lock does not seat a second player.
    const again = await say(dice, ctx, bob, [{ ...item }]);
    expect(text(again)).toContain("already holds a seat");
    expect(seats()).toBe(1);
  });

  it("a table the bot never settles: each player refunds its own lock from the deadline on, not before", async () => {
    const dice = new LiarsDiceBot();
    const ctx = botCtx();
    const created = tableItem<LiarsDiceItem>(await say(dice, ctx, alice, [{ type: "text", text: "/table create 0.1" }]), "liars-dice");
    const { item, lockId } = await lockAndJoinItem(alice, "liars-dice", created);
    expect(text(await say(dice, ctx, alice, [item]))).toContain("joined table");
    const refund = () =>
      refundTableBuyIn({
        wallet: alice.wallet,
        reader: chain,
        contract: htlc,
        game: "liars-dice",
        tableId: created.tableId,
        lockId,
      });
    await expect(refund()).rejects.toThrow("not past its deadline");
    // Bob cannot refund Alice's lock from his wallet.
    await chain.send("evm_setNextBlockTimestamp", [created.escrow!.expiresAt]);
    await chain.send("evm_mine", []);
    await expect(
      refundTableBuyIn({ wallet: bob.wallet, reader: chain, contract: htlc, game: "liars-dice", tableId: created.tableId, lockId })
    ).rejects.toThrow("does not refund to this wallet");
    const before = await balance(alice.main);
    const handle = await refund();
    const receipt = await included(handle.txHash);
    expect(receipt.status).toBe(1);
    expect((await readHtlcLock(chain, htlc, lockId))!.state).toBe("refunded");
    const gas = receipt.gasUsed * receipt.gasPrice;
    expect((await balance(alice.main)) - before).toBe(BUY_IN - gas);
    expect(alice.wallet.getNativeOperations!().find(r => r.operationId === handle.operationId)!.record).toEqual({
      kind: "table-htlc",
      action: "refund",
      game: "liars-dice",
      tableId: created.tableId,
      lockIds: [lockId],
    });
    // Restarted, the bot finds every lock of the table refunded: it sends nothing and forgets it.
    const restarted = await restartBot();
    const sends = jest.fn(restarted.contractCalls!.send);
    const revived = started(new LiarsDiceBot());
    await revived.onStart({ ...restarted, contractCalls: { ...restarted.contractCalls!, send: sends } } as BotContext);
    await revived.recovered();
    expect(sends).not.toHaveBeenCalled();
    expect(revived.getTableEscrow(created.tableId)).toBeUndefined();
    expect(await state.get("table-escrow:index")).toBe("[]");
  });

  /** Two players seated at a fresh liars-dice table of `dice`. */
  async function seatedTable(dice: LiarsDiceBot, ctx: BotContext) {
    const created = tableItem<LiarsDiceItem>(await say(dice, ctx, alice, [{ type: "text", text: "/table create 0.1" }]), "liars-dice");
    const locks: string[] = [];
    for (const player of [alice, bob]) {
      const { item, lockId } = await lockAndJoinItem(player, "liars-dice", created);
      expect(text(await say(dice, ctx, player, [item]))).toContain("joined table");
      locks.push(lockId);
    }
    return { created, locks };
  }

  /** The bot process dies: its wallet and state store close. A new one opens both again. */
  async function restartBot(): Promise<BotContext> {
    await state.close();
    await bot.wallet.close();
    bot.wallet = await bot.open();
    state = new LevelBotStateStore(join(directory, "bot-state"));
    return botCtx();
  }

  it("restarted, the bot derives the same preimage and returns the buy-ins of a table whose game is gone", async () => {
    const { created, locks } = await seatedTable(new LiarsDiceBot(), botCtx());
    const before = { alice: await balance(alice.main), bob: await balance(bob.main) };

    const ctx = await restartBot();
    const revived = started(new LiarsDiceBot());
    await revived.onStart(ctx);
    await revived.recovered();
    const record = revived.getTableEscrow(created.tableId)!;
    expect(record.settlement!.payouts).toHaveLength(2);
    expect((await included(record.settlement!.txHash!)).status).toBe(1);
    const preimage = tableSecretCapabilityOf(bot.wallet)!.tablePreimage({
      game: "liars-dice",
      tableId: Buffer.from(created.tableId, "hex"),
    });
    expect(sha256(preimage)).toBe(created.escrow!.hashLock);
    for (const id of locks) {
      const lock = await readHtlcLock(chain, htlc, id);
      expect(lock!.state).toBe("withdrawn");
      expect(lock!.preimage).toBe("0x" + Buffer.from(preimage).toString("hex"));
    }
    expect((await balance(alice.main)) - before.alice).toBe(BUY_IN);
    expect((await balance(bob.main)) - before.bob).toBe(BUY_IN);

    // Started again: the table is settled on chain, so it is dropped and nothing is sent. The
    // bot that settled it stops first (its watcher with it), as a process that dies does.
    await revived.onStop();
    const restarted = await restartBot();
    const sends = jest.fn(restarted.contractCalls!.send);
    const ctx2 = { ...restarted, contractCalls: { ...restarted.contractCalls!, send: sends } } as BotContext;
    const third = started(new LiarsDiceBot());
    await third.onStart(ctx2);
    await third.recovered();
    expect(sends).not.toHaveBeenCalled();
    expect(third.getTableEscrow(created.tableId)).toBeUndefined();
  });

  it("a settlement written down but never sent is sent as written after a restart: the winner gets the pot", async () => {
    const dice = started(new LiarsDiceBot());
    const dying = botCtx();
    const { created, locks } = await seatedTable(dice, dying);
    // The process dies after the payouts are written down and before the call is handed out.
    const crashing = {
      ...dying,
      contractCalls: { ...dying.contractCalls!, send: async () => { throw new Error("process died"); } },
    } as BotContext;
    const game = (dice as unknown as { tables: Map<string, { players: Array<{ diceCount: number }> }> }).tables.get(created.tableId)!;
    for (const p of game.players) p.diceCount = 1;
    await say(dice, crashing, alice, [{ type: "text", text: "/start" }]);
    await say(dice, crashing, alice, [{ type: "text", text: "/bid 1 2" }]);
    expect(text(await say(dice, crashing, bob, [{ type: "text", text: "/liar" }]))).toContain("not sent yet");
    // The process dies before its background retry.
    await dice.onStop();
    const written = dice.getTableEscrow(created.tableId)!.settlement!;
    expect(written.operationId).toBeUndefined();
    expect(written.payouts).toHaveLength(1);
    const winner = written.payouts[0]!.recipient.toLowerCase() === alice.main.toLowerCase() ? alice : bob;
    expect(written.payouts[0]!.amountWei).toBe((2n * BUY_IN).toString());
    for (const id of locks) expect((await readHtlcLock(chain, htlc, id))!.state).toBe("open");
    const before = await balance(winner.main);

    const ctx = await restartBot();
    const revived = started(new LiarsDiceBot());
    await revived.onStart(ctx);
    await revived.recovered();
    const record = revived.getTableEscrow(created.tableId)!;
    expect(record.settlement!.payouts).toEqual(written.payouts);
    expect((await included(record.settlement!.txHash!)).status).toBe(1);
    for (const id of locks) expect((await readHtlcLock(chain, htlc, id))!.state).toBe("withdrawn");
    expect((await balance(winner.main)) - before).toBe(2n * BUY_IN);
  });

  /** Waits for `check` to hold, polling. */
  async function until(check: () => Promise<boolean> | boolean, what: string) {
    for (let i = 0; i < 400; i++) {
      if (await check()) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`never: ${what}`);
  }

  it("joins arriving together are seated one at a time; a join the game refuses records no seat", async () => {
    const poker = started(new PokerBot());
    const ctx = botCtx();
    const created = tableItem<PokerItem>(await say(poker, ctx, alice, [{ type: "text", text: "/poker create" }]), "poker");
    const a = await lockAndJoinItem(alice, "poker", created);
    const b = await lockAndJoinItem(bob, "poker", created);
    // Both players, and Alice's join twice, all at once.
    const replies = await Promise.all([
      say(poker, ctx, alice, [a.item]),
      say(poker, ctx, bob, [b.item]),
      say(poker, ctx, alice, [a.item]),
    ]);
    expect(replies.map(text).filter(t => t.includes("joined table"))).toHaveLength(3);
    const seats = () => poker.getTableEscrow(created.tableId)!.seats;
    expect(seats().map(s => s.lockId)).toEqual([a.lockId, b.lockId]);
    const players = () =>
      (poker as unknown as { tables: Map<string, { players: Array<{ address: string }> }> }).tables.get(created.tableId)!.players;
    expect(players().map(p => p.address)).toEqual([alice.identity, bob.identity]);

    // The hand is dealt: a third player's lock is valid, but the game does not take it.
    await say(poker, ctx, alice, [{ type: "text", text: "/poker start" }]);
    const carol = await party("carol");
    const c = await lockAndJoinItem(carol, "poker", created);
    const refused = text(await say(poker, ctx, carol, [c.item]));
    expect(refused).toContain("Not seated");
    expect(refused).toContain("holds no seat");
    expect(seats()).toHaveLength(2);
    expect(players()).toHaveLength(2);
    expect((await readHtlcLock(chain, htlc, c.lockId))!.state).toBe("open");
  });

  it("poker: a turn timeout that ends the hand settles the table, and no second hand is dealt", async () => {
    const poker = started(new PokerBot());
    const ctx = botCtx();
    const created = tableItem<PokerItem>(await say(poker, ctx, alice, [{ type: "text", text: "/poker create" }]), "poker");
    for (const player of [alice, bob]) {
      const { item } = await lockAndJoinItem(player, "poker", created);
      expect(text(await say(poker, ctx, player, [item]))).toContain("joined table");
    }
    const dealt = tableItem<PokerItem>(await say(poker, ctx, alice, [{ type: "text", text: "/poker start" }]), "poker");
    const folder = dealt.activePlayer!.toLowerCase() === alice.identity.toLowerCase() ? alice : bob;
    const winner = folder === alice ? bob : alice;
    // The small blind's turn runs out facing the big blind: it folds, and the hand ends.
    await (poker as unknown as { onTurnTimeout(t: string, c: BotContext, p: string): Promise<void> }).onTurnTimeout(
      created.tableId,
      ctx,
      folder.identity
    );
    const sent = text((ctx.sendMessage as jest.Mock).mock.calls.at(-1)![1] as MessageItem[]);
    expect(sent).toContain("automatically folded");
    expect(sent).toContain("Paid out on chain");
    const record = poker.getTableEscrow(created.tableId)!;
    expect((await included(record.settlement!.txHash!)).status).toBe(1);
    const paid = new Map(record.settlement!.payouts.map(p => [p.recipient.toLowerCase(), BigInt(p.amountWei)]));
    expect(paid.get(winner.main.toLowerCase())).toBe((2n * BUY_IN * 1010n) / 2000n);
    expect(await balance(htlc)).toBe(0n);
    expect(text(await say(poker, ctx, alice, [{ type: "text", text: "/poker start" }]))).toContain("has settled");
  });

  it("liars-dice: a turn timeout's challenge that ends the game pays the winner", async () => {
    const dice = started(new LiarsDiceBot());
    const ctx = botCtx();
    const { created, locks } = await seatedTable(dice, ctx);
    const game = (dice as unknown as { tables: Map<string, { players: Array<{ diceCount: number }> }> }).tables.get(created.tableId)!;
    for (const p of game.players) p.diceCount = 1;
    await say(dice, ctx, alice, [{ type: "text", text: "/start" }]);
    await say(dice, ctx, alice, [{ type: "text", text: "/bid 1 2" }]);
    await (dice as unknown as { onTurnTimeout(t: string, c: BotContext, p: string): Promise<void> }).onTurnTimeout(
      created.tableId,
      ctx,
      bob.identity
    );
    const sent = text((ctx.sendMessage as jest.Mock).mock.calls.at(-1)![1] as MessageItem[]);
    expect(sent).toContain("automatically called Liar");
    expect(sent).toContain("Paid out on chain");
    const record = dice.getTableEscrow(created.tableId)!;
    expect(record.settlement!.payouts).toHaveLength(1);
    expect(record.settlement!.payouts[0]!.amountWei).toBe((2n * BUY_IN).toString());
    expect((await included(record.settlement!.txHash!)).status).toBe(1);
    for (const id of locks) expect((await readHtlcLock(chain, htlc, id))!.state).toBe("withdrawn");
  });

  it("a settlement whose send fails is retried in the background, as written, until it lands", async () => {
    const dice = started(new LiarsDiceBot({ escrows: new TableEscrows("liars-dice", { retryBaseMs: 100 }) }));
    const ctx = botCtx();
    const { created, locks } = await seatedTable(dice, ctx);
    const real = ctx.contractCalls!;
    let failures = 2;
    const sends: Array<Parameters<typeof real.send>[0]> = [];
    const flaky = {
      ...ctx,
      contractCalls: {
        ...real,
        send: async (params: Parameters<typeof real.send>[0]) => {
          sends.push(params);
          if (failures-- > 0) throw new Error("node unreachable");
          return real.send(params);
        },
      },
    } as BotContext;
    const game = (dice as unknown as { tables: Map<string, { players: Array<{ diceCount: number }> }> }).tables.get(created.tableId)!;
    for (const p of game.players) p.diceCount = 1;
    await say(dice, flaky, alice, [{ type: "text", text: "/start" }]);
    await say(dice, flaky, alice, [{ type: "text", text: "/bid 1 2" }]);
    expect(text(await say(dice, flaky, bob, [{ type: "text", text: "/liar" }]))).toContain("not sent yet");
    const written = dice.getTableEscrow(created.tableId)!.settlement!;
    // Read when it is signed: once the locks are withdrawn the watcher drops the record.
    let record: TableEscrowRecord | undefined;
    await until(() => {
      const now = dice.getTableEscrow(created.tableId);
      if (now?.settlement?.txHash) record = structuredClone(now) as TableEscrowRecord;
      return !!record;
    }, "the retried settlement is signed");
    expect(record!.settlement!.payouts).toEqual(written.payouts);
    expect(sends).toHaveLength(3);
    // Every attempt is the same call, bounded by the locks' deadline, waiting a bounded time
    // for the main account.
    for (const s of sends) {
      expect(s.data).toBe(sends[0]!.data);
      expect(s.deadline).toBe(created.escrow!.expiresAt);
      expect(s.mainAccountWaitMs).toBe(TABLE_MAIN_ACCOUNT_WAIT_MS);
    }
    expect((await included(record!.settlement!.txHash!)).status).toBe(1);
    for (const id of locks) expect((await readHtlcLock(chain, htlc, id))!.state).toBe("withdrawn");
    // Watched after the send: the chain shows every lock withdrawn, so the record is dropped and
    // nothing more is sent; the table stays ended.
    await until(() => dice.getTableEscrow(created.tableId) === undefined, "the settled table is dropped");
    expect(await state.get(`table-escrow:${created.tableId}`)).toBeUndefined();
    expect(sends).toHaveLength(3);
    expect(text(await say(dice, ctx, alice, [{ type: "text", text: "/start" }]))).toContain("has ended");
  });

  it("after a restart, one table's failed recovery neither blocks startup nor the other tables, and is retried", async () => {
    const first = await seatedTable(new LiarsDiceBot(), botCtx());
    const second = await seatedTable(new LiarsDiceBot(), botCtx());
    const ctx = await restartBot();
    const real = ctx.contractCalls!;
    let failing = true;
    const flaky = {
      ...ctx,
      contractCalls: {
        ...real,
        send: async (params: Parameters<typeof real.send>[0]) => {
          if (failing && params.record.tableId === first.created.tableId) throw new Error("node unreachable");
          return real.send(params);
        },
      },
    } as BotContext;
    const revived = started(new LiarsDiceBot({ escrows: new TableEscrows("liars-dice", { retryBaseMs: 100 }) }));
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    // Startup returns while the chain is still being read.
    const slow = { ...flaky, provider: new Proxy(chain, { get: (t, k) => (k === "call" ? async (...a: unknown[]) => { await gate; return (t.call as (...x: unknown[]) => unknown).apply(t, a); } : Reflect.get(t, k)) }) } as BotContext;
    await revived.onStart(slow);
    release();
    await revived.recovered();
    const secondTx = revived.getTableEscrow(second.created.tableId)!.settlement!.txHash;
    expect(secondTx).toBeDefined();
    expect(revived.getTableEscrow(first.created.tableId)!.settlement!.txHash).toBeUndefined();
    failing = false;
    let firstTx: string | undefined;
    await until(() => {
      firstTx = revived.getTableEscrow(first.created.tableId)?.settlement?.txHash;
      return !!firstTx;
    }, "the failed table is retried");
    for (const [{ locks }, txHash] of [[first, firstTx], [second, secondTx]] as const) {
      expect((await included(txHash!)).status).toBe(1);
      for (const id of locks) expect((await readHtlcLock(chain, htlc, id))!.state).toBe("withdrawn");
    }
  });

  /** Ends a seated liars-dice table of `dice` (one die each): Alice bids, Bob calls Liar. */
  async function endDiceTable(dice: LiarsDiceBot, ctx: BotContext, tableId: string): Promise<string> {
    const game = (dice as unknown as { tables: Map<string, { players: Array<{ diceCount: number }> }> }).tables.get(tableId)!;
    for (const p of game.players) p.diceCount = 1;
    (dice as unknown as { conversationTables: Map<string, string> }).conversationTables.set(alice.identity, tableId);
    (dice as unknown as { conversationTables: Map<string, string> }).conversationTables.set(bob.identity, tableId);
    await say(dice, ctx, alice, [{ type: "text", text: "/start" }]);
    await say(dice, ctx, alice, [{ type: "text", text: "/bid 1 2" }]);
    return text(await say(dice, ctx, bob, [{ type: "text", text: "/liar" }]));
  }

  it("a live distribute that reverts on chain is re-sent by the watcher with the same payouts, and lands", async () => {
    const dice = started(new LiarsDiceBot({ escrows: new TableEscrows("liars-dice", { retryBaseMs: 100 }) }));
    const ctx = botCtx();
    const { created, locks } = await seatedTable(dice, ctx);
    const real = ctx.contractCalls!;
    const sends: Array<Parameters<typeof real.send>[0]> = [];
    const hashes: string[] = [];
    const watched = {
      ...ctx,
      contractCalls: {
        ...real,
        send: async (params: Parameters<typeof real.send>[0]) => {
          sends.push(params);
          // The first distribute is given too little gas: it is mined and runs out of gas on
          // chain (receipt status 0), leaving every lock open. Later sends estimate their gas.
          const sent = await real.send(sends.length === 1 ? { ...params, gasLimit: 40_000n } : params);
          hashes.push(sent.txHash);
          return sent;
        },
      },
    } as BotContext;
    const said = await endDiceTable(dice, watched, created.tableId);
    expect(said).toContain("Paid out on chain");
    const written = structuredClone(dice.getTableEscrow(created.tableId)!.settlement!);
    expect(written.payouts).toHaveLength(1);
    const winner = written.payouts[0]!.recipient.toLowerCase() === alice.main.toLowerCase() ? alice : bob;
    expect((await included(hashes[0]!)).status).toBe(0);
    for (const id of locks) expect((await readHtlcLock(chain, htlc, id))!.state).toBe("open");
    const before = await balance(winner.main);

    // Nobody restarts the bot: its watcher sees the revert and sends the same payouts again.
    await until(() => hashes.length >= 2, "the reverted distribute is re-sent");
    expect(sends[1]!.data).toBe(sends[0]!.data);
    expect(sends[1]!.gasLimit).toBeUndefined();
    expect((await included(hashes[1]!)).status).toBe(1);
    for (const id of locks) expect((await readHtlcLock(chain, htlc, id))!.state).toBe("withdrawn");
    expect((await balance(winner.main)) - before).toBe(2n * BUY_IN);
    await until(() => dice.getTableEscrow(created.tableId) === undefined, "the settled table is dropped");
    expect(sends).toHaveLength(2);
    expect(text(await say(dice, ctx, bob, [{ type: "text", text: "/start" }]))).toContain("has ended");
  });

  it("a main account still holding an unmined distribute does not hold the next ending player's message: that settlement is sent once it is free", async () => {
    const dice = started(new LiarsDiceBot({ escrows: new TableEscrows("liars-dice", { retryBaseMs: 100 }) }));
    const ctx = botCtx();
    const first = await seatedTable(dice, ctx);
    const second = await seatedTable(dice, ctx);
    // Blocks stop: the first table's distribute is handed out and stays unmined, so the main
    // account it was sent from has no spendable state until the chain shows it.
    await chain.send("evm_setAutomine", [false]);
    expect(await endDiceTable(dice, ctx, first.created.tableId)).toContain("Paid out on chain");
    const started_ = Date.now();
    expect(await endDiceTable(dice, ctx, second.created.tableId)).toContain("not sent yet");
    // The handler returned without waiting for the account to be free.
    expect(Date.now() - started_).toBeLessThan(TABLE_MAIN_ACCOUNT_WAIT_MS);
    for (const id of [...first.locks, ...second.locks]) expect((await readHtlcLock(chain, htlc, id))!.state).toBe("open");
    await chain.send("evm_setAutomine", [true]);
    await chain.send("evm_mine", []);
    for (const { locks } of [first, second])
      for (const id of locks) await until(async () => (await readHtlcLock(chain, htlc, id))!.state === "withdrawn", "every lock is withdrawn");
    await until(
      () => !dice.getTableEscrow(first.created.tableId) && !dice.getTableEscrow(second.created.tableId),
      "both settled tables are dropped"
    );
    expect(await balance(htlc)).toBe(0n);
  });
});
