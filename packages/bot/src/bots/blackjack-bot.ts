import { randomBytes, createHash } from "crypto";
import type {
  FrankBotDefinition,
  BotProfile,
  BotContext,
  BotMessageContext,
  BotStateStore,
  NewUserEvent,
} from "@frank/bot-framework";
import { GAME_MAX_REPLIES_PER_PEER } from "@frank/bot-framework";
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
import { CANONICAL_EVM_CONTRACTS } from "@frank/wallet/chain/chains-registry";
import { encodeStateChannelCloseCall } from "@frank/wallet/game-escrow";
import { generateAvatarPng } from "../../bot-directory";
import { ACCOUNT_TYPE_BOT, BOT_ROLE_GAME } from "@frank/codec";
import {
  buildChallenge,
  buildAccept,
  dealerStep,
  applyHandEvent,
  foldHand,
  DEALER_COVER_MULTIPLE,
  type HandEvent,
  type HandItem,
  type HandState,
} from "@frank/wallet/message-item-plugins/blackjack/hand";

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
  channelId?: string;
  sig0?: string;
  sig1?: string;
  seq?: number;
}

function normalizeEvmAddress(addr: string): string {
  if (/^0x[0-9a-fA-F]{40}$/.test(addr)) return addr;
  const clean = addr.startsWith("0x") ? addr.slice(2) : addr;
  const hex = Buffer.from(clean, "utf8").toString("hex");
  return "0x" + hex.padStart(40, "0").slice(-40);
}

function serializeEvents(events: HandEvent[]): string {
  return JSON.stringify(events, (_key, val) =>
    typeof val === "bigint" ? val.toString() : val
  );
}

function deserializeEvents(raw?: string | null): HandEvent[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((e: any) => ({
      ...e,
      stampWei: BigInt(e.stampWei ?? 0),
    }));
  } catch {
    return [];
  }
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
  /** A game is many replies to one player: see `GAME_MAX_REPLIES_PER_PEER`. */
  readonly maxRepliesPerPeer = GAME_MAX_REPLIES_PER_PEER;
  readonly label = "Blackjack Dealer";
  readonly defaultIdentityPath =
    process.env.BLACKJACK_BOT_IDENTITY_JSON ??
    "/tmp/blackjack-bot-identity.json";

  private readonly minWagerWei: bigint;
  private readonly maxWagerWei: bigint;

  private async settleChannelOrDirect(
    gameId: string,
    playerAddress: string,
    wagerWei: bigint,
    outcome: BlackjackOutcome,
    record?: any,
    ctx?: BotContext
  ): Promise<string | undefined> {
    const channelId = record?.channelId ?? record?.escrowChannelId;
    if (!channelId || !ctx?.sendTransaction) return undefined;

    const dealerAddress = ctx.address
      ? normalizeEvmAddress(ctx.address)
      : normalizeEvmAddress("0x0000000000000000000000000000000000000001");
    const normPlayer = normalizeEvmAddress(playerAddress);
    const totalPot = wagerWei * 2n;

    let balances: [bigint, bigint];
    let payout0: string = dealerAddress;
    let payout1: string = normPlayer;

    if (outcome === "dealer_win") {
      balances = [totalPot, 0n];
    } else if (outcome === "player_win" || outcome === "player_blackjack") {
      const payoutWei =
        outcome === "player_blackjack" ? (wagerWei * 5n) / 2n : totalPot;
      balances = [0n, payoutWei];
    } else {
      balances = [wagerWei, wagerWei];
    }

    try {
      const callData = encodeStateChannelCloseCall({
        channelId,
        seq: record?.seq ?? 1,
        balances,
        payout0,
        payout1,
        sig0: record?.sig0 ?? "0x",
        sig1: record?.sig1 ?? "0x",
      });
      const stateChannelAddress = CANONICAL_EVM_CONTRACTS.stateChannel!;
      const res = await ctx.sendTransaction({
        to: stateChannelAddress,
        data: callData,
      });
      return res.txHash;
    } catch (err) {
      console.error(
        `[blackjack] StateChannel settlement error for game ${gameId}:`,
        err
      );
      return undefined;
    }
  }

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
      accountType: ACCOUNT_TYPE_BOT,
      botRole: BOT_ROLE_GAME,
    };
  }

  async onNewUser(user: NewUserEvent, ctx: BotContext): Promise<void> {
    console.log(
      `[blackjack] Proactively challenging new user ${user.address} to blackjack`
    );
    try {
      const bal = await ctx.getBalance().catch(() => 200_000_000_000_000_000n);
      const reserveWei = 20_000_000_000_000_000n;
      const free = bal > reserveWei ? bal - reserveWei : 0n;
      const dealerMax = free / DEALER_COVER_MULTIPLE;
      const maxBet =
        dealerMax > this.maxWagerWei
          ? this.maxWagerWei
          : dealerMax >= this.minWagerWei
          ? dealerMax
          : this.minWagerWei;
      const gameId = randomBytes(16).toString("hex");
      const seed = randomBytes(32).toString("hex");
      await ctx.state.put(`seed:${gameId}`, seed);
      await ctx.state.put(`active:${user.address}`, gameId);

      const built = buildChallenge({
        gameId,
        role: "dealer",
        maxBetWei: maxBet,
        spendableWei:
          bal > reserveWei ? bal : maxBet * DEALER_COVER_MULTIPLE + reserveWei,
        reserveWei,
        seed,
      });

      if ("item" in built) {
        const welcomeDM = [
          built.item,
          {
            type: "text",
            text: `Welcome to the blackjack table! Table limits: ${
              Number(this.minWagerWei) / 1e18
            } MON to ${Number(maxBet) / 1e18} MON per hand. Enter your bet and click Bet above to play!`,
          },
        ];
        const res = await ctx.sendMessage(user.address, welcomeDM as any);
        if (res) {
          const event: HandEvent = {
            item: built.item,
            from: ctx.address,
            to: user.address,
            stampWei: res.stampValueWei ?? 0n,
            digest: res.payloadDigest,
          };
          await ctx.state.put(`events:${gameId}`, serializeEvents([event]));
        }
      }
    } catch (err) {
      console.warn(
        `[blackjack] Failed to send challenge DM to ${user.address}:`,
        err
      );
    }
  }

  async onMessage(msgCtx: BotMessageContext, ctx?: BotContext): Promise<void> {
    const effectiveCtx = ctx ?? (msgCtx as any);

    // 1. Check for modern peer-to-peer blackjack hand item
    const handItem = msgCtx.items.find(
      (item: any) => item.type === "blackjack-hand"
    ) as HandItem | undefined;

    if (handItem) {
      await this.handleP2pHand(msgCtx, effectiveCtx, handItem);
      return;
    }

    // 2. Check for legacy blackjack-move item
    const moveItem = msgCtx.items.find(
      (item: any) =>
        item.type === "blackjack-move" ||
        item.type === "blackjack_move" ||
        item.action !== undefined
    ) as any;

    if (moveItem) {
      const action = moveItem.action;
      const gameId = String(moveItem.gameId ?? msgCtx.conversationId);
      console.log(
        `[blackjack] onMessage received legacy move: action=${action}, gameId=${gameId}, from=${msgCtx.peerAddress}`
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
      return;
    }

    // 3. Plain text or greeting / question (e.g. "How do I challenge?")
    await this.issueChallenge(msgCtx, effectiveCtx);
  }

  private async issueChallenge(
    msgCtx: BotMessageContext,
    ctx: BotContext
  ): Promise<void> {
    const bal = await ctx.getBalance().catch(() => 200_000_000_000_000_000n);
    const reserveWei = 20_000_000_000_000_000n;
    const free = bal > reserveWei ? bal - reserveWei : 0n;
    const dealerMax = free / DEALER_COVER_MULTIPLE;
    const maxBet =
      dealerMax > this.maxWagerWei
        ? this.maxWagerWei
        : dealerMax >= this.minWagerWei
        ? dealerMax
        : this.minWagerWei;
    const gameId = randomBytes(16).toString("hex");
    const seed = randomBytes(32).toString("hex");
    await ctx.state.put(`seed:${gameId}`, seed);
    await ctx.state.put(`active:${msgCtx.peerAddress}`, gameId);

    const built = buildChallenge({
      gameId,
      role: "dealer",
      maxBetWei: maxBet,
      spendableWei:
        bal > reserveWei ? bal : maxBet * DEALER_COVER_MULTIPLE + reserveWei,
      reserveWei,
      seed,
    });

    if ("item" in built) {
      const replyItems = [
        built.item,
        {
          type: "text",
          text: `Here is a fresh blackjack challenge! Enter your bet amount above and click "Bet" to start playing (Table limits: ${
            Number(this.minWagerWei) / 1e18
          } MON - ${
            Number(maxBet) / 1e18
          } MON). You can also challenge me anytime by clicking the 🎲 casino icon in the chat bar!`,
        },
      ];
      const sendRes = await msgCtx.reply(replyItems as any);
      if (sendRes) {
        const event: HandEvent = {
          item: built.item,
          from: ctx.address,
          to: msgCtx.peerAddress,
          stampWei: sendRes.stampValueWei ?? 0n,
          digest: sendRes.payloadDigest,
        };
        await ctx.state.put(`events:${gameId}`, serializeEvents([event]));
      }
    }
  }

  private async handleP2pHand(
    msgCtx: BotMessageContext,
    ctx: BotContext,
    handItem: HandItem
  ): Promise<void> {
    const gameId = handItem.gameId;
    const eventsKey = `events:${gameId}`;
    const rawEvents = await ctx.state.get(eventsKey);
    const events: HandEvent[] = deserializeEvents(rawEvents);

    const incomingEvent: HandEvent = {
      item: handItem,
      from: msgCtx.peerAddress,
      to: ctx.address,
      stampWei: msgCtx.stampValueWei,
      digest: msgCtx.payloadDigest,
    };
    events.push(incomingEvent);

    const { state } = foldHand(events);

    if (handItem.action === "challenge") {
      let seed = await ctx.state.get(`seed:${gameId}`);
      if (!seed) {
        seed = randomBytes(32).toString("hex");
        await ctx.state.put(`seed:${gameId}`, seed);
      }
      await ctx.state.put(`active:${msgCtx.peerAddress}`, gameId);

      if (state) {
        const bal = await ctx.getBalance().catch(() => 200_000_000_000_000_000n);
        const reserveWei = 20_000_000_000_000_000n;
        const free = bal > reserveWei ? bal - reserveWei : 0n;
        const dealerMax = free / DEALER_COVER_MULTIPLE;
        const wanted =
          state.maxBetWei < dealerMax
            ? state.maxBetWei
            : dealerMax > 0n
            ? dealerMax
            : this.minWagerWei;

        const built = buildAccept({
          state,
          spendableWei:
            bal > reserveWei ? bal : wanted * DEALER_COVER_MULTIPLE + reserveWei,
          reserveWei,
          seed,
          wantedMaxBetWei: wanted,
        });

        if ("item" in built) {
          const sendRes = await msgCtx.reply([
            built.item,
            {
              type: "text",
              text: `Challenge accepted! Max bet: ${
                Number(wanted) / 1e18
              } MON. Enter your bet and click Bet to begin!`,
            },
          ] as any);
          if (sendRes) {
            events.push({
              item: built.item,
              from: ctx.address,
              to: msgCtx.peerAddress,
              stampWei: sendRes.stampValueWei ?? 0n,
              digest: sendRes.payloadDigest,
            });
            await ctx.state.put(eventsKey, serializeEvents(events));
          }
        }
      }
      return;
    }

    // Move actions: bet, hit, stand, double
    let seed = await ctx.state.get(`seed:${gameId}`);
    if (!seed) {
      console.error(`[blackjack] Missing seed for game ${gameId}`);
      return;
    }

    const step = dealerStep(state, seed);
    if (!step) {
      console.warn(
        `[blackjack] dealerStep returned undefined for game ${gameId}, phase=${state?.phase}`
      );
      await ctx.state.put(eventsKey, serializeEvents(events));
      return;
    }

    let text = "";
    if (step.item.action === "deal") {
      text = "Cards dealt! Your turn: Hit, Stand, or Double.";
    } else if (step.item.action === "card") {
      text = "Card dealt. Hit or Stand?";
    } else if (step.item.action === "reveal") {
      const outcome = state?.outcome ?? "resolved";
      text = `Game over: ${outcome}!`;
    } else if (step.item.action === "refund") {
      text = "Bet refunded.";
    }

    const replyItems: any[] = [step.item];
    if (text) {
      replyItems.push({ type: "text", text });
    }

    const sendRes = await msgCtx.reply(replyItems, {
      stampValueWei: step.payWei,
    });

    if (sendRes) {
      events.push({
        item: step.item,
        from: ctx.address,
        to: msgCtx.peerAddress,
        stampWei: sendRes.stampValueWei ?? step.payWei ?? 0n,
        digest: sendRes.payloadDigest,
      });
      await ctx.state.put(eventsKey, serializeEvents(events));
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
        channelId: moveItem.channelId ?? moveItem.escrowChannelId,
        sig0: moveItem.sig0,
        sig1: moveItem.sig1,
        seq: moveItem.seq,
      });

      // If player won or pushed, execute payout via BotContext
      let payoutReceiptTx = await this.settleChannelOrDirect(
        gameId,
        msgCtx.peerAddress,
        declaredWagerWei,
        outcome,
        moveItem,
        ctx
      );

      if (!payoutReceiptTx) {
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
      channelId: moveItem.channelId ?? moveItem.escrowChannelId,
      sig0: moveItem.sig0,
      sig1: moveItem.sig1,
      seq: moveItem.seq,
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

    if (playerVal.bust) {
      game.status = "resolved";
      game.outcome = "dealer_win";
      await putStoredGame(ctx.state, `game:${game.gameId}`, game);
      await ctx.state.del(`active:${msgCtx.peerAddress}`);

      const payoutReceiptTx = await this.settleChannelOrDirect(
        game.gameId,
        msgCtx.peerAddress,
        BigInt(game.wagerWei),
        "dealer_win",
        game,
        ctx
      );

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
          payoutTxHash: payoutReceiptTx,
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
    let payoutReceiptTx = await this.settleChannelOrDirect(
      game.gameId,
      msgCtx.peerAddress,
      wagerWei,
      outcome,
      game,
      ctx
    );

    if (!payoutReceiptTx) {
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
