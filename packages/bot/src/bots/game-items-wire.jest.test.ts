import { testBlob } from '../../../wallet/message-item-plugins/blob/blob.testutil'
/**
 * What each game bot actually replies with goes through the canonical wire rule: every item a
 * bot emits in a played-through exchange is encoded as the paid send path encodes it (before any
 * funding) and read back as a recipient reads it. A reply the wire refuses would never be sent.
 */
import type { BotContext, BotMessageContext } from "@frank/bot-framework";
import type {
  LiarsDiceItem,
  MessageItem,
  PokerItem,
  RpsItem,
  SatoshiDiceItem,
} from "@frank/cashweb/types/messages";
import { commitSeed as commitPokerSeed } from "@frank/wallet/message-item-plugins/poker";
import { commitSeed as commitDiceSeed } from "@frank/wallet/message-item-plugins/liars-dice";
import { MessageItemNotCarriedError } from "@frank/wallet/message-item-plugins/wire";

import { harness as botHarness } from "./bot-harness.testutil";
import { overTheWire } from "./wire.testutil";
import { RaffleBot } from "./raffle-bot";
import { RpsBot } from "./rps-bot";
import { SatoshiDiceBot } from "./satoshi-dice-bot";
import { VendorBot } from "./vendor-bot";
import { PokerBot } from "./poker-bot";
import { LiarsDiceBot } from "./liars-dice-bot";
import { seatingEscrowBook } from "./table-escrow-book.testutil";

const ALICE = "0x" + "a1".repeat(20);
const BOB = "0x" + "b2".repeat(20);
const CAROL = "0x" + "c3".repeat(20);
const BOT = "0x" + "dd".repeat(20);

/** A bot's table: `say` delivers one message from a player, with the payments it came with, and
 * `sent` is every message the bot sent, in order. */
function harness(options: { hostStampedReplies?: boolean } = {}) {
  const h = botHarness();
  const sent: MessageItem[][] = [];
  const sync = () => {
    sent.length = 0;
    sent.push(...h.sent.map((message) => message.items));
    // No bot leaves a message of its own to the host's paid stamp. The table bots (poker, liar's
    // dice) answer through `msgCtx.reply`, which the host stamps; their tests are about items.
    if (!options.hostStampedReplies)
      expect(h.sent.filter((message) => message.hostStamp)).toEqual([]);
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
    expect(overTheWire(items)).toEqual(items);
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
    expectCarried(sent, "dice", ["table", "result", "rejected"]);
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

  it("raffle: announce, paid entries, a refused repeat and an unpaid entry, and the draw", async () => {
    const PRICE = 20_000_000_000_000_000n;
    const bot = new RaffleBot({ maxEntries: 3 });
    const { ctx, sent, say, sync } = harness();
    await bot.onNewUser({ address: ALICE, registeredAtMs: 1 }, ctx);
    sync();
    await say(bot, ALICE, "how does this work?");
    const announce = sent
      .flat()
      .find((i) => i.type === "raffle" && i.action === "announce") as {
      raffleId: string;
    };
    const enter: MessageItem = {
      type: "raffle",
      raffleId: announce.raffleId,
      action: "enter",
    };
    await say(bot, ALICE, enter, PRICE);
    await say(bot, ALICE, enter, PRICE);
    await say(bot, BOB, "enter");
    await say(bot, BOB, enter, PRICE);
    await say(bot, CAROL, enter, PRICE);
    expectCarried(sent, "raffle", ["announce", "joined", "draw", "error"]);
  });

  it("vendor: catalog, a paid purchase with its picture, an unpaid one and an unknown item", async () => {
    const image = "data:image/png;base64," + "A".repeat(80_000);
    const priceWei = 50_000_000_000_000_000n;
    const bot = new VendorBot({
      catalogItems: [
        {
          itemId: "test-art-1",
          description: "Test art",
          priceWei,
          image: testBlob(image),
          thumbnail: "data:image/png;base64," + "A".repeat(5_000),
        },
      ],
    });
    const { ctx, sent, say, sync } = harness();
    await bot.onNewUser({ address: ALICE, registeredAtMs: 1 }, ctx);
    sync();
    await say(bot, ALICE, "what do you have?");
    const buy: MessageItem = {
      type: "digital-goods",
      action: "request",
      itemId: "test-art-1",
    };
    await say(bot, ALICE, buy);
    expect(sent.flat().some((i) => i.type === "blob")).toBe(false);
    await say(bot, ALICE, buy, priceWei);
    await say(bot, ALICE, { ...buy, itemId: "missing" }, priceWei);
    expectCarried(sent, "digital-goods", ["catalog", "fulfill", "error"]);
    expect(sent.flat().some((i) => i.type === "blob")).toBe(true);
  });

  it("poker: create, status, seeds, joins, a hand played to showdown and its settlement", async () => {
    const bot = new PokerBot({ escrows: seatingEscrowBook("poker").book });
    const { sent, say } = harness({ hostStampedReplies: true });
    const last = () =>
      sent[sent.length - 1].find((i) => i.type === "poker") as PokerItem | undefined;
    await say(bot, ALICE, "/poker create");
    await say(bot, BOB, "/poker status");
    await say(bot, ALICE, "/poker join");
    await say(bot, BOB, "/poker join");
    const seeds = { [ALICE]: "a5".repeat(32), [BOB]: "b5".repeat(32) };
    for (const [player, seed] of Object.entries(seeds))
      await say(bot, player, `/poker commit ${commitPokerSeed(seed)}`);
    for (const [player, seed] of Object.entries(seeds))
      await say(bot, player, `/poker seed ${seed}`);
    await say(bot, ALICE, "/poker start");
    expect(last()?.serverCommit).toBeDefined();
    expect(last()?.holeCardCommits).toBeDefined();
    // Check, or call when there is a bet to match, until the hand is settled.
    for (let turn = 0; turn < 20 && last()?.street !== "settled"; turn++) {
      const active = last()!.activePlayer!;
      await say(bot, active, "/check");
      if (!last()) await say(bot, active, "/call");
    }
    expect(last()?.street).toBe("settled");
    // Revealed at settlement: what the app's fold verifies.
    expect(last()?.serverSeed).toBeDefined();
    expect(last()?.playerSeeds).toBeDefined();
    expect(last()?.holeCardSalts).toBeDefined();
    await say(bot, ALICE, "/poker status");
    expectCarried(sent, "poker", ["create", "action", "settle"]);
  });

  it("liar's dice: create, status, seeds, joins, rounds of bids and challenges to a winner", async () => {
    const bot = new LiarsDiceBot({ escrows: seatingEscrowBook("liars-dice").book });
    const { sent, say } = harness({ hostStampedReplies: true });
    const last = () =>
      sent[sent.length - 1].find((i) => i.type === "liars-dice") as LiarsDiceItem | undefined;
    await say(bot, ALICE, "/status");
    await say(bot, ALICE, "/table create 0.05");
    await say(bot, BOB, "/status");
    await say(bot, ALICE, "/table join");
    await say(bot, BOB, "/table join");
    let winner: string | undefined;
    for (let round = 0; round < 20 && !winner; round++) {
      await say(bot, ALICE, "/start");
      // Each seated player commits to and reveals a seed: the cups are then dealt and committed.
      for (const player of last()?.players ?? []) {
        const seed = (player === ALICE ? "a5" : "b5").repeat(31) + round.toString(16).padStart(2, "0");
        await say(bot, player, `/commit ${commitDiceSeed(seed)}`);
        await say(bot, player, `/seed ${seed}`);
      }
      await say(bot, ALICE, "/status");
      const bidder = last()!.activePlayer!;
      await say(bot, bidder, "/bid 1 2");
      await say(bot, last()!.activePlayer!, "/liar");
      winner = last()?.winnerAddress;
    }
    expect(winner).toBeDefined();
    expect(sent.flat().some((i) => i.type === "liars-dice" && i.cupCommits && Object.keys(i.cupCommits).length > 0)).toBe(true);
    expectCarried(sent, "liars-dice", ["create", "join", "round_start", "bid", "showdown"]);
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
