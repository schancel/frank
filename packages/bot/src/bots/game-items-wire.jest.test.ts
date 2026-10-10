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
import type {
  MessageItem,
  RpsItem,
  SatoshiDiceItem,
} from "@frank/cashweb/types/messages";
import { createDefaultMessageItemRegistry } from "@frank/wallet/message-item-plugins/default-registry";
import { pluginCapabilitiesNotYetAvailable } from "@frank/wallet/message-item-plugins/registry";
import {
  MessageItemNotCarriedError,
  decodeItemFrames,
  encodeItemFrames,
} from "@frank/wallet/message-item-plugins/wire";

import { harness as botHarness } from "./bot-harness.testutil";
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

/** A bot's table: `say` delivers one message from a player, with the payments it came with, and
 * `sent` is every message the bot sent, in order. */
function harness() {
  const h = botHarness();
  const sent: MessageItem[][] = [];
  const sync = () => {
    sent.length = 0;
    sent.push(...h.sent.map((message) => message.items));
  };
  const say = async (
    bot: { onMessage(m: BotMessageContext, c: BotContext): Promise<void> },
    from: string,
    input: string | MessageItem,
    paidWei = 0n
  ) => {
    await bot.onMessage(
      h.message(
        [typeof input === "string" ? { type: "text", text: input } : input],
        paidWei > 0n ? [h.pay(paidWei)] : [],
        from
      ),
      h.ctx
    );
    sync();
  };
  return { ...h, sent, say, sync };
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

  it("dice: the table, a paid bet at several targets, and a refused bet", async () => {
    const bot = new SatoshiDiceBot();
    const { sent, say } = harness();
    await say(bot, ALICE, "/roll 0.01 100");
    for (const target of [64000, 32768, 655, 1, 65535]) {
      const offer = sent[sent.length - 1].find(
        (i) => i.type === "dice"
      ) as SatoshiDiceItem;
      await say(
        bot,
        ALICE,
        {
          type: "dice",
          action: "roll",
          rollId: offer.nextRollId ?? offer.rollId,
          commitment: offer.nextCommitment ?? offer.commitment,
          clientSeed: "c3".repeat(16),
          target,
          wagerWei: "1000",
        },
        1000n
      );
    }
    // A bet on a roll that is not on offer: refused, with a new table.
    await say(bot, ALICE, { type: "dice", action: "roll", rollId: "gone" });
    expectCarried(sent, "dice", ["table", "result"]);
  });

  it("rps: a staked match through every move, and a typed one", async () => {
    for (const move of ["rock", "paper", "scissors"] as const) {
      const bot = new RpsBot();
      const { sent, say } = harness();
      await say(bot, ALICE, "/rps 0.01");
      const start = sent[0].find((i) => i.type === "rps") as RpsItem;
      await say(
        bot,
        ALICE,
        {
          type: "rps",
          action: "move",
          matchId: start.matchId,
          commitHash: start.commitHash,
          playerMove: move,
          wagerWei: "1000",
        },
        1000n
      );
      await say(bot, ALICE, "/rps");
      await say(bot, ALICE, `/${move}`);
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

  it("a swap offer as the app's dialog builds it is not carried: refused before any payment", () => {
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
    expect(() => overTheWire([offer])).toThrow(MessageItemNotCarriedError);
  });
});
