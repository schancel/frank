import { randomBytes } from "crypto";
import type {
  FrankBotDefinition,
  BotProfile,
  BotContext,
  BotMessageContext,
  InterruptedMessage,
  BotScheduleDefinition,
  NewUserEvent,
} from "@frank/bot-framework";
import { GAME_MAX_REPLIES_PER_PEER } from "@frank/bot-framework";
import type { MessageItem, RaffleItem } from "@frank/cashweb/types/messages";
import {
  buildRaffleDrawItem,
  sha256Hex,
} from "@frank/wallet/message-item-plugins/raffle/draw";
import { formatMon } from "@frank/wallet/monad-amount";
import { ACCOUNT_TYPE_BOT, BOT_ROLE_GAME } from "@frank/codec";
import { generateAvatarPng } from "../../bot-directory";
import { Outbox, refuse, type Received, replyFree, sendFree } from "./money";

export const RAFFLE_DEFAULT_ENTRY_PRICE_WEI = 20_000_000_000_000_000n; // 0.02 MON
export const RAFFLE_DEFAULT_MAX_ENTRIES = 5;

/** One round. `open`: taking entries. `drawing`: full, the winner is fixed and is owed the pot;
 * nobody else is told and no new round opens until that payment has gone out. */
export interface RaffleRoundState {
  raffleId: string;
  entryPriceWei: string;
  maxEntries: number;
  serverSeed: string;
  serverSeedHash: string;
  entrants: string[];
  /** The hash of each entrant's own confirmed entry payment, in the order they joined. */
  entryTxHashes: string[];
  /** The conversation each entrant entered in (null: the default thread): where they are told
   * the draw. */
  conversations: (string | null)[];
  status: "open" | "drawing";
}

const ROUND = "current_round";
const UNPAID = "unpaid_rounds";

export class RaffleBot implements FrankBotDefinition {
  readonly id = "raffle";
  /** A game is many replies to one player: see `GAME_MAX_REPLIES_PER_PEER`. */
  readonly maxRepliesPerPeer = GAME_MAX_REPLIES_PER_PEER;
  readonly label = "Raffle";
  readonly defaultIdentityPath =
    process.env.RAFFLE_BOT_IDENTITY_JSON ?? "/tmp/raffle-bot-identity.json";

  private readonly entryPriceWei: bigint;
  private readonly maxEntries: number;
  private readonly outbox = new Outbox("raffle");
  /** Entries change the round one at a time. */
  private turn: Promise<unknown> = Promise.resolve();

  readonly schedules: BotScheduleDefinition[] = [
    this.outbox.schedule,
    {
      // A round whose winner could not be paid at once is finished here once the payment went.
      id: "raffle-finish",
      intervalMs: 10_000,
      runOnStartup: true,
      handler: (ctx) => this.serial(() => this.finish(ctx)),
    },
  ];

  constructor(options?: { entryPriceWei?: bigint; maxEntries?: number }) {
    this.entryPriceWei =
      options?.entryPriceWei ?? RAFFLE_DEFAULT_ENTRY_PRICE_WEI;
    this.maxEntries = options?.maxEntries ?? RAFFLE_DEFAULT_MAX_ENTRIES;
  }

  getProfile(): BotProfile {
    return {
      name: "Raffle",
      bio: "Raffle: pay the entry price to join; when the round is full one entrant wins the whole pot. The draw seed is committed before the round opens, and the app checks the draw.",
      avatarPng: generateAvatarPng("raffle", [230, 160, 40]),
      bot: true,
      accountType: ACCOUNT_TYPE_BOT,
      botRole: BOT_ROLE_GAME,
    };
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.turn.then(run, run);
    this.turn = next.catch(() => undefined);
    return next;
  }

  /** The round on record; a new one, with its seed committed, when there is none. A record that
   * cannot be read is an error, never silently a new round: it may hold entrants' money. */
  private async round(ctx: BotContext): Promise<RaffleRoundState> {
    const raw = await ctx.state.get(ROUND);
    if (raw !== undefined) return JSON.parse(raw) as RaffleRoundState;
    const serverSeed = randomBytes(32).toString("hex");
    const round: RaffleRoundState = {
      raffleId: randomBytes(16).toString("hex"),
      entryPriceWei: this.entryPriceWei.toString(),
      maxEntries: this.maxEntries,
      serverSeed,
      serverSeedHash: sha256Hex(serverSeed),
      entrants: [],
      entryTxHashes: [],
      conversations: [],
      status: "open",
    };
    await ctx.state.put(ROUND, JSON.stringify(round));
    return round;
  }

  private status(
    round: RaffleRoundState,
    action: "announce" | "joined"
  ): RaffleItem {
    return {
      type: "raffle",
      raffleId: round.raffleId,
      action,
      entryPriceWei: round.entryPriceWei,
      maxEntries: round.maxEntries,
      entryCount: round.entrants.length,
      serverSeedHash: round.serverSeedHash,
    };
  }

  private invitation(round: RaffleRoundState): MessageItem[] {
    return [
      this.status(round, "announce"),
      {
        type: "text",
        text:
          round.status === "open"
            ? `Round ${round.raffleId.slice(0, 8)}: ${round.entrants.length} of ${
                round.maxEntries
              } entries. Entry is ${formatMon(
                BigInt(round.entryPriceWei)
              )}, paid with your entry message; the winner takes all ${formatMon(
                BigInt(round.entryPriceWei) * BigInt(round.maxEntries)
              )}. Use the card to enter.`
            : `Round ${round.raffleId.slice(
                0,
                8
              )} is full and its winner is being paid. The next round opens once that payment has gone out.`,
      },
    ];
  }

  async onNewUser(user: NewUserEvent, ctx: BotContext): Promise<void> {
    try {
      const round = await this.serial(() => this.round(ctx));
      await sendFree(ctx, user.address, this.invitation(round));
    } catch (err) {
      console.warn(`[raffle] Failed to welcome new user ${user.address}:`, err);
    }
  }

  /** A message cut off by a crash: what it paid is accounted for (see `Outbox.interrupted`). */
  onInterrupted(message: InterruptedMessage, ctx: BotContext): Promise<void> {
    return this.outbox.interrupted(ctx, message);
  }

  async onMessage(msgCtx: BotMessageContext, ctx: BotContext): Promise<void> {
    const entry = msgCtx.items.find(
      (item): item is RaffleItem =>
        item.type === "raffle" && item.action === "enter"
    );
    const typed = msgCtx.items.some(
      (item) => item.type === "text" && item.text.trim().toLowerCase() === "enter"
    );
    if (!entry && !typed) {
      const round = await this.serial(() => this.round(ctx));
      await replyFree(msgCtx, this.invitation(round));
      return;
    }
    // What the entry paid, on chain; looked up before taking the round's turn, since it can wait.
    await this.outbox.handle(msgCtx, ctx, (received) =>
      this.serial(() => this.enter(entry, msgCtx, ctx, received))
    );
  }

  private async enter(
    entry: RaffleItem | undefined,
    msgCtx: BotMessageContext,
    ctx: BotContext,
    received: Received
  ): Promise<void> {
    const round = await this.round(ctx);
    const peer = msgCtx.peerAddress.toLowerCase();
    const refused = (why: string) =>
      refuse(this.outbox, msgCtx, ctx, received, why, [
        { type: "raffle", raffleId: round.raffleId, action: "error", message: why },
      ]);
    if (round.status !== "open")
      return refused(
        "This round is full and its winner is being paid. You are not entered."
      );
    if (entry && entry.raffleId !== round.raffleId)
      return refused("That round is over. You are not entered in the current one.");
    if (round.entrants.includes(peer))
      return refused("You have already entered this round.");
    const price = BigInt(round.entryPriceWei);
    // An entry is a confirmed payment of the entry price. Nothing else is.
    if (received.unconfirmed.length > 0 || received.confirmedWei < price)
      return refused(
        `Entry is ${formatMon(price)} and ${formatMon(
          received.confirmedWei
        )} is confirmed as paid with your message. You are not entered.`
      );

    round.entrants.push(peer);
    round.entryTxHashes.push(received.confirmed[0].txHash);
    round.conversations.push(msgCtx.conversationId ?? null);
    if (round.entrants.length >= round.maxEntries) round.status = "drawing";
    // Anything paid above the entry price goes back with the confirmation. The entry and the
    // confirmation owed for it are written together, with the message taken off the unsettled
    // list: an entry is never both counted and refunded.
    const excessWei = received.confirmedWei - price;
    await this.outbox.owe(
      ctx,
      `joined:${msgCtx.payloadDigest}`,
      {
        to: msgCtx.peerAddress,
        conversationId: msgCtx.conversationId,
        items: [
          this.status(round, "joined"),
          {
            type: "text",
            text:
              `You are entered: ${round.entrants.length} of ${round.maxEntries}. The draw happens when the round is full.` +
              (excessWei > 0n
                ? ` You paid ${formatMon(excessWei)} more than the entry price; it is returned with this message.`
                : ""),
          },
        ],
        valueWei: excessWei,
      },
      {
        digest: msgCtx.payloadDigest,
        writes: [{ type: "put", key: ROUND, value: JSON.stringify(round) }],
      }
    );
    await this.outbox.settle(ctx);
    if (round.status === "drawing") await this.finish(ctx);
  }

  /** Rounds whose winner's payment the relay ended: drawn, not announced, waiting for an operator
   * to send the payment again. They do not hold up the rounds after them. */
  private async unpaid(ctx: BotContext): Promise<RaffleRoundState[]> {
    const raw = await ctx.state.get(UNPAID);
    return raw ? (JSON.parse(raw) as RaffleRoundState[]) : [];
  }

  private draw(round: RaffleRoundState) {
    return buildRaffleDrawItem({
      raffleId: round.raffleId,
      entryPriceWei: round.entryPriceWei,
      serverSeed: round.serverSeed,
      entrants: round.entrants,
      entryTxHashes: round.entryTxHashes,
    });
  }

  /** Tells the entrants who did not win, once the winner's payment has gone out. */
  private async announce(ctx: BotContext, round: RaffleRoundState) {
    const draw = this.draw(round);
    for (const entrant of round.entrants) {
      if (entrant === draw.winnerAddress) continue;
      await this.outbox.owe(ctx, `draw:${round.raffleId}:${entrant}`, {
        to: entrant,
        conversationId:
          round.conversations[round.entrants.indexOf(entrant)] ?? undefined,
        items: [
          draw,
          {
            type: "text",
            text: `Round ${round.raffleId.slice(0, 8)} is drawn. ${draw.winnerAddress.slice(
              0,
              10
            )}… won and has been paid the pot of ${formatMon(BigInt(draw.potWei))}.`,
          },
        ],
      });
    }
  }

  /** Pays the winner of a full round, and only once that payment has gone out tells the other
   * entrants. The next round opens when the payment has gone out, or when the relay has ended
   * it: such a round is set aside, unannounced, until an operator sends the payment again, and
   * is announced then. Safe to repeat: every message is owed once by its own name. */
  private async finish(ctx: BotContext): Promise<void> {
    // Rounds set aside earlier whose winner has been paid since.
    const waiting = await this.unpaid(ctx);
    for (const round of waiting)
      if (await this.outbox.sent(ctx, `draw:${round.raffleId}`)) {
        await this.announce(ctx, round);
        await ctx.state.put(
          UNPAID,
          JSON.stringify(
            (await this.unpaid(ctx)).filter((other) => other.raffleId !== round.raffleId)
          )
        );
      }

    const raw = await ctx.state.get(ROUND);
    const round = raw === undefined ? undefined : (JSON.parse(raw) as RaffleRoundState);
    if (round?.status === "drawing") {
      const draw = this.draw(round);
      const pot = BigInt(draw.potWei);
      const paid = `draw:${round.raffleId}`;
      await this.outbox.owe(ctx, paid, {
        to: draw.winnerAddress,
        conversationId:
          round.conversations[round.entrants.indexOf(draw.winnerAddress)] ?? undefined,
        items: [
          draw,
          {
            type: "text",
            text: `You won round ${round.raffleId.slice(0, 8)}. This message pays you the pot of ${formatMon(pot)}.`,
          },
        ],
        valueWei: pot,
      });
      await this.outbox.settle(ctx);
      if (await this.outbox.sent(ctx, paid)) {
        await this.announce(ctx, round);
      } else if (await this.outbox.failed(ctx, paid)) {
        console.error(
          `[raffle] Round ${round.raffleId} is drawn but its winner ${draw.winnerAddress} was NOT paid ${pot} wei (the relay ended the payment). Nobody has been told a winner. The next round opens; this one waits for the outbox admin tool.`
        );
        await ctx.state.put(
          UNPAID,
          JSON.stringify([
            ...(await this.unpaid(ctx)).filter((other) => other.raffleId !== round.raffleId),
            round,
          ])
        );
      } else return; // Still on its way: nothing is said and no round opens yet.
      // The next round: a fresh seed, committed before anyone can enter it.
      await ctx.state.del(ROUND);
      await this.round(ctx);
    }
    await this.outbox.settle(ctx);
  }
}
