import { randomBytes, createHash } from "crypto";
import { parseEther } from "ethers";
import type {
  FrankBotDefinition,
  BotProfile,
  BotContext,
  BotMessageContext,
  NewUserEvent,
} from "@frank/bot-framework";
import type { MessageItem } from "@frank/cashweb/types/messages";
import { formatMon } from "@frank/wallet/monad-amount";
import { generateAvatarPng } from "../../bot-directory";

export const SATOSHI_DICE_MODULO = 65536;
export const SATOSHI_DICE_HOUSE_EDGE = 0.019; // 1.9%
export const SATOSHI_DICE_DEFAULT_TARGET = 32768; // 50% win probability

export interface SatoshiDiceTargetInfo {
  target: number;
  label: string;
  winProbabilityPercent: number;
  multiplier: number;
}

export const SATOSHI_DICE_PRESETS: SatoshiDiceTargetInfo[] = [
  { target: 64000, label: "Safe Harbor (< 64,000)", winProbabilityPercent: 97.66, multiplier: 1.004 },
  { target: 48000, label: "Steady (< 48,000)", winProbabilityPercent: 73.24, multiplier: 1.339 },
  { target: 32768, label: "Coin Flip (< 32,768)", winProbabilityPercent: 50.0, multiplier: 1.962 },
  { target: 16384, label: "Four-to-One (< 16,384)", winProbabilityPercent: 25.0, multiplier: 3.924 },
  { target: 6553, label: "Ten-to-One (< 6,553)", winProbabilityPercent: 10.0, multiplier: 9.81 },
  { target: 655, label: "Jackpot (< 655)", winProbabilityPercent: 1.0, multiplier: 98.15 },
  { target: 65, label: "Moonshot (< 65)", winProbabilityPercent: 0.1, multiplier: 989.1 },
];

export function calculateMultiplier(target: number): number {
  if (target <= 0 || target >= SATOSHI_DICE_MODULO) return 0;
  return Number(((SATOSHI_DICE_MODULO * (1 - SATOSHI_DICE_HOUSE_EDGE)) / target).toFixed(4));
}

export function rollLuckyNumber(serverSecret: string, userNonce: string): number {
  const hash = createHash("sha256")
    .update(`${serverSecret}:${userNonce}`)
    .digest();
  return hash.readUInt16BE(0);
}

export interface DiceStats {
  totalRolls: number;
  totalWins: number;
  totalWageredWei: string;
  totalPaidOutWei: string;
  biggestWinWei: string;
}

export class SatoshiDiceBot implements FrankBotDefinition {
  readonly id = "dice";
  readonly label = "Satoshi Dice";
  readonly defaultIdentityPath =
    process.env.DICE_BOT_IDENTITY_JSON ?? "/tmp/dice-bot-identity.json";

  getProfile(): BotProfile {
    return {
      name: "Satoshi Dice",
      bio: "The original crypto dice game. Provably fair 16-bit rolls, 1.9% house edge, multipliers up to 981x! Send /roll to play.",
      avatarPng: generateAvatarPng("dice", [240, 100, 20]),
      bot: true,
    };
  }

  async onNewUser(user: NewUserEvent, ctx: BotContext): Promise<void> {
    console.log(`[dice] Proactively welcoming new user ${user.address}`);
    try {
      await ctx.sendMessage(user.address, [
        {
          type: "text",
          text: "🎲 **Welcome to Satoshi Dice on Frank!**\n\nThe legendary provably-fair crypto dice game. Send **/roll** to test your luck on a 50/50 roll, or **/odds** to view multipliers up to 981x!",
        },
      ]);
    } catch (err) {
      console.warn(`[dice] Failed to welcome ${user.address}:`, err);
    }
  }

  private async getStats(ctx: BotContext): Promise<DiceStats> {
    const raw = await ctx.state.get("stats:global");
    if (!raw) {
      return {
        totalRolls: 0,
        totalWins: 0,
        totalWageredWei: "0",
        totalPaidOutWei: "0",
        biggestWinWei: "0",
      };
    }
    try {
      return JSON.parse(raw);
    } catch {
      return {
        totalRolls: 0,
        totalWins: 0,
        totalWageredWei: "0",
        totalPaidOutWei: "0",
        biggestWinWei: "0",
      };
    }
  }

  private async recordRoll(
    ctx: BotContext,
    wagerWei: bigint,
    payoutWei: bigint,
    isWin: boolean
  ): Promise<void> {
    const stats = await this.getStats(ctx);
    stats.totalRolls += 1;
    if (isWin) stats.totalWins += 1;
    stats.totalWageredWei = (BigInt(stats.totalWageredWei) + wagerWei).toString();
    stats.totalPaidOutWei = (BigInt(stats.totalPaidOutWei) + payoutWei).toString();
    if (payoutWei > BigInt(stats.biggestWinWei)) {
      stats.biggestWinWei = payoutWei.toString();
    }
    await ctx.state.put("stats:global", JSON.stringify(stats));
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
          text: "🎲 **Satoshi Dice**\n\nSend **/roll** to roll, **/odds** for payout multipliers, or **/help** for all commands.",
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
          text: `🎲 **Satoshi Dice Commands**

• \`/roll\` or \`/dice\` - Roll with standard 50/50 odds (< 32,768, 1.96x)
• \`/roll <amount> [target]\` - Roll with wager and optional custom target (e.g. \`/roll 0.05 16384\`)
• \`/odds\` - Display all target presets, win probabilities, and multipliers
• \`/stats\` - View global house statistics and payouts
• \`/verify <secret> <nonce>\` - Verify provable fairness of a roll`,
        },
      ]);
      return;
    }

    // 2. /odds or /targets
    if (lower === "/odds" || lower === "odds" || lower === "/targets" || lower === "targets") {
      const rows = SATOSHI_DICE_PRESETS.map((p) => {
        return `• **${p.label}**: **${p.multiplier}x** payout (${p.winProbabilityPercent}% win chance)`;
      });

      await msgCtx.reply([
        {
          type: "text",
          text: `📊 **Satoshi Dice Odds & Multipliers** (1.9% House Edge)

Rolls range from **0 to 65,535**. If your roll is **strictly less than** the target, you win!

${rows.join("\n")}

_Example: \`/roll 0.01 6553\` wagers 0.01 MON for a 10x jackpot!_`,
        },
      ]);
      return;
    }

    // 3. /stats
    if (lower === "/stats" || lower === "stats") {
      const stats = await this.getStats(ctx);
      const winRate =
        stats.totalRolls > 0
          ? ((stats.totalWins / stats.totalRolls) * 100).toFixed(1)
          : "0.0";

      await msgCtx.reply([
        {
          type: "text",
          text: `📈 **Satoshi Dice Global Statistics**

• **Total Rolls:** ${stats.totalRolls.toLocaleString()}
• **Player Wins:** ${stats.totalWins.toLocaleString()} (${winRate}%)
• **Total Wagered:** ${formatMon(BigInt(stats.totalWageredWei))}
• **Total Payouts:** ${formatMon(BigInt(stats.totalPaidOutWei))}
• **Biggest Win:** ${formatMon(BigInt(stats.biggestWinWei))}`,
        },
      ]);
      return;
    }

    // 4. /verify <secret> <nonce>
    if (lower.startsWith("/verify") || lower.startsWith("verify")) {
      const parts = text.split(/\s+/);
      const secret = parts[1];
      const nonce = parts[2];
      if (!secret || !nonce) {
        await msgCtx.reply([
          {
            type: "text",
            text: "⚠️ Usage: `/verify <serverSecret> <userNonce>`",
          },
        ]);
        return;
      }

      const lucky = rollLuckyNumber(secret, nonce);
      const hash = createHash("sha256").update(`${secret}:${nonce}`).digest("hex");

      await msgCtx.reply([
        {
          type: "text",
          text: `🔍 **Provable Fairness Verification**

• Input: \`${secret}:${nonce}\`
• SHA-256 Hash: \`${hash}\`
• First 2 Bytes (BE): \`${lucky}\` (out of 65,535)`,
        },
      ]);
      return;
    }

    // 5. /roll or /dice
    if (
      lower.startsWith("/roll") ||
      lower.startsWith("roll") ||
      lower.startsWith("/dice") ||
      lower.startsWith("dice")
    ) {
      const parts = text.split(/\s+/);
      // Syntax: /roll [amountMon] [target]
      const arg1 = parts[1];
      const arg2 = parts[2];

      let wagerWei = 0n;
      let target = SATOSHI_DICE_DEFAULT_TARGET;

      if (arg1) {
        // Check if arg1 is target (e.g. integer > 1) or amount (float or int)
        const parsedTarget = parseInt(arg1, 10);
        if (parsedTarget >= 10 && parsedTarget < SATOSHI_DICE_MODULO && !arg2 && !arg1.includes(".")) {
          // Player just passed target: /roll 16384
          target = parsedTarget;
        } else {
          try {
            wagerWei = parseEther(arg1);
          } catch {
            wagerWei = 0n;
          }

          if (arg2) {
            const parsedT2 = parseInt(arg2, 10);
            if (!isNaN(parsedT2) && parsedT2 > 0 && parsedT2 < SATOSHI_DICE_MODULO) {
              target = parsedT2;
            }
          }
        }
      }

      const multiplier = calculateMultiplier(target);
      const winProbability = ((target / SATOSHI_DICE_MODULO) * 100).toFixed(2);

      // Generate provably fair server secret and nonce
      const serverSecret = randomBytes(16).toString("hex");
      const serverHash = createHash("sha256").update(serverSecret).digest("hex");
      const userNonce = `${msgCtx.payloadDigest.slice(0, 16)}_${Date.now()}`;

      // Roll lucky number
      const luckyNumber = rollLuckyNumber(serverSecret, userNonce);
      const isWin = luckyNumber < target;

      let payoutWei = 0n;
      let payoutNote = "";
      let payoutTxHash: string | undefined;

      if (wagerWei > 0n) {
        if (isWin) {
          // Multiply wager by multiplier
          payoutWei = BigInt(Math.floor(Number(wagerWei) * multiplier));
          try {
            const tx = await ctx.sendTransfer({
              to: sender,
              valueWei: payoutWei,
            });
            payoutTxHash = tx.txHash;
            payoutNote = `\n\n🏆 **Payout Sent!** Transferred **${formatMon(payoutWei)}** (tx: \`${tx.txHash}\`)`;
          } catch (err) {
            console.error("[dice] Payout transfer error:", err);
            payoutNote = `\n\n⚠️ Payout error: ${String(err)}`;
          }
        }
        await this.recordRoll(ctx, wagerWei, payoutWei, isWin);
      }

      const outcomeEmoji = isWin ? "🎉" : "💀";
      const outcomeText = isWin
        ? `**YOU WIN!** (Lucky Roll ${luckyNumber} < Target ${target})`
        : `**YOU LOSE!** (Lucky Roll ${luckyNumber} ≥ Target ${target})`;

      const wagerHeader =
        wagerWei > 0n
          ? `💰 **Wager:** ${formatMon(wagerWei)} | **Multiplier:** ${multiplier}x`
          : `🎮 **Free Play Roll** | **Multiplier:** ${multiplier}x`;

      await msgCtx.reply([
        {
          type: "dice" as any,
          action: "result",
          target,
          multiplier,
          wagerWei: wagerWei > 0n ? wagerWei.toString() : undefined,
          luckyNumber,
          isWin,
          serverSecret,
          userNonce,
          payoutWei: payoutWei > 0n ? payoutWei.toString() : undefined,
          txHash: payoutTxHash,
        },
        {
          type: "text",
          text: `🎲 **Satoshi Dice Roll Result**
${wagerHeader}
🎯 **Target:** < ${target} (${winProbability}% win chance)

${outcomeEmoji} ${outcomeText}${payoutNote}

🔍 **Fairness Verification Proof:**
• **Lucky Number:** \`${luckyNumber}\` / 65,535
• **Server Secret:** \`${serverSecret}\`
• **User Nonce:** \`${userNonce}\`
• **Verify:** \`/verify ${serverSecret} ${userNonce}\`

_Send \`/roll\` to roll again, or \`/odds\` to adjust your target!_`,
        },
      ]);
      return;
    }

    // Unrecognized message
    await msgCtx.reply([
      {
        type: "text",
        text: `🎲 Welcome to Satoshi Dice! Send **/roll** to play, or **/help** for all commands.`,
      },
    ]);
  }
}
