/**
 * PARKED: not registered. Nothing imports this file: it is not in the bot set (`./index.ts`,
 * `targets/`), the launcher or the demo, and the app's card for it is not mounted. It is kept
 * for the rebuild, ticket #1377.
 *
 * Known wrong, as it stands:
 * - the deck is shuffled from a seed only the bot knows, with no commitment and nothing from
 *   the players, so the dealer can choose the cards and nobody can check a deal;
 * - no buy-in is collected: chips are numbers, and nothing a player paid backs them;
 * - the app's card emitted a malformed message (`{type:'text', text}` with no `items`).
 * While parked it sends no "settlement": the call to the HTLC contract with lock IDs the bot
 * made up is removed, and its profile makes no fairness claim.
 */
import { randomBytes } from "crypto";
import type {
  FrankBotDefinition,
  BotProfile,
  BotContext,
  BotMessageContext,
  NewUserEvent,
} from "@frank/bot-framework";
import { GAME_MAX_REPLIES_PER_PEER } from "@frank/bot-framework";
import type { PokerItem, PokerPlayerView, PokerActionType } from "@frank/cashweb/types/messages";
import { keccak256, toUtf8Bytes } from "ethers";
import {
  createPokerTable,
  joinPokerTable,
  startNewHand,
  applyPlayerAction,
  formatCard,
  type PokerGameState,
  type PokerPlayer,
} from "@frank/wallet/message-item-plugins/poker";
import { generateAvatarPng } from "../../bot-directory";
import { ACCOUNT_TYPE_BOT, BOT_ROLE_GAME } from "@frank/codec";
import {
  announceTableToTopic,
  type GameTableDetails,
  DEFAULT_GAMES_TOPIC,
} from "./table-announcements";

export const POKER_DEFAULT_BUY_IN_WEI = 100_000_000_000_000_000n; // 0.1 MON
export const POKER_TURN_TIMEOUT_SECONDS = 45;
export interface TableEscrowRecord {
  preimage: string;
  hashLock: string;
  playerLocks: Map<string, string>;
  settlementTxHash?: string;
}


export class PokerBot implements FrankBotDefinition {
  readonly id = "poker";
  /** A game is many replies to one player: see `GAME_MAX_REPLIES_PER_PEER`. */
  readonly maxRepliesPerPeer = GAME_MAX_REPLIES_PER_PEER;
  readonly label = "Texas Hold'em Poker";
  readonly defaultIdentityPath =
    process.env.POKER_BOT_IDENTITY_JSON ?? "/tmp/poker-bot-identity.json";

  private readonly tables = new Map<string, PokerGameState>();
  private readonly tableEscrows = new Map<string, TableEscrowRecord>();
  private readonly conversationTables = new Map<string, string>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private latestTableId?: string;

  private async settleTableEscrow(
    table: PokerGameState,
    ctx?: BotContext
  ): Promise<string | undefined> {
    // Parked (#1377): no settlement is sent. The earlier code called the HTLC contract's
    // batchDistribute with lock IDs no player ever funded.
    void table;
    void ctx;
    return undefined;
  }

  getProfile(): BotProfile {
    return {
      name: "Texas Hold'em Poker",
      bio: "No-Limit Texas Hold'em table for 2 to 6 players. Parked: not fair or playable yet.",
      avatarPng: generateAvatarPng("poker", [30, 160, 80]),
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
          text: "♠️ Welcome to Texas Hold'em Poker! Create a table with `/poker create`, or join an existing table with `/poker join`.",
        },
      ]);
    } catch (err) {
      console.warn(`[poker] Failed to welcome ${user.address}:`, err);
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
    const timer = setTimeout(async () => {
      const table = this.tables.get(tableId);
      if (!table || table.street === "waiting" || table.street === "settled" || table.street === "showdown") {
        return;
      }
      const active = table.players[table.activePlayerIndex];
      if (!active) return;

      console.log(`[poker] Turn timer expired for ${active.address} on table ${tableId}`);
      // Auto-check if possible, else auto-fold
      const autoAction: PokerActionType = active.currentStreetBet >= table.currentBet ? "check" : "fold";
      const res = applyPlayerAction(table, active.address, autoAction);
      if (res.success) {
        const item = this.buildPokerItem(table, active.address);
        await ctx.sendMessage(peerAddress, [
          {
            type: "text",
            text: `⏰ Turn timeout! ${active.address.slice(0, 8)} automatically ${autoAction}ed.`,
          },
          item,
        ]);
      }
    }, POKER_TURN_TIMEOUT_SECONDS * 1000);

    timer.unref?.();
    this.timers.set(tableId, timer);
  }

  private buildPokerItem(
    table: PokerGameState,
    recipientAddress?: string,
  ): PokerItem {
    const active = table.players[table.activePlayerIndex];
    const localPlayer = recipientAddress
      ? table.players.find(p => p.address.toLowerCase() === recipientAddress.toLowerCase())
      : undefined;

    const totalPot = table.pot + table.players.reduce((sum, p) => sum + p.currentStreetBet, 0);

    const playerViews: PokerPlayerView[] = table.players.map((p, idx) => ({
      address: p.address,
      chips: p.chips,
      currentStreetBet: p.currentStreetBet,
      totalHandBet: p.totalHandBet,
      folded: p.folded,
      isAllIn: p.isAllIn,
      isDealerButton: idx === table.dealerIndex,
      isSmallBlind: table.players.length === 2 ? idx === table.dealerIndex : idx === (table.dealerIndex + 1) % table.players.length,
      isBigBlind: table.players.length === 2 ? idx !== table.dealerIndex : idx === (table.dealerIndex + 2) % table.players.length,
      holeCards:
        table.street === "settled" || table.street === "showdown" || p.address.toLowerCase() === recipientAddress?.toLowerCase()
          ? p.holeCards
          : undefined,
    }));

    return {
      type: "poker",
      tableId: table.tableId,
      action: table.street === "settled" ? "settle" : table.street === "waiting" ? "create" : "action",
      buyInWei: POKER_DEFAULT_BUY_IN_WEI.toString(),
      smallBlind: table.smallBlind,
      bigBlind: table.bigBlind,
      street: table.street === "waiting" ? undefined : table.street,
      pot: totalPot,
      currentBet: table.currentBet,
      minRaise: table.minRaise,
      activePlayer: active?.address,
      boardCards: table.boardCards,
      players: playerViews,
      myHoleCards: localPlayer?.holeCards && localPlayer.holeCards[0] !== -1 ? localPlayer.holeCards : undefined,
      lastAction: table.lastAction,
      winners: table.winners?.map(w => ({
        address: w.address,
        amount: w.amount,
        handDescription: w.evaluation?.description,
        best5Cards: w.evaluation?.best5,
      })),
      winnerAddress: table.winners?.[0]?.address,
      txHash: this.tableEscrows.get(table.tableId)?.settlementTxHash,
    };
  }

  async onMessage(msgCtx: BotMessageContext, ctx: BotContext): Promise<void> {
    const sender = msgCtx.peerAddress || (msgCtx as any).senderAddress || "";
    const conversationId = sender;

    const incomingItem = msgCtx.items.find((item: any) => item.type === "poker") as
      | PokerItem
      | undefined;

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

    await msgCtx.reply([
      {
        type: "text",
        text: `♠️ **Frank Texas Hold'em Poker**\n\nCommands:\n• \`/poker create [buyIn]\` - Create a table\n• \`/poker join\` - Join the current table\n• \`/poker start\` - Start the hand\n• \`/check\`, \`/call\`, \`/bet <amount>\`, \`/raise <amount>\`, \`/fold\`, \`/allin\` - Player actions\n• \`/poker status\` - View table status`,
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

    if (cmd === "/help" || cmd === "/poker_help") {
      await msgCtx.reply([
        {
          type: "text",
          text: `♠️ **Texas Hold'em Poker Rules**\n\n• 2 to 6 players, No-Limit rules.\n• Each player receives 2 secret hole cards.\n• 5 community cards dealt across Flop (3), Turn (1), River (1).\n• Best 5-card combination from 7 cards wins the pot!`,
        },
      ]);
      return;
    }

    if (cmd === "/poker" || cmd === "/create" || cmd === "/join" || cmd === "/start") {
      const sub = cmd === "/poker" ? parts[1]?.toLowerCase() : cmd.slice(1);

      if (sub === "create") {
        const tableId = randomBytes(8).toString("hex");
        const table = createPokerTable({ tableId, buyInChips: 1000, smallBlind: 10, bigBlind: 20 });
        joinPokerTable(table, sender);

        const preimage = "0x" + randomBytes(32).toString("hex");
        const hashLock = keccak256(preimage);
        const playerLocks = new Map<string, string>();
        playerLocks.set(sender.toLowerCase(), keccak256(toUtf8Bytes(`poker:${tableId}:${sender.toLowerCase()}`)));
        this.tableEscrows.set(tableId, { preimage, hashLock, playerLocks });

        this.tables.set(tableId, table);
        this.conversationTables.set(conversationId, tableId);
        this.latestTableId = tableId;

        // Announce table to public discovery topic
        await this.announceTableToTopic(ctx, DEFAULT_GAMES_TOPIC, {
          gameName: "Texas Hold'em Poker",
          gameType: "poker",
          tableId,
          hostAddress: sender,
          buyInAmount: "1000 chips (Blinds: 10/20)",
          currentPlayers: table.players.length,
          maxPlayers: table.maxPlayers,
          botAddress: ctx.address,
        });

        const item = this.buildPokerItem(table, sender);
        await msgCtx.reply([
          {
            type: "text",
            text: `♠️ Poker Table **${tableId}** created! Buy-in: 1000 chips (Blinds: 10/20). Players: 1/${table.maxPlayers}. Type \`/poker join\` to sit at table!`,
          },
          item,
        ]);
        return;
      }

      if (sub === "join") {
        const explicitId = parts[cmd === "/poker" ? 2 : 1];
        const tableId = explicitId ?? this.conversationTables.get(conversationId) ?? this.latestTableId;
        if (!tableId || !this.tables.has(tableId)) {
          await msgCtx.reply([{ type: "text", text: "No active poker table to join. Create one with `/poker create`." }]);
          return;
        }

        const table = this.tables.get(tableId)!;
        const res = joinPokerTable(table, sender);
        if (!res.success) {
          await msgCtx.reply([{ type: "text", text: `❌ Could not join table: ${res.error}` }]);
          return;
        }

        this.conversationTables.set(conversationId, tableId);
        const escrow = this.tableEscrows.get(tableId);
        if (escrow) {
          escrow.playerLocks.set(sender.toLowerCase(), keccak256(toUtf8Bytes(`poker:${tableId}:${sender.toLowerCase()}`)));
        }

        const item = this.buildPokerItem(table, sender);
        await msgCtx.reply([
          {
            type: "text",
            text: `👤 ${sender.slice(0, 8)} joined table! Players: ${table.players.length}/${table.maxPlayers}. Type \`/poker start\` to deal!`,
          },
          item,
        ]);
        return;
      }

      if (sub === "start") {
        const tableId = this.conversationTables.get(conversationId) ?? this.latestTableId;
        if (!tableId || !this.tables.has(tableId)) {
          await msgCtx.reply([{ type: "text", text: "No active poker table. Create one with `/poker create`." }]);
          return;
        }

        const table = this.tables.get(tableId)!;
        const res = startNewHand(table);
        if (!res.success) {
          await msgCtx.reply([{ type: "text", text: `❌ Cannot deal hand: ${res.error}` }]);
          return;
        }

        this.resetTurnTimer(tableId, ctx, sender);
        const active = table.players[table.activePlayerIndex];
        const item = this.buildPokerItem(table, sender);

        await msgCtx.reply([
          {
            type: "text",
            text: `♠️ Hand #${table.handNumber} dealt! Pot: ${table.pot} chips. Current bet: ${table.currentBet}. To act: ${active.address.slice(0, 8)}.`,
          },
          item,
        ]);
        return;
      }
    }

    // Action commands: /check, /call, /bet, /raise, /fold, /allin
    const actionMap: Record<string, PokerActionType> = {
      "/check": "check",
      "/call": "call",
      "/bet": "bet",
      "/raise": "raise",
      "/fold": "fold",
      "/allin": "all_in",
    };

    if (actionMap[cmd]) {
      const tableId = this.conversationTables.get(conversationId) ?? this.latestTableId;
      if (!tableId || !this.tables.has(tableId)) {
        await msgCtx.reply([{ type: "text", text: "No active hand in progress." }]);
        return;
      }

      const table = this.tables.get(tableId)!;
      const action = actionMap[cmd];
      const amount = parts[1] ? parseInt(parts[1], 10) : undefined;

      const res = applyPlayerAction(table, sender, action, amount);
      if (!res.success) {
        await msgCtx.reply([{ type: "text", text: `❌ Illegal action: ${res.error}` }]);
        return;
      }

      if (table.street === "settled") {
        this.clearTableTimer(tableId);
        const txHash = await this.settleTableEscrow(table, ctx);
        let msg = `🏆 **HAND SETTLED!**\n`;
        for (const w of table.winners ?? []) {
          msg += `• **${w.address.slice(0, 8)}** won **${w.amount} chips**! (${w.evaluation ? w.evaluation.description : 'Uncontested'})\n`;
        }
        if (txHash) {
          msg += `⛓️ **On-Chain Settlement:** \`${txHash}\` (GenericHTLC.batchDistribute)\n`;
        }
        const item = this.buildPokerItem(table, sender);
        await msgCtx.reply([{ type: "text", text: msg }, item]);
        return;
      }

      const item = this.buildPokerItem(table, sender);

      this.resetTurnTimer(tableId, ctx, sender);
      const active = table.players[table.activePlayerIndex];
      let msg = `🗣️ ${sender.slice(0, 8)} ${action}${amount ? ` ${amount}` : ''}! `;
      if (table.boardCards.length > 0) {
        msg += `Board: [${table.boardCards.map(formatCard).join(' ')}] | `;
      }
      msg += `Pot: ${table.pot} | Current bet: ${table.currentBet} | Next to act: ${active.address.slice(0, 8)}.`;

      await msgCtx.reply([{ type: "text", text: msg }, item]);
      return;
    }

    if (cmd === "/status") {
      const tableId = this.conversationTables.get(conversationId) ?? this.latestTableId;
      if (!tableId || !this.tables.has(tableId)) {
        await msgCtx.reply([{ type: "text", text: "No active table." }]);
        return;
      }
      const table = this.tables.get(tableId)!;
      const item = this.buildPokerItem(table, sender);
      await msgCtx.reply([
        {
          type: "text",
          text: `📊 Table ${table.tableId} | Street: ${table.street} | Pot: ${table.pot} chips | Players: ${table.players.length}`,
        },
        item,
      ]);
    }
  }

  private async handleStructuredAction(
    item: PokerItem,
    sender: string,
    msgCtx: BotMessageContext,
    ctx: BotContext,
  ): Promise<void> {
    const table = this.tables.get(item.tableId);
    if (!table) {
      await msgCtx.reply([{ type: "text", text: "Table not found or expired." }]);
      return;
    }

    if (item.action === "join") {
      const res = joinPokerTable(table, sender);
      if (res.success) {
        const escrow = this.tableEscrows.get(item.tableId);
        if (escrow) {
          escrow.playerLocks.set(sender.toLowerCase(), keccak256(toUtf8Bytes(`poker:${item.tableId}:${sender.toLowerCase()}`)));
        }
        const out = this.buildPokerItem(table, sender);
        await msgCtx.reply([out]);
      }
      return;
    }

    if (item.lastAction) {
      const res = applyPlayerAction(
        table,
        sender,
        item.lastAction.action,
        item.lastAction.amount,
      );
      if (res.success) {
        if (table.street === "settled") {
          this.clearTableTimer(table.tableId);
          await this.settleTableEscrow(table, ctx);
        } else {
          this.resetTurnTimer(table.tableId, ctx, sender);
        }
        const out = this.buildPokerItem(table, sender);
        await msgCtx.reply([out]);
      }
    }
  }
}
