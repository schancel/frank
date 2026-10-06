import { randomBytes, createHash } from "crypto";
import type {
  FrankBotDefinition,
  BotProfile,
  BotContext,
  BotMessageContext,
  NewUserEvent,
} from "@frank/bot-framework";
import {
  BLACKJACK_DEFAULT_MIN_WAGER_WEI,
  BLACKJACK_DEFAULT_MAX_WAGER_WEI,
  BLACKJACK_RULES_SUMMARY,
  buildBlackjackWelcomeItem,
  dealInitialCards,
  playOutDealer,
  resolveOutcome,
  type BlackjackOutcome,
} from "@frank/wallet/message-item-plugins/blackjack/game";
import {
  deriveDeck,
  handValue,
  type Card,
} from "@frank/wallet/message-item-plugins/blackjack/deck";
import { generateAvatarPng } from "../../bot-directory";

export interface ActiveGameRecord {
  gameId: string;
  playerAddress: string;
  wagerTxHash: string;
  wagerWei: string;
  serverSeed: string;
  serverCommit: string;
  dealtCount: number;
  playerCards: Card[];
  dealerCards: Card[];
  status: "active" | "resolved";
  outcome?: BlackjackOutcome;
}

export class BlackjackDealerBot implements FrankBotDefinition {
  readonly id = "blackjack";
  readonly label = "Blackjack Dealer";
  readonly defaultIdentityPath =
    process.env.BLACKJACK_BOT_IDENTITY_JSON ??
    "/tmp/blackjack-bot-identity.json";

  private readonly minWagerWei: bigint;
  private readonly maxWagerWei: bigint;

  constructor(options?: { minWagerWei?: bigint; maxWagerWei?: bigint }) {
    this.minWagerWei = options?.minWagerWei ?? BLACKJACK_DEFAULT_MIN_WAGER_WEI;
    this.maxWagerWei = options?.maxWagerWei ?? BLACKJACK_DEFAULT_MAX_WAGER_WEI;
  }

  getProfile(): BotProfile {
    return {
      name: "Blackjack Dealer",
      bio: "Automated blackjack dealer. Send a wager to start a provably fair hand.",
      avatarPng: generateAvatarPng("blackjack", [200, 60, 60]),
      bot: true,
    };
  }

  async onNewUser(user: NewUserEvent, ctx: BotContext): Promise<void> {
    console.log(
      `[blackjack] Proactively welcoming new user ${user.displayAddress}`
    );
    const welcomeItem = buildBlackjackWelcomeItem({
      minWagerWei: this.minWagerWei,
      maxWagerWei: this.maxWagerWei,
      rulesSummary: BLACKJACK_RULES_SUMMARY,
    });
    try {
      await ctx.sendDirectMessage(user.address, [welcomeItem]);
    } catch (err) {
      console.warn(
        `[blackjack] Failed to send welcome DM to ${user.displayAddress}:`,
        err
      );
    }
  }

  async onMessage(ctx: BotMessageContext): Promise<void> {
    // Check if any item represents a blackjack action
    const moveItem = ctx.items.find(
      (item: any) => item.type === "blackjack_move" || item.action !== undefined
    ) as any;

    if (!moveItem) {
      // Plain text or greeting: send welcome and instructions
      const welcomeItem = buildBlackjackWelcomeItem({
        minWagerWei: this.minWagerWei,
        maxWagerWei: this.maxWagerWei,
        rulesSummary: BLACKJACK_RULES_SUMMARY,
      });
      await ctx.reply([
        {
          type: "text",
          text: `Welcome to Frank Blackjack! Minimum bet is ${
            Number(this.minWagerWei) / 1e18
          } MON. Send a bet to start a game.`,
        } as any,
        welcomeItem,
      ]);
      return;
    }

    const action = moveItem.action;
    const gameId = String(moveItem.gameId ?? ctx.conversationId);

    if (action === "bet") {
      await this.handleBet(ctx, moveItem, gameId);
    } else if (action === "hit") {
      await this.handleHit(ctx, gameId);
    } else if (action === "stand") {
      await this.handleStand(ctx, gameId);
    } else {
      await ctx.reply([
        {
          type: "text",
          text: `Unknown blackjack action: ${action}. Available actions: bet, hit, stand.`,
        } as any,
      ]);
    }
  }

  private async handleBet(
    ctx: BotMessageContext,
    moveItem: any,
    gameId: string
  ): Promise<void> {
    const wagerTxHash = moveItem.wagerTxHash;
    const declaredWagerWei = BigInt(moveItem.wagerWei ?? this.minWagerWei);

    if (declaredWagerWei < this.minWagerWei) {
      await ctx.reply([
        {
          type: "text",
          text: `Bet rejected: minimum wager is ${
            Number(this.minWagerWei) / 1e18
          } MON`,
        } as any,
      ]);
      return;
    }

    // Generate provably-fair server seed & commitment
    const serverSeed = randomBytes(32).toString("hex");
    const serverCommit = createHash("sha256")
      .update(Buffer.from(serverSeed, "hex"))
      .digest("hex");

    // Derive deterministic deck
    const deckEntropy = wagerTxHash ?? serverCommit;
    const deck = deriveDeck(serverSeed, deckEntropy, 0);
    const initial = dealInitialCards(deck);

    const initialPlayerScore = handValue(initial.playerCards).total;
    const initialDealerScore = handValue(initial.dealerCards).total;

    const isPlayerBlackjack = initialPlayerScore === 21;
    const isDealerBlackjack = initialDealerScore === 21;

    if (isPlayerBlackjack || isDealerBlackjack) {
      // Natural resolution
      let outcome: BlackjackOutcome = "dealer_win";
      if (isPlayerBlackjack && isDealerBlackjack) {
        outcome = "push";
      } else if (isPlayerBlackjack) {
        outcome = "player_blackjack";
      }

      // Record resolved game
      await (ctx as any).state?.putJson?.(`game:${gameId}`, {
        gameId,
        playerAddress: ctx.peerAddress,
        wagerTxHash: deckEntropy,
        wagerWei: declaredWagerWei.toString(),
        serverSeed,
        serverCommit,
        dealtCount: 4,
        playerCards: initial.playerCards,
        dealerCards: initial.dealerCards,
        status: "resolved",
        outcome,
      });

      // If player won or pushed, execute payout via BotContext/BotHost
      let payoutReceiptTx: string | undefined;
      if (outcome === "player_blackjack") {
        const payoutWei = (declaredWagerWei * 5n) / 2n; // 2.5x (3:2 payout)
        try {
          const receipt = await (ctx as any).payout?.(
            ctx.peerAddress,
            payoutWei
          );
          payoutReceiptTx = receipt?.hash;
        } catch (err) {
          console.error("[blackjack] payout error on natural blackjack:", err);
        }
      } else if (outcome === "push") {
        try {
          const receipt = await (ctx as any).payout?.(
            ctx.peerAddress,
            declaredWagerWei
          );
          payoutReceiptTx = receipt?.hash;
        } catch (err) {
          console.error("[blackjack] payout refund error on push:", err);
        }
      }

      await ctx.reply([
        {
          type: "blackjack_move",
          action: "reveal",
          gameId,
          playerCards: initial.playerCards,
          dealerCards: initial.dealerCards,
          serverSeed,
          outcome,
          payoutTxHash: payoutReceiptTx,
          text: `Game over: ${outcome}! Dealer: ${initialDealerScore}, Player: ${initialPlayerScore}.`,
        } as any,
      ]);
      return;
    }

    // Active hand in progress
    const record: ActiveGameRecord = {
      gameId,
      playerAddress: ctx.peerAddress,
      wagerTxHash: deckEntropy,
      wagerWei: declaredWagerWei.toString(),
      serverSeed,
      serverCommit,
      dealtCount: 4,
      playerCards: initial.playerCards,
      dealerCards: initial.dealerCards,
      status: "active",
    };

    await (ctx as any).state?.putJson?.(`game:${gameId}`, record);
    await (ctx as any).state?.put?.(`active:${ctx.peerAddress}`, gameId);

    // Dealer only reveals upcard (first card) to the player during active game
    await ctx.reply([
      {
        type: "blackjack_move",
        action: "deal",
        gameId,
        playerCards: initial.playerCards,
        dealerUpCard: initial.dealerCards[0],
        serverCommit,
        text: `Hand dealt! Your cards: [${initial.playerCards
          .map((c) => c.value)
          .join(", ")}] (Score: ${initialPlayerScore}). Dealer shows: ${
          initial.dealerCards[0].value
        }.`,
      } as any,
    ]);
  }

  private async handleHit(
    ctx: BotMessageContext,
    gameId: string
  ): Promise<void> {
    const activeGameId =
      (await (ctx as any).state?.get?.(`active:${ctx.peerAddress}`)) ?? gameId;
    const game = (await (ctx as any).state?.getJson?.(
      `game:${activeGameId}`
    )) as ActiveGameRecord | undefined;

    if (!game || game.status !== "active") {
      await ctx.reply([
        {
          type: "text",
          text: "No active blackjack game found to hit. Send a bet to start a new hand!",
        } as any,
      ]);
      return;
    }

    const deck = deriveDeck(game.serverSeed, game.wagerTxHash, 0);
    const nextCard = deck[game.dealtCount];
    game.dealtCount += 1;
    game.playerCards.push(nextCard);

    const playerVal = handValue(game.playerCards);

    if (playerVal.isBust) {
      game.status = "resolved";
      game.outcome = "dealer_win";
      await (ctx as any).state?.putJson?.(`game:${game.gameId}`, game);
      await (ctx as any).state?.del?.(`active:${ctx.peerAddress}`);

      await ctx.reply([
        {
          type: "blackjack_move",
          action: "reveal",
          gameId: game.gameId,
          playerCards: game.playerCards,
          dealerCards: game.dealerCards,
          serverSeed: game.serverSeed,
          outcome: "dealer_win",
          text: `Bust! You drew ${nextCard.value} (Score: ${playerVal.total}). Dealer wins!`,
        } as any,
      ]);
      return;
    }

    // Save state and reply with new card
    await (ctx as any).state?.putJson?.(`game:${game.gameId}`, game);
    await ctx.reply([
      {
        type: "blackjack_move",
        action: "hit_result",
        gameId: game.gameId,
        playerCards: game.playerCards,
        drawnCard: nextCard,
        playerScore: playerVal.total,
        text: `Hit: You drew ${nextCard.value}. Current score: ${playerVal.total}. Hit or stand?`,
      } as any,
    ]);
  }

  private async handleStand(
    ctx: BotMessageContext,
    gameId: string
  ): Promise<void> {
    const activeGameId =
      (await (ctx as any).state?.get?.(`active:${ctx.peerAddress}`)) ?? gameId;
    const game = (await (ctx as any).state?.getJson?.(
      `game:${activeGameId}`
    )) as ActiveGameRecord | undefined;

    if (!game || game.status !== "active") {
      await ctx.reply([
        {
          type: "text",
          text: "No active blackjack game found to stand. Send a bet to start a new hand!",
        } as any,
      ]);
      return;
    }

    const deck = deriveDeck(game.serverSeed, game.wagerTxHash, 0);
    // Play out dealer from remaining deck
    const dealerRun = playOutDealer(deck, game.dealerCards, game.dealtCount);
    game.dealerCards = dealerRun.dealerCards;

    const playerVal = handValue(game.playerCards);
    const dealerVal = handValue(game.dealerCards);
    const outcome = resolveOutcome(playerVal, dealerVal);

    game.status = "resolved";
    game.outcome = outcome;
    await (ctx as any).state?.putJson?.(`game:${game.gameId}`, game);
    await (ctx as any).state?.del?.(`active:${ctx.peerAddress}`);

    const wagerWei = BigInt(game.wagerWei);
    let payoutReceiptTx: string | undefined;

    if (outcome === "player_win" || outcome === "player_blackjack") {
      const multiplier = outcome === "player_blackjack" ? 2.5 : 2.0;
      const payoutWei = (wagerWei * BigInt(Math.round(multiplier * 10))) / 10n;
      try {
        const receipt = await (ctx as any).payout?.(ctx.peerAddress, payoutWei);
        payoutReceiptTx = receipt?.hash;
      } catch (err) {
        console.error("[blackjack] stand payout failed:", err);
      }
    } else if (outcome === "push") {
      try {
        const receipt = await (ctx as any).payout?.(ctx.peerAddress, wagerWei);
        payoutReceiptTx = receipt?.hash;
      } catch (err) {
        console.error("[blackjack] push refund failed:", err);
      }
    }

    await ctx.reply([
      {
        type: "blackjack_move",
        action: "reveal",
        gameId: game.gameId,
        playerCards: game.playerCards,
        dealerCards: game.dealerCards,
        serverSeed: game.serverSeed,
        outcome,
        payoutTxHash: payoutReceiptTx,
        text: `Hand complete: ${outcome}! Player: ${playerVal.total}, Dealer: ${dealerVal.total}.`,
      } as any,
    ]);
  }
}
