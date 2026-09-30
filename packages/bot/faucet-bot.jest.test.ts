import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import __pb_signed_payload_payload_pb from '@frank/cashweb/signed_payload/payload_pb'
const { SignedPayload } = __pb_signed_payload_payload_pb
import __pb_registry_metadata_pb from '@frank/cashweb/registry/metadata_pb'
const { AddressMetadata, Entry } = __pb_registry_metadata_pb

import { BotLoopGuard } from './bot-loop-guard'
import {
  assertTestnet,
  DAY_MS,
  faucetAdmin,
  faucetSettingsFromEnv,
  keyFilePermissionWarning,
  MAX_PROFILE_FAILURES,
  stateDirWarning,
  Faucet,
  FaucetConfig,
  FaucetDeps,
  faucetConfigFromEnv,
  MAX_AMOUNT_WEI,
} from './faucet-core'
import { FaucetStateStore } from './faucet-state'

const FAUCET = `0x${'ff'.repeat(20)}`
const ALICE = `0x${'a1'.repeat(20)}`
const BOB = `0x${'b2'.repeat(20)}`
const CAROL = `0x${'c3'.repeat(20)}`
const BOT = `0x${'d4'.repeat(20)}`
const AMOUNT = 50n

function profile(address: string, timestamp: number, bot = false) {
  const metadata = new AddressMetadata()
  metadata.setTimestamp(timestamp)
  if (bot) {
    const entry = new Entry()
    entry.setKind('bot')
    entry.setBody(new TextEncoder().encode('1'))
    metadata.setEntriesList([entry])
  }
  const signed = new SignedPayload()
  signed.setPayload(metadata.serializeBinary())
  return { address, signedPayload: signed }
}

describe('Faucet', () => {
  let dir: string
  let store: FaucetStateStore
  let now: number
  let sent: Array<{ to: string; rawTx: string }>
  let signCount: number
  let balances: Map<string, bigint>
  let logs: string[]

  const config: FaucetConfig = {
    amountWei: AMOUNT,
    maxPerRun: 10,
    maxPerDay: 20,
    minReserveWei: 100n,
  }

  function makeFaucet(overrides: Partial<FaucetDeps> = {}, cfg = config) {
    return new Faucet({
      store,
      config: cfg,
      guard: new BotLoopGuard({
        selfAddress: FAUCET,
        relayBaseUrl: 'http://relay.test',
        denylist: [CAROL],
      }),
      faucetAddress: FAUCET,
      now: () => now,
      signTransfer: async (to, value) => {
        signCount++
        return { rawTx: `0xraw-${to}-${value}`, txHash: `0xhash-${to}` }
      },
      submitRaw: async tx => {
        sent.push({ to: tx.txHash.replace('0xhash-', ''), rawTx: tx.rawTx })
      },
      waitForConfirmation: async () => undefined,
      getTxStatus: async () => 'pending',
      log: message => logs.push(message),
      getBalance: async address => balances.get(address) ?? 0n,
      ...overrides,
    })
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'frank-faucet-'))
    store = new FaucetStateStore(dir)
    await store.Open()
    now = 1_000_000
    sent = []
    signCount = 0
    logs = []
    balances = new Map([[FAUCET, 10_000n]])
  })

  afterEach(async () => {
    await store.Close().catch(() => undefined)
    rmSync(dir, { recursive: true, force: true })
  })

  it('funds a new human once and never again, even if it is polled repeatedly', async () => {
    const faucet = makeFaucet()
    const batch = [profile(ALICE, 10)]
    expect((await faucet.pollOnce(batch, 0)).cursor).toBe(10)
    await faucet.pollOnce(batch, 0)
    await faucet.pollOnce(batch, 0)
    expect(sent).toHaveLength(1)
    expect(signCount).toBe(1)
    expect(store.get(ALICE)?.state).toBe('confirmed')
    expect(store.get(ALICE)?.amountWei).toBe('50')
  })

  it('never funds an address twice across restarts and address casing', async () => {
    await makeFaucet().pollOnce([profile(ALICE, 10)], 0)
    await store.Close()
    store = new FaucetStateStore(dir)
    await store.Open()
    const restarted = makeFaucet()
    const upper = `0x${ALICE.slice(2).toUpperCase()}`
    await restarted.pollOnce([profile(upper, 10)], 0)
    expect(sent).toHaveLength(1)
    expect(restarted.fundedThisRun).toBe(0)
  })

  it('does not fund itself, denylisted addresses, bots, or addresses that already have funds', async () => {
    balances.set(BOB, AMOUNT)
    const faucet = makeFaucet()
    const outcomes = await Promise.all(
      [
        profile(FAUCET, 1),
        profile(CAROL, 2),
        profile(BOT, 3, true),
        profile(BOB, 4),
      ].map(p => faucet.handleProfile(p.address, p.signedPayload)),
    )
    expect(
      outcomes.map(o => (o.status === 'skipped' ? o.reason : o.status)),
    ).toEqual(['self', 'denylisted', 'bot-profile', 'has-funds'])
    expect(sent).toHaveLength(0)
  })

  it('persists the exact signed transaction before broadcasting', async () => {
    let recordAtBroadcast: unknown
    const faucet = makeFaucet({
      submitRaw: async tx => {
        recordAtBroadcast = store.get(ALICE)
        sent.push({ to: ALICE, rawTx: tx.rawTx })
      },
    })
    await faucet.pollOnce([profile(ALICE, 10)], 0)
    expect(recordAtBroadcast).toMatchObject({
      state: 'signed',
      txHash: `0xhash-${ALICE}`,
      rawTx: `0xraw-${ALICE}-50`,
    })
  })

  it('replays the exact bytes after a crash mid-broadcast and never re-signs or double-pays', async () => {
    let fail = true
    const submitted: string[] = []
    const deps = {
      submitRaw: async (tx: { rawTx: string }) => {
        if (fail) throw new Error('rpc down')
        submitted.push(tx.rawTx)
      },
    }
    const first = makeFaucet(deps)
    const result = await first.pollOnce([profile(ALICE, 10)], 0)
    expect(result).toEqual({ cursor: 0, stopped: 'error' })
    expect(store.get(ALICE)?.state).toBe('signed')

    // Process restart against the same durable state.
    await store.Close()
    store = new FaucetStateStore(dir)
    await store.Open()
    fail = false
    const second = makeFaucet(deps)
    expect(await second.recoverSigned()).toBe(1)
    await second.pollOnce([profile(ALICE, 10)], 0) // re-polled: already funded, no new tx
    expect(submitted).toEqual([`0xraw-${ALICE}-50`]) // the original bytes, once
    expect(signCount).toBe(1)
    expect(store.get(ALICE)?.state).toBe('submitted')
  })

  it('stops the batch at the per-run cap without consuming the profile behind it', async () => {
    const faucet = makeFaucet({}, { ...config, maxPerRun: 1 })
    const result = await faucet.pollOnce(
      [profile(ALICE, 10), profile(BOB, 20)],
      0,
    )
    expect(result).toEqual({ cursor: 10, stopped: 'run-cap' })
    expect(sent).toHaveLength(1)
    expect(store.get(BOB)).toBeUndefined()
  })

  it('enforces the rolling daily cap across runs, then resumes when the window passes', async () => {
    const capped = { ...config, maxPerDay: 1 }
    await makeFaucet({}, capped).pollOnce([profile(ALICE, 10)], 0)
    // A fresh process (per-run counter reset) still sees today's persisted funding.
    const next = makeFaucet({}, capped)
    expect(await next.pollOnce([profile(BOB, 20)], 10)).toEqual({
      cursor: 10,
      stopped: 'daily-cap',
    })
    expect(store.get(BOB)).toBeUndefined()
    now += DAY_MS + 1
    expect((await next.pollOnce([profile(BOB, 20)], 10)).cursor).toBe(20)
    expect(store.get(BOB)?.state).toBe('confirmed')
  })

  it('never spends below the reserve', async () => {
    balances.set(FAUCET, AMOUNT + config.minReserveWei - 1n)
    const faucet = makeFaucet()
    expect(await faucet.pollOnce([profile(ALICE, 10)], 0)).toEqual({
      cursor: 0,
      stopped: 'faucet-low',
    })
    expect(signCount).toBe(0)
    balances.set(FAUCET, AMOUNT + config.minReserveWei)
    await faucet.pollOnce([profile(ALICE, 10)], 0)
    expect(sent).toHaveLength(1)
  })

  it('does not advance the cursor past a profile it failed to sign for, and retries it', async () => {
    let failSign = true
    const faucet = makeFaucet({
      signTransfer: async (to, value) => {
        if (failSign) throw new Error('rpc down')
        return { rawTx: `0xraw-${to}-${value}`, txHash: `0xhash-${to}` }
      },
    })
    expect(await faucet.pollOnce([profile(ALICE, 10)], 0)).toEqual({
      cursor: 0,
      stopped: 'error',
    })
    expect(store.get(ALICE)).toBeUndefined()
    failSign = false
    await faucet.pollOnce([profile(ALICE, 10)], 0)
    expect(sent).toHaveLength(1)
  })

  it('serializes concurrent handling of the same address in two casings: one transfer', async () => {
    const faucet = makeFaucet({
      // Yield inside the check so an unserialized implementation would interleave.
      getBalance: async address => {
        await new Promise(resolve => setTimeout(resolve, 5))
        return balances.get(address) ?? 0n
      },
    })
    const upper = `0x${ALICE.slice(2).toUpperCase()}`
    const results = await Promise.all([
      faucet.handleProfile(ALICE, profile(ALICE, 10).signedPayload),
      faucet.handleProfile(upper, profile(upper, 10).signedPayload),
    ])
    expect(results.map(r => r.status).sort()).toEqual(['funded', 'skipped'])
    expect(signCount).toBe(1)
    expect(sent).toHaveLength(1)
  })

  it('does not sign a new transfer while an earlier one is still unsettled', async () => {
    const faucet = makeFaucet({
      submitRaw: async () => {
        throw new Error('rpc down')
      },
    })
    await faucet.pollOnce([profile(ALICE, 10)], 0)
    expect(store.get(ALICE)?.state).toBe('signed')
    signCount = 0
    expect(await faucet.pollOnce([profile(BOB, 20)], 0)).toEqual({
      cursor: 0,
      stopped: 'unsettled',
    })
    expect(signCount).toBe(0)
    expect(store.get(BOB)).toBeUndefined()
  })

  it('a rejected replay that was actually mined settles the record, quietly', async () => {
    const rejecting = {
      submitRaw: async () => {
        throw new Error('already known')
      },
    }
    const faucet = makeFaucet(rejecting)
    await faucet.pollOnce([profile(ALICE, 10)], 0)
    const mined = makeFaucet({
      ...rejecting,
      getTxStatus: async () => 'confirmed',
    })
    expect(await mined.recoverSigned()).toBe(1)
    expect(store.get(ALICE)?.state).toBe('confirmed')
    // and the next transfer is no longer blocked
    await makeFaucet().pollOnce([profile(BOB, 20)], 0)
    expect(store.get(BOB)?.state).toBe('confirmed')
  })

  it('a rejected replay with no receipt is logged once, not on every poll', async () => {
    const faucet = makeFaucet({
      submitRaw: async () => {
        throw new Error('nonce too low')
      },
    })
    await faucet.pollOnce([profile(ALICE, 10)], 0)
    logs.length = 0
    for (let i = 0; i < 5; i++) await faucet.recoverSigned()
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('--clear')
    expect(store.get(ALICE)?.state).toBe('signed')
  })

  it('a replay that was mined but reverted is marked failed and stops blocking others', async () => {
    const rejecting = {
      submitRaw: async () => {
        throw new Error('nonce too low')
      },
    }
    await makeFaucet(rejecting).pollOnce([profile(ALICE, 10)], 0)
    await makeFaucet({
      ...rejecting,
      getTxStatus: async () => 'failed',
    }).recoverSigned()
    expect(store.get(ALICE)?.state).toBe('failed')
    expect(store.signedRecords()).toHaveLength(0)
  })

  it('skips a profile that deterministically fails after N tries, records it, and moves on', async () => {
    const bad = `0x${'e5'.repeat(20)}`
    const faucet = makeFaucet({
      getBalance: async address => {
        if (address === bad) throw new Error('bad address')
        return balances.get(address) ?? 0n
      },
    })
    const batch = [profile(bad, 10), profile(ALICE, 20)]
    for (let i = 1; i < MAX_PROFILE_FAILURES; i++) {
      expect(await faucet.pollOnce(batch, 0)).toEqual({
        cursor: 0,
        stopped: 'error',
      })
    }
    expect((await faucet.pollOnce(batch, 0)).cursor).toBe(20)
    expect(store.get(bad)?.state).toBe('skipped')
    expect(store.get(ALICE)?.state).toBe('confirmed')
    expect(store.countSince(0)).toBe(1) // the skipped profile does not use the daily budget
  })

  it('does not blame a profile for an RPC outage', async () => {
    let down = true
    const faucet = makeFaucet({
      getBalance: async address => {
        if (down) throw new Error('rpc down')
        return balances.get(address) ?? 0n
      },
    })
    for (let i = 0; i < MAX_PROFILE_FAILURES + 2; i++) {
      expect((await faucet.pollOnce([profile(ALICE, 10)], 0)).stopped).toBe(
        'rpc-down',
      )
    }
    expect(store.get(ALICE)).toBeUndefined()
    down = false
    await faucet.pollOnce([profile(ALICE, 10)], 0)
    expect(store.get(ALICE)?.state).toBe('confirmed')
  })

  it('operator can list and clear a stuck record, but not a paid one', async () => {
    await makeFaucet().pollOnce([profile(BOB, 20)], 0)
    await makeFaucet({
      submitRaw: async () => {
        throw new Error('x')
      },
    }).pollOnce([profile(ALICE, 10)], 0)
    expect((await faucetAdmin(store, ['--list-stuck']))![0]).toContain(
      'state=signed',
    )
    expect((await faucetAdmin(store, ['--clear', BOB]))![0]).toContain(
      'refusing',
    )
    expect(store.get(BOB)).toBeDefined()
    expect((await faucetAdmin(store, ['--clear', ALICE]))![0]).toContain(
      'cleared',
    )
    expect(store.get(ALICE)).toBeUndefined()
    expect(await faucetAdmin(store, ['--list-stuck'])).toEqual([
      'no stuck records',
    ])
    expect(await faucetAdmin(store, [])).toBeUndefined()
  })
})

describe('faucetConfigFromEnv', () => {
  it('has small testnet defaults', () => {
    const config = faucetConfigFromEnv({})
    expect(config.amountWei).toBe(50_000_000_000_000_000n)
    expect(config.maxPerRun).toBe(10)
    expect(config.maxPerDay).toBe(20)
  })

  it('refuses an amount above the hard ceiling, zero, or junk', () => {
    expect(() =>
      faucetConfigFromEnv({
        FAUCET_AMOUNT_WEI: (MAX_AMOUNT_WEI + 1n).toString(),
      }),
    ).toThrow(/hard ceiling/)
    expect(
      faucetConfigFromEnv({ FAUCET_AMOUNT_WEI: MAX_AMOUNT_WEI.toString() })
        .amountWei,
    ).toBe(MAX_AMOUNT_WEI)
    expect(() => faucetConfigFromEnv({ FAUCET_AMOUNT_WEI: '0' })).toThrow()
    expect(() => faucetConfigFromEnv({ FAUCET_MAX_PER_DAY: '-1' })).toThrow()
    expect(() => faucetConfigFromEnv({ FAUCET_MAX_PER_RUN: 'ten' })).toThrow()
  })
})

describe('faucetSettingsFromEnv', () => {
  const settings = (env: Record<string, string>) =>
    faucetSettingsFromEnv(env, '/home/u')

  it('defaults to a persistent per-user state dir and sane limits', () => {
    const result = settings({})
    expect(result.stateDir).toBe('/home/u/.frank-faucet')
    expect(result.pollIntervalMs).toBe(4000)
    expect(result.profileSinceMs).toBeUndefined()
    expect(settings({ FAUCET_STATE_DIR: '/var/lib/faucet' }).stateDir).toBe(
      '/var/lib/faucet',
    )
  })

  it.each([
    ['FAUCET_POLL_INTERVAL_MS', 'abc'],
    ['FAUCET_POLL_INTERVAL_MS', '0'],
    ['FAUCET_POLL_INTERVAL_MS', '1'],
    ['FAUCET_PROFILE_SINCE_MS', 'yesterday'],
    ['FAUCET_PROFILE_SINCE_MS', '-5'],
    ['FAUCET_MAX_PER_DAY', '0'],
    ['FAUCET_MAX_PER_DAY', '100000'],
    ['FAUCET_MAX_PER_RUN', '0'],
    ['FAUCET_MIN_RESERVE_WEI', '0'],
    ['FAUCET_MIN_RESERVE_WEI', '1'],
    ['FAUCET_AMOUNT_WEI', '1.5'],
  ])('refuses %s=%s at startup with a clear message', (name, value) => {
    expect(() => settings({ [name]: value })).toThrow(new RegExp(name))
  })

  it('accepts a first-run cursor override', () => {
    expect(settings({ FAUCET_PROFILE_SINCE_MS: '0' }).profileSinceMs).toBe(0)
  })
})

describe('startup safety checks', () => {
  it('assertTestnet requires both the MONT tag and chain id 10143', () => {
    expect(() =>
      assertTestnet({ networkTag: 'MONT', chainId: 10143n }),
    ).not.toThrow()
    expect(() =>
      assertTestnet({ networkTag: 'MON1', chainId: 10143n }),
    ).toThrow(/testnet-only/)
    expect(() => assertTestnet({ networkTag: 'MONT', chainId: 143n })).toThrow(
      /chain id 143/,
    )
    expect(() => assertTestnet({ networkTag: '', chainId: 10143n })).toThrow()
  })

  it('warns when the state dir is under a temporary directory only', () => {
    const tmps = ['/tmp', '/var/folders/x/T']
    expect(stateDirWarning('/tmp/faucet-state', tmps)).toMatch(/temporary/)
    expect(stateDirWarning('/var/folders/x/T/a/b', tmps)).toMatch(/temporary/)
    expect(stateDirWarning('/tmp', tmps)).toMatch(/temporary/)
    expect(stateDirWarning('/home/u/.frank-faucet', tmps)).toBeUndefined()
    expect(stateDirWarning('/tmpfoo/x', tmps)).toBeUndefined()
  })

  it('warns when the wallet file is group/world accessible', () => {
    expect(keyFilePermissionWarning('/w.json', 0o100600)).toBeUndefined()
    expect(keyFilePermissionWarning('/w.json', 0o100640)).toMatch(/chmod 600/)
    expect(keyFilePermissionWarning('/w.json', 0o100604)).toMatch(/chmod 600/)
  })
})
