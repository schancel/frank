/**
 * INTEGRATION: the hash lock and buy-in lock ids of a poker and a liars-dice table, as the bots
 * build them, are the ones GenericHTLC v2 (`packages/contracts/artifacts/GenericHTLC.json`)
 * computes on a real EVM node (`anvil`): `lockIdOf` and the `Locked` event give the same id, the
 * lock holds the table's hash lock, and the arbiter's `batchDistribute` with the table's preimage
 * pays the pot.
 *
 * Needs an `anvil` binary: `ANVIL_BIN=/path/to/anvil`, or the `@foundry-rs/anvil` package
 * installed, or `anvil` on PATH. Without one the suite reports itself as NOT RUN.
 */
import { spawn, spawnSync, type ChildProcess } from "child_process";
import { existsSync } from "fs";
import { createServer } from "net";
import { dirname, join } from "path";
import { Contract, ContractFactory, JsonRpcProvider, Wallet, parseEther } from "ethers";
import type { BotContext, BotMessageContext } from "@frank/bot-framework";
import {
  encodeHtlcLock,
  evmHtlcInterface,
  HTLC_NATIVE_TOKEN,
} from "@frank/wallet/swap-escrow";
import { encodeBatchDistributeCall } from "@frank/wallet/game-escrow";
import GenericHTLCArtifact from "../../../contracts/artifacts/GenericHTLC.json";
import { PokerBot } from "./poker-bot";
import { LiarsDiceBot } from "./liars-dice-bot";
import { tableBuyInLockId, type TableHtlcEscrow } from "./table-htlc";
import { amountsOf } from "./chain-amounts.testutil";

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

/** anvil's first well-known development key: holds the node's test ether. */
const DEV_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const anvilBin = findAnvil();
if (!anvilBin)
  // eslint-disable-next-line no-console
  console.warn("NOT RUN: table-htlc.anvil needs an anvil binary (set ANVIL_BIN). Nothing here was exercised.");
const suite = anvilBin ? describe : describe.skip;

const botCtx = () =>
  ({
    ...amountsOf("monad-testnet"),
    address: "0x0000000000000000000000000000000000000b07",
    sendMessage: jest.fn(),
    state: { get: jest.fn(), set: jest.fn(), put: jest.fn() },
  }) as unknown as BotContext;

/** Creates a table through the bot's own command and returns the escrow it holds for it. */
async function createTable(
  bot: { onMessage(m: BotMessageContext, c: BotContext): Promise<unknown>; getTableEscrow(id: string): Readonly<TableHtlcEscrow> | undefined },
  command: string
): Promise<Readonly<TableHtlcEscrow>> {
  const reply = jest.fn();
  await bot.onMessage(
    { senderAddress: "0xAlice", items: [{ type: "text", text: command }], reply } as unknown as BotMessageContext,
    botCtx()
  );
  const tableId = reply.mock.calls[0][0][1].tableId as string;
  const escrow = bot.getTableEscrow(tableId);
  if (!escrow) throw new Error(`no escrow for table ${tableId}`);
  return escrow;
}

suite("game table escrow against GenericHTLC v2 on a real EVM node (anvil)", () => {
  jest.setTimeout(60_000);
  let node: ChildProcess;
  let chain: JsonRpcProvider;
  let dev: Wallet;
  let htlcAddress: string;
  let htlc: Contract;

  beforeAll(async () => {
    const port = await freePort();
    node = spawn(anvilBin!, ["--port", String(port), "--silent"], { stdio: "ignore" });
    chain = new JsonRpcProvider(`http://127.0.0.1:${port}`, undefined, { cacheTimeout: -1 });
    for (let attempt = 0; ; attempt++) {
      try {
        await chain.getBlockNumber();
        break;
      } catch (err) {
        if (attempt > 100) throw err;
        await new Promise(r => setTimeout(r, 100));
      }
    }
    dev = new Wallet(DEV_KEY, chain);
    const deployed = await new ContractFactory(GenericHTLCArtifact.abi, GenericHTLCArtifact.bytecode, dev).deploy();
    await deployed.waitForDeployment();
    htlcAddress = await deployed.getAddress();
    htlc = new Contract(htlcAddress, evmHtlcInterface, chain);
  });
  afterAll(() => {
    chain?.destroy();
    node?.kill();
  });

  async function funded(): Promise<Wallet> {
    const w = Wallet.createRandom().connect(chain);
    await (await dev.sendTransaction({ to: w.address, value: parseEther("10") })).wait();
    return w;
  }

  async function playTable(escrow: Readonly<TableHtlcEscrow>) {
    const arbiter = await funded();
    const buyIn = parseEther("0.1");
    const expiresAt = BigInt((await chain.getBlock("latest"))!.timestamp) + 3600n;
    const lockIds: string[] = [];
    for (let seat = 0; seat < 2; seat++) {
      const player = await funded();
      const terms = { refundAddress: player.address, token: HTLC_NATIVE_TOKEN, amount: buyIn, expiresAt };
      const expected = tableBuyInLockId(escrow, arbiter.address, player.address, terms);

      const onChainId: string = await htlc.lockIdOf(
        player.address, arbiter.address, player.address, HTLC_NATIVE_TOKEN, buyIn, escrow.hashLock, expiresAt
      );
      expect(onChainId.toLowerCase()).toBe(expected.toLowerCase());

      const tx = encodeHtlcLock(htlcAddress, { ...terms, recipient: arbiter.address, hashLock: escrow.hashLock });
      const receipt = (await (await player.sendTransaction(tx)).wait())!;
      const locked = receipt.logs
        .map(log => evmHtlcInterface.parseLog(log))
        .find(parsed => parsed?.name === "Locked");
      expect(String(locked!.args.lockId).toLowerCase()).toBe(expected.toLowerCase());
      const stored = await htlc.locks(expected);
      expect(String(stored.hashLock).toLowerCase()).toBe(escrow.hashLock.toLowerCase());
      lockIds.push(expected);
    }

    // The contract accepts the table's preimage against the hash lock: sha256 of the 32 bytes.
    const winner = Wallet.createRandom().address;
    const data = encodeBatchDistributeCall({
      lockIds,
      payouts: [{ recipient: winner, amount: 2n * buyIn }],
      preimage: escrow.preimage,
    });
    const settled = (await (await arbiter.sendTransaction({ to: htlcAddress, data })).wait())!;
    expect(settled.status).toBe(1);
    expect(await chain.getBalance(winner)).toBe(2n * buyIn);
    for (const id of lockIds) expect(Number((await htlc.locks(id)).state)).toBe(2);
  }

  it("a poker table's hash lock and buy-in lock ids are GenericHTLC v2's", async () => {
    await playTable(await createTable(new PokerBot(), "/poker create"));
  });

  it("a liars-dice table's hash lock and buy-in lock ids are GenericHTLC v2's", async () => {
    await playTable(await createTable(new LiarsDiceBot(), "/table create 0.1"));
  });
});
