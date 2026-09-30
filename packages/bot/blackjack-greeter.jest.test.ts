import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import __pb_signed_payload_payload_pb from '@frank/cashweb/signed_payload/payload_pb'
const { SignedPayload } = __pb_signed_payload_payload_pb
import __pb_registry_metadata_pb from '@frank/cashweb/registry/metadata_pb'
const { AddressMetadata, Entry } = __pb_registry_metadata_pb

import {
  BLACKJACK_RULES_SUMMARY,
  parseBlackjackWelcome,
} from '@frank/wallet/message-item-plugins/blackjack/game'

import { BotLoopGuard } from './bot-loop-guard'
import {
  BlackjackGreeter,
  BlackjackGreeterConfig,
  BlackjackGreetingStore,
  dayKey,
  GreeterProfile,
  greeterConfigFromEnv,
  welcomeItems,
} from './blackjack-greeter'

const DEALER = `0x${'d1'.repeat(20)}`
const DENIED = `0x${'de'.repeat(20)}`
const BOT = `0x${'b0'.repeat(20)}`
const NOW = Date.UTC(2026, 8, 30, 12, 0, 0)
const HOUR = 60 * 60 * 1000

function addr(n: number): string {
  return `0x${n.toString(16).padStart(40, '0')}`
}

function payload(bot = false) {
  const metadata = new AddressMetadata()
  metadata.setEntriesList(
    bot
      ? [
          (() => {
            const entry = new Entry()
            entry.setKind('bot')
            entry.setBody(new TextEncoder().encode('1'))
            return entry
          })(),
        ]
      : [],
  )
  const signed = new SignedPayload()
  signed.setPayload(metadata.serializeBinary())
  return signed
}

function profile(
  address: string,
  registeredAt = NOW - 1000,
  bot = false,
): GreeterProfile {
  return { address, signedPayload: payload(bot), registeredAt }
}

const CONFIG: BlackjackGreeterConfig = {
  maxPerRun: 5,
  maxPerDay: 20,
  maxAgeMs: 24 * HOUR,
}

describe('BlackjackGreeter', () => {
  let directory: string
  let stores: BlackjackGreetingStore[]
  let feed: GreeterProfile[]
  let sent: string[]
  let now: number
  let affordable: boolean
  let failSend: boolean

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'blackjack-greeter-'))
    stores = []
    feed = []
    sent = []
    now = NOW
    affordable = true
    failSend = false
    jest.spyOn(console, 'log').mockImplementation(() => undefined)
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(async () => {
    await Promise.all(stores.map(store => store.Close()))
    rmSync(directory, { recursive: true, force: true })
    jest.restoreAllMocks()
  })

  async function openStore() {
    const store = new BlackjackGreetingStore(directory)
    await store.Open()
    stores.push(store)
    return store
  }

  async function makeGreeter(
    config: Partial<BlackjackGreeterConfig> = {},
    store?: BlackjackGreetingStore,
  ) {
    const guard = new BotLoopGuard({
      selfAddress: DEALER,
      relayBaseUrl: 'http://relay.test',
      denylist: [DENIED],
    })
    const greeter = new BlackjackGreeter(
      {
        store: store ?? (await openStore()),
        guard,
        startedAt: NOW - HOUR,
        now: () => now,
        listProfiles: async since => feed.filter(p => p.registeredAt >= since),
        canAffordGreeting: async () => affordable,
        sendWelcome: async p => {
          if (failSend) throw new Error('insufficient funds for gas')
          sent.push(p.address)
        },
      },
      { ...CONFIG, ...config },
    )
    return greeter
  }

  it('greets a new registration once, however often the feed is polled', async () => {
    feed = [profile(addr(1))]
    const greeter = await makeGreeter()
    expect(await greeter.poll()).toBe(1)
    expect(await greeter.poll()).toBe(0)
    expect(await greeter.poll()).toBe(0)
    expect(sent).toEqual([addr(1)])
  })

  it('never re-greets an address, even when the cursor is lost or it is re-listed after a restart', async () => {
    feed = [profile(addr(1)), profile(addr(2), NOW - 500)]
    const first = await makeGreeter()
    await first.poll()
    expect(sent).toEqual([addr(1), addr(2)])
    await stores[0].Close()
    stores.length = 0

    // A restart with the same directory, and a feed that lists the same addresses again
    // (re-registration under the same address, or a cursor rewound by an operator override).
    const store = await openStore()
    expect(store.hasGreeted(addr(1))).toBe(true)
    expect(store.getSinceProfiles()).toBeGreaterThan(NOW - 500)
    const second = await makeGreeter({}, store)
    await second.poll()
    // Force the rewound case too: the durable greeted record alone must stop it.
    await store.setSinceProfiles(0)
    await second.poll()
    expect(sent).toEqual([addr(1), addr(2)])
  })

  it('remembers the per-address record across restarts even when the send was attempted just before a crash', async () => {
    feed = [profile(addr(3))]
    // The claim is durable before the send: a send that never finishes (crash) is not retried.
    const store = await openStore()
    await store.claim(addr(3), dayKey(NOW))
    await store.Close()
    stores.length = 0
    const greeter = await makeGreeter()
    await greeter.poll()
    expect(sent).toEqual([])
  })

  it('claims the address durably BEFORE sending it', async () => {
    feed = [profile(addr(4))]
    const store = await openStore()
    const order: string[] = []
    const claim = store.claim.bind(store)
    store.claim = async (a, d) => {
      order.push('claim')
      return claim(a, d)
    }
    const greeter = new BlackjackGreeter(
      {
        store,
        guard: new BotLoopGuard({
          selfAddress: DEALER,
          relayBaseUrl: 'http://relay.test',
        }),
        startedAt: NOW - HOUR,
        now: () => now,
        listProfiles: async () => feed,
        canAffordGreeting: async () => true,
        sendWelcome: async () => {
          order.push(`send(greeted=${store.hasGreeted(addr(4))})`)
        },
      },
      CONFIG,
    )
    await greeter.poll()
    expect(order).toEqual(['claim', 'send(greeted=true)'])
  })

  it('does not send when the durable record cannot be written', async () => {
    feed = [profile(addr(5))]
    const store = await openStore()
    store.claim = async () => {
      throw new Error('disk full')
    }
    const greeter = await makeGreeter({}, store)
    expect(await greeter.poll()).toBe(0)
    expect(sent).toEqual([])
  })

  it('skips itself, the denylist and bot-marked profiles, and does not spend a greeting on them', async () => {
    feed = [
      profile(DEALER),
      profile(DENIED),
      profile(BOT, NOW - 900, true),
      profile(addr(6), NOW - 800),
    ]
    const greeter = await makeGreeter({ maxPerRun: 1 })
    await greeter.poll()
    expect(sent).toEqual([addr(6)])
    expect(greeter.greetings).toBe(1)
    const store = stores[0]
    expect(store.hasGreeted(BOT)).toBe(false)
    expect(store.hasGreeted(DENIED)).toBe(false)
    expect(store.hasGreeted(DEALER)).toBe(false)
  })

  it('stops at the per-run cap and leaves the rest for a later run', async () => {
    feed = [
      profile(addr(1), NOW - 3000),
      profile(addr(2), NOW - 2000),
      profile(addr(3), NOW - 1000),
    ]
    const greeter = await makeGreeter({ maxPerRun: 2 })
    await greeter.poll()
    await greeter.poll()
    expect(sent).toEqual([addr(1), addr(2)])

    // A new run (fresh greeter, same store) picks the third one up: it was not consumed.
    const next = await makeGreeter({ maxPerRun: 2 }, stores[0])
    await next.poll()
    expect(sent).toEqual([addr(1), addr(2), addr(3)])
  })

  it('stops at the per-day cap across restarts and resumes the next UTC day', async () => {
    feed = [
      profile(addr(1), NOW - 3000),
      profile(addr(2), NOW - 2000),
      profile(addr(3), NOW - 1000),
    ]
    const greeter = await makeGreeter({ maxPerDay: 2 })
    await greeter.poll()
    expect(sent).toEqual([addr(1), addr(2)])
    await stores[0].Close()
    stores.length = 0

    const restarted = await makeGreeter({ maxPerDay: 2 })
    await restarted.poll()
    expect(sent).toEqual([addr(1), addr(2)])

    now = NOW + 13 * HOUR // the next UTC day
    await restarted.poll()
    expect(sent).toEqual([addr(1), addr(2), addr(3)])
  })

  it('counts a failed send against the caps and never retries it', async () => {
    feed = [profile(addr(1), NOW - 2000), profile(addr(2), NOW - 1000)]
    failSend = true
    const greeter = await makeGreeter({ maxPerRun: 1 })
    expect(await greeter.poll()).toBe(1)
    failSend = false
    expect(await greeter.poll()).toBe(0)
    expect(sent).toEqual([])
    expect(stores[0].hasGreeted(addr(1))).toBe(true)
  })

  it('fails safe when the dealer cannot afford a greeting: skips, logs, keeps the profile for later, never throws', async () => {
    feed = [profile(addr(1))]
    affordable = false
    const greeter = await makeGreeter()
    await expect(greeter.poll()).resolves.toBe(0)
    expect(sent).toEqual([])
    expect(stores[0].hasGreeted(addr(1))).toBe(false)
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('funds are short'),
    )
    // Funded later: greeted then (the registration was not consumed).
    affordable = true
    expect(await greeter.poll()).toBe(1)
    expect(sent).toEqual([addr(1)])
  })

  it('does not crash when the funds check or the registration feed throws', async () => {
    feed = [profile(addr(1))]
    const store = await openStore()
    const greeter = new BlackjackGreeter(
      {
        store,
        guard: new BotLoopGuard({
          selfAddress: DEALER,
          relayBaseUrl: 'http://relay.test',
        }),
        startedAt: NOW - HOUR,
        now: () => now,
        listProfiles: async () => {
          throw new Error('relay down')
        },
        canAffordGreeting: async () => true,
        sendWelcome: async () => undefined,
      },
      CONFIG,
    )
    await expect(greeter.poll()).resolves.toBe(0)

    const throwingFunds = new BlackjackGreeter(
      {
        store,
        guard: new BotLoopGuard({
          selfAddress: DEALER,
          relayBaseUrl: 'http://relay.test',
        }),
        startedAt: NOW - HOUR,
        now: () => now,
        listProfiles: async () => feed,
        canAffordGreeting: async () => {
          throw new Error('rpc down')
        },
        sendWelcome: async () => undefined,
      },
      CONFIG,
    )
    await expect(throwingFunds.poll()).resolves.toBe(0)
    expect(store.hasGreeted(addr(1))).toBe(false)
  })

  it('drops a registration older than the maximum age instead of greeting it late', async () => {
    feed = [profile(addr(1), NOW - 25 * HOUR)]
    const greeter = await makeGreeter()
    await stores[0].setSinceProfiles(0)
    expect(await greeter.poll()).toBe(0)
    expect(sent).toEqual([])
  })

  it('does not greet before the first-run start and resumes from the persisted cursor', async () => {
    feed = [profile(addr(1), NOW - 2 * HOUR)] // before startedAt (NOW - 1h)
    const greeter = await makeGreeter()
    await greeter.poll()
    expect(sent).toEqual([])
  })

  it('never greets when the per-run cap is 0', async () => {
    feed = [profile(addr(1))]
    const greeter = await makeGreeter({ maxPerRun: 0 })
    await greeter.poll()
    expect(sent).toEqual([])
  })
})

describe('welcomeItems and configuration', () => {
  it('builds a welcome item from the bot table plus a trailing text line', () => {
    const items = welcomeItems({
      minWagerWei: 2n * 10n ** 16n,
      maxWagerWei: 3n * 10n ** 17n,
      stampValueWei: 10n ** 16n,
    })
    expect(items).toHaveLength(2)
    // The text is LAST: an older client's chat-list preview reads the last item.
    expect(items[1].type).toBe('text')
    const welcome = items[0] as { action: string }
    expect(welcome.action).toBe('welcome')
    expect(parseBlackjackWelcome(items[0] as never)).toEqual({
      minWagerWei: 2n * 10n ** 16n,
      maxWagerWei: 3n * 10n ** 17n,
      feeHintWei: 10n ** 16n + 5n * 10n ** 16n,
      rules: BLACKJACK_RULES_SUMMARY.slice(0, 400),
    })
    expect((items[1] as { text: string }).text).toContain('0.02 MON')
  })

  it('reads the caps from the environment and rejects garbage', () => {
    expect(greeterConfigFromEnv({})).toEqual({
      maxPerRun: 5,
      maxPerDay: 20,
      maxAgeMs: 24 * HOUR,
    })
    expect(
      greeterConfigFromEnv({
        BLACKJACK_BOT_MAX_GREETINGS: '0',
        BLACKJACK_BOT_MAX_GREETINGS_PER_DAY: '3',
      }),
    ).toMatchObject({ maxPerRun: 0, maxPerDay: 3 })
    expect(() =>
      greeterConfigFromEnv({ BLACKJACK_BOT_MAX_GREETINGS: '-1' }),
    ).toThrow(/BLACKJACK_BOT_MAX_GREETINGS/)
  })
})
