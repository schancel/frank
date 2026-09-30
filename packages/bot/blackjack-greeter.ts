/**
 * The blackjack dealer's greeting (#395): the dealer opens the conversation with each NEW
 * registration, once, with a `blackjack` `welcome` item (table limits, fee hint, rules) plus a short
 * plain-text line. The app renders an inline bet control in that bubble; there is no toolbar entry.
 *
 * This is the same mechanism as the Qwen greeter (poll the relay's new-profile feed with a cursor,
 * skip ourselves / the denylist / self-declared bots via `bot-loop-guard`), with the differences
 * that matter because EVERY greeting costs the dealer a real stamp:
 *
 * - Durable once-per-address record, written BEFORE the send (at most once: a failed or crashed
 *   send is never retried, so an address can never be greeted twice, across restarts too).
 * - Per-run and per-day (UTC) caps. Both count every claimed greeting, including a failed send, so
 *   retries cannot exceed the bound. A capped profile is NOT consumed: it stays ahead of the cursor
 *   and is greeted by a later run or day (unless it is older than `maxAgeMs`, then it is dropped as
 *   stale).
 * - Fail safe when the dealer's funds are short: the greeting is skipped (logged, the profile stays
 *   ahead of the cursor for when it is funded) and a failing send is logged; the bot never crashes
 *   on either. Greetings never eat the bankroll that open hands may still owe.
 *
 * All I/O is injected (`BlackjackGreeterDeps`) so the rules are unit-tested with fakes; the real
 * wiring lives in `blackjack-bot.livecheck.ts`. Persistence is a small `level` database of its own
 * (like `qwen-bot-state.ts`), separate from the game-authority store so a greeting bug can never
 * touch wager state.
 */
import { mkdirSync } from 'fs'
import level, { LevelDB } from 'level'
import { join } from 'path'

import { canonicalMonadEnvelopeAddress } from '@frank/cashweb/relay/monad-message-envelope'
import { MessageItem } from '@frank/cashweb/types/messages'
import {
  BET_MESSAGE_FEE_RESERVE_WEI,
  BLACKJACK_RULES_SUMMARY,
  buildBlackjackWelcomeItem,
} from '@frank/wallet/message-item-plugins/blackjack/game'
import { formatMon } from '@frank/wallet/monad-amount'

import type { BotLoopGuard } from './bot-loop-guard'

const SINCE_PROFILES_KEY = '__since_profiles__'
const GREETED_PREFIX = 'greeted:'
const DAY_PREFIX = 'greeted-on-day:'

/** What a greeting costs the dealer beyond the stamp itself: the fee reserve its lazily funded
 * stamp sub-account needs (about 0.013 MON was observed on a local chain). */
export const GREETING_FEE_RESERVE_WEI = 5n * 10n ** 16n // 0.05 MON

export const DEFAULT_MAX_GREETINGS_PER_RUN = 5
export const DEFAULT_MAX_GREETINGS_PER_DAY = 20
export const DEFAULT_GREETING_MAX_AGE_MS = 24 * 60 * 60 * 1000

/** UTC calendar day of `ms`, e.g. `2026-09-30`. */
export function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export class BlackjackGreetingStore {
  private readonly dbLocation: string
  private openedDb?: LevelDB
  private sinceProfiles?: number
  private readonly greeted = new Set<string>()
  private readonly perDay = new Map<string, number>()

  constructor(location: string) {
    this.dbLocation = join(location, 'blackjack-greeting-state')
  }

  private get db(): LevelDB {
    if (!this.openedDb) throw new Error('No db opened')
    return this.openedDb
  }

  async Open(): Promise<void> {
    mkdirSync(this.dbLocation, { recursive: true })
    this.openedDb = level(this.dbLocation)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for await (const [key, value] of this.db.iterator({}) as any) {
      if (key === SINCE_PROFILES_KEY) {
        this.sinceProfiles = JSON.parse(value)
      } else if (key.startsWith(GREETED_PREFIX)) {
        this.greeted.add(
          canonicalMonadEnvelopeAddress(key.slice(GREETED_PREFIX.length)),
        )
      } else if (key.startsWith(DAY_PREFIX)) {
        this.perDay.set(key.slice(DAY_PREFIX.length), JSON.parse(value))
      }
    }
  }

  async Close(): Promise<void> {
    await this.db.close()
  }

  getSinceProfiles(): number | undefined {
    return this.sinceProfiles
  }

  async setSinceProfiles(value: number): Promise<void> {
    await this.db.put(SINCE_PROFILES_KEY, JSON.stringify(value))
    this.sinceProfiles = value
  }

  hasGreeted(address: string): boolean {
    return this.greeted.has(canonicalMonadEnvelopeAddress(address))
  }

  greetedOn(day: string): number {
    return this.perDay.get(day) ?? 0
  }

  /** Durably records that `address` is being greeted (and counts it against `day`) in ONE atomic
   * batch, BEFORE the greeting is sent. Rejects if it cannot be written, in which case the caller
   * must not send. */
  async claim(address: string, day: string): Promise<void> {
    const canonical = canonicalMonadEnvelopeAddress(address)
    const count = this.greetedOn(day) + 1
    // level@7 has an atomic batch at runtime, but its legacy type alias omits it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (this.db as any).batch([
      { type: 'put', key: GREETED_PREFIX + canonical, value: '1' },
      { type: 'put', key: DAY_PREFIX + day, value: JSON.stringify(count) },
    ])
    this.greeted.add(canonical)
    this.perDay.set(day, count)
  }
}

/**
 * The greeting message: the `welcome` item first, then a plain-text line LAST. Order matters for
 * older clients: they know nothing of `welcome` (empty block, and a chat-list preview taken from
 * the LAST item, which must be something they can render), so the text carries the same headline
 * in words. Table limits come from the bot's own config, never from the client's defaults.
 */
export function welcomeItems(table: {
  minWagerWei: bigint
  maxWagerWei: bigint
  stampValueWei: bigint
}): MessageItem[] {
  return [
    buildBlackjackWelcomeItem({
      minWagerWei: table.minWagerWei,
      maxWagerWei: table.maxWagerWei,
      feeHintWei: table.stampValueWei + BET_MESSAGE_FEE_RESERVE_WEI,
      rules: BLACKJACK_RULES_SUMMARY,
    }),
    {
      type: 'text',
      text: `Welcome to the blackjack table. Table limits: ${formatMon(
        table.minWagerWei,
      )} to ${formatMon(table.maxWagerWei)} per hand.`,
    },
  ]
}

export interface GreeterProfile {
  address: string
  signedPayload: Parameters<BotLoopGuard['profileBlockReason']>[1]
  /** Registration time, ms since the epoch (from the signed metadata). */
  registeredAt: number
}

export interface BlackjackGreeterConfig {
  /** Greetings per process run; 0 turns greeting off. */
  maxPerRun: number
  /** Greetings per UTC day, across restarts. */
  maxPerDay: number
  /** Registrations older than this are skipped as stale instead of greeted late. */
  maxAgeMs: number
}

export interface BlackjackGreeterDeps {
  store: Pick<
    BlackjackGreetingStore,
    'hasGreeted' | 'greetedOn' | 'claim' | 'getSinceProfiles' | 'setSinceProfiles'
  >
  guard: Pick<BotLoopGuard, 'profileBlockReason'>
  /** Registrations at or after `sinceMs`. */
  listProfiles(sinceMs: number): Promise<GreeterProfile[]>
  /** Whether the dealer can pay for one more greeting without touching what open hands may owe. */
  canAffordGreeting(): Promise<boolean>
  /** Sends the welcome. May throw; that is logged, never propagated. */
  sendWelcome(profile: GreeterProfile): Promise<void>
  now?: () => number
  /** Where the first run starts (a persisted cursor wins). */
  startedAt: number
  log?: (line: string) => void
  logError?: (line: string, err?: unknown) => void
}

const FUNDS_LOG_INTERVAL_MS = 60_000

export class BlackjackGreeter {
  private greetedThisRun = 0
  private lastFundsLogAt = 0
  private readonly now: () => number
  private readonly log: (line: string) => void
  private readonly logError: (line: string, err?: unknown) => void

  constructor(
    private readonly deps: BlackjackGreeterDeps,
    private readonly config: BlackjackGreeterConfig,
  ) {
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? (line => console.log(line))
    this.logError = deps.logError ?? ((line, err) => console.error(line, err))
  }

  get greetings(): number {
    return this.greetedThisRun
  }

  private capped(day: string): boolean {
    return (
      this.greetedThisRun >= this.config.maxPerRun ||
      this.deps.store.greetedOn(day) >= this.config.maxPerDay
    )
  }

  /** One poll of the registration feed. Never throws. Returns how many greetings were claimed. */
  async poll(): Promise<number> {
    const before = this.greetedThisRun
    try {
      await this.pollOnce()
    } catch (err) {
      this.logError('[blackjack-bot] greeting poll failed (continuing):', err)
    }
    return this.greetedThisRun - before
  }

  private async pollOnce(): Promise<void> {
    const { store, guard } = this.deps
    if (this.config.maxPerRun <= 0) return
    const day = dayKey(this.now())
    if (this.capped(day)) return
    const since = store.getSinceProfiles() ?? this.deps.startedAt
    const profiles = [...(await this.deps.listProfiles(since))].sort(
      (a, b) => a.registeredAt - b.registeredAt,
    )
    let cursor = since
    for (const profile of profiles) {
      if (this.capped(dayKey(this.now()))) {
        // Not consumed: a later run or day greets it. Hold the cursor ON this
        // profile. An earlier profile in this batch with the same timestamp has
        // already moved it to registeredAt + 1, and listProfiles is inclusive
        // of `since`, so leaving that +1 would skip this one forever.
        cursor = profile.registeredAt
        break
      }
      const skipReason = guard.profileBlockReason(
        profile.address,
        profile.signedPayload,
      )
      if (skipReason) {
        this.log(`[blackjack-bot] not greeting ${profile.address} (${skipReason})`)
      } else if (store.hasGreeted(profile.address)) {
        // Already greeted (an earlier run, or the cursor was re-read): never again.
      } else if (this.now() - profile.registeredAt > this.config.maxAgeMs) {
        this.log(
          `[blackjack-bot] not greeting ${profile.address} (registered more than ${this.config.maxAgeMs} ms ago)`,
        )
      } else {
        let affordable = false
        try {
          affordable = await this.deps.canAffordGreeting()
        } catch (err) {
          this.logError('[blackjack-bot] could not check the greeting funds:', err)
        }
        if (!affordable) {
          if (this.now() - this.lastFundsLogAt >= FUNDS_LOG_INTERVAL_MS) {
            this.lastFundsLogAt = this.now()
            this.log(
              `[blackjack-bot] dealer funds are short: skipping the greeting to ${profile.address} for now`,
            )
          }
          // Same cursor rule as the cap: do not step past this profile, even
          // when an earlier same-timestamp profile already did.
          cursor = profile.registeredAt
          break
        }
        // Durable BEFORE the send: at most once per address, and counted against the caps even if
        // the send fails.
        await store.claim(profile.address, dayKey(this.now()))
        this.greetedThisRun++
        this.log(`[blackjack-bot] greeting new profile ${profile.address}`)
        try {
          await this.deps.sendWelcome(profile)
        } catch (err) {
          this.logError(
            `[blackjack-bot] failed to greet ${profile.address} (not retried):`,
            err,
          )
        }
      }
      cursor = Math.max(cursor, profile.registeredAt + 1)
    }
    if (cursor > since) await store.setSinceProfiles(cursor)
  }
}

function nonNegativeIntEnv(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got "${raw}"`)
  }
  return value
}

/** `BLACKJACK_BOT_MAX_GREETINGS` (per run, default 5, 0 = never greet),
 * `BLACKJACK_BOT_MAX_GREETINGS_PER_DAY` (default 20),
 * `BLACKJACK_BOT_GREETING_MAX_AGE_MS` (default 24 h). */
export function greeterConfigFromEnv(
  env: Record<string, string | undefined>,
): BlackjackGreeterConfig {
  return {
    maxPerRun: nonNegativeIntEnv(
      env,
      'BLACKJACK_BOT_MAX_GREETINGS',
      DEFAULT_MAX_GREETINGS_PER_RUN,
    ),
    maxPerDay: nonNegativeIntEnv(
      env,
      'BLACKJACK_BOT_MAX_GREETINGS_PER_DAY',
      DEFAULT_MAX_GREETINGS_PER_DAY,
    ),
    maxAgeMs: nonNegativeIntEnv(
      env,
      'BLACKJACK_BOT_GREETING_MAX_AGE_MS',
      DEFAULT_GREETING_MAX_AGE_MS,
    ),
  }
}
