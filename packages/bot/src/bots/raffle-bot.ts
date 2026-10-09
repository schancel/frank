import { randomBytes, createHash } from "crypto";
import type {
  FrankBotDefinition,
  BotProfile,
  BotContext,
  BotMessageContext,
  NewUserEvent,
} from "@frank/bot-framework";
import { GAME_MAX_REPLIES_PER_PEER } from "@frank/bot-framework";
import type { RaffleItem } from "@frank/cashweb/types/messages";
import {
  buildRaffleDrawItem,
  sha256Hex,
} from "@frank/wallet/message-item-plugins/raffle/draw";
import { formatMon } from "@frank/wallet/monad-amount";
import { ACCOUNT_TYPE_BOT, BOT_ROLE_GAME } from "@frank/codec";
import { generateAvatarPng } from "../../bot-directory";

export const RAFFLE_DEFAULT_ENTRY_PRICE_WEI = 20_000_000_000_000_000n; // 0.02 MON
export const RAFFLE_DEFAULT_MAX_ENTRIES = 5;

export interface RaffleRoundState {
  raffleId: string;
  entryPriceWei: string;
  maxEntries: number;
  serverSeed: string;
  serverSeedHash: string;
  entrants: string[];
  entryTxHashes: string[];
  status: "open" | "drawn";
  winnerAddress?: string;
  potWei?: string;
}

export class RaffleBot implements FrankBotDefinition {
  readonly id = "raffle";
  /** A game is many replies to one player: see `GAME_MAX_REPLIES_PER_PEER`. */
  readonly maxRepliesPerPeer = GAME_MAX_REPLIES_PER_PEER;
  readonly label = "Raffle";
  readonly defaultIdentityPath =
    process.env.RAFFLE_BOT_IDENTITY_JSON ?? "/tmp/raffle-bot-identity.json";

  private readonly entryPriceWei: bigint;
  private readonly maxEntries: number;
  private currentRound?: RaffleRoundState;

  constructor(options?: { entryPriceWei?: bigint; maxEntries?: number }) {
    this.entryPriceWei =
      options?.entryPriceWei ?? RAFFLE_DEFAULT_ENTRY_PRICE_WEI;
    this.maxEntries = options?.maxEntries ?? RAFFLE_DEFAULT_MAX_ENTRIES;
  }

  getProfile(): BotProfile {
    return {
      name: "Raffle",
      bio: "Automated raffle. Send a message for the current round, pay the entry price to join.",
      avatarPng: generateAvatarPng("raffle", [230, 160, 40]),
      bot: true,
      accountType: ACCOUNT_TYPE_BOT,
      botRole: BOT_ROLE_GAME,
    };
  }

  private generateSeed(): string {
    return randomBytes(32).toString("hex");
  }

  private initNewRound(): RaffleRoundState {
    const serverSeed = this.generateSeed();
    const serverSeedHash = sha256Hex(serverSeed);
    const raffleId = randomBytes(16).toString("hex");

    return {
      raffleId,
      entryPriceWei: this.entryPriceWei.toString(),
      maxEntries: this.maxEntries,
      serverSeed,
      serverSeedHash,
      entrants: [],
      entryTxHashes: [],
      status: "open",
    };
  }

  async onStart(ctx: BotContext): Promise<void> {
    const raw = await ctx.state.get("current_round");
    if (raw) {
      try {
        this.currentRound = JSON.parse(raw);
      } catch {
        this.currentRound = this.initNewRound();
      }
    } else {
      this.currentRound = this.initNewRound();
      await ctx.state.put("current_round", JSON.stringify(this.currentRound));
    }
  }

  async onNewUser(user: NewUserEvent, ctx: BotContext): Promise<void> {
    if (!this.currentRound || this.currentRound.status !== "open") {
      this.currentRound = this.initNewRound();
      await ctx.state.put("current_round", JSON.stringify(this.currentRound));
    }
    const round = this.currentRound;

    console.log(`[raffle] Proactively welcoming new user ${user.address}`);
    try {
      await ctx.sendMessage(user.address, [
        {
          type: "raffle",
          raffleId: round.raffleId,
          action: "announce",
          entryPriceWei: round.entryPriceWei,
          maxEntries: round.maxEntries,
          entryCount: round.entrants.length,
          serverSeedHash: round.serverSeedHash,
        } as RaffleItem,
        {
          type: "text",
          text: `Welcome to Frank Raffle! Join round #${round.raffleId.slice(
            0,
            8
          )} for ${formatMon(
            BigInt(round.entryPriceWei)
          )}. Pot size is ${formatMon(
            BigInt(round.entryPriceWei) * BigInt(round.maxEntries)
          )} with ${round.maxEntries} entrants. Send "enter" to join!`,
        },
      ]);
    } catch (err) {
      console.warn(`[raffle] Failed to welcome new user ${user.address}:`, err);
    }
  }

  async onMessage(
    msgCtx: BotMessageContext,
    ctx: BotContext
  ): Promise<void> {
    if (!this.currentRound || this.currentRound.status !== "open") {
      this.currentRound = this.initNewRound();
      await ctx.state.put("current_round", JSON.stringify(this.currentRound));
    }
    const round = this.currentRound;

    const raffleItem = msgCtx.items.find(
      (item: any) => item.type === "raffle" && item.action === "enter"
    ) as RaffleItem | undefined;

    const textItem = msgCtx.items.find((item: any) => item.type === "text") as
      | { text: string }
      | undefined;
    const isTextEnter =
      textItem && textItem.text.trim().toLowerCase() === "enter";

    if (!raffleItem && !isTextEnter) {
      // Send round status announcement
      await msgCtx.reply([
        {
          type: "raffle",
          raffleId: round.raffleId,
          action: "announce",
          entryPriceWei: round.entryPriceWei,
          maxEntries: round.maxEntries,
          entryCount: round.entrants.length,
          serverSeedHash: round.serverSeedHash,
        } as RaffleItem,
        {
          type: "text",
          text: `Round #${round.raffleId.slice(0, 8)}: ${
            round.entrants.length
          }/${round.maxEntries} entries. Entry: ${formatMon(
            BigInt(round.entryPriceWei)
          )}. Reply "enter" or send a raffle enter item to join!`,
        },
      ]);
      return;
    }

    // Check if player has already entered this round
    if (round.entrants.includes(msgCtx.peerAddress)) {
      await msgCtx.reply([
        {
          type: "raffle",
          raffleId: round.raffleId,
          action: "error",
          message: "You have already entered this round.",
        } as RaffleItem,
      ]);
      return;
    }

    // Record entry
    const entryTxHash =
      msgCtx.payloadDigest ||
      `0x${randomBytes(32).toString("hex")}`;
    round.entrants.push(msgCtx.peerAddress);
    round.entryTxHashes.push(entryTxHash);

    console.log(
      `[raffle] Accepted entry from ${msgCtx.peerAddress} (${round.entrants.length}/${round.maxEntries})`
    );

    if (round.entrants.length < round.maxEntries) {
      await ctx.state.put("current_round", JSON.stringify(round));
      await msgCtx.reply([
        {
          type: "raffle",
          raffleId: round.raffleId,
          action: "announce",
          entryPriceWei: round.entryPriceWei,
          maxEntries: round.maxEntries,
          entryCount: round.entrants.length,
          serverSeedHash: round.serverSeedHash,
        } as RaffleItem,
        {
          type: "text",
          text: `Entry accepted! ${round.entrants.length}/${round.maxEntries} entries filled. Waiting for remaining players...`,
        },
      ]);
      return;
    }

    // Round is full! Run provably fair draw
    console.log(`[raffle] Round #${round.raffleId} full -- drawing winner!`);
    const drawItem = buildRaffleDrawItem({
      raffleId: round.raffleId,
      entryPriceWei: round.entryPriceWei,
      serverSeed: round.serverSeed,
      entrants: round.entrants,
      entryTxHashes: round.entryTxHashes,
    });

    round.status = "drawn";
    round.winnerAddress = drawItem.winnerAddress;
    round.potWei = drawItem.potWei;

    await ctx.state.put("current_round", JSON.stringify(round));
    await ctx.state.put(`round:${round.raffleId}`, JSON.stringify(round));

    // Send pot payout on-chain
    try {
      console.log(
        `[raffle] Transferring pot ${formatMon(BigInt(drawItem.potWei))} to winner ${drawItem.winnerAddress}`
      );
      await ctx.sendTransfer({
        to: drawItem.winnerAddress,
        valueWei: BigInt(drawItem.potWei),
      });
    } catch (err) {
      console.error(`[raffle] Payout transfer failed:`, err);
    }

    // Announce to all entrants
    const announcement = [
      drawItem,
      {
        type: "text",
        text: `🎉 Round #${round.raffleId.slice(
          0,
          8
        )} Complete! Winner: ${drawItem.winnerAddress.slice(
          0,
          10
        )}... Pot: ${formatMon(BigInt(drawItem.potWei))}`,
      },
    ];

    for (const entrant of round.entrants) {
      try {
        if (entrant === msgCtx.peerAddress) {
          await msgCtx.reply(announcement as any);
        } else {
          await ctx.sendMessage(entrant, announcement as any);
        }
      } catch (err) {
        console.warn(`[raffle] Failed to notify entrant ${entrant}:`, err);
      }
    }

    // Advance to fresh round
    this.currentRound = this.initNewRound();
    await ctx.state.put("current_round", JSON.stringify(this.currentRound));
  }
}
