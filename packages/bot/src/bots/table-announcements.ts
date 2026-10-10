import type { BotContext } from "@frank/bot-framework";
import type { ForumMessageEntry } from "@frank/wallet/forum-model";

export const DEFAULT_GAMES_TOPIC = "games";

export interface GameTableDetails {
  /** Display name of the game (e.g. "Texas Hold'em Poker", "Liar's Dice"). */
  gameName: string;
  /** Unique table or game identifier. */
  tableId: string;
  /** Address of the user who created / is hosting the table. */
  hostAddress: string;
  /** Human-readable buy-in amount or limits (e.g. "1000 chips (Blinds: 10/20)", "0.1 MON"). */
  buyInAmount: string;
  /** Current number of seated / joined players. */
  currentPlayers: number;
  /** Maximum capacity of the table. */
  maxPlayers: number;
  /** Address of the bot referee hosting the game table. */
  botAddress?: string;
  /** Direct action link / URI to join the table (e.g. "/chat/0xBot?join=tableId"). */
  actionLink?: string;
  /** Machine-readable game type identifier (e.g. "poker", "liars-dice"). */
  gameType?: "poker" | "liars-dice" | "blackjack" | "rps" | string;
  /** Call-to-action button or link text (defaults to "Join Table"). */
  callToAction?: string;
}

export interface GameAnnouncementPayload {
  version: 1;
  kind: "game-table-announcement";
  gameName: string;
  gameType?: string;
  tableId: string;
  hostAddress: string;
  buyInAmount: string;
  currentPlayers: number;
  maxPlayers: number;
  botAddress?: string;
  actionLink: string;
  callToAction: string;
}

/**
 * Formats a clean markdown message for topic and forum readers,
 * embedding machine-readable metadata in an HTML comment.
 */
export function formatGameAnnouncementMarkdown(details: GameTableDetails): string {
  const botTarget = details.botAddress || "";
  const actionLink =
    details.actionLink ||
    (botTarget
      ? `/chat/${botTarget}?join=${details.tableId}`
      : `/chat/${details.hostAddress}`);
  const callToAction = details.callToAction || "Join Table";

  const payload: GameAnnouncementPayload = {
    version: 1,
    kind: "game-table-announcement",
    gameName: details.gameName,
    gameType: details.gameType,
    tableId: details.tableId,
    hostAddress: details.hostAddress,
    buyInAmount: details.buyInAmount,
    currentPlayers: details.currentPlayers,
    maxPlayers: details.maxPlayers,
    botAddress: details.botAddress,
    actionLink,
    callToAction,
  };

  const metadataComment = `<!-- GAME_ANNOUNCEMENT:${JSON.stringify(payload)} -->`;

  return [
    `🎮 **${details.gameName} Table Created!**`,
    ``,
    `• **Table ID**: \`${details.tableId}\``,
    `• **Host**: \`${details.hostAddress}\``,
    `• **Buy-in**: ${details.buyInAmount}`,
    `• **Players**: ${details.currentPlayers}/${details.maxPlayers}`,
    ``,
    `[${callToAction}](${actionLink}) | [Message Host](/chat/${details.hostAddress})`,
    ``,
    metadataComment,
  ].join("\n");
}

/**
 * Builds a structured ForumMessageEntry (kind "game") suitable for publishing to topic feeds or forum boards.
 */
export function buildGameAnnouncementEntry(
  details: GameTableDetails
): ForumMessageEntry {
  const title = `🎮 [${details.gameName}] Table #${details.tableId} (${details.currentPlayers}/${details.maxPlayers} players)`;
  const message = formatGameAnnouncementMarkdown(details);

  return {
    kind: "game",
    gameType: details.gameType || "game",
    tableId: details.tableId,
    hostAddress: details.hostAddress,
    buyInAmount: details.buyInAmount,
    currentPlayers: details.currentPlayers,
    maxPlayers: details.maxPlayers,
    botAddress: details.botAddress,
    title,
    message,
  };
}

/**
 * Builds a legacy text post entry (kind "post") with markdown formatting.
 */
export function buildLegacyGameAnnouncementEntry(
  details: GameTableDetails
): ForumMessageEntry {
  const botTarget = details.botAddress || "";
  const actionLink =
    details.actionLink ||
    (botTarget
      ? `/chat/${botTarget}?join=${details.tableId}`
      : `/chat/${details.hostAddress}`);
  const title = `🎮 [${details.gameName}] Table #${details.tableId} (${details.currentPlayers}/${details.maxPlayers} players)`;
  const message = formatGameAnnouncementMarkdown(details);

  return {
    kind: "post",
    title,
    url: actionLink,
    message,
  };
}

/**
 * Publishes a game table announcement to a designated public topic (default "games").
 */
export async function announceTableToTopic(
  ctx: BotContext,
  topic: string = DEFAULT_GAMES_TOPIC,
  gameDetails: GameTableDetails
): Promise<{ payloadDigest?: string; entry: ForumMessageEntry }> {
  const detailsWithBot: GameTableDetails = {
    ...gameDetails,
    botAddress: gameDetails.botAddress || ctx.address,
    actionLink:
      gameDetails.actionLink ||
      (ctx.address
        ? `/chat/${ctx.address}?join=${gameDetails.tableId}`
        : `/chat/${gameDetails.hostAddress}`),
  };

  const entry = buildGameAnnouncementEntry(detailsWithBot);

  let payloadDigest: string | undefined;
  try {
    if (typeof (ctx as any).publishTopicMessage === "function") {
      const res = await (ctx as any).publishTopicMessage({
        topic,
        entries: [entry],
      });
      payloadDigest = res?.payloadDigest;
    } else if (typeof (ctx as any).postToTopic === "function") {
      const res = await (ctx as any).postToTopic({
        topic,
        entries: [entry],
      });
      payloadDigest = res?.payloadDigest;
    } else if (
      ctx.subscriptions &&
      typeof ctx.subscriptions.broadcast === "function"
    ) {
      await ctx.subscriptions.broadcast(
        [
          {
            type: "text",
            text: entry.message || entry.title || "Game Table Announcement",
          },
        ],
        topic
      );
    }
  } catch (err) {
    console.warn(
      `[game-announcement] Failed to publish announcement to topic "${topic}":`,
      err
    );
  }

  return { payloadDigest, entry };
}
