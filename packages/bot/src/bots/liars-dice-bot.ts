import { randomBytes } from "crypto";
import type {
  FrankBotDefinition,
  BotProfile,
  BotContext,
  BotMessageContext,
  NewUserEvent,
} from "@frank/bot-framework";
import type { MessageItem, LiarsDiceItem } from "@frank/cashweb/types/messages";
import { formatMon, parseMon } from "@frank/wallet/monad-amount";
import {
  createLiarsDiceGame,
  joinGame,
  startNextRound,
  applyBid,
  applyChallenge,
  getActivePlayer,
  getTotalDiceInPlay,
  TURN_TIMEOUT_SECONDS,
  DEFAULT_BUY_IN_WEI,
  type LiarsDiceGameState,
} from "@frank/wallet/message-item-plugins/liars-dice";
import { generateAvatarPng } from "../../bot-directory";

export class LiarsDiceBot implements FrankBotDefinition {
  readonly id = "liars-dice";
  readonly label = "Liar's Dice (Perudo)";
  readonly defaultIdentityPath =
    process.env.LIARS_DICE_BOT_IDENTITY_JSON ?? "/tmp/liars-dice-bot-identity.json";

  private readonly tables = new Map<string, LiarsDiceGameState>();
  private readonly conversationTables = new Map<string, string>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private latestTableId?: string;

  getProfile(): BotProfile {
    return {
      name: "Liar's Dice",
      bio: "Provably-fair Liar's Dice (Perudo) table referee with mental dice commitments.",
      avatarPng: generateAvatarPng("liars-dice", [240, 180, 50]),
      bot: true,
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

  private clearTableTimer(tableId: string) {
    const existing = this.timers.get(tableId);
    if (existing) {
      clearTimeout(existing);
      this.timers.delete(tableId);
    }
  }

  private resetTurnTimer(tableId: string, ctx: BotContext, peerAddress: string) {
    this.clearTableTimer(tableId);
    const timer = setTimeout(async () => {
      const game = this.tables.get(tableId);
      if (!game || game.status !== "round_active") return;
      const active = getActivePlayer(game);
      if (!active) return;

      console.log(`[liars-dice] Turn timer expired for ${active.address} on table ${tableId}`);
      if (game.currentBid) {
        // Auto-challenge on timeout if there is an existing bid
        const res = applyChallenge(game, active.address);
        if (res.success) {
          const item = this.buildLiarsDiceItem(game, "showdown", active.address);
          await ctx.sendMessage(peerAddress, [
            {
              type: "text",
              text: `⏰ Turn timeout! ${active.address.slice(0, 8)} automatically called Liar!`,
            },
            item,
          ]);
        }
      }
    }, TURN_TIMEOUT_SECONDS * 1000);

    this.timers.set(tableId, timer);
  }

  private buildLiarsDiceItem(
    game: LiarsDiceGameState,
    action: LiarsDiceItem["action"],
    recipientAddress?: string,
  ): LiarsDiceItem {
    const active = getActivePlayer(game);
    const revealedCups: Record<string, number[]> = {};
    for (const p of game.players) {
      if (p.currentDice) {
        revealedCups[p.address] = p.currentDice;
      }
    }

    const localPlayer = recipientAddress
      ? game.players.find(p => p.address.toLowerCase() === recipientAddress.toLowerCase())
      : undefined;

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
      serverSeed: game.status === "showdown" || game.status === "resolved" ? game.serverSeed : undefined,
      myDice: localPlayer?.currentDice,
      revealedCups: game.status === "showdown" || game.status === "resolved" ? revealedCups : undefined,
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
    };
  }

  async onMessage(msgCtx: BotMessageContext, ctx: BotContext): Promise<void> {
    const sender = msgCtx.senderAddress;
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
            buyInWei = parseMon(buyInStr);
          } catch {
            // Keep default
          }
        }

        const tableId = randomBytes(8).toString("hex");
        const game = createLiarsDiceGame({
          tableId,
          hostAddress: sender,
          buyInWei,
        });

        // Host automatically joins
        joinGame(game, sender);
        this.tables.set(tableId, game);
        this.conversationTables.set(conversationId, tableId);
        this.latestTableId = tableId;

        const item = this.buildLiarsDiceItem(game, "create", sender);
        await msgCtx.reply([
          {
            type: "text",
            text: `🎲 Table **${tableId}** created! Buy-in: ${formatMon(buyInWei)} MON. Joined: 1/${game.maxPlayers}. Type \`/table join\` to join!`,
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

        const game = this.tables.get(tableId)!;
        const res = joinGame(game, sender);
        if (!res.success) {
          await msgCtx.reply([{ type: "text", text: `❌ Could not join table: ${res.error}` }]);
          return;
        }

        this.conversationTables.set(conversationId, tableId);

        const item = this.buildLiarsDiceItem(game, "join", sender);
        await msgCtx.reply([
          {
            type: "text",
            text: `👤 ${sender.slice(0, 8)} joined table! Players: ${game.players.length}/${game.maxPlayers}. Type \`/start\` to begin!`,
          },
          item,
        ]);
        return;
      }
    }

    if (cmd === "/start") {
      const tableId = this.conversationTables.get(conversationId) ?? this.latestTableId;
      if (!tableId || !this.tables.has(tableId)) {
        await msgCtx.reply([{ type: "text", text: "No active table. Create one with `/table create`." }]);
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

      const game = this.tables.get(tableId)!;
      const res = applyChallenge(game, sender);
      if (!res.success) {
        await msgCtx.reply([{ type: "text", text: `❌ Cannot call Liar: ${res.error}` }]);
        return;
      }

      this.clearTableTimer(tableId);
      const r = res.resolution!;
      const item = this.buildLiarsDiceItem(game, "showdown", sender);

      let msg = `🚨 **SHOWDOWN!** ${sender.slice(0, 8)} called Liar on ${r.bid.quantity}x [${r.bid.face}]!\n` +
        `Actual count: **${r.totalMatchingDice}** (${r.wildAcesCount} wild Aces).\n` +
        `${r.challengerWon ? "🎉 Challenger was right!" : "❌ Bidder was truthful!"}\n` +
        `💀 ${r.loserAddress.slice(0, 8)} loses 1 die (remaining: ${r.loserRemainingDice}).`;

      if (r.eliminated) {
        msg += `\n☠️ ${r.loserAddress.slice(0, 8)} is ELIMINATED!`;
      }

      if (game.status === "resolved") {
        msg += `\n\n🏆 **GAME OVER!** Winner: ${game.winnerAddress?.slice(0, 8)}! Pot: ${formatMon(game.potWei)} MON.`;
      }

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
          text: `📊 Table ${game.tableId} | Round ${game.roundNumber} | Pot: ${formatMon(game.potWei)} MON | Players: ${game.players.length}`,
        },
        item,
      ]);
    }
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
      const res = joinGame(game, sender);
      if (res.success) {
        const out = this.buildLiarsDiceItem(game, "join", sender);
        await msgCtx.reply([out]);
      }
      return;
    }

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
        this.clearTableTimer(game.tableId);
        const out = this.buildLiarsDiceItem(game, "showdown", sender);
        await msgCtx.reply([out]);
      }
    }
  }
}
