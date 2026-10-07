import type { ForumMessage, ForumMessageEntry } from '@frank/wallet/forum-model'

export interface ParsedGameAnnouncement {
  /** The display name of the game (e.g. "Texas Hold'em Poker", "Liar's Dice"). */
  gameName: string
  /** Machine-readable game type identifier (e.g. "poker", "liars-dice"). */
  gameType?: string
  /** Unique table or challenge ID. */
  tableId: string
  /** Address of the table creator or host. */
  hostAddress: string
  /** Buy-in amount or stakes description (e.g. "1000 chips", "0.1 MON"). */
  buyInAmount?: string
  /** Current count of joined players. */
  currentPlayers?: number
  /** Maximum player capacity. */
  maxPlayers?: number
  /** Address of the bot referee managing the table. */
  botAddress?: string
  /** Destination action link / route (e.g. "/chat/0xBot?join=tableId"). */
  actionLink?: string
  /** Call-to-action text for the join button. */
  callToAction?: string
}

/**
 * Parses a ForumMessageEntry (and parent ForumMessage) to extract game table details.
 * Supports:
 * 1. Embedded JSON metadata comment: <!-- GAME_ANNOUNCEMENT:{...} -->
 * 2. Markdown text structure and table/challenge patterns
 * 3. Chat join links in entry.url or entry.message
 */
export function parseGameAnnouncement(
  entry?: ForumMessageEntry,
  message?: ForumMessage,
): ParsedGameAnnouncement | null {
  if (!entry) return null

  // 0. Check for native CBOR Kind 2 entry
  if (entry.kind === 'game') {
    const defaultGameName =
      entry.gameType === 'poker'
        ? "Texas Hold'em Poker"
        : entry.gameType === 'liars-dice'
        ? "Liar's Dice"
        : entry.gameType === 'blackjack'
        ? 'Blackjack'
        : entry.gameType === 'rps'
        ? 'Rock Paper Scissors'
        : entry.gameType || 'Game Table'

    let gameName = defaultGameName
    if (entry.title) {
      const match = entry.title.match(/\[([^\]]+)\]/)
      if (match) {
        gameName = match[1].trim()
      } else if (!entry.gameType || entry.gameType === 'game') {
        gameName = entry.title
      }
    }

    const botAddress = entry.botAddress || message?.poster
    const actionLink = botAddress
      ? `/chat/${botAddress}?join=${entry.tableId}`
      : entry.hostAddress
      ? `/chat/${entry.hostAddress}`
      : undefined

    return {
      gameName,
      gameType: entry.gameType,
      tableId: entry.tableId,
      hostAddress: entry.hostAddress || message?.poster || '',
      buyInAmount: entry.buyInAmount,
      currentPlayers: entry.currentPlayers,
      maxPlayers: entry.maxPlayers,
      botAddress,
      actionLink,
      callToAction: 'Join Table',
    }
  }

  const rawText = (entry as { message?: string }).message || ''
  const title = (entry as { title?: string }).title || ''

  // 1. Check for embedded machine-readable JSON comment
  const jsonMatch = rawText.match(/<!--\s*GAME_ANNOUNCEMENT:\s*({.*?})\s*-->/s)
  if (jsonMatch && jsonMatch[1]) {
    try {
      const parsed = JSON.parse(jsonMatch[1])
      if (parsed.tableId && parsed.gameName) {
        return {
          gameName: String(parsed.gameName),
          gameType: parsed.gameType ? String(parsed.gameType) : undefined,
          tableId: String(parsed.tableId),
          hostAddress: String(parsed.hostAddress || message?.poster || ''),
          buyInAmount: parsed.buyInAmount ? String(parsed.buyInAmount) : undefined,
          currentPlayers:
            typeof parsed.currentPlayers === 'number'
              ? parsed.currentPlayers
              : undefined,
          maxPlayers:
            typeof parsed.maxPlayers === 'number'
              ? parsed.maxPlayers
              : undefined,
          botAddress: parsed.botAddress
            ? String(parsed.botAddress)
            : message?.poster,
          actionLink: parsed.actionLink ? String(parsed.actionLink) : undefined,
          callToAction: parsed.callToAction
            ? String(parsed.callToAction)
            : 'Join Table',
        }
      }
    } catch {
      // Fall through to regex / heuristic parsing
    }
  }

  // 2. Check if this entry represents a game announcement via heuristics
  const fullText = `${title} ${rawText}`
  const isGameAnnouncement =
    /poker|liar'?s\s*dice|blackjack|arcade|table\s*id|table\s*created|match\s*challenge/i.test(
      fullText,
    )

  // Also check if entry.url is a chat join link
  const urlJoinMatch = entry.url?.match(/^\/chat\/([^?]+)(?:\?.*join=([^&]+))?/i)
  if (!isGameAnnouncement && !urlJoinMatch) {
    return null
  }

  // Extract table ID
  let tableId = ''
  if (urlJoinMatch && urlJoinMatch[2]) {
    tableId = urlJoinMatch[2]
  } else {
    const tableIdMatch =
      rawText.match(/Table\s*(?:ID|#)?[:\s*]+`?([a-zA-Z0-9_-]{4,32})`?/i) ||
      title.match(/Table\s*(?:#|ID)?\s*`?([a-zA-Z0-9_-]{4,32})`?/i)
    if (tableIdMatch) {
      tableId = tableIdMatch[1]
    }
  }

  // Extract host address
  let hostAddress = message?.poster || ''
  const hostMatch =
    rawText.match(/Host[:\s*]+`?(0x[a-zA-Z0-9]{6,42})`?/i) ||
    rawText.match(/\b(0x[a-zA-Z0-9]{40})\b/i)
  if (hostMatch) {
    hostAddress = hostMatch[1]
  }

  // Infer game name
  let gameName = 'Game Table'
  let gameType: string | undefined
  if (/texas\s*hold'?em|poker/i.test(fullText)) {
    gameName = "Texas Hold'em Poker"
    gameType = 'poker'
  } else if (/liar'?s\s*dice|perudo/i.test(fullText)) {
    gameName = "Liar's Dice"
    gameType = 'liars-dice'
  } else if (/blackjack/i.test(fullText)) {
    gameName = 'Blackjack'
    gameType = 'blackjack'
  } else if (/rock\s*paper\s*scissors|rps/i.test(fullText)) {
    gameName = 'Rock Paper Scissors'
    gameType = 'rps'
  } else if (title) {
    gameName = title.replace(/^[^\w]+/, '').trim()
  }

  // Extract buy-in amount
  let buyInAmount: string | undefined
  const buyInMatch = rawText.match(/Buy-?in[:\s*]+([^\n\r•]+)/i)
  if (buyInMatch) {
    buyInAmount = buyInMatch[1].trim()
  }

  // Extract players count
  let currentPlayers: number | undefined
  let maxPlayers: number | undefined
  const playersMatch = rawText.match(/Players?[:\s*]+(\d+)\s*\/\s*(\d+)/i)
  if (playersMatch) {
    currentPlayers = parseInt(playersMatch[1], 10)
    maxPlayers = parseInt(playersMatch[2], 10)
  }

  // Extract action link or markdown link
  let actionLink: string | undefined = entry.url
  const linkMatch =
    rawText.match(/\[(?:Join Table|Sit at Table|Play)\]\(([^)]+)\)/i) ||
    rawText.match(/\(((\/chat\/[^)]+))\)/i)
  if (linkMatch) {
    actionLink = linkMatch[1]
  }

  // Extract bot address from actionLink or message.poster
  let botAddress = message?.poster
  if (actionLink && actionLink.startsWith('/chat/')) {
    const chatTarget = actionLink.slice(6).split('?')[0]
    if (chatTarget && chatTarget.startsWith('0x')) {
      botAddress = chatTarget
    }
  }

  if (!tableId && !actionLink) {
    return null
  }

  return {
    gameName,
    gameType,
    tableId: tableId || 'table',
    hostAddress,
    buyInAmount,
    currentPlayers,
    maxPlayers,
    botAddress,
    actionLink,
    callToAction: 'Join Table',
  }
}

/**
 * Resolves the destination route for the "Join Table" action button.
 */
export function getJoinRoute(announcement: ParsedGameAnnouncement): string {
  if (announcement.actionLink && announcement.actionLink.startsWith('/chat/')) {
    return announcement.actionLink
  }
  const target = announcement.botAddress || announcement.hostAddress
  if (!target) return '/chat'
  return announcement.tableId
    ? `/chat/${target}?join=${announcement.tableId}`
    : `/chat/${target}`
}

/**
 * Resolves the destination route for the "Message Host" action button.
 */
export function getHostRoute(
  announcement: ParsedGameAnnouncement,
): string | undefined {
  if (announcement.hostAddress && announcement.hostAddress.startsWith('0x')) {
    return `/chat/${announcement.hostAddress}`
  }
  return undefined
}
