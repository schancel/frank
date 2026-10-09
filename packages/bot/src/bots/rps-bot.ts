import { randomBytes, createHash } from "crypto";
import type {
  FrankBotDefinition,
  BotProfile,
  BotContext,
  BotMessageContext,
  NewUserEvent,
} from "@frank/bot-framework";
import { GAME_MAX_REPLIES_PER_PEER } from "@frank/bot-framework";
import type { MessageItem } from "@frank/cashweb/types/messages";
import { formatMon, parseMon } from "@frank/wallet/monad-amount";
import { ACCOUNT_TYPE_BOT, BOT_ROLE_GAME } from "@frank/codec";
import { generateAvatarPng } from "../../bot-directory";

export type RpsMove = "rock" | "paper" | "scissors";

export interface RpsSinglePlayerMatch {
  commitHash: string;
  botMove: RpsMove;
  salt: string;
  wagerWei?: string;
  wagerTxHash?: string;
  timestampMs: number;
}

export interface RpsP2PChallenge {
  challengeId: string;
  creator: string;
  opponent: string;
  wagerWei: string;
  status: "pending" | "accepted" | "resolved" | "cancelled";
  creatorMove?: RpsMove;
  opponentMove?: RpsMove;
  winner?: string | "tie";
  timestampMs: number;
}

export function evaluateRps(player: RpsMove, bot: RpsMove): "win" | "lose" | "tie" {
  if (player === bot) return "tie";
  if (
    (player === "rock" && bot === "scissors") ||
    (player === "paper" && bot === "rock") ||
    (player === "scissors" && bot === "paper")
  ) {
    return "win";
  }
  return "lose";
}

export function moveEmoji(move: RpsMove): string {
  switch (move) {
    case "rock":
      return "🪨 Rock";
    case "paper":
      return "📄 Paper";
    case "scissors":
      return "✂️ Scissors";
  }
}

export class RpsBot implements FrankBotDefinition {
  readonly id = "rps";
  /** A game is many replies to one player: see `GAME_MAX_REPLIES_PER_PEER`. */
  readonly maxRepliesPerPeer = GAME_MAX_REPLIES_PER_PEER;
  readonly label = "RPS Arena";
  readonly defaultIdentityPath =
    process.env.RPS_BOT_IDENTITY_JSON ?? "/tmp/rps-bot-identity.json";

  getProfile(): BotProfile {
    return {
      name: "RPS Arena",
      bio: "Provably-fair Rock-Paper-Scissors! Play against the bot or challenge other players.",
      avatarPng: generateAvatarPng("rps", [220, 80, 50]),
      bot: true,
      accountType: ACCOUNT_TYPE_BOT,
      botRole: BOT_ROLE_GAME,
    };
  }

  async onNewUser(user: NewUserEvent, ctx: BotContext): Promise<void> {
    console.log(`[rps] Proactively challenging new user ${user.address}`);
    try {
      await ctx.sendMessage(user.address, [
        {
          type: "text",
          text: "🎮 Welcome to Frank! I am the RPS Arena bot. Challenge me to provably fair Rock-Paper-Scissors by sending /rps, or /help to see all game modes!",
        },
      ]);
    } catch (err) {
      console.warn(`[rps] Failed to welcome ${user.address}:`, err);
    }
  }

  private generateCommitment(): { move: RpsMove; salt: string; hash: string } {
    const moves: RpsMove[] = ["rock", "paper", "scissors"];
    const move = moves[Math.floor(Math.random() * moves.length)];
    const salt = randomBytes(16).toString("hex");
    const hash = createHash("sha256").update(`${move}:${salt}`).digest("hex");
    return { move, salt, hash };
  }

  async onMessage(msgCtx: BotMessageContext, ctx: BotContext): Promise<void> {
    const textItems = msgCtx.items.filter((item: any) => item.type === "text") as Array<{
      type: "text";
      text: string;
    }>;
    const text = textItems.map((it) => it.text).join("\n").trim();
    const sender = msgCtx.peerAddress.toLowerCase();

    if (!text) {
      await msgCtx.reply([
        {
          type: "text",
          text: "🎮 Welcome to RPS Arena! Send `/rps` to start a match, or `/help` for instructions.",
        },
      ]);
      return;
    }

    const lower = text.toLowerCase();

    // 1. /help
    if (lower === "/help" || lower === "help") {
      await msgCtx.reply([
        {
          type: "text",
          text: `🎮 **RPS Arena Commands**

• \`/rps\` or \`/play\` - Start a new match against the bot (bot commits first!)
• \`/rock\`, \`/paper\`, \`/scissors\` - Make your move in an active match
• \`/challenge <address> [amount]\` - Challenge another user to P2P RPS
• \`/accept <id>\` - Accept a pending challenge
• \`/rules\` - Learn about provable fairness & rules`,
        },
      ]);
      return;
    }

    // 2. /rules
    if (lower === "/rules" || lower === "rules") {
      await msgCtx.reply([
        {
          type: "text",
          text: `⚖️ **Provable Fairness in RPS Arena**

1. When you start a match, the bot picks its move secretly and hashes it: \`SHA256(botMove:salt)\`.
2. The hash commitment is sent to you before you pick your move, guaranteeing the bot cannot change its choice.
3. After you choose, the bot reveals its move and the secret salt.
4. You can independently verify that \`SHA256(revealedMove:salt)\` matches the initial commitment hash!`,
        },
      ]);
      return;
    }

    // 3. /rps or /play - Start single-player match against the bot
    if (lower === "/rps" || lower === "rps" || lower === "/play" || lower === "play" || lower.startsWith("/rps ") || lower.startsWith("/play ")) {
      const parts = text.split(/\s+/);
      const wagerMonStr = parts[1];
      let wagerWei: string | undefined;

      if (wagerMonStr && !isNaN(parseFloat(wagerMonStr))) {
        try {
          wagerWei = parseMon(wagerMonStr).toString();
        } catch {
          // ignore invalid wager string
        }
      }

      const { move, salt, hash } = this.generateCommitment();
      const match: RpsSinglePlayerMatch = {
        commitHash: hash,
        botMove: move,
        salt,
        wagerWei,
        timestampMs: Date.now(),
      };

      await ctx.state.put(`rps:match:${sender}`, JSON.stringify(match));

      const wagerNote = wagerWei ? `\n💰 **Wager**: ${formatMon(BigInt(wagerWei))} MON` : "";

      await msgCtx.reply([
        {
          type: "rps" as any,
          action: "start",
          commitHash: hash,
          wagerWei,
        },
        {
          type: "text",
          text: `🎮 **Rock-Paper-Scissors Match Started!**${wagerNote}

🔐 **Cryptographic Commitment**:
\`0x${hash}\`
_(I have committed my secret move. I cannot change it!)_

👉 **Make your move:**
Reply **/rock**, **/paper**, or **/scissors**!`,
        },
      ]);
      return;
    }

    // 4. Player Move: /rock, /paper, /scissors
    const moveMatch = lower.match(/^\/?(rock|paper|scissors)$/);
    if (moveMatch) {
      const playerMove = moveMatch[1] as RpsMove;
      const rawMatch = await ctx.state.get(`rps:match:${sender}`);

      let match: RpsSinglePlayerMatch;
      if (rawMatch) {
        match = JSON.parse(rawMatch);
      } else {
        // Auto-start match if none was active
        const generated = this.generateCommitment();
        match = {
          commitHash: generated.hash,
          botMove: generated.move,
          salt: generated.salt,
          timestampMs: Date.now(),
        };
      }

      // Delete active match so it cannot be replayed
      await ctx.state.del(`rps:match:${sender}`);

      const outcome = evaluateRps(playerMove, match.botMove);

      let outcomeHeadline = "";
      if (outcome === "win") {
        outcomeHeadline = "🎉 **YOU WIN!** Congratulations!";
      } else if (outcome === "lose") {
        outcomeHeadline = "💀 **I WIN!** Better luck next time!";
      } else {
        outcomeHeadline = "🤝 **IT'S A TIE!** Great minds think alike!";
      }

      let payoutNote = "";
      let payoutTxHash: string | undefined;

      if (match.wagerWei && outcome === "win") {
        const winAmountWei = BigInt(match.wagerWei) * 2n;
        try {
          const tx = await ctx.sendTransfer({
            to: sender,
            valueWei: winAmountWei,
          });
          payoutTxHash = tx.txHash;
          payoutNote = `\n\n🏆 **Payout Sent!** Transferred ${formatMon(winAmountWei)} MON (tx: \`${tx.txHash}\`)`;
        } catch (err) {
          console.error("[rps] Error sending payout transfer:", err);
          payoutNote = `\n\n⚠️ Payout transfer error: ${String(err)}`;
        }
      } else if (match.wagerWei && outcome === "tie") {
        const refundWei = BigInt(match.wagerWei);
        try {
          const tx = await ctx.sendTransfer({
            to: sender,
            valueWei: refundWei,
          });
          payoutTxHash = tx.txHash;
          payoutNote = `\n\n↩️ **Wager Refunded:** Returned ${formatMon(refundWei)} MON (tx: \`${tx.txHash}\`)`;
        } catch {
          // ignore
        }
      }

      await msgCtx.reply([
        {
          type: "rps" as any,
          action: "resolve",
          commitHash: match.commitHash,
          botMove: match.botMove,
          playerMove,
          secretSalt: match.salt,
          wagerWei: match.wagerWei,
          outcome,
          txHash: payoutTxHash,
        },
        {
          type: "text",
          text: `🧑 You chose: ${moveEmoji(playerMove)}
🤖 I chose: ${moveEmoji(match.botMove)}

${outcomeHeadline}${payoutNote}

🔍 **Fairness Verification:**
• Commitment: \`0x${match.commitHash}\`
• Secret Salt: \`${match.salt}\`
• Proof: \`SHA256("${match.botMove}:${match.salt}")\` matches!

_Send \`/rps\` to play again!_`,
        },
      ]);
      return;
    }

    // 5. /challenge <address> [amount] - P2P Matchmaking
    if (lower.startsWith("/challenge") || lower.startsWith("challenge")) {
      const parts = text.split(/\s+/);
      const targetPeer = parts[1]?.trim()?.toLowerCase();
      const wagerMon = parts[2]?.trim() ?? "0";

      if (!targetPeer || !targetPeer.startsWith("0x")) {
        await msgCtx.reply([
          {
            type: "text",
            text: "⚠️ Usage: `/challenge <0xAddress> [wagerMon]`",
          },
        ]);
        return;
      }

      const challengeId = randomBytes(8).toString("hex");
      let wagerWei = "0";
      try {
        if (wagerMon && wagerMon !== "0") {
          wagerWei = parseMon(wagerMon).toString();
        }
      } catch {
        wagerWei = "0";
      }

      const challenge: RpsP2PChallenge = {
        challengeId,
        creator: sender,
        opponent: targetPeer,
        wagerWei,
        status: "pending",
        timestampMs: Date.now(),
      };

      await ctx.state.put(`rps:challenge:${challengeId}`, JSON.stringify(challenge));

      // Notify opponent
      try {
        await ctx.sendMessage(targetPeer, [
          {
            type: "text",
            text: `⚔️ **New RPS Challenge!**
**${sender.slice(0, 6)}...${sender.slice(-4)}** challenged you to Rock-Paper-Scissors!
${wagerWei !== "0" ? `💰 **Wager**: ${formatMon(BigInt(wagerWei))} MON\n` : ""}
To accept, reply:
\`/accept ${challengeId}\``,
          },
        ]);
      } catch (err) {
        console.warn(`[rps] Could not notify opponent ${targetPeer}:`, err);
      }

      await msgCtx.reply([
        {
          type: "text",
          text: `✅ **Challenge created!** (ID: \`${challengeId}\`)
Waiting for ${targetPeer.slice(0, 6)}...${targetPeer.slice(-4)} to accept.`,
        },
      ]);
      return;
    }

    // 6. /accept <challengeId>
    if (lower.startsWith("/accept") || lower.startsWith("accept")) {
      const parts = text.split(/\s+/);
      const challengeId = parts[1]?.trim();
      if (!challengeId) {
        await msgCtx.reply([
          {
            type: "text",
            text: "⚠️ Usage: `/accept <challengeId>`",
          },
        ]);
        return;
      }

      const raw = await ctx.state.get(`rps:challenge:${challengeId}`);
      if (!raw) {
        await msgCtx.reply([
          {
            type: "text",
            text: "⚠️ Challenge not found or already completed.",
          },
        ]);
        return;
      }

      const challenge: RpsP2PChallenge = JSON.parse(raw);
      if (challenge.opponent !== sender) {
        await msgCtx.reply([
          {
            type: "text",
            text: "⚠️ This challenge was not sent to you.",
          },
        ]);
        return;
      }

      challenge.status = "accepted";
      await ctx.state.put(`rps:challenge:${challengeId}`, JSON.stringify(challenge));

      // Notify creator
      try {
        await ctx.sendMessage(challenge.creator, [
          {
            type: "text",
            text: `⚔️ **Challenge #${challengeId} Accepted!**
${sender.slice(0, 6)}...${sender.slice(-4)} accepted your challenge!
Reply with: \`/move ${challengeId} rock\` (or paper/scissors) to lock in your move.`,
          },
        ]);
      } catch {
        // ignore
      }

      await msgCtx.reply([
        {
          type: "text",
          text: `🎉 **Challenge #${challengeId} Accepted!**
Now send your secret move:
\`/move ${challengeId} rock\` (or paper/scissors)`,
        },
      ]);
      return;
    }

    // 7. /move <challengeId> <rock|paper|scissors>
    if (lower.startsWith("/move") || lower.startsWith("move")) {
      const parts = text.split(/\s+/);
      const challengeId = parts[1]?.trim();
      const move = parts[2]?.trim()?.toLowerCase() as RpsMove;

      if (!challengeId || !["rock", "paper", "scissors"].includes(move)) {
        await msgCtx.reply([
          {
            type: "text",
            text: "⚠️ Usage: `/move <challengeId> <rock|paper|scissors>`",
          },
        ]);
        return;
      }

      const raw = await ctx.state.get(`rps:challenge:${challengeId}`);
      if (!raw) {
        await msgCtx.reply([
          {
            type: "text",
            text: "⚠️ Challenge not found.",
          },
        ]);
        return;
      }

      const challenge: RpsP2PChallenge = JSON.parse(raw);
      if (challenge.creator !== sender && challenge.opponent !== sender) {
        await msgCtx.reply([
          {
            type: "text",
            text: "⚠️ You are not a player in this challenge.",
          },
        ]);
        return;
      }

      if (sender === challenge.creator) {
        challenge.creatorMove = move;
      } else {
        challenge.opponentMove = move;
      }

      if (challenge.creatorMove && challenge.opponentMove) {
        // Both moved! Resolve outcome
        challenge.status = "resolved";
        const outcome = evaluateRps(challenge.creatorMove, challenge.opponentMove);
        if (outcome === "win") {
          challenge.winner = challenge.creator;
        } else if (outcome === "lose") {
          challenge.winner = challenge.opponent;
        } else {
          challenge.winner = "tie";
        }

        await ctx.state.put(`rps:challenge:${challengeId}`, JSON.stringify(challenge));

        const resultText = `🏁 **P2P Match Resolved!** (Challenge #${challengeId})

Player 1 (${challenge.creator.slice(0, 6)}...): ${moveEmoji(challenge.creatorMove)}
Player 2 (${challenge.opponent.slice(0, 6)}...): ${moveEmoji(challenge.opponentMove)}

${
  challenge.winner === "tie"
    ? "🤝 **IT'S A DRAW!**"
    : `🏆 **WINNER: ${challenge.winner.slice(0, 6)}...${challenge.winner.slice(-4)}**!`
}`;

        // Send to both players
        try {
          await ctx.sendMessage(challenge.creator, [{ type: "text", text: resultText }]);
          await ctx.sendMessage(challenge.opponent, [{ type: "text", text: resultText }]);
        } catch {
          // ignore
        }
        return;
      }

      await ctx.state.put(`rps:challenge:${challengeId}`, JSON.stringify(challenge));
      await msgCtx.reply([
        {
          type: "text",
          text: `🔒 Move locked in! Waiting for the other player to submit their move.`,
        },
      ]);
      return;
    }

    // Default response for unhandled message
    await msgCtx.reply([
      {
        type: "text",
        text: `👋 RPS Arena here! Send \`/rps\` to play against the bot, or \`/help\` for commands.`,
      },
    ]);
  }
}
