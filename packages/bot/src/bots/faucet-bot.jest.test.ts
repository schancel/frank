import { harness, PLAYER, BOT } from "./bot-harness.testutil";
import { FaucetBot, MAX_AMOUNT_WEI } from "./faucet-bot";

const AMOUNT = 50_000_000_000_000_000n;
const RESERVE = 100_000_000_000_000_000n;
const OTHER = "0x" + "a2".repeat(20);
const bot = () => new FaucetBot({ amountWei: AMOUNT, minReserveWei: RESERVE });
const user = (address = PLAYER) => ({ address, registeredAtMs: 1 });
const message = (f: ReturnType<typeof harness>, address = PLAYER) =>
  f.message([{ type: "text", text: "hello" }], [], address);
const startup = (b: FaucetBot, f: ReturnType<typeof harness>) =>
  b.schedules[0].handler(f.ctx);

// The existing unit wallet seam enforces one attempt per ID and survives bot restarts.
// This is not evidence about a real relay or chain.
describe("FaucetBot paid welcome", () => {
  test("a new user receives the grant in the welcome stamp, once", async () => {
    const f = harness();
    const b = bot();
    await b.onNewUser(user(), f.ctx);
    await b.onNewUser(user(), f.ctx);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toMatchObject({
      to: PLAYER,
      valueWei: AMOUNT,
      settlement: true,
      hostStamp: false,
    });
    expect(f.sent[0].messageId).toBeDefined();
    expect(f.item("text").text).toBe(
      "This is the Frank faucet. This message includes 0.05 MONT for you to start messaging."
    );
    expect(f.item("text").text).not.toMatch(/profile|cordoned|transaction/);
  });

  test("a first manual request gets a paid welcome in its conversation; later replies are free", async () => {
    const f = harness();
    const b = bot();
    const request = message(f);
    await b.onMessage(request, f.ctx);
    await b.onMessage(message(f), f.ctx);
    expect(f.sent[0]).toMatchObject({
      valueWei: AMOUNT,
      conversationId: request.conversationId,
    });
    expect(f.sent[1]).toMatchObject({ valueWei: 0n, hostStamp: false });
    expect(f.item("text").text).toContain("already received");
    expect(f.paidOut()).toBe(AMOUNT);
  });

  test("simultaneous registration and case-equivalent manual identity pay only once", async () => {
    const f = harness();
    const b = bot();
    await Promise.all([
      b.onNewUser(user(), f.ctx),
      b.onMessage(message(f, `0x${PLAYER.slice(2).toUpperCase()}`), f.ctx),
    ]);
    expect(f.settlements()).toEqual([AMOUNT]);
    expect(f.data.get(`funded:${PLAYER}`)).toBe(`grant:${PLAYER}`);
  });

  test("new and manual grants keep the reserve", async () => {
    const f = harness();
    f.ctx.getBalance = async () => AMOUNT + RESERVE - 1n;
    const b = bot();
    await b.onNewUser(user(), f.ctx);
    await b.onMessage(message(f), f.ctx);
    expect(f.paidOut()).toBe(0n);
    expect(f.data.has(`funded:${PLAYER}`)).toBe(false);
    expect(f.item("text").text).toContain("reserve");
  });

  test("zero reserve still requires the wallet's fee headroom before committing a grant", async () => {
    const f = harness();
    f.ctx.getBalance = async () => AMOUNT;
    f.feeFloor(1n);
    await new FaucetBot({ amountWei: AMOUNT, minReserveWei: 0n }).onNewUser(
      user(),
      f.ctx
    );
    expect(f.data.has(`funded:${PLAYER}`)).toBe(false);
    expect(f.paidOut()).toBe(0n);
  });

  test("owed grants are deducted before another user can consume the reserve", async () => {
    const f = harness();
    f.ctx.getBalance = async () => AMOUNT + RESERVE;
    f.wallet("refuse");
    const b = bot();
    await Promise.all([
      b.onNewUser(user(), f.ctx),
      b.onNewUser(user(OTHER), f.ctx),
    ]);
    expect(f.data.has(`funded:${PLAYER}`)).toBe(true);
    expect(f.data.has(`funded:${OTHER}`)).toBe(false);
    expect(JSON.parse(f.data.get("outbox:index")!).owed).toEqual([
      `grant:${PLAYER}`,
    ]);
  });

  test("a persisted welcome refused before submission is sent after restart without a new grant", async () => {
    const f = harness();
    f.wallet("refuse");
    await bot().onNewUser(user(), f.ctx);
    const owedBefore = f.data.get(`outbox:owed:grant:${PLAYER}`);
    expect(owedBefore).toBeDefined();
    expect(f.sent).toHaveLength(0);
    f.wallet("deliver");
    await startup(bot(), f);
    await bot().onNewUser(user(), f.ctx);
    expect(f.settlements()).toEqual([AMOUNT]);
    expect(f.data.get(`outbox:sent:grant:${PLAYER}`)).toBeDefined();
  });

  test("failure of the atomic journal write exposes no payment and can be retried", async () => {
    const f = harness();
    const batch = f.ctx.state.batch;
    f.ctx.state.batch = async () => {
      throw new Error("state unavailable");
    };
    await bot().onNewUser(user(), f.ctx);
    expect(f.sent).toHaveLength(0);
    expect(f.data.has(`funded:${PLAYER}`)).toBe(false);
    f.ctx.state.batch = batch;
    await bot().onNewUser(user(), f.ctx);
    expect(f.settlements()).toEqual([AMOUNT]);
  });

  test("ambiguous submission keeps the same message ID across restart and repeated requests", async () => {
    const f = harness();
    const ids: (string | undefined)[] = [];
    const send = f.ctx.sendMessage;
    f.ctx.sendMessage = async (...args) => {
      ids.push(args[3]?.messageId);
      return send(...args);
    };
    f.wallet("live");
    await bot().onNewUser(user(), f.ctx);
    await bot().onMessage(message(f), f.ctx);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(1);
    expect(f.sent).toHaveLength(0);
    await startup(bot(), f);
    f.deliverLive();
    f.wallet("deliver");
    await startup(bot(), f);
    await bot().onMessage(message(f), f.ctx);
    expect(f.settlements()).toEqual([AMOUNT]);
    expect(f.data.has(`outbox:owed:grant:${PLAYER}`)).toBe(false);
  });

  test("delivery followed by lost response recovers the original attempt after restart", async () => {
    const f = harness();
    const send = f.ctx.sendMessage;
    const ids: (string | undefined)[] = [];
    f.ctx.sendMessage = async (...args) => {
      ids.push(args[3]?.messageId);
      await send(...args);
      throw new Error("response lost after delivery");
    };
    await bot().onNewUser(user(), f.ctx);
    await startup(bot(), f);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
    expect(f.settlements()).toEqual([AMOUNT]);
    expect(f.data.has(`outbox:sent:grant:${PLAYER}`)).toBe(true);
  });

  test.each(["0xold-confirmed-transfer", "pending"])(
    "preserves legacy %s records even after funds were spent",
    async (record) => {
      const f = harness();
      f.data.set(`funded:${PLAYER}`, record);
      f.ctx.getBalance = async (address) => (address ? 0n : 10n ** 18n);
      await bot().onNewUser(user(), f.ctx);
      await bot().onMessage(message(f), f.ctx);
      expect(f.paidOut()).toBe(0n);
      expect(f.data.get(`funded:${PLAYER}`)).toBe(record);
      expect(f.item("text").text).toContain(
        record === "pending" ? "needs to be checked" : "already received"
      );
    }
  );

  test("a relay-ended grant remains failed across requests and restart, without a fresh payment", async () => {
    const f = harness();
    f.wallet("dead");
    await bot().onNewUser(user(), f.ctx);
    await startup(bot(), f);
    f.wallet("deliver");
    await bot().onMessage(message(f), f.ctx);
    expect(f.settlements()).toEqual([]);
    expect(f.data.has(`outbox:failed:grant:${PLAYER}`)).toBe(true);
    expect(f.item("text").text).toContain("needs to be checked");
  });

  test("the configured grant uses the host chain unit", async () => {
    const f = harness(new Map(), "ethereum-sepolia");
    await bot().onNewUser(user(), f.ctx);
    expect(f.item("text").text).toContain(f.ctx.formatAmount(AMOUNT));
    expect(f.item("text").text).not.toContain("MONT");
  });

  test("invalid grant configuration cannot empty the wallet", () => {
    expect(() => new FaucetBot({ amountWei: MAX_AMOUNT_WEI + 1n })).toThrow();
    expect(() => new FaucetBot({ amountWei: 0n })).toThrow();
  });
  test.each(["included-success", "included-revert", "submitted", "pending"])(
    "legacy native-grants %s records block a regrant and never repay",
    async (stateStatus) => {
      const f = harness();
      const ngState = f.ctx.state.sublevel("native-grants");
      await ngState.put(
        `grant:${PLAYER}`,
        JSON.stringify({
          version: 2,
          chainIdentifier: "monad-testnet",
          walletAddress: BOT,
          recipient: PLAYER,
          valueWei: AMOUNT.toString(),
          minReserveWei: RESERVE.toString(),
          maxFeeWei: "1000",
          previousOperationIds: [],
          operationId: "op1",
        })
      );
      
      ngState.durableBatch = async (ops: any[]) => {
        for (const op of ops) {
          if (op.type === "put") await ngState.put(op.key, op.value);
        }
      };
      
      const operation = {
        operationId: "op1",
        binding: { chainIdentifier: "monad-testnet", kind: "native", recipient: PLAYER, intendedValueWei: AMOUNT.toString() },
        kind: "native",
        recipient: PLAYER,
        intendedValueWei: AMOUNT.toString(),
        maximumFeeWei: "1000",
        cancelled: false,
        members: [{
          exposed: stateStatus !== "pending",
          signed: stateStatus !== "pending" ? { transactionHash: "0xhash" } : undefined,
          observation: { state: stateStatus }
        }]
      };

      const wallet = {
        family: "evm",
        chainIdentifier: "monad-testnet",
        identity: { address: { raw: BOT } },
        getBalance: async () => AMOUNT + RESERVE,
        getNativeOperations: () => [operation],
        resumeNativeOperation: jest.fn(),
      } as any;

      const { NativeGrants } = require("@frank/bot-framework/native-grants");
      f.ctx.nativeGrants = new NativeGrants(ngState, wallet);
      
      const b = bot();
      await b.onNewUser(user(), f.ctx);
      await b.onMessage(message(f), f.ctx);
      
      expect(f.paidOut()).toBe(0n);
      expect(wallet.resumeNativeOperation).toHaveBeenCalledTimes(2);
      expect(f.item("text").text).toContain("needs to be checked");
    }
  );

  test("ambiguous in-flight legacy native-grant without an operationId resolves it from the wallet and reconciles", async () => {
      const f = harness();
      const ngState = f.ctx.state.sublevel("native-grants");
      await ngState.put(
        `grant:${PLAYER}`,
        JSON.stringify({
          version: 2,
          chainIdentifier: "monad-testnet",
          walletAddress: BOT,
          recipient: PLAYER,
          valueWei: AMOUNT.toString(),
          minReserveWei: RESERVE.toString(),
          maxFeeWei: "1000",
          previousOperationIds: [],
          operationId: null,
        })
      );
      ngState.durableBatch = async (ops: any[]) => {
        for (const op of ops) {
          if (op.type === "put") await ngState.put(op.key, op.value);
        }
      };
      
      const operation = {
        operationId: "op1",
        binding: { chainIdentifier: "monad-testnet", kind: "native", recipient: PLAYER, intendedValueWei: AMOUNT.toString() },
        kind: "native",
        recipient: PLAYER,
        intendedValueWei: AMOUNT.toString(),
        maximumFeeWei: "1000",
        cancelled: false,
        members: [{
          exposed: true,
          signed: { transactionHash: "0xhash" },
          observation: { state: "submitted" }
        }]
      };

      const wallet = {
        family: "evm",
        chainIdentifier: "monad-testnet",
        identity: { address: { raw: BOT } },
        getBalance: async () => AMOUNT + RESERVE,
        getNativeOperations: () => [operation],
        resumeNativeOperation: jest.fn(),
      } as any;

      const { NativeGrants } = require("@frank/bot-framework/native-grants");
      f.ctx.nativeGrants = new NativeGrants(ngState, wallet);
      
      const b = bot();
      await b.onNewUser(user(), f.ctx);
      
      expect(f.paidOut()).toBe(0n);
      expect(wallet.resumeNativeOperation).toHaveBeenCalledWith("op1");
      const intent = JSON.parse(await ngState.get(`grant:${PLAYER}`));
      expect(intent.operationId).toBe("op1");
  });
});
