/**
 * Shared loop guard for the demo bots (#311).
 *
 * Failure this prevents: bots that answer any inbound message (vendor catalog, raffle status,
 * Qwen chat) reply to each other forever, each reply carrying a stamp payment (and, for Qwen, a
 * model call). Two independent layers, both cheap and both needed:
 *
 * 1. Never engage another bot. A peer is "a bot" when its registered profile carries the
 *    self-declared `bot` entry (`MONAD_PROFILE_BOT_KIND`, set by `registerAndLog`) or its address
 *    is on the operator denylist `FRANK_BOT_PEER_DENYLIST` (covers bots registered before the
 *    marker existed, or third-party bots that do not set it). The profile schema already carries
 *    open-ended `Entry { kind, headers, body }` items and the registry ignores kinds it does not
 *    know, so this needs no wire/proto/backend change. A lookup that errors fails CLOSED (the peer
 *    is treated as automated for that message) because the cost of a wrong "human" answer is a
 *    money-spending loop.
 * 2. A hard per-peer reply budget per sliding time window (`reserveReply`). This bounds the damage
 *    from anything the marker misses (an unmarked bot, a human spamming) to
 *    `maxRepliesPerPeer` per `windowMs` per peer. State is in memory only: a bot restart resets
 *    the budget (documented limit; the bot layer above is the primary defense).
 *
 * Limits: the marker is self-asserted, so a hostile bot can omit it; the budget is per peer
 * address, so a sybil owner minting many addresses gets `maxRepliesPerPeer` from each (each such
 * address must still pay a stamp to reach us). This is demo-grade loop prevention, not
 * anti-abuse.
 */
import { canonicalMonadEnvelopeAddress } from '@frank/cashweb/relay/monad-message-envelope'
import {
  fetchMonadProfile,
  isBotAccount,
  isBotProfileSignedPayload,
} from '@frank/wallet/monad-identity'
import __pb_signed_payload_payload_pb from '@frank/cashweb/signed_payload/payload_pb'
const { SignedPayload } = __pb_signed_payload_payload_pb

export const DEFAULT_MAX_REPLIES_PER_PEER = 20
export const DEFAULT_REPLY_WINDOW_MS = 60 * 60 * 1000
const BOT_LOOKUP_TTL_MS = 5 * 60 * 1000
const SWEEP_THRESHOLD = 1000

export type PeerBlockReason =
  | 'self'
  | 'denylisted'
  | 'bot-profile'
  | 'lookup-failed'

export interface BotLoopGuardOptions {
  selfAddress: string
  relayBaseUrl: string
  /** Addresses never engaged (canonicalized internally). */
  denylist?: readonly string[]
  maxRepliesPerPeer?: number
  windowMs?: number
  /** Injected in tests; defaults to a profile lookup on the relay. Resolves to whether the
   * peer's profile is marked as a bot (an unregistered peer is not a bot). May throw. */
  lookupIsBot?: (address: string) => Promise<boolean>
  now?: () => number
}

export class BotLoopGuard {
  private readonly self: string
  private readonly denylist: Set<string>
  private readonly maxReplies: number
  private readonly windowMs: number
  private readonly lookupIsBot: (address: string) => Promise<boolean>
  private readonly now: () => number
  private readonly replies = new Map<string, number[]>()
  private readonly lookups = new Map<
    string,
    { isBot: boolean; expiresAt: number }
  >()

  constructor(options: BotLoopGuardOptions) {
    this.self = canonicalMonadEnvelopeAddress(options.selfAddress)
    this.denylist = new Set(
      (options.denylist ?? []).map(canonicalMonadEnvelopeAddress),
    )
    this.maxReplies = options.maxRepliesPerPeer ?? DEFAULT_MAX_REPLIES_PER_PEER
    this.windowMs = options.windowMs ?? DEFAULT_REPLY_WINDOW_MS
    this.now = options.now ?? Date.now
    this.lookupIsBot =
      options.lookupIsBot ??
      (async address => {
        const profile = await fetchMonadProfile({
          relayBaseUrl: options.relayBaseUrl,
          address: { raw: address },
        })
        return isBotAccount(profile)
      })
  }

  /** Synchronous checks that need no network: ourselves and the operator denylist. Also what the
   * greeter uses (it already holds the profile payload, so it adds its own marker check). */
  staticBlockReason(address: string): PeerBlockReason | undefined {
    const key = canonicalMonadEnvelopeAddress(address)
    if (key === this.self) return 'self'
    if (this.denylist.has(key)) return 'denylisted'
    return undefined
  }

  /** Greeter variant of {@link peerBlockReason}: the caller already holds the peer's registered
   * profile payload (from the new-profile feed), so the marker is checked locally, no lookup. */
  profileBlockReason(
    address: string,
    signedPayload: InstanceType<typeof SignedPayload>,
  ): PeerBlockReason | undefined {
    return (
      this.staticBlockReason(address) ??
      (isBotProfileSignedPayload(signedPayload) ? 'bot-profile' : undefined)
    )
  }

  /** Why `address` must not be engaged, or `undefined` if it may be. Call before doing any work
   * (or spending anything) on behalf of an inbound message. */
  async peerBlockReason(address: string): Promise<PeerBlockReason | undefined> {
    const stat = this.staticBlockReason(address)
    if (stat) return stat
    const key = canonicalMonadEnvelopeAddress(address)
    const cached = this.lookups.get(key)
    const now = this.now()
    if (cached && cached.expiresAt > now) {
      return cached.isBot ? 'bot-profile' : undefined
    }
    let isBot: boolean
    try {
      isBot = await this.lookupIsBot(address)
    } catch {
      console.warn(
        '[loop-guard] profile lookup failed -- treating as automated',
      )
      return 'lookup-failed'
    }
    if (this.lookups.size >= SWEEP_THRESHOLD) {
      for (const [k, v] of this.lookups) {
        if (v.expiresAt <= now) this.lookups.delete(k)
      }
    }
    this.lookups.set(key, { isBot, expiresAt: now + BOT_LOOKUP_TTL_MS })
    return isBot ? 'bot-profile' : undefined
  }

  /** Consumes one unit of `address`'s reply budget. Returns false (and consumes nothing) once
   * `maxRepliesPerPeer` replies were reserved inside the trailing `windowMs`. Reserve BEFORE
   * sending so a failed send still counts: retries cannot exceed the bound. */
  reserveReply(address: string): boolean {
    const key = canonicalMonadEnvelopeAddress(address)
    const now = this.now()
    const recent = (this.replies.get(key) ?? []).filter(
      t => t > now - this.windowMs,
    )
    if (recent.length >= this.maxReplies) {
      this.replies.set(key, recent)
      return false
    }
    recent.push(now)
    this.replies.set(key, recent)
    if (this.replies.size >= SWEEP_THRESHOLD) {
      for (const [k, times] of this.replies) {
        if (times.every(t => t <= now - this.windowMs)) this.replies.delete(k)
      }
    }
    return true
  }
}

export function parseAddressList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map(part => part.trim())
    .filter(part => part.length > 0)
}

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got "${raw}"`)
  }
  return value
}

/** Builds the guard every bot shares, configured by:
 *   FRANK_BOT_PEER_DENYLIST         comma-separated addresses never engaged
 *   FRANK_BOT_MAX_REPLIES_PER_PEER  per-peer reply budget per window (default 20; 0 = never reply)
 *   FRANK_BOT_REPLY_WINDOW_MS       window length (default 1 hour) */
export function botLoopGuardFromEnv(params: {
  selfAddress: string
  relayBaseUrl: string
}): BotLoopGuard {
  return new BotLoopGuard({
    ...params,
    denylist: parseAddressList(process.env.FRANK_BOT_PEER_DENYLIST),
    maxRepliesPerPeer: positiveIntEnv(
      'FRANK_BOT_MAX_REPLIES_PER_PEER',
      DEFAULT_MAX_REPLIES_PER_PEER,
    ),
    windowMs: positiveIntEnv(
      'FRANK_BOT_REPLY_WINDOW_MS',
      DEFAULT_REPLY_WINDOW_MS,
    ),
  })
}
