import { randomBytes } from "crypto";
import type {
  FrankBotDefinition,
  BotProfile,
  BotContext,
  BotMessageContext,
  NewUserEvent,
} from "@frank/bot-framework";
import { GAME_MAX_REPLIES_PER_PEER } from "@frank/bot-framework";
import type {
  MessageItem,
  SatoshiDiceItem,
} from "@frank/cashweb/types/messages";
import { formatMon } from "@frank/wallet/monad-amount";
import { ACCOUNT_TYPE_BOT, BOT_ROLE_GAME } from "@frank/codec";
import {
  DICE_DEFAULT_TARGET,
  diceCommitment,
  diceMultiplier,
  dicePayoutWei,
  diceRoll,
  isDiceTarget,
} from "@frank/wallet/message-item-plugins/dice/fair";
import { generateAvatarPng } from "../../bot-directory";
import { Outbox, refuse, type Received } from "./money";

/** The most one roll pays, stake included: the table limit. */
export const DICE_DEFAULT_MAX_PAYOUT_WEI = 250_000_000_000_000_000n; // 0.25 MON
/** Kept back from the bank's balance when it checks that it can cover a bet. */
export const BANK_RESERVE_WEI = 20_000_000_000_000_000n; // 0.02 MON

const HELP = `Satoshi Dice: pick a target, and you win if the number rolled (0 to 65,535) is below it. 1.9% house edge.

How a roll is fair: I publish the hash of a secret before you bet. Your bet adds a random value of your own. The number is derived from both, and I reveal the secret with the result, so the app can check that the secret matches the hash and that the number, outcome and payout follow from it.

Your stake is what your bet message pays me. Amounts typed in chat are not bets. Use the card below.`;

interface OfferedRoll {
  secret: string;
  peer: string;
}

export class SatoshiDiceBot implements FrankBotDefinition {
  readonly id = "dice";
  /** A game is many replies to one player: see `GAME_MAX_REPLIES_PER_PEER`. */
  readonly maxRepliesPerPeer = GAME_MAX_REPLIES_PER_PEER;
  readonly label = "Satoshi Dice";
  readonly defaultIdentityPath =
    process.env.DICE_BOT_IDENTITY_JSON ?? "/tmp/dice-bot-identity.json";

  private readonly outbox = new Outbox("dice");
  readonly schedules = [this.outbox.schedule];
  private readonly maxPayoutWei: bigint;

  constructor(options?: { maxPayoutWei?: bigint }) {
    this.maxPayoutWei = options?.maxPayoutWei ?? DICE_DEFAULT_MAX_PAYOUT_WEI;
  }

  getProfile(): BotProfile {
    return {
      name: "Satoshi Dice",
      bio: "Dice with a 1.9% house edge. The bot commits to its secret before you bet, and the app checks every roll.",
      avatarPng: generateAvatarPng("dice", [240, 100, 20]),
      bot: true,
      accountType: ACCOUNT_TYPE_BOT,
      botRole: BOT_ROLE_GAME,
    };
  }

  async onNewUser(user: NewUserEvent, ctx: BotContext): Promise<void> {
    try {
      await ctx.sendMessage(user.address, [
        await this.offer(ctx, user.address),
        { type: "text", text: `Welcome to Satoshi Dice.\n\n${HELP}` },
      ]);
    } catch (err) {
      console.warn(`[dice] Failed to welcome ${user.address}:`, err);
    }
  }

  /** A fresh secret, saved before its hash is shown to anyone. */
  private async offer(ctx: BotContext, peer: string): Promise<SatoshiDiceItem> {
    const rollId = randomBytes(16).toString("hex");
    const secret = randomBytes(32).toString("hex");
    const offered: OfferedRoll = { secret, peer: peer.toLowerCase() };
    await ctx.state.put(`roll:${rollId}`, JSON.stringify(offered));
    return {
      type: "dice",
      action: "table",
      rollId,
      commitment: diceCommitment(secret),
    };
  }

  async onMessage(msgCtx: BotMessageContext, ctx: BotContext): Promise<void> {
    const bet = msgCtx.items.find(
      (item): item is SatoshiDiceItem =>
        item.type === "dice" && item.action === "roll"
    );
    if (bet)
      return this.outbox.handle(msgCtx, ctx, (received) =>
        this.roll(bet, msgCtx, ctx, received)
      );
    // Anything else, including an amount typed in chat: the next roll on offer. Nothing typed
    // is ever a stake.
    await msgCtx.reply([
      await this.offer(ctx, msgCtx.peerAddress),
      { type: "text", text: HELP },
    ]);
  }

  private async roll(
    bet: SatoshiDiceItem,
    msgCtx: BotMessageContext,
    ctx: BotContext,
    received: Received
  ): Promise<void> {
    const peer = msgCtx.peerAddress.toLowerCase();
    const refused = async (why: string) =>
      refuse(this.outbox, msgCtx, ctx, received, why, [
        await this.offer(ctx, peer),
      ]);

    const rollId = bet.rollId ?? "";
    const raw = rollId ? await ctx.state.get(`roll:${rollId}`) : undefined;
    const offered = raw ? (JSON.parse(raw) as OfferedRoll) : undefined;
    // One commitment, one roll: the secret is deleted once its roll is written down.
    if (
      !offered ||
      offered.peer !== peer ||
      (await this.outbox.has(ctx, `roll:${rollId}`))
    )
      return refused(
        "That roll is not on offer (each commitment is good for one roll). No roll was made."
      );
    const commitment = diceCommitment(offered.secret);
    if ((bet.commitment ?? "").replace(/^0x/, "").toLowerCase() !== commitment)
      return refused(
        "Your bet names a different commitment than the one I published. No roll was made."
      );
    const clientSeed = (bet.clientSeed ?? "").toLowerCase();
    if (!/^(?:[0-9a-f]{2}){8,64}$/.test(clientSeed))
      return refused(
        "Your bet carried no random value of your own, so the roll would not be fair. No roll was made."
      );
    const target = bet.target;
    if (!isDiceTarget(target))
      return refused("That target is not between 1 and 65,535. No roll was made.");
    let wagerWei: bigint;
    try {
      wagerWei = BigInt(bet.wagerWei ?? "0");
    } catch {
      wagerWei = -1n;
    }
    if (wagerWei < 0n) return refused("That stake is not an amount. No roll was made.");
    if (dicePayoutWei(wagerWei, target) > this.maxPayoutWei)
      return refused(
        `That stake could win more than the table limit of ${formatMon(
          this.maxPayoutWei
        )} per roll. No roll was made.`
      );
    // The stake is what this message is confirmed, on chain, to have paid. Never what it says.
    if (received.unconfirmed.length > 0 || received.confirmedWei < wagerWei)
      return refused(
        `Your bet states a stake of ${formatMon(wagerWei)} but ${formatMon(
          received.confirmedWei
        )} is confirmed as paid with it. No roll was made.`
      );

    // The bank must hold the most this roll can pay before the bet is taken.
    if (
      wagerWei > 0n &&
      (await ctx.getBalance().catch(() => 0n)) <
        dicePayoutWei(wagerWei, target) + BANK_RESERVE_WEI
    )
      return refused(
        "The bank cannot cover that bet right now. No roll was made."
      );
    // Anything paid above a stated stake goes back with the result. (A free roll states no
    // stake: what its message paid is the price of the message.)
    const excessWei = wagerWei > 0n ? received.confirmedWei - wagerWei : 0n;

    const luckyNumber = diceRoll(offered.secret, clientSeed);
    const isWin = luckyNumber < target;
    const payoutWei = isWin ? dicePayoutWei(wagerWei, target) : 0n;
    const next = await this.offer(ctx, peer);
    const result: SatoshiDiceItem = {
      type: "dice",
      action: "result",
      rollId,
      commitment,
      clientSeed,
      target,
      multiplier: diceMultiplier(target),
      wagerWei: wagerWei.toString(),
      serverSecret: offered.secret,
      luckyNumber,
      isWin,
      payoutWei: payoutWei.toString(),
      nextRollId: next.rollId,
      nextCommitment: next.commitment,
    };
    const text =
      `Rolled ${luckyNumber} against a target below ${target}: ` +
      (isWin ? "you win." : "you lose.") +
      (wagerWei === 0n
        ? " Free roll, nothing staked."
        : isWin
        ? ` This message pays you ${formatMon(payoutWei)}.`
        : ` Your stake of ${formatMon(wagerWei)} is lost.`) +
      (excessWei > 0n
        ? ` You paid ${formatMon(excessWei)} more than your stake; it is returned with this message.`
        : "");
    const items: MessageItem[] = [result, { type: "text", text }];
    // The result, with its payout, is written down before the secret is given up and before
    // anything is sent; it is then sent until it has gone, once.
    await this.outbox.owe(
      ctx,
      `roll:${rollId}`,
      {
        to: msgCtx.peerAddress,
        conversationId: msgCtx.conversationId,
        items,
        valueWei: payoutWei + excessWei,
      },
      {
        digest: msgCtx.payloadDigest,
        writes: [{ type: "del", key: `roll:${rollId}` }],
      }
    );
    await this.outbox.settle(ctx);
  }
}
