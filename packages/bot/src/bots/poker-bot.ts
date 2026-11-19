/**
 * Registered: in the bot set (`./index.ts`), `targets/all-bots.ts` (`poker`), `targets/poker.ts`
 * and the demo. The game itself is still to be rebuilt, ticket #1377.
 *
 * Known wrong, as it stands:
 * - the deck is shuffled from a seed only the bot knows, with no commitment and nothing from
 *   the players, so the dealer can choose the cards and nobody can check a deal.
 * Its profile makes no fairness claim.
 *
 * Buy-ins are held in a GenericHTLC v2 table escrow (`./table-htlc`): a player is seated only by a
 * join naming an open buy-in lock with the table's terms; when a hand settles, the pot of locked
 * buy-ins is paid out by chip stack with `batchDistribute`, and the table closes. One escrowed
 * hand per table: a closed table deals no other hand and seats nobody, also once its escrow
 * record is dropped (`closedTables`; the escrow drops it when every lock is withdrawn).
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
import type { PokerItem, PokerPlayerView, PokerActionType } from "@frank/cashweb/types/messages";
import {
  createPokerTable,
  joinPokerTable,
  startNewHand,
  applyPlayerAction,
  setPokerPlayerCommit,
  setPokerPlayerSeed,
  verifyPokerShowdown,
  commitSeed,
  generatePokerSeed,
  formatCard,
  type PokerGameState,
  type PokerPlayer,
} from "@frank/wallet/message-item-plugins/poker";
import { botProfileSpec, generateAvatarPng } from "../../bot-directory";
import { ACCOUNT_TYPE_BOT, BOT_ROLE_GAME } from "@frank/codec";
import {
  TableEscrows,
  returnBuyIns,
  seatRefusalText,
  settlementText,
  splitPool,
  tableEscrowItemTerms,
  tablePool,
  type TableEscrowBook,
  type TableEscrowRecord,
  type TableSettlementResult,
} from "./table-htlc";
import {
  announceTableToTopic,
  type GameTableDetails,
  DEFAULT_GAMES_TOPIC,
} from "./table-announcements";

export const POKER_DEFAULT_BUY_IN_WEI = 100_000_000_000_000_000n; // 0.1 MON
export const POKER_TURN_TIMEOUT_SECONDS = 45;
export type { TableEscrowRecord };
const POKER_PROFILE = botProfileSpec("poker");

export class PokerBot implements FrankBotDefinition {
  readonly id = "poker";
  /** A game is many replies to one player: see `GAME_MAX_REPLIES_PER_PEER`. */
  readonly maxRepliesPerPeer = GAME_MAX_REPLIES_PER_PEER;
  readonly label = "Texas Hold'em Poker";
  readonly defaultIdentityPath =
    process.env.POKER_BOT_IDENTITY_JSON ?? "/tmp/poker-bot-identity.json";

  private readonly tables = new Map<string, PokerGameState>();
  private readonly conversationTables = new Map<string, string>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private latestTableId?: string;
  private readonly escrows: TableEscrowBook;
  /** Tables whose escrowed hand has ended: no other hand, no join, whatever the escrow keeps. */
  private readonly closedTables = new Set<string>();
  /** Every table's escrow terms as opened, kept after the escrow forgets a settled table: a
   * player whose lock was never seated still needs them on the table's card to refund it. */
  private readonly openedEscrows = new Map<string, Readonly<TableEscrowRecord>>();

  constructor(options: { escrows?: TableEscrowBook } = {}) {
    this.escrows = options.escrows ?? new TableEscrows("poker");
  }

  getTableEscrow(tableId: string): Readonly<TableEscrowRecord> | undefined {
    return this.escrows.get(tableId);
  }

  private recovery: Promise<void> = Promise.resolve();

  /** After a restart: every kept table's game is gone, so each is settled as it was written
   * down, or its buy-ins are returned (`TableEscrows.recover`). Startup does not wait for it. */
  async onStart(ctx: BotContext): Promise<void> {
    this.recovery = this.escrows.recover(ctx, tableId => this.tables.has(tableId)).then(results => {
      for (const result of results)
        console.log(`[poker] table ${result.tableId} after restart: ${settlementText(result, ctx)}`);
    });
  }

  /** The recovery `onStart` began, done. */
  recovered(): Promise<void> {
    return this.recovery;
  }

  async onStop(): Promise<void> {
    for (const tableId of [...this.timers.keys()]) this.clearTableTimer(tableId);
    // Before the host closes the state store and provider: retries cancelled, a running step
    // and the restart recovery finished.
    await this.escrows.stop();
    await this.recovery;
  }

  /**
   * The hand ended, by any path (an action, a fold, a turn timeout): the table settles and closes.
   * A verified showdown pays the locked pot out by chip stack; one that fails verification
   * returns every buy-in.
   */
  private async endHand(
    table: PokerGameState,
    ctx: BotContext
  ): Promise<{ verified: boolean; reason?: string; settlement?: TableSettlementResult }> {
    this.clearTableTimer(table.tableId);
    const verification = verifyPokerShowdown(table);
    if (!this.escrows.get(table.tableId)) return { verified: verification.verified, reason: verification.reason };
    // Closed before the settlement's wait: nothing deals or seats at this table again.
    this.closedTables.add(table.tableId);
    const settlement = await this.escrows.settle(
      ctx,
      table.tableId,
      verification.verified
        ? record =>
            splitPool(
              tablePool(record),
              table.players.map(p => ({ player: p.address, weight: BigInt(p.chips) }))
            )
        : returnBuyIns
    );
    return { verified: verification.verified, reason: verification.reason, settlement };
  }

  getProfile(): BotProfile {
    return {
      name: POKER_PROFILE.name,
      bio: POKER_PROFILE.bio,
      avatarPng: generateAvatarPng("poker", POKER_PROFILE.accent),
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

  /** The active player's turn ran out: it checks if it can, else folds. A fold or check that
   * ends the hand settles the table, as any other end of a hand does. */
  private async onTurnTimeout(tableId: string, ctx: BotContext, peerAddress: string): Promise<void> {
    const table = this.tables.get(tableId);
    if (!table || table.street === "waiting" || table.street === "settled" || table.street === "showdown") {
      return;
    }
    const active = table.players[table.activePlayerIndex];
    if (!active) return;

    console.log(`[poker] Turn timer expired for ${active.address} on table ${tableId}`);
    const autoAction: PokerActionType = active.currentStreetBet >= table.currentBet ? "check" : "fold";
    const res = applyPlayerAction(table, active.address, autoAction);
    if (!res.success) return;
    let note = "";
    if ((table.street as PokerGameState["street"]) === "settled") {
      const ended = await this.endHand(table, ctx);
      if (ended.settlement) note = `\n${settlementText(ended.settlement, ctx)}`;
    } else {
      this.resetTurnTimer(tableId, ctx, peerAddress);
    }
    const item = this.buildPokerItem(table, active.address);
    await ctx.sendMessage(peerAddress, [
      {
        type: "text",
        text: `⏰ Turn timeout! ${active.address.slice(0, 8)} automatically ${autoAction}ed.${note}`,
      },
      item,
    ]);
  }

  private resetTurnTimer(tableId: string, ctx: BotContext, peerAddress: string) {
    this.clearTableTimer(tableId);
    const timer = setTimeout(() => {
      void this.onTurnTimeout(tableId, ctx, peerAddress).catch(error =>
        console.warn(`[poker] turn timeout on table ${tableId} failed:`, error)
      );
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
    const escrow = this.escrows.get(table.tableId) ?? this.openedEscrows.get(table.tableId);
    const isRevealed = table.street === "settled" || table.street === "showdown";

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
        isRevealed || p.address.toLowerCase() === recipientAddress?.toLowerCase()
          ? p.holeCards
          : undefined,
    }));

    return {
      type: "poker",
      tableId: table.tableId,
      action: table.street === "settled" ? "settle" : table.street === "waiting" ? "create" : "action",
      buyInWei: escrow?.buyInWei ?? POKER_DEFAULT_BUY_IN_WEI.toString(),
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
      serverCommit: table.serverCommit,
      serverSeed: isRevealed ? table.serverSeed : undefined,
      playerCommits: table.playerCommits,
      playerSeeds: isRevealed ? table.playerSeeds : undefined,
      holeCardCommits: table.holeCardCommits,
      holeCardSalts: isRevealed ? table.holeCardSalts : undefined,
      escrow: escrow ? tableEscrowItemTerms(escrow) : undefined,
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
        const escrow = await this.escrows.open(ctx, POKER_DEFAULT_BUY_IN_WEI);
        if ("status" in escrow) {
          await msgCtx.reply([{ type: "text", text: `❌ Cannot open a table: ${escrow.reason}` }]);
          return;
        }
        const tableId = escrow.tableId;
        this.openedEscrows.set(tableId, escrow);
        const table = createPokerTable({ tableId, buyInChips: 1000, smallBlind: 10, bigBlind: 20 });

        this.tables.set(tableId, table);
        this.conversationTables.set(conversationId, tableId);
        this.latestTableId = tableId;

        const item = this.buildPokerItem(table, sender);
        await msgCtx.reply([
          {
            type: "text",
            text: `♠️ Poker Table **${tableId}** created! Buy-in: ${ctx.formatAmount(POKER_DEFAULT_BUY_IN_WEI)} for 1000 chips (Blinds: 10/20). Players: 0/${table.maxPlayers}. Join from the app: it locks your buy-in, then sits you down.`,
          },
          item,
        ]);

        // Announced on the public discovery topic beside the handler: the post pays on chain and
        // may be slow or fail, and neither this reply nor the player's next message waits for it.
        ctx.runInBackground(`Announcing table ${tableId}`, () =>
          this.announceTableToTopic(ctx, DEFAULT_GAMES_TOPIC, {
            gameName: "Texas Hold'em Poker",
            gameType: "poker",
            tableId,
            hostAddress: sender,
            buyInAmount: `${ctx.formatAmount(POKER_DEFAULT_BUY_IN_WEI)} (1000 chips, blinds 10/20)`,
            currentPlayers: table.players.length,
            maxPlayers: table.maxPlayers,
            botAddress: ctx.address,
          })
        );
        return;
      }

      if (sub === "join") {
        const explicitId = parts[cmd === "/poker" ? 2 : 1];
        const tableId = explicitId ?? this.conversationTables.get(conversationId) ?? this.latestTableId;
        if (!tableId || !this.tables.has(tableId)) {
          await msgCtx.reply([{ type: "text", text: "No active poker table to join. Create one with `/poker create`." }]);
          return;
        }

        await this.join(this.tables.get(tableId)!, sender, undefined, msgCtx, ctx);
        return;
      }

      if (sub === "start") {
        const tableId = this.conversationTables.get(conversationId) ?? this.latestTableId;
        if (!tableId || !this.tables.has(tableId)) {
          await msgCtx.reply([{ type: "text", text: "No active poker table. Create one with `/poker create`." }]);
          return;
        }

        const table = this.tables.get(tableId)!;
        // One escrowed hand per table: once it is dealt, the table settles when it ends.
        if (this.closedTables.has(tableId) || (this.escrows.get(tableId) && table.handNumber > 0)) {
          await msgCtx.reply([{ type: "text", text: "❌ This table has settled: open a new one with `/poker create`." }]);
          return;
        }
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

    if (cmd === "/commit" || (cmd === "/poker" && parts[1]?.toLowerCase() === "commit")) {
      const commitVal = cmd === "/poker" ? parts[2] : parts[1];
      const tableId = this.conversationTables.get(conversationId) ?? this.latestTableId;
      if (!tableId || !this.tables.has(tableId) || !commitVal) {
        await msgCtx.reply([{ type: "text", text: "Usage: `/poker commit <sha256_hex>`" }]);
        return;
      }
      const table = this.tables.get(tableId)!;
      const res = setPokerPlayerCommit(table, sender, commitVal);
      if (!res.success) {
        await msgCtx.reply([{ type: "text", text: `❌ ${res.error}` }]);
        return;
      }
      await msgCtx.reply([{ type: "text", text: `🔒 Seed commitment recorded for ${sender.slice(0, 8)}.` }]);
      return;
    }

    if (cmd === "/seed" || (cmd === "/poker" && parts[1]?.toLowerCase() === "seed")) {
      const seedVal = cmd === "/poker" ? parts[2] : parts[1];
      const tableId = this.conversationTables.get(conversationId) ?? this.latestTableId;
      if (!tableId || !this.tables.has(tableId) || !seedVal) {
        await msgCtx.reply([{ type: "text", text: "Usage: `/poker seed <seed_hex>`" }]);
        return;
      }
      const table = this.tables.get(tableId)!;
      const res = setPokerPlayerSeed(table, sender, seedVal);
      if (!res.success) {
        await msgCtx.reply([{ type: "text", text: `❌ ${res.error}` }]);
        return;
      }
      await msgCtx.reply([{ type: "text", text: `🔓 Seed verified and recorded for ${sender.slice(0, 8)}.` }]);
      return;
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
        const { verified, reason, settlement } = await this.endHand(table, ctx);
        if (!verified) {
          await msgCtx.reply([
            {
              type: "text",
              text: `❌ Showdown verification failed: ${reason}${
                settlement ? `\nEvery buy-in is returned. ${settlementText(settlement, ctx)}` : ""
              }`,
            },
          ]);
          return;
        }
        let msg = `🏆 **HAND SETTLED!**\n`;
        for (const w of table.winners ?? []) {
          msg += `• **${w.address.slice(0, 8)}** won **${w.amount} chips**! (${w.evaluation ? w.evaluation.description : 'Uncontested'})\n`;
        }
        if (settlement) {
          msg += `${settlementText(settlement, ctx)}\n`;
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

    if (cmd === "/status" || (cmd === "/poker" && parts[1]?.toLowerCase() === "status")) {
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

  /** Seats `sender` for the buy-in lock its join names, then sits it at the table. */
  private async join(
    table: PokerGameState,
    sender: string,
    lock: PokerItem["buyInLock"],
    msgCtx: BotMessageContext,
    ctx: BotContext,
  ): Promise<void> {
    if (this.closedTables.has(table.tableId)) {
      await msgCtx.reply([{ type: "text", text: "❌ Not seated: this table has settled. Open a new one with `/poker create`." }]);
      return;
    }
    // The game's join runs inside the escrow's seating step: a seat is recorded only when the
    // game took the player, and the player is told when it did not.
    const seat = await this.escrows.seat(ctx, table.tableId, sender, lock, () => {
      if (this.closedTables.has(table.tableId) || (this.escrows.get(table.tableId) && table.handNumber > 0))
        return { ok: false, error: "this table's escrowed hand has been dealt" };
      const joined = joinPokerTable(table, sender);
      return joined.success ? { ok: true } : { ok: false, error: joined.error ?? "the table refused the player" };
    });
    if (!seat.seated) {
      await msgCtx.reply([
        { type: "text", text: `❌ Not seated: ${seatRefusalText(seat)}` },
        // A text join gets the table's card: the app joins from it, locking the buy-in first.
        ...(seat.reason === "no-buy-in-lock" ? [this.buildPokerItem(table, sender)] : []),
      ]);
      return;
    }
    this.conversationTables.set(sender, table.tableId);
    const item = this.buildPokerItem(table, sender);
    await msgCtx.reply([
      {
        type: "text",
        text: `👤 ${sender.slice(0, 8)} joined table! Players: ${table.players.length}/${table.maxPlayers}. Type \`/poker start\` to deal!`,
      },
      item,
    ]);
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
      await this.join(table, sender, item.buyInLock, msgCtx, ctx);
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
        let settlement: TableSettlementResult | undefined;
        if (table.street === "settled") {
          // As the text path: the showdown is verified, and an unverified one returns the buy-ins.
          settlement = (await this.endHand(table, ctx)).settlement;
        } else {
          this.resetTurnTimer(table.tableId, ctx, sender);
        }
        const out = this.buildPokerItem(table, sender);
        await msgCtx.reply(
          settlement ? [{ type: "text", text: settlementText(settlement, ctx) }, out] : [out]
        );
      }
    }
  }
}
