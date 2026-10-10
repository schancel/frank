import { randomBytes, randomInt } from "crypto";
import type {
  FrankBotDefinition,
  BotProfile,
  BotContext,
  BotMessageContext,
  NewUserEvent,
} from "@frank/bot-framework";
import { GAME_MAX_REPLIES_PER_PEER } from "@frank/bot-framework";
import type { MessageItem, RpsItem } from "@frank/cashweb/types/messages";
import { formatMon } from "@frank/wallet/monad-amount";
import { ACCOUNT_TYPE_BOT, BOT_ROLE_GAME } from "@frank/codec";
import {
  evaluateRps,
  RPS_MOVES,
  rpsCommitment,
  rpsPayoutWei,
  type RpsMove,
} from "@frank/wallet/message-item-plugins/rps/fair";
import { generateAvatarPng } from "../../bot-directory";
import { Outbox, refuse, type Received } from "./money";
import { BANK_RESERVE_WEI } from "./satoshi-dice-bot";

/** The most one match can be played for: the table limit. */
export const RPS_DEFAULT_MAX_WAGER_WEI = 100_000_000_000_000_000n; // 0.1 MON

const HELP = `Rock-Paper-Scissors. I pick my move first and send you its hash; you pick yours; I reveal my move and the salt, and the app checks they match the hash.

Your stake is what your move message pays me: a win pays twice the stake, a tie returns it. Amounts typed in chat are not bets. Use the card below, or type rock, paper or scissors to play for nothing.`;

interface Match {
  move: RpsMove;
  salt: string;
  peer: string;
}

export class RpsBot implements FrankBotDefinition {
  readonly id = "rps";
  /** A game is many replies to one player: see `GAME_MAX_REPLIES_PER_PEER`. */
  readonly maxRepliesPerPeer = GAME_MAX_REPLIES_PER_PEER;
  readonly label = "RPS Arena";
  readonly defaultIdentityPath =
    process.env.RPS_BOT_IDENTITY_JSON ?? "/tmp/rps-bot-identity.json";

  private readonly outbox = new Outbox("rps");
  readonly schedules = [this.outbox.schedule];
  private readonly maxWagerWei: bigint;

  constructor(options?: { maxWagerWei?: bigint }) {
    this.maxWagerWei = options?.maxWagerWei ?? RPS_DEFAULT_MAX_WAGER_WEI;
  }

  getProfile(): BotProfile {
    return {
      name: "RPS Arena",
      bio: "Rock-Paper-Scissors against the bot. It commits to its move before you choose, and the app checks the reveal.",
      avatarPng: generateAvatarPng("rps", [220, 80, 50]),
      bot: true,
      accountType: ACCOUNT_TYPE_BOT,
      botRole: BOT_ROLE_GAME,
    };
  }

  async onNewUser(user: NewUserEvent, ctx: BotContext): Promise<void> {
    try {
      await ctx.sendMessage(user.address, [
        await this.start(ctx, user.address),
        { type: "text", text: `Welcome to RPS Arena.\n\n${HELP}` },
      ]);
    } catch (err) {
      console.warn(`[rps] Failed to welcome ${user.address}:`, err);
    }
  }

  /** A new match: the bot's move is chosen and saved before its hash is shown to anyone. */
  private async start(ctx: BotContext, peerAddress: string): Promise<RpsItem> {
    const peer = peerAddress.toLowerCase();
    const matchId = randomBytes(16).toString("hex");
    const match: Match = {
      move: RPS_MOVES[randomInt(RPS_MOVES.length)],
      salt: randomBytes(16).toString("hex"),
      peer,
    };
    await ctx.state.put(`match:${matchId}`, JSON.stringify(match));
    await ctx.state.put(`open:${peer}`, matchId);
    return {
      type: "rps",
      action: "start",
      matchId,
      commitHash: rpsCommitment(match.move, match.salt),
    };
  }

  async onMessage(msgCtx: BotMessageContext, ctx: BotContext): Promise<void> {
    const peer = msgCtx.peerAddress.toLowerCase();
    const played = msgCtx.items.find(
      (item): item is RpsItem => item.type === "rps" && item.action === "move"
    );
    if (played)
      return this.outbox.handle(msgCtx, ctx, (received) =>
        this.resolve(played, msgCtx, ctx, received)
      );

    const text = msgCtx.items
      .flatMap((item) => (item.type === "text" ? [item.text] : []))
      .join("\n")
      .trim()
      .toLowerCase();
    // A typed move plays the open match for nothing: a message's text is never a stake.
    const typed = text.match(/^\/?(rock|paper|scissors)$/)?.[1] as
      | RpsMove
      | undefined;
    const open = typed ? await ctx.state.get(`open:${peer}`) : undefined;
    const raw = open ? await ctx.state.get(`match:${open}`) : undefined;
    if (typed && open && raw) {
      const match = JSON.parse(raw) as Match;
      // Free: nothing the message paid is a stake, so nothing is looked up or held.
      return this.resolve(
        {
          type: "rps",
          action: "move",
          matchId: open,
          commitHash: rpsCommitment(match.move, match.salt),
          playerMove: typed,
        },
        msgCtx,
        ctx,
        { confirmedWei: 0n, confirmed: [], unconfirmed: [] }
      );
    }
    await msgCtx.reply([
      await this.start(ctx, peer),
      { type: "text", text: HELP },
    ]);
  }

  private async resolve(
    played: RpsItem,
    msgCtx: BotMessageContext,
    ctx: BotContext,
    received: Received
  ): Promise<void> {
    const peer = msgCtx.peerAddress.toLowerCase();
    const refused = async (why: string) =>
      refuse(this.outbox, msgCtx, ctx, received, why, [
        await this.start(ctx, peer),
      ]);

    const matchId = played.matchId ?? "";
    const raw = matchId ? await ctx.state.get(`match:${matchId}`) : undefined;
    const match = raw ? (JSON.parse(raw) as Match) : undefined;
    // One commitment, one match: it is deleted once its result is written down.
    if (
      !match ||
      match.peer !== peer ||
      (await this.outbox.has(ctx, `match:${matchId}`))
    )
      return refused(
        "That match is not open (each commitment is good for one match). Nothing was played."
      );
    const commitHash = rpsCommitment(match.move, match.salt);
    if ((played.commitHash ?? "").replace(/^0x/, "").toLowerCase() !== commitHash)
      return refused(
        "Your move names a different commitment than the one I published. Nothing was played."
      );
    const playerMove = played.playerMove;
    if (!playerMove || !RPS_MOVES.includes(playerMove))
      return refused("That is not rock, paper or scissors. Nothing was played.");
    let wagerWei: bigint;
    try {
      wagerWei = BigInt(played.wagerWei ?? "0");
    } catch {
      wagerWei = -1n;
    }
    if (wagerWei < 0n) return refused("That stake is not an amount. Nothing was played.");
    if (wagerWei > this.maxWagerWei)
      return refused(
        `That stake is over the table limit of ${formatMon(
          this.maxWagerWei
        )}. Nothing was played.`
      );
    // The stake is what this message is confirmed, on chain, to have paid. Never what it says.
    if (received.unconfirmed.length > 0 || received.confirmedWei < wagerWei)
      return refused(
        `Your move states a stake of ${formatMon(wagerWei)} but ${formatMon(
          received.confirmedWei
        )} is confirmed as paid with it. Nothing was played.`
      );

    // The bank must hold the most this match can pay before the stake is taken.
    if (
      wagerWei > 0n &&
      (await ctx.getBalance().catch(() => 0n)) < wagerWei * 2n + BANK_RESERVE_WEI
    )
      return refused(
        "The bank cannot cover that stake right now. Nothing was played."
      );
    // Anything paid above a stated stake goes back with the result.
    const excessWei = wagerWei > 0n ? received.confirmedWei - wagerWei : 0n;

    const outcome = evaluateRps(playerMove, match.move);
    const payoutWei = rpsPayoutWei(wagerWei, outcome);
    const result: RpsItem = {
      type: "rps",
      action: "resolve",
      matchId,
      commitHash,
      playerMove,
      botMove: match.move,
      secretSalt: match.salt,
      wagerWei: wagerWei.toString(),
      outcome,
    };
    const text =
      `You chose ${playerMove}, I chose ${match.move}: ` +
      (outcome === "win" ? "you win." : outcome === "lose" ? "I win." : "a tie.") +
      (wagerWei === 0n
        ? " Nothing was staked."
        : payoutWei > 0n
        ? ` This message pays you ${formatMon(payoutWei)}.`
        : ` Your stake of ${formatMon(wagerWei)} is lost.`) +
      (excessWei > 0n
        ? ` You paid ${formatMon(excessWei)} more than your stake; it is returned with this message.`
        : "");
    const items: MessageItem[] = [result, { type: "text", text }];
    // The result, with its payout, is written down before the move is given up and before
    // anything is sent; it is then sent until it has gone, once.
    await this.outbox.owe(
      ctx,
      `match:${matchId}`,
      {
        to: msgCtx.peerAddress,
        conversationId: msgCtx.conversationId,
        items,
        valueWei: payoutWei + excessWei,
      },
      {
        digest: msgCtx.payloadDigest,
        writes: [
          { type: "del", key: `match:${matchId}` },
          { type: "del", key: `open:${peer}` },
        ],
      }
    );
    await this.outbox.settle(ctx);
  }
}
