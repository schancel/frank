/**
 * What each game bot actually replies with goes through the canonical wire rule: every item a
 * bot emits in a played-through exchange is encoded as the paid send path encodes it (before any
 * funding) and read back as a recipient reads it. A reply the wire refuses would never be sent.
 */
import {
  encodeFrame,
  standaloneItemBudget,
  validateFrame,
  type Encodable,
} from "@frank/codec";
import type { BotContext, BotMessageContext } from "@frank/bot-framework";
import type { MessageItem } from "@frank/cashweb/types/messages";
import { createDefaultMessageItemRegistry } from "@frank/wallet/message-item-plugins/default-registry";
import { pluginCapabilitiesNotYetAvailable } from "@frank/wallet/message-item-plugins/registry";
import {
  decodeItemFrames,
  encodeItemFrames,
} from "@frank/wallet/message-item-plugins/wire";

import { LiarsDiceBot } from "./liars-dice-bot";
import { PokerBot } from "./poker-bot";
import { RaffleBot } from "./raffle-bot";
import { RpsBot } from "./rps-bot";
import { SatoshiDiceBot } from "./satoshi-dice-bot";
import { VendorBot } from "./vendor-bot";

const registry = createDefaultMessageItemRegistry(
  pluginCapabilitiesNotYetAvailable
);

const ALICE = "0x" + "a1".repeat(20);
const BOB = "0x" + "b2".repeat(20);
const CAROL = "0x" + "c3".repeat(20);
const BOT = "0x" + "dd".repeat(20);

/** The item as it is after a JSON round trip: no `undefined` properties. */
const plain = (item: MessageItem): MessageItem =>
  JSON.parse(JSON.stringify(item));

/** Encodes as the send path does and reads back as a recipient does. */
function overTheWire(items: MessageItem[]): MessageItem[] {
  const frames = encodeItemFrames(registry, items);
  const revision = validateFrame(
    encodeFrame(
      { typeId: 8, schemaVersion: 1, minReaderVersion: 1 },
      new Map<number, Encodable>([
        [0, "frank"],
        [1, frames],
      ])
    )
  );
  if (revision.kind !== "parsed" || revision.typed?.type !== 8)
    throw new Error("expected a revision");
  return decodeItemFrames(
    registry,
    revision.typed.items,
    standaloneItemBudget()
  );
}

function harness() {
  const state = new Map<string, string>();
  const sent: MessageItem[][] = [];
  let transfers = 0;
  let digests = 0;
  const ctx = {
    botId: "game",
    address: BOT,
    subject: BOT,
    relayBaseUrl: "http://127.0.0.1:8098",
    networkTag: "MONT",
    provider: {},
    state: {
      get: async (k: string) => state.get(k),
      put: async (k: string, v: string) => void state.set(k, v),
      set: async (k: string, v: string) => void state.set(k, v),
      del: async (k: string) => void state.delete(k),
      list: async () => [],
      batch: async () => undefined,
      sublevel: () => undefined,
      close: async () => undefined,
    },
    subscriptions: {},
    lookupPeer: async () => undefined,
    sendMessage: async (_to: string, items: MessageItem[]) => {
      sent.push(items);
      return { ok: true };
    },
    sendDirectMessage: async (_to: string, items: MessageItem[]) => {
      sent.push(items);
      return { ok: true };
    },
    onNewUserRegistered: () => undefined,
    // What the host returns for a payout: a real transaction hash.
    sendTransfer: async () => ({
      txHash: "0x" + (++transfers).toString(16).padStart(64, "0"),
    }),
    sendTransaction: async () => ({
      txHash: "0x" + (++transfers).toString(16).padStart(64, "0"),
    }),
    buildAndSignTransfer: async () => undefined,
    waitForReceipt: async () => undefined,
    getBalance: async () => 10n ** 18n,
  } as unknown as BotContext;
  const say = async (
    bot: { onMessage(m: BotMessageContext, c: BotContext): Promise<void> },
    from: string,
    input: string | MessageItem
  ) => {
    await bot.onMessage(
      {
        conversationId: "c1",
        peerAddress: from,
        peerSubject: from,
        timestampMs: 1_760_000_000_000 + digests,
        // As the host supplies it: 64 lowercase hex characters, no prefix.
        payloadDigest: (++digests).toString(16).padStart(64, "0"),
        stampValueWei: 10n ** 17n,
        items: [
          typeof input === "string" ? { type: "text", text: input } : input,
        ],
        reply: async (items: MessageItem[]) => {
          sent.push(items);
        },
      } as unknown as BotMessageContext,
      ctx
    );
  };
  return { ctx, sent, say };
}

/** Every reply crosses the wire unchanged, and at least one item of `type` was produced. */
function expectCarried(sent: MessageItem[][], type: string, actions: string[]) {
  expect(sent.length).toBeGreaterThan(0);
  const seen = new Set<string>();
  for (const items of sent) {
    expect(overTheWire(items)).toEqual(items.map(plain));
    for (const item of items)
      if (item.type === type) seen.add((item as { action: string }).action);
  }
  expect([...seen].sort()).toEqual([...actions].sort());
}

describe("game bot replies cross the canonical wire", () => {
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it("dice: a roll at every preset target, win or lose", async () => {
    for (const lucky of [0, 65_535]) {
      const bot = new SatoshiDiceBot({ luckyNumberOverride: lucky });
      const { sent, say } = harness();
      for (const target of [64000, 32768, 16384, 6553, 655, 65, 1, 65535])
        await say(bot, ALICE, `/roll 0.01 ${target}`);
      await say(bot, ALICE, "/roll");
      expectCarried(sent, "dice", ["result"]);
    }
  });

  it("rps: a wagered match through every move", async () => {
    for (const move of ["/rock", "/paper", "/scissors"]) {
      const bot = new RpsBot();
      const { sent, say } = harness();
      await say(bot, ALICE, "/rps 0.01");
      await say(bot, ALICE, move);
      expectCarried(sent, "rps", ["start", "resolve"]);
    }
  });

  it("raffle: announce, entries by item and by text, a refused repeat, and the draw", async () => {
    const bot = new RaffleBot({ maxEntries: 3 });
    const { ctx, sent, say } = harness();
    await bot.onNewUser({ address: ALICE, registeredAtMs: 1 }, ctx);
    await say(bot, ALICE, "how does this work?");
    const announce = sent
      .flat()
      .find(i => i.type === "raffle" && i.action === "announce") as {
      raffleId: string;
    };
    await say(bot, ALICE, {
      type: "raffle",
      raffleId: announce.raffleId,
      action: "enter",
    });
    await say(bot, ALICE, "enter");
    await say(bot, BOB, "enter");
    await say(bot, CAROL, "enter");
    expectCarried(sent, "raffle", ["announce", "draw", "error"]);
  });

  it("vendor: catalog, a purchase with its picture, and an unknown item", async () => {
    const image = "data:image/png;base64," + "A".repeat(80_000);
    const bot = new VendorBot({
      catalogItems: [
        {
          itemId: "test-art-1",
          description: "Test art",
          priceWei: 50_000_000_000_000_000n,
          image,
          thumbnail: "data:image/png;base64," + "A".repeat(5_000),
        },
      ],
    });
    const { ctx, sent, say } = harness();
    await bot.onNewUser({ address: ALICE, registeredAtMs: 1 }, ctx);
    await say(bot, ALICE, "what do you have?");
    await say(bot, ALICE, {
      type: "digital-goods",
      action: "request",
      itemId: "test-art-1",
    });
    await say(bot, ALICE, {
      type: "digital-goods",
      action: "request",
      itemId: "missing",
    });
    expectCarried(sent, "digital-goods", ["catalog", "fulfill", "error"]);
    expect(sent.flat().some(i => i.type === "image")).toBe(true);
  });

  it("poker: create, join, deal, bet, call, check and fold to a settled hand", async () => {
    jest.useFakeTimers();
    const bot = new PokerBot();
    const { sent, say } = harness();
    await say(bot, ALICE, "/poker create");
    await say(bot, BOB, "/poker join");
    await say(bot, ALICE, "/poker start");
    for (const [who, command] of [
      [ALICE, "/call"],
      [BOB, "/check"],
      [BOB, "/bet 40"],
      [ALICE, "/raise 80"],
      [BOB, "/call"],
      [ALICE, "/status"],
      [BOB, "/check"],
      [ALICE, "/check"],
      [BOB, "/fold"],
      [ALICE, "/fold"],
    ] as const)
      await say(bot, who, command);
    const actions = new Set(
      sent
        .flat()
        .filter(i => i.type === "poker")
        .map(i => (i as { action: string }).action)
    );
    expect(actions.has("create")).toBe(true);
    expect(actions.has("action")).toBe(true);
    for (const items of sent)
      expect(overTheWire(items)).toEqual(items.map(plain));
  });

  it("liar's dice: create, join, start, bids and a challenge to the showdown", async () => {
    jest.useFakeTimers();
    const bot = new LiarsDiceBot();
    const { sent, say } = harness();
    await say(bot, ALICE, "/table create 0.05");
    await say(bot, BOB, "/table join");
    await say(bot, ALICE, "/start");
    for (const [who, command] of [
      [ALICE, "/bid 1 2"],
      [BOB, "/bid 2 3"],
      [ALICE, "/bid 2 3"],
      [BOB, "/bid 3 3"],
      [ALICE, "/status"],
      [ALICE, "/liar"],
      [BOB, "/liar"],
    ] as const)
      await say(bot, who, command);
    const actions = new Set(
      sent
        .flat()
        .filter(i => i.type === "liars-dice")
        .map(i => (i as { action: string }).action)
    );
    for (const action of ["create", "join", "round_start", "bid", "showdown"])
      expect(actions.has(action)).toBe(true);
    for (const items of sent)
      expect(overTheWire(items)).toEqual(items.map(plain));
  });

  it("a swap offer as the app's dialog builds it", () => {
    const offer: MessageItem = {
      type: "swap-offer",
      swapId: "00112233445566778899aabbccddeeff",
      offeredChain: "monad-testnet",
      offeredAsset: "MON",
      offeredAmount: "0.5",
      requestedChain: "solana-testnet",
      requestedAsset: "SOL",
      requestedAmount: "0.01",
      status: "pending",
      recipientAddress: "0xA1B2c3D4e5F6a1b2C3d4E5f6A1B2c3d4E5F6a1b2",
      createdAt: 1_760_000_000_000,
    };
    expect(overTheWire([offer])).toEqual([offer]);
  });
});
