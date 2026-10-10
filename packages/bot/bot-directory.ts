/**
 * The demo bots' public profiles (#317): the single home for each bot's display name, bio,
 * avatar and where its identity file lives, shared by the bots (which register the profile at
 * startup) and by `print-curated-defaults.ts` (which lists them for the relay's curated
 * defaults). Nothing here is secret and no address is hard-coded: addresses come from each bot's
 * own persisted identity, so they are per machine / per network.
 */
import { deflateSync } from 'zlib'

import {
  ACCOUNT_TYPE_BOT,
  ACCOUNT_TYPE_SERVICE,
  BOT_ROLE_ASSISTANT,
  BOT_ROLE_FAUCET,
  BOT_ROLE_GAME,
  BOT_ROLE_MERCHANT,
  BOT_ROLE_MODERATOR,
  type AccountType,
  type BotRole,
} from '@frank/codec'
import { MonadProfileFields } from '@frank/wallet/monad-identity'

export type BotKey =
  | 'blackjack'
  | 'raffle'
  | 'vendor'
  | 'qwen'
  | 'faucet'
  | 'lobby'
  | 'rps'
  | 'dice'

export interface BotProfileSpec {
  key: BotKey
  /** Shown in Contacts/chat headers. Must satisfy the registry's display-name rules. */
  name: string
  bio: string
  identityEnv: string
  identityDefaultPath: string
  /** Avatar accent colour (RGB). */
  accent: [number, number, number]
  accountType?: AccountType
  botRole?: BotRole
}

/** Order is the order they appear in the printed curated defaults. */
export const BOT_PROFILES: readonly BotProfileSpec[] = [
  {
    key: 'blackjack',
    name: 'Blackjack Dealer',
    bio: 'Automated blackjack dealer. Both sides commit to their randomness before the bet, and the app works out every card itself.',
    identityEnv: 'BLACKJACK_BOT_IDENTITY_JSON',
    identityDefaultPath: '/tmp/blackjack-bot-identity.json',
    accent: [200, 60, 60],
    accountType: ACCOUNT_TYPE_BOT,
    botRole: BOT_ROLE_GAME,
  },
  {
    key: 'raffle',
    name: 'Raffle',
    bio: 'Automated raffle. Send a message for the current round, pay the entry price to join.',
    identityEnv: 'RAFFLE_BOT_IDENTITY_JSON',
    identityDefaultPath: '/tmp/raffle-bot-identity.json',
    accent: [230, 160, 40],
    accountType: ACCOUNT_TYPE_BOT,
    botRole: BOT_ROLE_GAME,
  },
  {
    key: 'vendor',
    name: 'Picture Shop',
    bio: 'Automated store selling demo pictures. Send any message to see the catalog.',
    identityEnv: 'VENDOR_BOT_IDENTITY_JSON',
    identityDefaultPath: '/tmp/vendor-bot-identity.json',
    accent: [60, 150, 90],
    accountType: ACCOUNT_TYPE_BOT,
    botRole: BOT_ROLE_MERCHANT,
  },
  {
    key: 'qwen',
    name: 'Qwen',
    bio: 'Automated Qwen-powered assistant. Ask it anything.',
    identityEnv: 'QWEN_BOT_IDENTITY_JSON',
    identityDefaultPath: '/tmp/qwen-bot-identity.json',
    accent: [110, 90, 220],
    accountType: ACCOUNT_TYPE_BOT,
    botRole: BOT_ROLE_ASSISTANT,
  },
  {
    key: 'faucet',
    name: 'Monad Faucet',
    bio: 'Automated testnet faucet. Grants starter testnet coins to newly registered accounts.',
    identityEnv: 'FAUCET_BOT_IDENTITY_JSON',
    identityDefaultPath: '/tmp/faucet-bot-identity.json',
    accent: [40, 160, 220],
    accountType: ACCOUNT_TYPE_SERVICE,
    botRole: BOT_ROLE_FAUCET,
  },
  {
    key: 'lobby',
    name: 'Lobby',
    bio: 'Community group chat rooms. Send /join to enter #general, /rooms to list rooms, /help for commands.',
    identityEnv: 'LOBBY_BOT_IDENTITY_JSON',
    identityDefaultPath: '/tmp/lobby-bot-identity.json',
    accent: [30, 140, 220],
    accountType: ACCOUNT_TYPE_BOT,
    botRole: BOT_ROLE_MODERATOR,
  },
  {
    key: 'rps',
    name: 'Rock Paper Scissors',
    bio: 'Rock-Paper-Scissors against the bot. It commits to its move before you choose, and the app checks the reveal.',
    identityEnv: 'RPS_BOT_IDENTITY_JSON',
    identityDefaultPath: '/tmp/rps-bot-identity.json',
    accent: [220, 100, 30],
    accountType: ACCOUNT_TYPE_BOT,
    botRole: BOT_ROLE_GAME,
  },
  {
    key: 'dice',
    name: 'Satoshi Dice',
    bio: 'Dice with a 1.9% house edge. The bot commits to its secret before you bet, and the app checks every roll.',
    identityEnv: 'DICE_BOT_IDENTITY_JSON',
    identityDefaultPath: '/tmp/dice-bot-identity.json',
    accent: [180, 50, 180],
    accountType: ACCOUNT_TYPE_BOT,
    botRole: BOT_ROLE_GAME,
  },
]

export function botProfileSpec(key: BotKey): BotProfileSpec {
  const spec = BOT_PROFILES.find(candidate => candidate.key === key)
  if (!spec) throw new Error(`Unknown bot ${key}`)
  return spec
}

const CRC_TABLE = (() => {
  const table: number[] = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table.push(c >>> 0)
  }
  return table
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const out = Buffer.alloc(body.length + 8)
  out.writeUInt32BE(data.length, 0)
  body.copy(out, 4)
  out.writeUInt32BE(crc32(body), body.length + 4)
  return out
}

/** A tiny deterministic 5x5 mirrored "identicon" PNG (60x60, well under 1 KB), generated with no
 * image library and no third-party artwork, so there is nothing to license. */
export function generateAvatarPng(
  seed: string,
  accent: [number, number, number],
): Buffer {
  const CELL = 12
  const SIZE = CELL * 5
  // Deterministic bits from the seed (FNV-1a stepped), 15 cells mirrored to 25.
  let h = 0x811c9dc5
  const bits: boolean[] = []
  for (let i = 0; i < 15; i++) {
    for (const ch of `${seed}:${i}`) {
      h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0
    }
    bits.push((h & 1) === 1)
  }
  const filled = (x: number, y: number) =>
    bits[y * 3 + (x < 3 ? x : 4 - x)] as boolean
  const raw = Buffer.alloc((SIZE * 3 + 1) * SIZE)
  for (let y = 0; y < SIZE; y++) {
    const rowStart = y * (SIZE * 3 + 1) // first byte is the filter type 0
    for (let x = 0; x < SIZE; x++) {
      const on = filled(Math.floor(x / CELL), Math.floor(y / CELL))
      const rgb = on ? accent : [245, 245, 245]
      raw[rowStart + 1 + x * 3] = rgb[0]
      raw[rowStart + 2 + x * 3] = rgb[1]
      raw[rowStart + 3 + x * 3] = rgb[2]
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(SIZE, 0)
  ihdr.writeUInt32BE(SIZE, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolour RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** The profile a bot registers: name, bio, generated avatar (data URI) and the bot marker (#311). */
export function botProfileFields(key: BotKey): MonadProfileFields {
  const spec = botProfileSpec(key)
  return {
    name: spec.name,
    bio: spec.bio,
    avatar: `data:image/png;base64,${generateAvatarPng(
      spec.key,
      spec.accent,
    ).toString('base64')}`,
    bot: true,
    accountType: spec.accountType ?? ACCOUNT_TYPE_BOT,
    botRole: spec.botRole,
  }
}
