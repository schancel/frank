import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bytesToHex } from '@noble/hashes/utils.js'
import { MonadIdentity } from '../../wallet/evm-identity'
import { encodeSignedSwapEvent, type SwapResult } from './index'
import {
  buildNegotiationOffer,
  buildNegotiationResponse,
  TESTNET_NEGOTIATION_POLICY,
  type NegotiationContext,
} from './negotiation'
import {
  NegotiationRecovery,
  type NegotiationEnvelope,
  type NegotiationRecoveryOptions,
} from './runtime'
import { createNativeNegotiationJournalStore } from './storage/negotiation-native'
import type { OwnedNegotiationJournalStore } from './storage/negotiation-common'
import { NegotiationJournalError } from './negotiation-journal'
const a = MonadIdentity.fromPrivateKeyHex(`0x${'00'.repeat(31)}01`)
const b = MonadIdentity.fromPrivateKeyHex(`0x${'00'.repeat(31)}02`)
const must = <T>(result: SwapResult<T>): T => {
  if (!result.ok) throw new Error(result.error.code)
  return result.value
}
const sign = (who: MonadIdentity) => async (digest: Uint8Array) =>
  new Uint8Array(who.signHash(Buffer.from(digest)))
const context: NegotiationContext = {
  swapId: new Uint8Array(32).fill(1),
  conversationId: new Uint8Array(16).fill(2),
  parties: [a.compressedPubKey, b.compressedPubKey],
  policy: TESTNET_NEGOTIATION_POLICY,
}
const uuid = '02020202-0202-0202-0202-020202020202'
async function signed() {
  const offer = must(
    encodeSignedSwapEvent(
      must(
        await buildNegotiationOffer(
          context,
          { xecPrincipal: 100n, evmPrincipal: 200n, expiry: 2000000000n },
          sign(a),
        ),
      ),
    ),
  )
  const response = must(
    encodeSignedSwapEvent(
      must(await buildNegotiationResponse(context, offer, 'accept', sign(b))),
    ),
  )
  return { offer, response }
}
function envelope(bytes: Uint8Array, outbound = true): NegotiationEnvelope {
  return {
    chainIdentifier: 'monad-testnet',
    senderPublicKey: outbound ? a.compressedPubKey : b.compressedPubKey,
    recipientPublicKey: outbound ? b.compressedPubKey : a.compressedPubKey,
    direction: outbound ? 'outbound' : 'incoming',
    payloadDigest: 'ab'.repeat(32),
    conversationId: uuid,
    messageId: uuid,
    items: [
      {
        type: 'application',
        itemType: 'swap-negotiation-v1',
        value: { eventHex: bytesToHex(bytes) },
      },
    ],
  }
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('Recovery did not reach state')
}
let root: string
let live: NegotiationRecovery[]
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'host-negotiation-'))
  live = []
})
afterEach(async () => {
  await Promise.all(live.map((item) => item.stop()))
  await rm(root, { recursive: true, force: true })
})
function options(
  overrides: Partial<NegotiationRecoveryOptions> = {},
): NegotiationRecoveryOptions {
  return {
    owner: {
      accountIncarnation: 'test-owner',
      localPublicKey: a.compressedPubKey,
      messagingChainIdentifier: 'monad-testnet',
    },
    policy: TESTNET_NEGOTIATION_POLICY,
    openStore: () =>
      createNativeNegotiationJournalStore({
        hostDiscriminator: 'bot',
        accountIncarnation: 'test-owner',
        localPublicKey: a.compressedPubKey,
        rootLocation: root,
      }),
    scan: async (since) => ({
      records: [],
      resumeFromInclusive: since,
      truncated: false,
    }),
    schedule: (work, delay) => {
      const timer = setTimeout(work, delay)
      return () => clearTimeout(timer)
    },
    publish: () => undefined,
    ...overrides,
  }
}
function start(input: NegotiationRecoveryOptions) {
  const runtime = new NegotiationRecovery(input)
  live.push(runtime)
  runtime.start()
  return runtime
}
test('qualified native restart recovers response-before-offer, duplicates and deleted presentation', async () => {
  const { offer, response } = await signed()
  const scan = jest.fn(async () => ({
    records: [envelope(response, false), envelope(offer), envelope(offer)],
    resumeFromInclusive: 10,
    truncated: false,
  }))
  const first = start(options({ scan }))
  await until(() => first.snapshot.state === 'ready')
  expect(first.snapshot.journals).toHaveLength(1)
  expect(first.snapshot.journals[0].reduction.usableAcceptance).not.toBeNull()
  expect(first.snapshot.journals[0].entries).toHaveLength(2)
  const copy = first.snapshot
  copy.journals[0].context.swapId.fill(99)
  expect(first.snapshot.journals[0].context.swapId[0]).toBe(1)
  await first.stop()
  const restartScan = jest.fn(async (since: number) => ({
    records: [],
    resumeFromInclusive: since,
    truncated: false,
  }))
  const second = start(options({ scan: restartScan }))
  await until(() => second.snapshot.state === 'ready')
  expect(restartScan).toHaveBeenCalledWith(10)
  expect(second.snapshot.journals[0].reduction.usableAcceptance).not.toBeNull()
})
test('an ambiguous durable admission pins coverage; reopening replays the earlier event', async () => {
  const { offer } = await signed()
  let fail = true
  const original = options()
  const first = start(
    options({
      scan: async () => ({
        records: [envelope(offer)],
        resumeFromInclusive: 20,
        truncated: false,
      }),
      openStore: async () => {
        const store = await original.openStore()
        return {
          ...store,
          compareAndSwap: async (key, expected, next) => {
            const won = await store.compareAndSwap(key, expected, next)
            if (fail) {
              fail = false
              throw new Error('lost acknowledgement')
            }
            return won
          },
        }
      },
    }),
  )
  await until(() => first.snapshot.state === 'storage-error')
  await first.stop()
  const secondScan = jest.fn(async () => ({
    records: [envelope(offer)],
    resumeFromInclusive: 20,
    truncated: false,
  }))
  const second = start(options({ scan: secondScan }))
  await until(() => second.snapshot.state === 'ready')
  expect(secondScan).toHaveBeenCalledWith(0)
  expect(second.snapshot.journals[0].entries).toHaveLength(1)
})
test('hung scanning is revoked without waiting; late result neither admits nor commits', async () => {
  const { offer } = await signed()
  let finish!: (
    result: Awaited<ReturnType<NegotiationRecoveryOptions['scan']>>,
  ) => void
  const scan = jest.fn(
    () =>
      new Promise<Awaited<ReturnType<NegotiationRecoveryOptions['scan']>>>(
        (resolve) => {
          finish = resolve
        },
      ),
  )
  const first = start(options({ scan }))
  await until(() => scan.mock.calls.length === 1)
  await first.stop()
  finish({
    records: [envelope(offer)],
    resumeFromInclusive: 100,
    truncated: false,
  })
  await new Promise((resolve) => setImmediate(resolve))
  expect(await readdir(root)).toEqual([])
  const second = start(options())
  await until(() => second.snapshot.state === 'ready')
  expect(second.snapshot.journals).toEqual([])
})
test('invalid provenance and nested outbox content cannot enter; capacity never advances coverage', async () => {
  const { offer } = await signed()
  const record = envelope(offer)
  const runtime = start(
    options({
      scan: async () => ({
        records: [
          { ...record, messageId: undefined },
          {
            ...record,
            items: [{ type: 'outbox-message', value: record.items }],
          },
          { ...record, chainIdentifier: 'monad-mainnet' },
        ],
        resumeFromInclusive: 5,
        truncated: false,
      }),
    }),
  )
  await until(() => runtime.snapshot.state === 'ready')
  expect(runtime.snapshot.journals).toEqual([])
  await runtime.stop()
  const original = options()
  const full = start(
    options({
      scan: async () => ({
        records: [record],
        resumeFromInclusive: 30,
        truncated: false,
      }),
      openStore: async () => {
        const store = await original.openStore()
        return {
          ...store,
          compareAndSwap: async () => {
            throw new NegotiationJournalError('capacity', 'full')
          },
        } as OwnedNegotiationJournalStore
      },
    }),
  )
  await until(() => full.snapshot.state === 'capacity')
  expect(full.snapshot.coverage).toBe(5)
})
test('stop drains an owned admission without admitting coverage or publishing old completion', async () => {
  const { offer } = await signed()
  let release!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  let writing = false
  const original = options()
  const publish = jest.fn()
  const first = start(
    options({
      publish,
      scan: async () => ({
        records: [envelope(offer)],
        resumeFromInclusive: 20,
        truncated: false,
      }),
      openStore: async () => {
        const store = await original.openStore()
        return {
          ...store,
          compareAndSwap: async (key, expected, next) => {
            writing = true
            await blocked
            return store.compareAndSwap(key, expected, next)
          },
        }
      },
    }),
  )
  await until(() => writing)
  const count = publish.mock.calls.length
  let stopped = false
  const cleanup = first.stop().then(() => {
    stopped = true
  })
  await new Promise((resolve) => setImmediate(resolve))
  expect(stopped).toBe(false)
  release()
  await cleanup
  expect(publish).toHaveBeenCalledTimes(count)
  const restored = start(options())
  await until(() => restored.snapshot.state === 'ready')
  expect(restored.snapshot.journals[0].entries).toHaveLength(1)
  expect(restored.snapshot.coverage).toBe(0)
})
test('lost coverage CAS reads a committed winner; corruption is visible with no scan or mutation', async () => {
  const original = options()
  const first = start(
    options({
      scan: async () => ({
        records: [],
        resumeFromInclusive: 20,
        truncated: false,
      }),
      openStore: async () => {
        const store = await original.openStore()
        return {
          ...store,
          compareAndSwapCoverage: async (chain) => {
            await store.compareAndSwapCoverage(chain, undefined, 50)
            return false
          },
        }
      },
    }),
  )
  await until(() => first.snapshot.state === 'ready')
  expect(first.snapshot.coverage).toBe(50)
  await first.stop()
  const scan = jest.fn()
  const corrupt = start(
    options({
      scan,
      openStore: async () => {
        const store = await original.openStore()
        return {
          ...store,
          listRecords: async () => [{ key: 'ab'.repeat(32), raw: '{}' }],
        }
      },
    }),
  )
  await until(() => corrupt.snapshot.state === 'storage-error')
  expect(scan).not.toHaveBeenCalled()
})
test('equal-timestamp truncated pages use only scanner coverage, and retry is independently scheduled', async () => {
  const { offer } = await signed()
  const scheduled: { work: () => void; delay: number; canceled: boolean }[] = []
  const schedule = (work: () => void, delay: number) => {
    const task = { work, delay, canceled: false }
    scheduled.push(task)
    return () => {
      task.canceled = true
    }
  }
  const scan = jest
    .fn()
    .mockResolvedValueOnce({
      records: [envelope(offer)],
      resumeFromInclusive: 10,
      truncated: true,
    })
    .mockRejectedValueOnce(new Error('network'))
    .mockResolvedValue({
      records: [envelope(offer)],
      resumeFromInclusive: 10,
      truncated: false,
    })
  const runtime = start(options({ scan, schedule }))
  await until(() =>
    scheduled.some((task) => task.delay === 3000 && !task.canceled),
  )
  expect(runtime.snapshot.state).toBe('incomplete')
  expect(runtime.snapshot.coverage).toBe(10)
  scheduled.find((task) => task.delay === 3000 && !task.canceled)!.work()
  await until(
    () =>
      scan.mock.calls.length === 2 &&
      runtime.snapshot.state === 'incomplete' &&
      scheduled.filter((task) => task.delay === 3000 && !task.canceled)
        .length === 2,
  )
  scheduled.filter((task) => task.delay === 3000 && !task.canceled)[1].work()
  await until(
    () =>
      scan.mock.calls.length === 3 && runtime.snapshot.journals.length === 1,
  )
  expect(scan.mock.calls.map((call) => call[0])).toEqual([0, 10, 10])
  expect(runtime.snapshot.journals[0].entries).toHaveLength(1)
})
test('same-peer conversations remain separate and malformed original identities remain inert', async () => {
  const { offer } = await signed()
  const secondContext = {
    ...context,
    conversationId: new Uint8Array(16).fill(3),
  }
  const secondOffer = must(
    encodeSignedSwapEvent(
      must(
        await buildNegotiationOffer(
          secondContext,
          { xecPrincipal: 100n, evmPrincipal: 200n, expiry: 2000000000n },
          sign(a),
        ),
      ),
    ),
  )
  const first = envelope(offer)
  const second = {
    ...envelope(secondOffer),
    conversationId: '03030303-0303-0303-0303-030303030303',
  }
  const runtime = start(
    options({
      scan: async () => ({
        records: [
          first,
          second,
          { ...first, conversationId: undefined },
          { ...first, payloadDigest: '' },
        ],
        resumeFromInclusive: 10,
        truncated: false,
      }),
    }),
  )
  await until(() => runtime.snapshot.state === 'ready')
  expect(runtime.snapshot.journals).toHaveLength(2)
  expect(
    runtime.snapshot.journals
      .map((row) => bytesToHex(row.context.conversationId))
      .sort(),
  ).toEqual(['02'.repeat(16), '03'.repeat(16)])
})

function manualSchedule() {
  const tasks: { work: () => void; delay: number; canceled: boolean }[] = []
  return {
    tasks,
    schedule(work: () => void, delay: number) {
      const task = { work, delay, canceled: false }
      tasks.push(task)
      return () => {
        task.canceled = true
      }
    },
    has(delay: number) {
      return tasks.some((task) => task.delay === delay && !task.canceled)
    },
    fire(delay: number) {
      const task = tasks.find((task) => task.delay === delay && !task.canceled)
      if (!task) throw new Error(`Missing scheduled delay ${delay}`)
      task.canceled = true
      task.work()
    },
  }
}
test.each(['success', 'rejection'] as const)(
  'a timed-out scanner remains exclusive until late %s; retry starts from unchanged durable coverage',
  async (outcome) => {
    const { offer } = await signed()
    let resolve!: (
      result: Awaited<ReturnType<NegotiationRecoveryOptions['scan']>>,
    ) => void
    let reject!: (error: Error) => void
    const pending = new Promise<
      Awaited<ReturnType<NegotiationRecoveryOptions['scan']>>
    >((yes, no) => {
      resolve = yes
      reject = no
    })
    const scan = jest
      .fn()
      .mockImplementationOnce(() => pending)
      .mockResolvedValue({
        records: [],
        resumeFromInclusive: 20,
        truncated: false,
      })
    const clock = manualSchedule()
    const runtime = start(options({ scan, schedule: clock.schedule }))
    await until(() => scan.mock.calls.length === 1)
    clock.fire(30000)
    await until(() => clock.has(3000))
    expect(runtime.snapshot.state).toBe('incomplete')
    for (const [retry, next] of [
      [3000, 6000],
      [6000, 12000],
    ]) {
      clock.fire(retry)
      await until(() => clock.has(next) || scan.mock.calls.length > 1)
      expect(scan).toHaveBeenCalledTimes(1)
      expect(runtime.snapshot.state).toBe('incomplete')
      expect(runtime.snapshot.coverage).toBeUndefined()
    }
    if (outcome === 'success')
      resolve({
        records: [envelope(offer)],
        resumeFromInclusive: 999,
        truncated: false,
      })
    else reject(new Error('Late scanner rejection'))
    await new Promise((done) => setImmediate(done))
    expect(runtime.snapshot.journals).toEqual([])
    expect(runtime.snapshot.coverage).toBeUndefined()
    clock.fire(12000)
    await until(() => runtime.snapshot.state === 'ready')
    expect(scan.mock.calls.map((call) => call[0])).toEqual([0, 0])
    expect(runtime.snapshot.coverage).toBe(20)
    expect(runtime.snapshot.journals).toEqual([])
  },
)
test('stop and replacement do not await a timed-out outstanding scanner; late rejection is observed', async () => {
  let reject!: (error: Error) => void
  const scan = jest.fn(
    () =>
      new Promise<Awaited<ReturnType<NegotiationRecoveryOptions['scan']>>>(
        (_, no) => {
          reject = no
        },
      ),
  )
  const publish = jest.fn()
  const clock = manualSchedule()
  const runtime = start(options({ scan, publish, schedule: clock.schedule }))
  await until(() => scan.mock.calls.length === 1)
  clock.fire(30000)
  await until(() => clock.has(3000))
  clock.fire(3000)
  await until(() => clock.has(6000) || scan.mock.calls.length > 1)
  expect(scan).toHaveBeenCalledTimes(1)
  await runtime.stop()
  expect(clock.tasks.every((task) => task.canceled)).toBe(true)
  const publications = publish.mock.calls.length
  const replacement = start(
    options({
      scan: async () => ({
        records: [],
        resumeFromInclusive: 5,
        truncated: false,
      }),
    }),
  )
  await until(() => replacement.snapshot.state === 'ready')
  reject(new Error('Stopped scanner rejection'))
  await new Promise((done) => setImmediate(done))
  expect(scan).toHaveBeenCalledTimes(1)
  expect(publish).toHaveBeenCalledTimes(publications)
  expect(replacement.snapshot.coverage).toBe(5)
})
