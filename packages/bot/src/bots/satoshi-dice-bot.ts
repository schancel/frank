import { randomBytes, createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import { parseEther } from "ethers";
import type {
  FrankBotDefinition,
  BotProfile,
  BotContext,
  BotMessageContext,
  NewUserEvent,
} from "@frank/bot-framework";
import { GAME_MAX_REPLIES_PER_PEER } from "@frank/bot-framework";
import type { MessageItem } from "@frank/cashweb/types/messages";
import { formatMon } from "@frank/wallet/monad-amount";
import {
  addressFromCompressedPubkey,
  channelStateDigest,
  decodeDiceGamePayload,
  encodeDiceGamePayload,
  fromHex,
  isChannelUpdateItemFrame,
  projectChannelUpdateItem,
  toHex,
  validateChannelSequence,
  validateChannelTransition,
  verifyChannelSignature,
  verifyChannelSignatures,
  type CanonicalChannelUpdateItem,
  type CanonicalChainAllocation,
  type CanonicalParticipantBalance,
  type CanonicalSignatureEntry,
  type DiceGamePayload,
  ACCOUNT_TYPE_BOT,
  BOT_ROLE_GAME,
} from "@frank/codec";
import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { generateAvatarPng } from "../../bot-directory";

function uint8ArrayToBigInt(bytes: Uint8Array): bigint {
  let val = 0n;
  for (const b of bytes) {
    val = (val << 8n) | BigInt(b);
  }
  return val;
}

function parseBalanceToBigInt(val: string | number | bigint): bigint {
  if (typeof val === "bigint") return val;
  if (typeof val === "number") return BigInt(val);
  if (typeof val === "string") {
    const clean = val.startsWith("0x") ? val.slice(2) : val;
    if (val.startsWith("0x")) {
      return BigInt("0x" + clean);
    }
    return BigInt(clean);
  }
  return 0n;
}

export interface SatoshiDiceBotOptions {
  signerPrivateKey?: Uint8Array | string;
  luckyNumberOverride?: number;
}

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
  /** A game is many replies to one player: see `GAME_MAX_REPLIES_PER_PEER`. */
  readonly maxRepliesPerPeer = GAME_MAX_REPLIES_PER_PEER;
  readonly label = "Satoshi Dice";
  readonly defaultIdentityPath =
    process.env.DICE_BOT_IDENTITY_JSON ?? "/tmp/dice-bot-identity.json";

  private signerPrivateKey?: Uint8Array;
  private signerPublicKey?: Uint8Array;
  private luckyNumberOverride?: number;

  constructor(options?: SatoshiDiceBotOptions) {
    if (options?.signerPrivateKey) {
      this.setSignerKey(options.signerPrivateKey);
    }
    if (options?.luckyNumberOverride !== undefined) {
      this.luckyNumberOverride = options.luckyNumberOverride;
    }
  }

  setSignerKey(privKey: Uint8Array | string): void {
    const bytes =
      typeof privKey === "string"
        ? fromHex(privKey.startsWith("0x") ? privKey.slice(2) : privKey)
        : privKey;
    if (bytes.length !== 32) {
      throw new Error("Private key must be 32 bytes");
    }
    this.signerPrivateKey = bytes;
    this.signerPublicKey = secp256k1.getPublicKey(bytes, true);
  }

  setLuckyNumberOverride(num?: number): void {
    this.luckyNumberOverride = num;
  }

  getSignerKey(ctx?: BotContext): { privateKey: Uint8Array; publicKey: Uint8Array } {
    if (this.signerPrivateKey && this.signerPublicKey) {
      return { privateKey: this.signerPrivateKey, publicKey: this.signerPublicKey };
    }
    if (process.env.DICE_BOT_PRIVATE_KEY) {
      this.setSignerKey(process.env.DICE_BOT_PRIVATE_KEY);
      return { privateKey: this.signerPrivateKey!, publicKey: this.signerPublicKey! };
    }
    if (this.defaultIdentityPath && existsSync(this.defaultIdentityPath)) {
      try {
        const raw = JSON.parse(readFileSync(this.defaultIdentityPath, "utf8"));
        const hex = raw.privateKey ?? raw.privateKeyHex;
        if (hex) {
          this.setSignerKey(hex);
          return { privateKey: this.signerPrivateKey!, publicKey: this.signerPublicKey! };
        }
      } catch {
        // ignore
      }
    }
    const generated = randomBytes(32);
    this.setSignerKey(generated);
    return { privateKey: this.signerPrivateKey!, publicKey: this.signerPublicKey! };
  }

  getPublicKeyHex(ctx?: BotContext): string {
    return toHex(this.getSignerKey(ctx).publicKey);
  }

  getProfile(): BotProfile {
    return {
      name: "Satoshi Dice",
      bio: "The original crypto dice game. Provably fair 16-bit rolls, 1.9% house edge, multipliers up to 981x! Send /roll to play.",
      avatarPng: generateAvatarPng("dice", [240, 100, 20]),
      bot: true,
      accountType: ACCOUNT_TYPE_BOT,
      botRole: BOT_ROLE_GAME,
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

  private async handleChannelUpdate(
    rawItem: any,
    msgCtx: BotMessageContext,
    ctx: BotContext
  ): Promise<boolean> {
    let channelItem: CanonicalChannelUpdateItem;
    if (isChannelUpdateItemFrame(rawItem)) {
      channelItem = projectChannelUpdateItem(rawItem);
    } else if (rawItem.type === 24) {
      channelItem = {
        type: "channel-update",
        channelId:
          typeof rawItem.channelId === "string"
            ? rawItem.channelId
            : toHex(rawItem.channelId),
        appId: rawItem.appId,
        sequenceNumber: rawItem.sequenceNumber,
        allocations: (rawItem.allocations || []).map((a: any) => ({
          networkTag: a.networkTag,
          token: a.token
            ? typeof a.token === "string"
              ? a.token
              : toHex(a.token)
            : "",
          balances: (a.balances || []).map((b: any) => ({
            participant: {
              keyType: b.participant.keyType,
              pubKey:
                typeof b.participant.pubKey === "string"
                  ? b.participant.pubKey
                  : toHex(b.participant.keyBytes),
            },
            balance:
              typeof b.balance === "bigint"
                ? b.balance.toString()
                : b.balance,
          })),
        })),
        appState: rawItem.appState,
        signatures: (rawItem.signatures || []).map((s: any) => ({
          algorithm: s.algorithm,
          signer: {
            keyType: s.signer.keyType,
            pubKey:
              typeof s.signer.pubKey === "string"
                ? s.signer.pubKey
                : toHex(s.signer.keyBytes),
          },
          signature:
            typeof s.signature === "string" ? s.signature : toHex(s.signature),
        })),
        ...(rawItem.settlementRef !== undefined
          ? {
              settlementRef:
                typeof rawItem.settlementRef === "string"
                  ? rawItem.settlementRef
                  : toHex(rawItem.settlementRef),
            }
          : {}),
      };
    } else if (rawItem.type === "channel-update") {
      channelItem = rawItem as CanonicalChannelUpdateItem;
    } else {
      return false;
    }

    const appId = (channelItem.appId ?? "").toLowerCase();
    if (
      appId !== "dice" &&
      appId !== "dice-v1" &&
      appId !== "satoshi-dice-v1"
    ) {
      return false;
    }

    const channelId = channelItem.channelId.toLowerCase();

    // 1. Monotonic sequence number validation
    const priorSeqStr = await ctx.state.get(`channel:${channelId}:seq`);
    if (priorSeqStr !== undefined) {
      const priorSeq = parseInt(priorSeqStr, 10);
      try {
        validateChannelSequence(priorSeq, channelItem.sequenceNumber);
      } catch (err: any) {
        await msgCtx.reply([
          {
            type: "text",
            text: `⚠️ Channel sequence validation failed: ${err.message}`,
          },
        ]);
        return true;
      }
    }

    // 2. Signature verification
    if (channelItem.signatures && channelItem.signatures.length > 0) {
      const valid = verifyChannelSignatures(channelItem);
      if (!valid) {
        await msgCtx.reply([
          {
            type: "text",
            text: "⚠️ Channel signature verification failed: invalid state signatures.",
          },
        ]);
        return true;
      }
    } else {
      await msgCtx.reply([
        {
          type: "text",
          text: "⚠️ Channel update must be signed by counterparty.",
        },
      ]);
      return true;
    }

    // 3. Parse DiceGamePayload
    const appStateBytes =
      typeof channelItem.appState === "string"
        ? fromHex(
            channelItem.appState.startsWith("0x")
              ? channelItem.appState.slice(2)
              : channelItem.appState
          )
        : channelItem.appState;

    let dicePayload: DiceGamePayload;
    try {
      dicePayload = decodeDiceGamePayload(appStateBytes);
    } catch (err: any) {
      await msgCtx.reply([
        {
          type: "text",
          text: `⚠️ Failed to decode dice payload: ${err.message}`,
        },
      ]);
      return true;
    }

    // 4. Resolve allocations and participant indices
    if (!channelItem.allocations || channelItem.allocations.length === 0) {
      await msgCtx.reply([
        {
          type: "text",
          text: "⚠️ Channel update missing allocations.",
        },
      ]);
      return true;
    }

    const alloc = channelItem.allocations[0];
    if (!alloc.balances || alloc.balances.length < 2) {
      await msgCtx.reply([
        {
          type: "text",
          text: "⚠️ Channel allocation requires at least 2 participant balances.",
        },
      ]);
      return true;
    }

    const botSigner = this.getSignerKey(ctx);
    const botPubKeyHex = toHex(botSigner.publicKey).toLowerCase();

    const balances = alloc.balances;
    let botIndex = balances.findIndex(
      (b) => b.participant.pubKey.toLowerCase() === botPubKeyHex
    );

    let playerIndex = -1;
    if (botIndex !== -1) {
      playerIndex = botIndex === 0 ? 1 : 0;
    } else {
      const playerSignerHex = channelItem.signatures[0]?.signer?.pubKey?.toLowerCase();
      if (playerSignerHex) {
        playerIndex = balances.findIndex(
          (b) => b.participant.pubKey.toLowerCase() === playerSignerHex
        );
      }
      if (playerIndex === -1 && msgCtx.peerAddress) {
        playerIndex = balances.findIndex((b) => {
          try {
            const rawPub = fromHex(
              b.participant.pubKey.startsWith("0x")
                ? b.participant.pubKey.slice(2)
                : b.participant.pubKey
            );
            const derived =
              "0x" + toHex(addressFromCompressedPubkey(rawPub)).toLowerCase();
            return derived === msgCtx.peerAddress.toLowerCase();
          } catch {
            return false;
          }
        });
      }
      if (playerIndex !== -1) {
        botIndex = playerIndex === 0 ? 1 : 0;
      } else {
        playerIndex = 0;
        botIndex = 1;
      }
    }

    const playerBal = parseBalanceToBigInt(balances[playerIndex].balance);
    const botBal = parseBalanceToBigInt(balances[botIndex].balance);

    const wagerWei =
      typeof dicePayload.wager === "bigint"
        ? dicePayload.wager
        : uint8ArrayToBigInt(dicePayload.wager);

    if (playerBal < wagerWei) {
      await msgCtx.reply([
        {
          type: "text",
          text: `⚠️ Insufficient channel balance for wager: balance=${playerBal.toString()}, wager=${wagerWei.toString()}`,
        },
      ]);
      return true;
    }

    // 5. Calculate target & execute roll
    const targetRoll =
      dicePayload.targetRoll !== undefined &&
      dicePayload.targetRoll > 0 &&
      dicePayload.targetRoll <= 100
        ? dicePayload.targetRoll
        : 50;

    const effectiveTarget = Math.floor(
      (targetRoll / 100) * SATOSHI_DICE_MODULO
    );
    const multiplier = calculateMultiplier(effectiveTarget);

    const maxPayoutWei = BigInt(Math.floor(Number(wagerWei) * multiplier));
    const maxGainWei = maxPayoutWei > wagerWei ? maxPayoutWei - wagerWei : 0n;
    if (botBal < maxGainWei) {
      await msgCtx.reply([
        {
          type: "text",
          text: `⚠️ Bot channel balance insufficient to cover potential payout (${maxGainWei.toString()} wei needed, bot holds ${botBal.toString()} wei)`,
        },
      ]);
      return true;
    }

    const serverSecretBytes = randomBytes(32);
    const serverSecretHex = toHex(serverSecretBytes);
    const serverCommitmentBytes = sha256(serverSecretBytes);
    const userNonceHex = toHex(dicePayload.seedCommitment);

    const luckyNumber =
      this.luckyNumberOverride !== undefined
        ? this.luckyNumberOverride
        : rollLuckyNumber(serverSecretHex, userNonceHex);

    const isWin = luckyNumber < effectiveTarget;

    let payoutWei = 0n;
    let newPlayerBal = playerBal;
    let newBotBal = botBal;

    if (wagerWei > 0n) {
      if (isWin) {
        payoutWei = BigInt(Math.floor(Number(wagerWei) * multiplier));
        const netGain = payoutWei - wagerWei;
        newPlayerBal = playerBal + netGain;
        newBotBal = botBal - netGain;
      } else {
        newPlayerBal = playerBal - wagerWei;
        newBotBal = botBal + wagerWei;
      }
      await this.recordRoll(ctx, wagerWei, isWin ? payoutWei : 0n, isWin);
    }

    // 6. Build updated DiceGamePayload & State Channel update
    const nextSeq = channelItem.sequenceNumber + 1;

    const responseDicePayload: DiceGamePayload = {
      round: dicePayload.round,
      action: "reveal",
      seedCommitment: serverCommitmentBytes,
      revealSeed: serverSecretBytes,
      targetRoll,
      wager: dicePayload.wager,
    };

    const responseAppState = encodeDiceGamePayload(responseDicePayload);

    const updatedBalances = [...alloc.balances];
    updatedBalances[playerIndex] = {
      participant: alloc.balances[playerIndex].participant,
      balance: newPlayerBal.toString(),
    };
    updatedBalances[botIndex] = {
      participant: alloc.balances[botIndex].participant,
      balance: newBotBal.toString(),
    };

    const updatedAllocations: CanonicalChainAllocation[] = channelItem.allocations.map(
      (a, idx) => {
        if (idx === 0) {
          return {
            networkTag: a.networkTag,
            ...(a.token !== undefined ? { token: a.token } : {}),
            balances: updatedBalances,
          };
        }
        return a;
      }
    );

    const responseChannelState = {
      channelId: channelItem.channelId,
      appId: channelItem.appId,
      sequenceNumber: nextSeq,
      allocations: updatedAllocations,
      appState: responseAppState,
      ...(channelItem.settlementRef !== undefined
        ? { settlementRef: channelItem.settlementRef }
        : {}),
    };

    const stateDigest = channelStateDigest(responseChannelState);
    const botSigDer = new Uint8Array(
      secp256k1.sign(stateDigest, botSigner.privateKey).toDERRawBytes()
    );

    const responseChannelItem: CanonicalChannelUpdateItem = {
      type: "channel-update",
      channelId: channelItem.channelId,
      appId: channelItem.appId,
      sequenceNumber: nextSeq,
      allocations: updatedAllocations,
      appState: responseAppState,
      signatures: [
        {
          algorithm: 1,
          signer: {
            keyType: 1,
            pubKey: botPubKeyHex,
          },
          signature: toHex(botSigDer),
        },
      ],
      ...(channelItem.settlementRef !== undefined
        ? { settlementRef: channelItem.settlementRef }
        : {}),
    };

    // 7. Persist channel sequence and state
    await ctx.state.put(`channel:${channelId}:seq`, nextSeq.toString());
    await ctx.state.put(
      `channel:${channelId}:item`,
      JSON.stringify(responseChannelItem)
    );

    // 8. Reply with channel update and summary text
    const outcomeEmoji = isWin ? "🎉" : "💀";
    const outcomeText = isWin
      ? `**YOU WIN!** (Lucky Roll ${luckyNumber} < Target ${effectiveTarget})`
      : `**YOU LOSE!** (Lucky Roll ${luckyNumber} ≥ Target ${effectiveTarget})`;

    const wagerHeader =
      wagerWei > 0n
        ? `💰 **Channel Wager:** ${formatMon(wagerWei)} | **Multiplier:** ${multiplier}x`
        : `🎮 **Channel Free Roll** | **Multiplier:** ${multiplier}x`;

    await msgCtx.reply([
      responseChannelItem as any,
      {
        type: "text",
        text: `🎲 **Satoshi Dice Channel State Update (Seq #${nextSeq})**
${wagerHeader}
🎯 **Target:** < ${effectiveTarget} (${targetRoll}% win chance)

${outcomeEmoji} ${outcomeText}

📊 **New Channel Balances:**
• **Player:** ${formatMon(newPlayerBal)}
• **House:** ${formatMon(newBotBal)}

🔍 **Provably Fair Verification:**
• **Lucky Number:** \`${luckyNumber}\` / 65,535
• **Server Commitment:** \`${toHex(serverCommitmentBytes)}\`
• **Reveal Seed:** \`${serverSecretHex}\`
• **Player Nonce:** \`${userNonceHex}\`
• **Bot Signature:** \`${toHex(botSigDer).slice(0, 32)}...\``,
      },
    ]);

    return true;
  }

  async onMessage(msgCtx: BotMessageContext, ctx: BotContext): Promise<void> {
    // 0. Support Type 24 channel-update items (appId 'dice-v1', 'satoshi-dice-v1', or 'dice')
    const rawChannelItem = msgCtx.items.find(
      (item: any) =>
        item.type === "channel-update" ||
        item.type === 24 ||
        (item.kind === "parsed" && item.typeId === 24)
    );

    if (rawChannelItem) {
      const handled = await this.handleChannelUpdate(rawChannelItem, msgCtx, ctx);
      if (handled) return;
    }

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
