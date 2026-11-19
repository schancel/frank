/**
 * Registered: in the bot set (`./index.ts`), `targets/all-bots.ts` (`liars-dice`),
 * `targets/liars-dice.ts` and the demo. The game itself is still to be rebuilt, ticket #1377.
 *
 * Known wrong, as it stands:
 * - dice are never dealt at the start of a round: players bid blind and the bot rolls at
 *   challenge time (`setPlayerRoundCommit` / `setPlayerRoundSecret` are never called).
 * Its profile makes no fairness claim.
 *
 * Buy-ins are held in a GenericHTLC v2 table escrow (`./table-htlc`): a player is seated only by a
 * join naming an open buy-in lock with the table's terms; the winner is paid the pot of locked
 * buy-ins with `batchDistribute`. A reveal that fails verification returns every buy-in and ends
 * the table. An ended table (`closedTables`) starts no round and takes no join, bid or challenge,
 * also once its escrow record is dropped (the escrow drops it when every lock is withdrawn).
 *
 * Replies go to the player whose message they answer (and a turn timeout's to the player who
 * started the timer); the other seated players are not messaged.
 */
import type {
  FrankBotDefinition,
  BotProfile,
  BotContext,
  BotMessageContext,
  NewUserEvent,
} from "@frank/bot-framework";
import { GAME_MAX_REPLIES_PER_PEER } from "@frank/bot-framework";
import type { MessageItem, LiarsDiceItem } from "@frank/cashweb/types/messages";
import {
  createLiarsDiceGame,
  joinGame,
  startNextRound,
  setPlayerRoundCommit,
  setPlayerRoundSecret,
  verifyLiarsDiceReveal,
  applyBid,
  applyChallenge,
  getActivePlayer,
  getTotalDiceInPlay,
  TURN_TIMEOUT_SECONDS,
  DEFAULT_BUY_IN_WEI,
  type LiarsDiceGameState,
} from "@frank/wallet/message-item-plugins/liars-dice";
import { botProfileSpec, generateAvatarPng } from "../../bot-directory";
import { ACCOUNT_TYPE_BOT, BOT_ROLE_GAME } from "@frank/codec";
import {
  TableEscrows,
  returnBuyIns,
  tablePool,
  seatRefusalText,
  settlementText,
  tableEscrowItemTerms,
  type TableEscrowBook,
  type TableEscrowRecord,
  type TableSettlementResult,
} from "./table-htlc";
import {
  announceTableToTopic,
  type GameTableDetails,
  DEFAULT_GAMES_TOPIC,
} from "./table-announcements";

export type LiarsDiceTableEscrowRecord = TableEscrowRecord;
export type { TableEscrowRecord };
const LIARS_DICE_PROFILE = botProfileSpec("liars-dice");
/** What an ended table answers to anything that would play on. */
const CLOSED_TABLE_TEXT = "❌ This table has ended: open a new one with `/table create`.";

export class LiarsDiceBot implements FrankBotDefinition {
  readonly id = "liars-dice";
  /** A game is many replies to one player: see `GAME_MAX_REPLIES_PER_PEER`. */
  readonly maxRepliesPerPeer = GAME_MAX_REPLIES_PER_PEER;
  readonly label = "Liar's Dice (Perudo)";
  readonly defaultIdentityPath =
    process.env.LIARS_DICE_BOT_IDENTITY_JSON ?? "/tmp/liars-dice-bot-identity.json";

  private readonly tables = new Map<string, LiarsDiceGameState>();
  private readonly conversationTables = new Map<string, string>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private latestTableId?: string;
  private readonly escrows: TableEscrowBook;
  /** Tables that have ended (won, or a reveal failed verification): nothing more is played. */
  private readonly closedTables = new Set<string>();

  constructor(options: { escrows?: TableEscrowBook } = {}) {
    this.escrows = options.escrows ?? new TableEscrows("liars-dice");
  }

  getTableEscrow(tableId: string): Readonly<LiarsDiceTableEscrowRecord> | undefined {
    return this.escrows.get(tableId);
  }

  private recovery: Promise<void> = Promise.resolve();

  /** After a restart: every kept table's game is gone, so each is settled as it was written
   * down, or its buy-ins are returned (`TableEscrows.recover`). Startup does not wait for it. */
  async onStart(ctx: BotContext): Promise<void> {
    this.recovery = this.escrows.recover(ctx, tableId => this.tables.has(tableId)).then(results => {
      for (const result of results)
        console.log(`[liars-dice] table ${result.tableId} after restart: ${settlementText(result, ctx)}`);
    });
  }

  /** The recovery `onStart` began, done. */
  recovered(): Promise<void> {
    return this.recovery;
  }

  async onStop(): Promise<void> {
    for (const tableId of [...this.timers.keys()]) this.clearTableTimer(tableId);
    this.escrows.stop();
  }

  /**
   * After every challenge, by any path (a player's `/liar`, a challenge item, a turn timeout):
   * the reveal is verified. A won game pays the winner every locked buy-in; a reveal that fails
   * verification ends the table and returns every buy-in.
   */
  private async afterChallenge(
    game: LiarsDiceGameState,
    ctx: BotContext
  ): Promise<{ verified: boolean; reason?: string; settlement?: TableSettlementResult }> {
    this.clearTableTimer(game.tableId);
    const verification = verifyLiarsDiceReveal(game);
    const escrow = this.escrows.get(game.tableId);
    // An unverified reveal ends the table as a won game does, before the settlement's wait: an
    // unstaked game does not go on after its buy-ins are returned.
    if (!verification.verified || game.status === "resolved") this.closedTables.add(game.tableId);
    let settlement: TableSettlementResult | undefined;
    if (escrow && !verification.verified)
      settlement = await this.escrows.settle(ctx, game.tableId, returnBuyIns);
    else if (escrow && game.status === "resolved" && game.winnerAddress) {
      const winner = game.winnerAddress;
      settlement = await this.escrows.settle(ctx, game.tableId, record => [
        { player: winner, amountWei: tablePool(record) },
      ]);
    }
    return { verified: verification.verified, reason: verification.reason, settlement };
  }

  getProfile(): BotProfile {
    return {
      name: LIARS_DICE_PROFILE.name,
      bio: LIARS_DICE_PROFILE.bio,
      avatarPng: generateAvatarPng("liars-dice", LIARS_DICE_PROFILE.accent),
      bot: true,
      accountType: ACCOUNT_TYPE_BOT,
      botRole: BOT_ROLE_GAME,
    };
  }

  async onNewUser(user: NewUserEvent, ctx: BotContext): Promise<void> {
    try {
      await ctx.sendMessage(user.address, [
        {
          type: "text",
          text: "🎲 Welcome to Liar's Dice (Perudo)! Create a table with `/table create [buyIn]`, or type `/help` for rules.",
        },
      ]);
    } catch (err) {
      console.warn(`[liars-dice] Failed to welcome ${user.address}:`, err);
    }
  }

  async announceTableToTopic(
    ctx: BotContext,
    topic: string = DEFAULT_GAMES_TOPIC,
    details: GameTableDetails
  ): Promise<{ payloadDigest?: string; entry: any }> {
    return announceTableToTopic(ctx, topic, details);
  }

  private clearTableTimer(tableId: string) {
    const existing = this.timers.get(tableId);
    if (existing) {
      clearTimeout(existing);
      this.timers.delete(tableId);
    }
  }

  private resetTurnTimer(tableId: string, ctx: BotContext, peerAddress: string) {
    this.clearTableTimer(tableId);
    const timer = setTimeout(() => {
      void this.onTurnTimeout(tableId, ctx, peerAddress).catch(error =>
        console.warn(`[liars-dice] turn timeout on table ${tableId} failed:`, error)
      );
    }, TURN_TIMEOUT_SECONDS * 1000);

    timer.unref?.();
    this.timers.set(tableId, timer);
  }

  /** The active player's turn ran out with a bid standing: it calls Liar. A challenge that ends
   * the game settles the table, as any other does. */
  private async onTurnTimeout(tableId: string, ctx: BotContext, peerAddress: string): Promise<void> {
    const game = this.tables.get(tableId);
    if (!game || game.status !== "round_active" || this.closedTables.has(tableId)) return;
    const active = getActivePlayer(game);
    if (!active || !game.currentBid) return;

    console.log(`[liars-dice] Turn timer expired for ${active.address} on table ${tableId}`);
    const res = applyChallenge(game, active.address);
    if (!res.success) return;
    const { settlement } = await this.afterChallenge(game, ctx);
    const item = this.buildLiarsDiceItem(game, "showdown", active.address);
    await ctx.sendMessage(peerAddress, [
      {
        type: "text",
        text: `⏰ Turn timeout! ${active.address.slice(0, 8)} automatically called Liar!${
          settlement ? `\n${settlementText(settlement, ctx)}` : ""
        }`,
      },
      item,
    ]);
  }

  private buildLiarsDiceItem(
    game: LiarsDiceGameState,
    action: LiarsDiceItem["action"],
    recipientAddress?: string,
  ): LiarsDiceItem & {
    cupCommits?: Record<string, string>;
    cupSalts?: Record<string, string>;
  } {
    const active = getActivePlayer(game);
    const isRevealed = game.status === "showdown" || game.status === "resolved";
    const revealedCups: Record<string, number[]> = {};
    const playerCommits: Record<string, string> = {};
    const playerSeeds: Record<string, string> = {};

    for (const p of game.players) {
      if (p.currentDice) {
        revealedCups[p.address] = p.currentDice;
      }
      if (p.seedCommit) {
        playerCommits[p.address] = p.seedCommit;
      }
      if (p.seed) {
        playerSeeds[p.address] = p.seed;
      }
    }

    const localPlayer = recipientAddress
      ? game.players.find(p => p.address.toLowerCase() === recipientAddress.toLowerCase())
      : undefined;

    const escrow = this.escrows.get(game.tableId);
    return {
      type: "liars-dice",
      tableId: game.tableId,
      action,
      buyInWei: game.buyInWei.toString(),
      maxPlayers: game.maxPlayers,
      dicePerPlayer: game.dicePerPlayer,
      players: game.players.map(p => p.address),
      diceCounts: game.players.map(p => p.diceCount),
      roundNumber: game.roundNumber,
      activePlayer: active?.address,
      turnTimeoutSeconds: TURN_TIMEOUT_SECONDS,
      currentBid: game.currentBid,
      challenger: game.lastResolution?.challenger,
      serverCommit: game.serverCommit,
      serverSeed: isRevealed ? game.serverSeed : undefined,
      playerCommits: Object.keys(playerCommits).length > 0 ? playerCommits : game.playerCommits,
      playerSeeds: isRevealed ? playerSeeds : undefined,
      cupCommits: game.cupCommits,
      cupSalts: isRevealed ? game.cupSalts : undefined,
      myDice: localPlayer?.currentDice,
      revealedCups: isRevealed ? revealedCups : undefined,
      challengeResult: game.lastResolution
        ? {
            bidQuantity: game.lastResolution.bid.quantity,
            bidFace: game.lastResolution.bid.face,
            actualCount: game.lastResolution.totalMatchingDice,
            wildAcesCount: game.lastResolution.wildAcesCount,
            challengerWon: game.lastResolution.challengerWon,
            loserAddress: game.lastResolution.loserAddress,
            eliminated: game.lastResolution.eliminated,
          }
        : undefined,
      winnerAddress: game.winnerAddress,
      potWei: game.potWei.toString(),
      escrow: escrow ? tableEscrowItemTerms(escrow) : undefined,
    };
  }

  async onMessage(msgCtx: BotMessageContext, ctx: BotContext): Promise<void> {
    const sender = msgCtx.peerAddress || (msgCtx as any).senderAddress || "";
    const conversationId = sender; // Or topic if in group

    // Check for structured LiarsDiceItem in incoming message
    const incomingItem = msgCtx.items.find(
      (item: any) => item.type === "liars-dice",
    ) as LiarsDiceItem | undefined;

    const textItem = msgCtx.items.find((item: any) => item.type === "text") as
      | { type: "text"; text: string }
      | undefined;
    const text = textItem?.text?.trim() ?? "";

    if (incomingItem) {
      await this.handleStructuredAction(incomingItem, sender, msgCtx, ctx);
      return;
    }

    if (text.startsWith("/")) {
      await this.handleCommand(text, sender, conversationId, msgCtx, ctx);
      return;
    }

    // Default welcome / help
    await msgCtx.reply([
      {
        type: "text",
        text: `🎲 **Frank Liar's Dice (Perudo)**\n\nCommands:\n• \`/table create [buyIn]\` - Create a table\n• \`/table join\` - Join the current table\n• \`/start\` - Start the game (2+ players)\n• \`/bid <qty> <face>\` - Make a bid (e.g. \`/bid 3 4\`)\n• \`/liar\` - Call Liar on the current bid!\n• \`/status\` - View current table state`,
      },
    ]);
  }

  private async handleCommand(
    text: string,
    sender: string,
    conversationId: string,
    msgCtx: BotMessageContext,
    ctx: BotContext,
  ): Promise<void> {
    const parts = text.split(/\s+/);
    const cmd = parts[0].toLowerCase();

    if (cmd === "/help") {
      await msgCtx.reply([
        {
          type: "text",
          text: `🎲 **Liar's Dice Rules (Perudo)**\n\n• Each player starts with 5 dice.\n• 1s (Aces) are WILD for bids on 2..6!\n• Bids must increase quantity or face value.\n• Bidding on 1s halves the required quantity.\n• Call \`/liar\` if you suspect the previous bid exceeds total matching dice across all cups!`,
        },
      ]);
      return;
    }

    if (cmd === "/table" || cmd === "/create" || cmd === "/join") {
      const sub = cmd === "/table" ? parts[1]?.toLowerCase() : cmd.slice(1);
      if (sub === "create") {
        const buyInStr = parts[cmd === "/table" ? 2 : 1];
        let buyInWei = DEFAULT_BUY_IN_WEI;
        if (buyInStr) {
          try {
            buyInWei = ctx.parseAmount(buyInStr);
          } catch {
            // Keep default
          }
        }

        const escrow = await this.escrows.open(ctx, buyInWei);
        if ("status" in escrow) {
          await msgCtx.reply([{ type: "text", text: `❌ Cannot open a table: ${escrow.reason}` }]);
          return;
        }
        const tableId = escrow.tableId;
        const game = createLiarsDiceGame({
          tableId,
          hostAddress: sender,
          buyInWei,
        });

        this.tables.set(tableId, game);
        this.conversationTables.set(conversationId, tableId);
        this.latestTableId = tableId;

        // Announce table to public discovery topic
        await this.announceTableToTopic(ctx, DEFAULT_GAMES_TOPIC, {
          gameName: "Liar's Dice",
          gameType: "liars-dice",
          tableId,
          hostAddress: sender,
          buyInAmount: ctx.formatAmount(buyInWei),
          currentPlayers: game.players.length,
          maxPlayers: game.maxPlayers,
          botAddress: ctx.address,
        });

        const item = this.buildLiarsDiceItem(game, "create", sender);
        await msgCtx.reply([
          {
            type: "text",
            text: `🎲 Table **${tableId}** created! Buy-in: ${ctx.formatAmount(buyInWei)}. Joined: 0/${game.maxPlayers}. Join from the app: it locks your buy-in, then sits you down.`,
          },
          item,
        ]);
        return;
      }

      if (sub === "join") {
        const explicitId = parts[cmd === "/table" ? 2 : 1];
        const tableId = explicitId ?? this.conversationTables.get(conversationId) ?? this.latestTableId;
        if (!tableId || !this.tables.has(tableId)) {
          await msgCtx.reply([{ type: "text", text: "No active table to join. Create one with `/table create`." }]);
          return;
        }

        await this.join(this.tables.get(tableId)!, sender, undefined, msgCtx, ctx);
        return;
      }
    }

    if (cmd === "/start") {
      const tableId = this.conversationTables.get(conversationId) ?? this.latestTableId;
      if (!tableId || !this.tables.has(tableId)) {
        await msgCtx.reply([{ type: "text", text: "No active table. Create one with `/table create`." }]);
        return;
      }

      if (this.closedTables.has(tableId) || this.escrows.get(tableId)?.settlement) {
        await msgCtx.reply([{ type: "text", text: CLOSED_TABLE_TEXT }]);
        return;
      }
      const game = this.tables.get(tableId)!;
      const res = startNextRound(game);
      if (!res.success) {
        await msgCtx.reply([{ type: "text", text: `❌ Cannot start game: ${res.error}` }]);
        return;
      }

      this.resetTurnTimer(tableId, ctx, sender);
      const active = getActivePlayer(game)!;
      const item = this.buildLiarsDiceItem(game, "round_start", sender);

      await msgCtx.reply([
        {
          type: "text",
          text: `🎲 Round ${game.roundNumber} started! Total dice in play: ${getTotalDiceInPlay(game)}. First bidder: ${active.address.slice(0, 8)}.`,
        },
        item,
      ]);
      return;
    }

    if (cmd === "/commit") {
      const commitVal = parts[1];
      const tableId = this.conversationTables.get(conversationId) ?? this.latestTableId;
      if (!tableId || !this.tables.has(tableId) || !commitVal) {
        await msgCtx.reply([{ type: "text", text: "Usage: `/commit <sha256_hex>`" }]);
        return;
      }
      if (await this.refuseClosed(tableId, msgCtx)) return;
      const game = this.tables.get(tableId)!;
      const res = setPlayerRoundCommit(game, sender, commitVal);
      if (!res.success) {
        await msgCtx.reply([{ type: "text", text: `❌ ${res.error}` }]);
        return;
      }
      await msgCtx.reply([{ type: "text", text: `🔒 Seed commitment recorded for ${sender.slice(0, 8)}.` }]);
      return;
    }

    if (cmd === "/seed") {
      const seedVal = parts[1];
      const tableId = this.conversationTables.get(conversationId) ?? this.latestTableId;
      if (!tableId || !this.tables.has(tableId) || !seedVal) {
        await msgCtx.reply([{ type: "text", text: "Usage: `/seed <seed_hex>`" }]);
        return;
      }
      if (await this.refuseClosed(tableId, msgCtx)) return;
      const game = this.tables.get(tableId)!;
      const res = setPlayerRoundSecret(game, sender, seedVal);
      if (!res.success) {
        await msgCtx.reply([{ type: "text", text: `❌ ${res.error}` }]);
        return;
      }
      await msgCtx.reply([{ type: "text", text: `🔓 Seed verified and recorded for ${sender.slice(0, 8)}.` }]);
      return;
    }

    if (cmd === "/bid") {
      const tableId = this.conversationTables.get(conversationId) ?? this.latestTableId;
      if (!tableId || !this.tables.has(tableId)) {
        await msgCtx.reply([{ type: "text", text: "No active game in progress." }]);
        return;
      }

      const qty = parseInt(parts[1], 10);
      const face = parseInt(parts[2], 10);
      if (isNaN(qty) || isNaN(face)) {
        await msgCtx.reply([{ type: "text", text: "Usage: `/bid <quantity> <face>` (e.g. `/bid 3 4`)" }]);
        return;
      }

      if (await this.refuseClosed(tableId, msgCtx)) return;
      const game = this.tables.get(tableId)!;
      const res = applyBid(game, sender, qty, face);
      if (!res.success) {
        await msgCtx.reply([{ type: "text", text: `❌ Invalid bid: ${res.error}` }]);
        return;
      }

      this.resetTurnTimer(tableId, ctx, sender);
      const active = getActivePlayer(game)!;
      const item = this.buildLiarsDiceItem(game, "bid", sender);

      await msgCtx.reply([
        {
          type: "text",
          text: `🗣️ ${sender.slice(0, 8)} bid: **${qty}x [${face}]**! Next to act: ${active.address.slice(0, 8)} (or call \`/liar\`).`,
        },
        item,
      ]);
      return;
    }

    if (cmd === "/liar" || cmd === "/challenge") {
      const tableId = this.conversationTables.get(conversationId) ?? this.latestTableId;
      if (!tableId || !this.tables.has(tableId)) {
        await msgCtx.reply([{ type: "text", text: "No active game in progress." }]);
        return;
      }

      if (await this.refuseClosed(tableId, msgCtx)) return;
      const game = this.tables.get(tableId)!;
      const res = applyChallenge(game, sender);
      if (!res.success) {
        await msgCtx.reply([{ type: "text", text: `❌ Cannot call Liar: ${res.error}` }]);
        return;
      }

      const ended = await this.afterChallenge(game, ctx);
      if (!ended.verified) {
        await msgCtx.reply([
          {
            type: "text",
            text: `❌ Showdown verification failed: ${ended.reason}${
              ended.settlement ? `\nEvery buy-in is returned. ${settlementText(ended.settlement, ctx)}` : ""
            }`,
          },
        ]);
        return;
      }
      const r = res.resolution!;

      let msg = `🚨 **SHOWDOWN!** ${sender.slice(0, 8)} called Liar on ${r.bid.quantity}x [${r.bid.face}]!\n` +
        `Actual count: **${r.totalMatchingDice}** (${r.wildAcesCount} wild Aces).\n` +
        `${r.challengerWon ? "🎉 Challenger was right!" : "❌ Bidder was truthful!"}\n` +
        `💀 ${r.loserAddress.slice(0, 8)} loses 1 die (remaining: ${r.loserRemainingDice}).`;

      if (r.eliminated) {
        msg += `\n☠️ ${r.loserAddress.slice(0, 8)} is ELIMINATED!`;
      }

      if (game.status === "resolved") {
        msg += `\n\n🏆 **GAME OVER!** Winner: ${game.winnerAddress?.slice(0, 8)}! Pot: ${ctx.formatAmount(game.potWei)}.`;
        if (ended.settlement) {
          msg += `\n${settlementText(ended.settlement, ctx)}`;
        }
      }

      const item = this.buildLiarsDiceItem(game, "showdown", sender);
      await msgCtx.reply([{ type: "text", text: msg }, item]);
      return;
    }

    if (cmd === "/status") {
      const tableId = this.conversationTables.get(conversationId);
      if (!tableId || !this.tables.has(tableId)) {
        await msgCtx.reply([{ type: "text", text: "No active table in this conversation." }]);
        return;
      }
      const game = this.tables.get(tableId)!;
      const item = this.buildLiarsDiceItem(game, "bid", sender);
      await msgCtx.reply([
        {
          type: "text",
          text: `📊 Table ${game.tableId} | Round ${game.roundNumber} | Pot: ${ctx.formatAmount(game.potWei)} | Players: ${game.players.length}`,
        },
        item,
      ]);
    }
  }

  /** An ended table: says so and returns true. */
  private async refuseClosed(tableId: string, msgCtx: BotMessageContext): Promise<boolean> {
    if (!this.closedTables.has(tableId)) return false;
    await msgCtx.reply([{ type: "text", text: CLOSED_TABLE_TEXT }]);
    return true;
  }

  /** Seats `sender` for the buy-in lock its join names, then sits it at the table. */
  private async join(
    game: LiarsDiceGameState,
    sender: string,
    lock: LiarsDiceItem["buyInLock"],
    msgCtx: BotMessageContext,
    ctx: BotContext,
  ): Promise<void> {
    if (await this.refuseClosed(game.tableId, msgCtx)) return;
    // The game's join runs inside the escrow's seating step: a seat is recorded only when the
    // game took the player, and the player is told when it did not.
    const seat = await this.escrows.seat(ctx, game.tableId, sender, lock, () => {
      if (this.closedTables.has(game.tableId)) return { ok: false, error: "this table has ended" };
      const joined = joinGame(game, sender);
      return joined.success ? { ok: true } : { ok: false, error: joined.error ?? "the table refused the player" };
    });
    if (!seat.seated) {
      await msgCtx.reply([{ type: "text", text: `❌ Not seated: ${seatRefusalText(seat)}` }]);
      return;
    }
    this.conversationTables.set(sender, game.tableId);
    const item = this.buildLiarsDiceItem(game, "join", sender);
    await msgCtx.reply([
      {
        type: "text",
        text: `👤 ${sender.slice(0, 8)} joined table! Players: ${game.players.length}/${game.maxPlayers}. Type \`/start\` to begin!`,
      },
      item,
    ]);
  }

  private async handleStructuredAction(
    item: LiarsDiceItem,
    sender: string,
    msgCtx: BotMessageContext,
    ctx: BotContext,
  ): Promise<void> {
    const game = this.tables.get(item.tableId);
    if (!game) {
      await msgCtx.reply([{ type: "text", text: "Table not found or expired." }]);
      return;
    }

    if (item.action === "join") {
      await this.join(game, sender, item.buyInLock, msgCtx, ctx);
      return;
    }

    if ((item.action === "bid" || item.action === "challenge") && (await this.refuseClosed(game.tableId, msgCtx)))
      return;

    if (item.action === "bid" && item.currentBid) {
      const res = applyBid(game, sender, item.currentBid.quantity, item.currentBid.face);
      if (res.success) {
        this.resetTurnTimer(game.tableId, ctx, sender);
        const out = this.buildLiarsDiceItem(game, "bid", sender);
        await msgCtx.reply([out]);
      }
      return;
    }

    if (item.action === "challenge") {
      const res = applyChallenge(game, sender);
      if (res.success) {
        const { settlement } = await this.afterChallenge(game, ctx);
        const out = this.buildLiarsDiceItem(game, "showdown", sender);
        await msgCtx.reply(
          settlement ? [{ type: "text", text: settlementText(settlement, ctx) }, out] : [out]
        );
      }
    }
  }
}
