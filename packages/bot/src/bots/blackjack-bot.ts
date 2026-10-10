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
import type { MessageItem } from "@frank/cashweb/types/messages";
import {
  BLACKJACK_DEFAULT_MIN_WAGER_WEI,
  BLACKJACK_DEFAULT_MAX_WAGER_WEI,
} from "@frank/wallet/message-item-plugins/blackjack/game";
import { formatMon } from "@frank/wallet/monad-amount";
import { generateAvatarPng } from "../../bot-directory";
import { ACCOUNT_TYPE_BOT, BOT_ROLE_GAME } from "@frank/codec";
import {
  buildChallenge,
  buildAccept,
  dealerStep,
  foldHand,
  DEALER_COVER_MULTIPLE,
  type HandEvent,
  type HandItem,
  type HandState,
} from "@frank/wallet/message-item-plugins/blackjack/hand";
import { Outbox, refuse, tableMinimumWei, type Received } from "./money";

/** Kept back from the dealer's balance when it works out the largest bet it can cover. */
const RESERVE_WEI = 20_000_000_000_000_000n;

function serializeEvents(events: HandEvent[]): string {
  return JSON.stringify(events, (_key, val) =>
    typeof val === "bigint" ? val.toString() : val
  );
}

function deserializeEvents(raw?: string): HandEvent[] {
  if (!raw) return [];
  return (JSON.parse(raw) as HandEvent[]).map((event) => ({
    ...event,
    stampWei: BigInt(event.stampWei ?? 0),
  }));
}

/** The dealer's message that is written down but not yet in the hand's record: it joins the
 * record, under the digest it was sent with, once it has gone out. */
interface Hand {
  gameId: string;
  peer: string;
  conversationId?: string;
}

const WAITING = "waiting_hands";

interface PendingStep {
  id: string;
  item: HandItem;
  payWei?: string;
}

/**
 * The dealer of the peer-to-peer blackjack hand (`@frank/wallet/message-item-plugins/blackjack/hand`,
 * the same state machine the app folds to check every card). Money is the value of a message: a
 * bet is counted at what its message is confirmed, on chain, to have paid, and a payout or refund
 * is the value of the dealer's own message, written down before it is sent and sent once.
 */
export class BlackjackDealerBot implements FrankBotDefinition {
  readonly id = "blackjack";
  /** A game is many replies to one player: see `GAME_MAX_REPLIES_PER_PEER`. */
  readonly maxRepliesPerPeer = GAME_MAX_REPLIES_PER_PEER;
  readonly label = "Blackjack Dealer";
  readonly defaultIdentityPath =
    process.env.BLACKJACK_BOT_IDENTITY_JSON ??
    "/tmp/blackjack-bot-identity.json";

  private readonly minWagerWei: bigint;
  private readonly maxWagerWei: bigint;
  private readonly outbox = new Outbox("blackjack");
  readonly schedules: BotScheduleDefinition[] = [
    this.outbox.schedule,
    {
      // A hand whose dealer message could not be sent at once continues here once it has gone.
      id: "blackjack-resume",
      intervalMs: 10_000,
      runOnStartup: true,
      handler: (ctx) =>
        this.serial(async () => {
          for (const hand of await this.waiting(ctx)) await this.advance(ctx, hand);
        }),
    },
  ];
  /** One message of a hand is handled at a time. */
  private turn: Promise<unknown> = Promise.resolve();

  constructor(options?: { minWagerWei?: bigint; maxWagerWei?: bigint }) {
    this.minWagerWei = options?.minWagerWei ?? BLACKJACK_DEFAULT_MIN_WAGER_WEI;
    this.maxWagerWei = options?.maxWagerWei ?? BLACKJACK_DEFAULT_MAX_WAGER_WEI;
  }

  getProfile(): BotProfile {
    return {
      name: "Blackjack Dealer",
      bio: "Automated blackjack dealer. Both sides commit to their randomness before the bet, and the app works out every card itself from what is revealed.",
      avatarPng: generateAvatarPng("blackjack", [200, 60, 60]),
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

  /** The largest bet the dealer offers: what its balance covers, within the table limits. */
  private async limits(ctx: BotContext) {
    // What the dealer holds, less what it has already written down as owed.
    const held = await ctx.getBalance().catch(() => 0n);
    const owed = await this.outbox.owedWei(ctx);
    const balance = held > owed ? held - owed : 0n;
    const free = balance > RESERVE_WEI ? balance - RESERVE_WEI : 0n;
    const cover = free / DEALER_COVER_MULTIPLE;
    // The table minimum is never below what the chain charges to move a stamp, so a real
    // bet's payout or refund always clears the fee floor.
    return {
      balance,
      maxBet: cover > this.maxWagerWei ? this.maxWagerWei : cover,
      minBet: await tableMinimumWei(ctx, this.minWagerWei),
    };
  }

  /** The hand's record, with the dealer's last message added if it has gone out since.
   * `pending`: that message is written down but has not gone out yet. */
  private async events(ctx: BotContext, hand: Hand) {
    const events = deserializeEvents(await ctx.state.get(`events:${hand.gameId}`));
    const raw = await ctx.state.get(`step:${hand.gameId}`);
    if (raw === undefined) return { events, pending: false };
    const step = JSON.parse(raw) as PendingStep;
    const delivered = await this.outbox.delivered(ctx, step.id);
    if (!delivered) return { events, pending: true };
    events.push({
      item: step.item,
      from: ctx.address,
      to: hand.peer,
      stampWei: step.payWei ? BigInt(step.payWei) : delivered.stampWei,
      digest: delivered.digest,
    });
    await ctx.state.batch([
      { type: "put", key: `events:${hand.gameId}`, value: serializeEvents(events) },
      { type: "del", key: `step:${hand.gameId}` },
    ]);
    return { events, pending: false };
  }

  /** Hands the dealer may still have to act on: a message of theirs was recorded, or a dealer
   * message is written down and has not gone out. The schedule continues each of them, so a
   * restart at any point picks the hand up where its record stands. */
  private async waiting(ctx: BotContext): Promise<Hand[]> {
    const raw = await ctx.state.get(WAITING);
    return raw ? (JSON.parse(raw) as Hand[]) : [];
  }

  /** The write that puts `hand` on (or takes it off) the list of hands to continue. */
  private async listed(ctx: BotContext, hand: Hand, on: boolean) {
    const others = (await this.waiting(ctx)).filter(
      (other) => other.gameId !== hand.gameId
    );
    return {
      type: "put" as const,
      key: WAITING,
      value: JSON.stringify(on ? [...others, hand] : others),
    };
  }

  /** Sends one dealer message of a hand: written down first (with what it pays), then sent until
   * it has gone, once. Its name is its place in the hand, so the same step is never owed twice.
   * A hand has at most one such message outstanding: the next is worked out only from a record
   * that includes it, digest and all. */
  private async say(
    ctx: BotContext,
    hand: Hand,
    position: number,
    item: HandItem,
    text: string,
    payWei?: bigint
  ): Promise<void> {
    const id = `hand:${hand.gameId}:${position}`;
    const step: PendingStep = {
      id,
      item,
      ...(payWei !== undefined ? { payWei: payWei.toString() } : {}),
    };
    // One write: the step, the message owed for it, and the hand on the list to continue.
    await this.outbox.owe(
      ctx,
      id,
      {
        to: hand.peer,
        conversationId: hand.conversationId,
        // No stamp: only a payout or a refund carries value.
        items: [item as MessageItem, { type: "text", text }],
        valueWei: payWei,
      },
      {
        writes: [
          { type: "put", key: `step:${hand.gameId}`, value: JSON.stringify(step) },
          await this.listed(ctx, hand, true),
        ],
      }
    );
    await this.outbox.settle(ctx);
  }

  /** A fresh hand offered by the dealer, its seed saved before its commitment is shown. */
  private async challenge(
    ctx: BotContext,
    peer: string,
    conversationId?: string
  ): Promise<void> {
    const { balance, maxBet, minBet } = await this.limits(ctx);
    if (maxBet < minBet) {
      await ctx.sendMessage(
        peer,
        [
          {
            type: "text",
            text: "The dealer cannot cover a hand right now. Try again later.",
          },
        ],
        conversationId,
        { stampValueWei: 0n }
      );
      return;
    }
    const gameId = randomBytes(16).toString("hex");
    const seed = randomBytes(32).toString("hex");
    await ctx.state.put(`seed:${gameId}`, seed);
    const built = buildChallenge({
      gameId,
      role: "dealer",
      maxBetWei: maxBet,
      spendableWei: balance,
      reserveWei: RESERVE_WEI,
      seed,
    });
    if (!("item" in built)) return;
    await this.say(
      ctx,
      { gameId, peer, conversationId },
      0,
      built.item,
      `Blackjack: bet between ${formatMon(minBet)} and ${formatMon(
        maxBet
      )}. Your bet is what your bet message pays the dealer.`
    );
  }

  async onNewUser(user: NewUserEvent, ctx: BotContext): Promise<void> {
    try {
      await this.serial(() => this.challenge(ctx, user.address));
    } catch (err) {
      console.warn(`[blackjack] Failed to challenge ${user.address}:`, err);
    }
  }

  /** A message cut off by a crash: what it paid is accounted for (see `Outbox.interrupted`). */
  onInterrupted(message: InterruptedMessage, ctx: BotContext): Promise<void> {
    return this.outbox.interrupted(ctx, message);
  }

  async onMessage(msgCtx: BotMessageContext, ctx: BotContext): Promise<void> {
    const handItem = msgCtx.items.find(
      (item) => item.type === "blackjack-hand"
    ) as HandItem | undefined;
    // Anything but a hand message: a fresh challenge. The dealer has no other bet path.
    if (!handItem)
      return this.serial(() =>
        this.challenge(ctx, msgCtx.peerAddress, msgCtx.conversationId)
      );
    // Written down, then what it paid is looked up on chain, before the turn is taken.
    await this.outbox.handle(msgCtx, ctx, (received) =>
      this.serial(() => this.play(handItem, msgCtx, ctx, received))
    );
  }

  private async play(
    handItem: HandItem,
    msgCtx: BotMessageContext,
    ctx: BotContext,
    received: Received
  ): Promise<void> {
    const first = deserializeEvents(
      await ctx.state.get(`events:${handItem.gameId}`)
    )[0];
    // The other party of a hand is fixed by its first message. Everything the dealer sends for
    // the hand, every payout included, goes to that account and to nobody else.
    const player = first
      ? first.from.toLowerCase() === ctx.address.toLowerCase()
        ? first.to
        : first.from
      : msgCtx.peerAddress;
    if (player.toLowerCase() !== msgCtx.peerAddress.toLowerCase())
      return refuse(
        this.outbox,
        msgCtx,
        ctx,
        received,
        "That hand is not yours. Nothing was played."
      );
    const hand: Hand = {
      gameId: handItem.gameId,
      peer: player,
      conversationId: msgCtx.conversationId,
    };
    // Money that is not on chain yet is not a bet and is not lost either: the message is not
    // played, and what it paid goes back once it lands.
    if (received.unconfirmed.length > 0)
      return refuse(
        this.outbox,
        msgCtx,
        ctx,
        received,
        "Your payment was not confirmed on chain in time, so this message was not played. Send it again."
      );
    const { events } = await this.events(ctx, hand);
    if (!foldHand(events).state && handItem.action !== "challenge") {
      // Not a message of any hand this dealer holds: whatever it paid goes back.
      if (received.confirmedWei > 0n)
        await refuse(
          this.outbox,
          msgCtx,
          ctx,
          received,
          "That is not a hand at this table. Nothing was played."
        );
      return;
    }
    if (!events.some((event) => event.digest === msgCtx.payloadDigest)) {
      events.push({
        item: handItem,
        from: msgCtx.peerAddress,
        to: ctx.address,
        // The money of a message is what the chain confirms it paid, never what the wallet
        // or the message says.
        stampWei: received.confirmedWei,
        digest: msgCtx.payloadDigest,
      });
      // In the hand's record before anything is answered, and from here the hand accounts for
      // the money (a bet it does not accept is a refund the hand owes): one write.
      await this.outbox.keep(ctx, msgCtx.payloadDigest, [
        {
          type: "put",
          key: `events:${hand.gameId}`,
          value: serializeEvents(events),
        },
        // And on the list to continue: a crash right here is picked up by the schedule.
        await this.listed(ctx, hand, true),
      ]);
    }
    await this.advance(ctx, hand);
  }

  /** Sends the dealer's messages of a hand for as long as one is due and the last has gone out
   * (a card that busts the player is followed at once by the reveal). Returns whether the hand
   * exists. The same record always gives the same message. */
  private async advance(ctx: BotContext, hand: Hand): Promise<boolean> {
    for (let steps = 0; steps < 16; steps++) {
      const { events, pending } = await this.events(ctx, hand);
      const { state } = foldHand(events);
      if (pending) return true;
      const next = state ? await this.next(ctx, hand, state) : undefined;
      if (!next) {
        // Nothing for the dealer to do until the player's next message.
        await ctx.state.batch([await this.listed(ctx, hand, false)]);
        return !!state;
      }
      await this.say(ctx, hand, events.length, next.item, next.text, next.payWei);
    }
    return true;
  }

  /** The dealer's next message for `state`, if it is the dealer's turn. */
  private async next(
    ctx: BotContext,
    hand: Hand,
    state: HandState
  ): Promise<{ item: HandItem; text: string; payWei?: bigint } | undefined> {
    let seed = await ctx.state.get(`seed:${hand.gameId}`);
    if (state.phase === "challenged") {
      if (!seed) {
        seed = randomBytes(32).toString("hex");
        await ctx.state.put(`seed:${hand.gameId}`, seed);
      }
      const { balance, maxBet, minBet } = await this.limits(ctx);
      const wanted = state.maxBetWei < maxBet ? state.maxBetWei : maxBet;
      const built =
        wanted >= minBet
          ? buildAccept({
              state,
              spendableWei: balance,
              reserveWei: RESERVE_WEI,
              seed,
              wantedMaxBetWei: wanted,
            })
          : undefined;
      return built && "item" in built
        ? {
            item: built.item,
            text: `Challenge accepted. Bet up to ${formatMon(wanted)}.`,
          }
        : undefined;
    }
    const step = seed ? dealerStep(state, seed) : undefined;
    if (!step) return undefined;
    const text =
      step.item.action === "deal"
        ? "Cards dealt. Hit, stand or double."
        : step.item.action === "card"
        ? "Card dealt."
        : step.item.action === "reveal"
        ? step.payWei
          ? `Hand over. This message pays you ${formatMon(step.payWei)}.`
          : "Hand over."
        : `This message returns ${formatMon(
            step.payWei ?? 0n
          )} the hand did not accept.`;
    return { item: step.item, text, payWei: step.payWei };
  }
}
