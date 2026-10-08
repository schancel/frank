import {
  ACCOUNT_TYPE_BOT,
  ACCOUNT_TYPE_SERVICE,
  BOT_ROLE_ASSISTANT,
  BOT_ROLE_FAUCET,
  BOT_ROLE_GAME,
  BOT_ROLE_BRIDGE,
  BOT_ROLE_MERCHANT,
  BOT_ROLE_MODERATOR,
  BOT_ROLE_ANNOUNCER,
} from '@frank/codec'

export interface InferredBotAttributes {
  accountType?: number
  botRole?: number
  isBot?: boolean
}

/**
 * Infers curated bot attributes (accountType, botRole, isBot) from a contact display name.
 * This ensures official bots seeded via curated defaults or rendered with incomplete directory
 * metadata receive appropriate badges (e.g. Official Game, Official Faucet, Official AI, Official Bot).
 */
export function inferCuratedBotAttributes(name: string): InferredBotAttributes {
  const lower = name.trim().toLowerCase()
  if (!lower) return {}

  // Faucet service
  if (lower.includes('faucet')) {
    return {
      accountType: ACCOUNT_TYPE_SERVICE,
      botRole: BOT_ROLE_FAUCET,
      isBot: false,
    }
  }
  // AI assistant
  if (lower === 'qwen' || lower.includes('assistant') || lower.includes('ai')) {
    return {
      accountType: ACCOUNT_TYPE_BOT,
      botRole: BOT_ROLE_ASSISTANT,
      isBot: true,
    }
  }
  // Games
  if (
    lower.includes('blackjack') ||
    lower.includes('poker') ||
    lower.includes('dice') ||
    lower.includes('raffle') ||
    lower.includes('rps') ||
    lower.includes('rock paper scissors') ||
    lower.includes('game')
  ) {
    return {
      accountType: ACCOUNT_TYPE_BOT,
      botRole: BOT_ROLE_GAME,
      isBot: true,
    }
  }
  // Merchant / shop
  if (
    lower.includes('picture shop') ||
    lower.includes('vendor') ||
    lower.includes('shop') ||
    lower.includes('merchant') ||
    lower.includes('store')
  ) {
    return {
      accountType: ACCOUNT_TYPE_BOT,
      botRole: BOT_ROLE_MERCHANT,
      isBot: true,
    }
  }
  // Chat rooms / Moderator
  if (
    lower === 'lobby' ||
    lower.includes('moderator') ||
    lower.includes('chat room')
  ) {
    return {
      accountType: ACCOUNT_TYPE_BOT,
      botRole: BOT_ROLE_MODERATOR,
      isBot: true,
    }
  }
  // Bridge
  if (lower.includes('bridge')) {
    return {
      accountType: ACCOUNT_TYPE_BOT,
      botRole: BOT_ROLE_BRIDGE,
      isBot: true,
    }
  }
  // Announcer
  if (lower.includes('announcer')) {
    return {
      accountType: ACCOUNT_TYPE_BOT,
      botRole: BOT_ROLE_ANNOUNCER,
      isBot: true,
    }
  }
  // Generic bot or dealer in name
  if (lower.includes('bot') || lower.includes('dealer')) {
    return {
      accountType: ACCOUNT_TYPE_BOT,
      isBot: true,
    }
  }

  return {}
}
