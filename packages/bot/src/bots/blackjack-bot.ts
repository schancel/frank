import { randomBytes, createHash } from "crypto";
import type {
  FrankBotDefinition,
  BotProfile,
  BotContext,
  BotMessageContext,
  BotStateStore,
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
  cardLabel,
  sha256Hex,
  type Card,
} from "@frank/wallet/message-item-plugins/blackjack/deck";
import { generateAvatarPng } from "../../bot-directory";
import { welcomeItems } from "../../blackjack-greeter";

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

async function getStoredGame(
  state: BotStateStore,
  key: string
): Promise<ActiveGameRecord | undefined> {
  const val = await state.get(key);
  if (!val) return undefined;
  try {
    return JSON.parse(val);
  } catch {
    return undefined;
  }
}

async function putStoredGame(
  state: BotStateStore,
  key: string,
  game: unknown
): Promise<void> {
  await state.put(key, JSON.stringify(game));
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
      `[blackjack] Proactively challenging new user ${user.address} to blackjack`
    );
    const challengeItems = welcomeItems({
      minWagerWei: this.minWagerWei,
      maxWagerWei: this.maxWagerWei,
      stampValueWei: 10_000_000_000_000_000n,
    });
    try {
      await ctx.sendMessage(user.address, challengeItems);
    } catch (err) {
      console.warn(
        `[blackjack] Failed to send challenge DM to ${user.address}:`,
        err
      );
    }
  }

  async onMessage(msgCtx: BotMessageContext, ctx?: BotContext): Promise<void> {
    const effectiveCtx = ctx ?? (msgCtx as any);

    // Check if any item represents a blackjack action
    const moveItem = msgCtx.items.find(
      (item: any) =>
        item.type === "blackjack-move" ||
        item.type === "blackjack_move" ||
        item.action !== undefined
    ) as any;

    if (!moveItem) {
      // Plain text or greeting: send welcome and instructions
      const welcomeItem = buildBlackjackWelcomeItem({
        minWagerWei: this.minWagerWei,
        maxWagerWei: this.maxWagerWei,
        rulesSummary: BLACKJACK_RULES_SUMMARY,
      });
      await msgCtx.reply([
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
    const gameId = String(moveItem.gameId ?? msgCtx.conversationId);
    console.log(
      `[blackjack] onMessage received: action=${action}, gameId=${gameId}, from=${msgCtx.peerAddress}`
    );

    if (action === "bet") {
      await this.handleBet(msgCtx, effectiveCtx, moveItem, gameId);
    } else if (action === "hit") {
      await this.handleHit(msgCtx, effectiveCtx, gameId);
    } else if (action === "stand") {
      await this.handleStand(msgCtx, effectiveCtx, gameId);
    } else if (action === "deal") {
      await msgCtx.reply([
        {
          type: "text",
          text: `Blackjack: deal is a dealer-only action [game=${JSON.stringify(
            gameId
          )}]`,
        } as any,
      ]);
    } else {
      await msgCtx.reply([
        {
          type: "text",
          text: `Unknown blackjack action: ${action}. Available actions: bet, hit, stand.`,
        } as any,
      ]);
    }
  }

  private async handleBet(
    msgCtx: BotMessageContext,
    ctx: BotContext,
    moveItem: any,
    gameId: string
  ): Promise<void> {
    const wagerTxHash = moveItem.wagerTxHash;
    const declaredWagerWei = BigInt(moveItem.wagerWei ?? this.minWagerWei);
    console.log(
      `[blackjack] handleBet: gameId=${gameId}, wagerTxHash=${wagerTxHash}, declaredWagerWei=${declaredWagerWei}`
    );

    if (declaredWagerWei < this.minWagerWei) {
      await msgCtx.reply([
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
    const serverCommit = sha256Hex(serverSeed);

    // Derive deterministic deck
    const deckEntropy = wagerTxHash ?? serverCommit;
    const deck = deriveDeck(serverSeed, deckEntropy, 0);
    const initial = dealInitialCards(deck);

    const initialPlayerScore = handValue(initial.playerCards).total;
    const initialDealerScore = handValue(initial.dealerCards).total;

    // 1. Always send deal message first so player/client receives their hand
    console.log(
      `[blackjack] Sending deal message for game ${gameId}: player=${initialPlayerScore}, dealerUpCard=${cardLabel(
        initial.dealerCards[0]
      )}`
    );
    await msgCtx.reply([
      {
        type: "blackjack-move",
        action: "deal",
        gameId,
        playerCards: initial.playerCards,
        dealerUpCard: initial.dealerCards[0],
        serverSeedHash: serverCommit,
        serverCommit,
        text: `Hand dealt! Your cards: [${initial.playerCards
          .map((c) => cardLabel(c))
          .join(", ")}] (Score: ${initialPlayerScore}). Dealer shows: ${cardLabel(
          initial.dealerCards[0]
        )}.`,
      } as any,
    ]);

    const isPlayerBlackjack = initialPlayerScore === 21;
    const isDealerBlackjack = initialDealerScore === 21;

    // 2. Check natural blackjack
    if (isPlayerBlackjack || isDealerBlackjack) {
      console.log(
        `[blackjack] Natural blackjack for game ${gameId}: player=${isPlayerBlackjack}, dealer=${isDealerBlackjack}`
      );
      let outcome: BlackjackOutcome = "dealer_win";
      if (isPlayerBlackjack && isDealerBlackjack) {
        outcome = "push";
      } else if (isPlayerBlackjack) {
        outcome = "player_blackjack";
      }

      // Record resolved game
      await putStoredGame(ctx.state, `game:${gameId}`, {
        gameId,
        playerAddress: msgCtx.peerAddress,
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

      // If player won or pushed, execute payout via BotContext
      let payoutReceiptTx: string | undefined;
      if (outcome === "player_blackjack") {
        const payoutWei = (declaredWagerWei * 5n) / 2n; // 2.5x (3:2 payout)
        try {
          const res = await ctx.sendTransfer({
            to: msgCtx.peerAddress,
            valueWei: payoutWei,
          });
          payoutReceiptTx = res.txHash;
        } catch (err) {
          console.error("[blackjack] payout error on natural blackjack:", err);
        }
      } else if (outcome === "push") {
        try {
          const res = await ctx.sendTransfer({
            to: msgCtx.peerAddress,
            valueWei: declaredWagerWei,
          });
          payoutReceiptTx = res.txHash;
        } catch (err) {
          console.error("[blackjack] payout refund error on push:", err);
        }
      }

      await msgCtx.reply([
        {
          type: "blackjack-move",
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
      playerAddress: msgCtx.peerAddress,
      wagerTxHash: deckEntropy,
      wagerWei: declaredWagerWei.toString(),
      serverSeed,
      serverCommit,
      dealtCount: 4,
      playerCards: initial.playerCards,
      dealerCards: initial.dealerCards,
      status: "active",
    };

    await putStoredGame(ctx.state, `game:${gameId}`, record);
    await ctx.state.put(`active:${msgCtx.peerAddress}`, gameId);
  }

  private async handleHit(
    msgCtx: BotMessageContext,
    ctx: BotContext,
    gameId: string
  ): Promise<void> {
    const activeGameId =
      (await ctx.state.get(`active:${msgCtx.peerAddress}`)) ?? gameId;
    const game = await getStoredGame(ctx.state, `game:${activeGameId}`);

    if (!game || game.status !== "active") {
      await msgCtx.reply([
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
      await putStoredGame(ctx.state, `game:${game.gameId}`, game);
      await ctx.state.del(`active:${msgCtx.peerAddress}`);

      await msgCtx.reply([
        {
          type: "blackjack-move",
          action: "reveal",
          gameId: game.gameId,
          playerCards: game.playerCards,
          dealerCards: game.dealerCards,
          serverSeed: game.serverSeed,
          serverSeedHash: game.serverCommit,
          outcome: "dealer_win",
          text: `Bust! You drew ${cardLabel(nextCard)} (Score: ${
            playerVal.total
          }). Dealer wins!`,
        } as any,
      ]);
      return;
    }

    // Save state and reply with new card
    await putStoredGame(ctx.state, `game:${game.gameId}`, game);
    await msgCtx.reply([
      {
        type: "blackjack-move",
        action: "hit_result",
        gameId: game.gameId,
        playerCards: game.playerCards,
        drawnCard: nextCard,
        playerScore: playerVal.total,
        text: `Hit: You drew ${cardLabel(nextCard)}. Current score: ${
          playerVal.total
        }. Hit or stand?`,
      } as any,
    ]);
  }

  private async handleStand(
    msgCtx: BotMessageContext,
    ctx: BotContext,
    gameId: string
  ): Promise<void> {
    const activeGameId =
      (await ctx.state.get(`active:${msgCtx.peerAddress}`)) ?? gameId;
    const game = await getStoredGame(ctx.state, `game:${activeGameId}`);

    if (!game || game.status !== "active") {
      await msgCtx.reply([
        {
          type: "text",
          text: "No active blackjack game found to stand. Send a bet to start a new hand!",
        } as any,
      ]);
      return;
    }

    const deck = deriveDeck(game.serverSeed, game.wagerTxHash, 0);
    // Play out dealer against playerCards
    const dealerRun = playOutDealer(deck, game.playerCards, game.dealtCount);
    game.dealerCards = dealerRun.dealerCards;
    game.dealtCount = dealerRun.dealtCount;
    const outcome = dealerRun.outcome;

    const playerVal = handValue(game.playerCards);
    const dealerVal = handValue(game.dealerCards);

    game.status = "resolved";
    game.outcome = outcome;
    await putStoredGame(ctx.state, `game:${game.gameId}`, game);
    await ctx.state.del(`active:${msgCtx.peerAddress}`);

    const wagerWei = BigInt(game.wagerWei);
    let payoutReceiptTx: string | undefined;

    if (outcome === "player_win" || outcome === "player_blackjack") {
      const multiplier = outcome === "player_blackjack" ? 2.5 : 2.0;
      const payoutWei = (wagerWei * BigInt(Math.round(multiplier * 10))) / 10n;
      try {
        const res = await ctx.sendTransfer({
          to: msgCtx.peerAddress,
          valueWei: payoutWei,
        });
        payoutReceiptTx = res.txHash;
      } catch (err) {
        console.error("[blackjack] stand payout failed:", err);
      }
    } else if (outcome === "push") {
      try {
        const res = await ctx.sendTransfer({
          to: msgCtx.peerAddress,
          valueWei: wagerWei,
        });
        payoutReceiptTx = res.txHash;
      } catch (err) {
        console.error("[blackjack] push refund failed:", err);
      }
    }

    await msgCtx.reply([
      {
        type: "blackjack-move",
        action: "reveal",
        gameId: game.gameId,
        playerCards: game.playerCards,
        dealerCards: game.dealerCards,
        serverSeed: game.serverSeed,
        serverSeedHash: game.serverCommit,
        outcome,
        payoutTxHash: payoutReceiptTx,
        text: `Hand complete: ${outcome}! Player: ${playerVal.total}, Dealer: ${dealerVal.total}.`,
      } as any,
    ]);
  }
}
