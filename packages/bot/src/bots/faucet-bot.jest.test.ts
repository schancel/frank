import type { BotContext } from "@frank/bot-framework";
import { harness, PLAYER } from "./bot-harness.testutil";
import { FaucetBot, MAX_AMOUNT_WEI } from "./faucet-bot";

const AMOUNT = 50_000_000_000_000_000n;
const RESERVE = 100_000_000_000_000_000n;

/** A faucet wallet holding `funds`, and what it transferred. */
function faucet(funds = 10n ** 18n) {
  const h = harness();
  const transfers: { to: string; valueWei: bigint }[] = [];
  const balances = new Map<string, bigint>();
  let fails = false;
  const grants = new Map<string, string>();
  const ctx = {
    ...h.ctx,
    getBalance: async (address?: string) =>
      address ? balances.get(address.toLowerCase()) ?? 0n : funds,
    sendTransfer: async () => {
      throw new Error("Faucet must use durable grant capability");
    },
    nativeGrants: {
      resume: jest.fn(async () => undefined),
      grant: jest.fn(
        async ({
          to,
          valueWei,
          minReserveWei,
        }: {
          to: string;
          valueWei: bigint;
          minReserveWei: bigint;
        }) => {
          if (fails) throw new Error("rpc down");
          const txHash = grants.get(to.toLowerCase());
          if (txHash) return { state: "confirmed", already: true, txHash };
          if (funds < valueWei + minReserveWei)
            return { state: "low", already: false };
          funds -= valueWei;
          transfers.push({ to, valueWei });
          const hash = "0x" + transfers.length.toString(16).padStart(64, "0");
          grants.set(to.toLowerCase(), hash);
          return { state: "confirmed", already: false, txHash: hash };
        }
      ),
    },
  } as unknown as BotContext;
  return { ...h, ctx, transfers, failTransfers: (on: boolean) => (fails = on) };
}

const bot = () => new FaucetBot({ amountWei: AMOUNT, minReserveWei: RESERVE });

describe("FaucetBot", () => {
  test("grants a new profile once and says where the money went", async () => {
    const f = faucet();
    const b = bot();
    await b.onNewUser({ address: PLAYER, registeredAtMs: 1 }, f.ctx);
    await b.onNewUser({ address: PLAYER, registeredAtMs: 2 }, f.ctx);
    expect(f.transfers).toEqual([{ to: PLAYER, valueWei: AMOUNT }]);
    expect(f.sent).toHaveLength(1);
    expect(f.item("text").text).toContain(`profile address ${PLAYER}`);
  });

  test("a message from a profile that was never granted is granted once; afterwards it is told so", async () => {
    const f = faucet();
    const b = bot();
    await b.onMessage(
      f.message([{ type: "text", text: "funds please" }]),
      f.ctx
    );
    await b.onMessage(f.message([{ type: "text", text: "again" }]), f.ctx);
    expect(f.transfers).toHaveLength(1);
    expect(f.sent[1].items[0]).toMatchObject({
      text: expect.stringContaining("already received"),
    });
  });

  test("two requests at once for one profile grant once", async () => {
    const f = faucet();
    const b = bot();
    await Promise.all([
      b.onNewUser({ address: PLAYER, registeredAtMs: 1 }, f.ctx),
      b.onMessage(f.message([{ type: "text", text: "hi" }]), f.ctx),
    ]);
    expect(f.transfers).toHaveLength(1);
  });

  test("the reserve is kept on both paths", async () => {
    const f = faucet(AMOUNT + RESERVE - 1n);
    const b = bot();
    await b.onNewUser({ address: PLAYER, registeredAtMs: 1 }, f.ctx);
    await b.onMessage(f.message([{ type: "text", text: "hi" }]), f.ctx);
    expect(f.transfers).toHaveLength(0);
    expect(f.item("text").text).toContain("reserve");
  });

  test("a transfer that failed is not counted as a grant", async () => {
    const f = faucet();
    const b = bot();
    f.failTransfers(true);
    await b.onMessage(f.message([{ type: "text", text: "hi" }]), f.ctx);
    expect(f.item("text").text).toContain("could not send");
    f.failTransfers(false);
    // Also after a restart: the unfinished record does not block the grant.
    await bot().onMessage(f.message([{ type: "text", text: "hi" }]), f.ctx);
    expect(f.transfers).toHaveLength(1);
  });

  test("an old pending grant never authorizes a fresh payment, regardless of recipient balance", async () => {
    const f = faucet();
    await bot().onMessage(f.message([{ type: "text", text: "hi" }]), f.ctx);
    f.data.set(`funded:${PLAYER}`, "pending");
    await bot().onMessage(f.message([{ type: "text", text: "hi" }]), f.ctx);
    expect(f.transfers).toHaveLength(1);
    expect(f.item("text").text).toContain("could not send");
  });

  test("startup and scheduled recovery resume existing grants without new registration", async () => {
    const f = faucet();
    await bot().schedules[0]!.handler(f.ctx);
    expect(f.ctx.nativeGrants!.resume).toHaveBeenCalledTimes(1);
    expect(f.transfers).toHaveLength(0);
  });

  test("every setting is enforced: there is no cap that is read and ignored", () => {
    expect(() => new FaucetBot({ amountWei: MAX_AMOUNT_WEI + 1n })).toThrow();
    expect(() => new FaucetBot({ amountWei: 0n })).toThrow();
    expect(Object.keys(bot())).not.toEqual(
      expect.arrayContaining(["maxPerDay", "maxPerRun"])
    );
  });
});
