/**
 * The app's background tick against a REAL typed wallet (#1236 Q3): a paid message the app holds
 * no message for is finished by the tick alone, and an idle wallet is asked without a single
 * request leaving it.
 *
 * Real typed custody, real Level journals, the real link store, real directory admission, real
 * sealing and real stamp funding, from the shared two-wallet fixture
 * (`@frank/wallet/chain/canonical-two-wallets.testutil`). Only the chain RPC, the chain HTTP
 * client and the message relay's HTTP surface are stand-ins, and each of them counts what it was
 * asked. The app's chain facade is pointed at the fixture's chain. Real timers, with the tick's
 * intervals shortened through its own options.
 */
// First: the mock factories below load this file while the wallet modules are still loading.
import {
  chainHttpRequests,
  fixture,
  mailboxes,
  mockBalances,
  mockFunded,
  providerRequests,
  type Fixture,
  type InboxRecord,
} from '@frank/wallet/chain/canonical-two-wallets.testutil'
import { createPinia, setActivePinia } from 'pinia'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(global as any).document = { hasFocus: () => true }

import { startOutgoingReconciliation } from './pinia-chain-adapter'
import { activeChain } from '@frank/wallet/chain'
import type { WalletHandle } from '@frank/wallet/chain'
import {
  canonicalMonadStampClient,
  installCanonicalDirectory,
} from '@frank/wallet/chain/monad-chain'
import { MonadStampPendingAttemptError } from '@frank/wallet/monad-stamp-client'

/* eslint-disable @typescript-eslint/no-var-requires */
jest.mock('@frank/wallet/monad-provider', () =>
  require('@frank/wallet/chain/canonical-two-wallets.testutil').offlineProviderModule(),
)
jest.mock('@frank/wallet/monad-http', () =>
  require('@frank/wallet/chain/canonical-two-wallets.testutil').offlineHttpModule(),
)
jest.mock('@frank/cashweb/relay/monad-mailbox-client', () =>
  require('@frank/wallet/chain/canonical-two-wallets.testutil').offlineMailboxModule(),
)
/* eslint-enable @typescript-eslint/no-var-requires */
jest.mock('../utils/notifications', () => ({ desktopNotify: jest.fn() }))
jest.mock('./level-message-store', () => ({
  store: Promise.resolve({
    saveMessage: jest.fn(async () => undefined),
    deleteMessage: jest.fn(async () => undefined),
    mostRecentMessageTime: jest.fn(async () => 0),
    getIterator: async function* () {
      /* none */
    },
  }),
}))

/** What the tests read off the stamp client; the client keeps it private. */
interface ClientInternals {
  journal: {
    getIntents(): unknown[]
    getAll(): { terminal: { phase: string } | null }[]
  }
}

describe('the outgoing tick on a real wallet (#1236 Q3)', () => {
  jest.setTimeout(120_000)
  const directMessages = activeChain.directMessages as Required<
    typeof activeChain.directMessages
  >
  let f: Fixture
  let wallet: WalletHandle
  let bobInbox: InboxRecord[]
  let reconcileAttempts: jest.SpiedFunction<
    typeof directMessages.reconcileAttempts
  >
  let unattributedAttempts: jest.SpiedFunction<
    typeof directMessages.unattributedAttempts
  >
  let fundAhead: jest.SpiedFunction<typeof directMessages.fundAhead>
  let stop: (() => void) | undefined

  /** Every request that left the wallet: node RPC, chain HTTP, and payment sets to the relay. */
  const requests = () =>
    providerRequests.length + chainHttpRequests.length + f.requests.length
  /** Questions the tick has put to the wallet: one per tick when no message asks. */
  const asked = () =>
    unattributedAttempts.mock.calls.length + reconcileAttempts.mock.calls.length
  const journal = () =>
    (canonicalMonadStampClient(f.alice) as unknown as ClientInternals).journal
  const until = async (done: () => boolean, what: string) => {
    const deadline = Date.now() + 20_000
    while (!done()) {
      if (Date.now() > deadline)
        throw new Error(`timed out waiting for ${what}`)
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  }
  /** The tick with its pauses shortened: 10 ms doubling to 40 ms, 20 ms when idle. */
  const start = () => {
    const polling = startOutgoingReconciliation({
      wallet,
      intervalMs: 10,
      maxIntervalMs: 40,
      idleIntervalMs: 20,
    })
    stop = polling.stop
    return polling
  }
  /** Sends one paid message straight through the wallet, as a message whose row the app lost:
   * the relay keeps it without delivering, and nothing in the chat store points at it. */
  const paidMessageWithNoRow = async (text: string) => {
    f.setPhase('retained')
    let digest = ''
    await expect(
      f.chain.directMessages.send({
        wallet: f.alice,
        recipient: f.bob.identity.address,
        items: [{ type: 'text', text }],
        onAttemptCreated: created => void (digest = created),
      }),
    ).rejects.toBeInstanceOf(MonadStampPendingAttemptError)
    expect(digest).not.toBe('')
    return digest
  }

  beforeEach(async () => {
    setActivePinia(createPinia())
    mockBalances.clear()
    mockFunded.length = 0
    mailboxes.clear()
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    jest.spyOn(console, 'info').mockImplementation(() => undefined)
    // A stamp large enough that funding its accounts ahead costs less than it moves: the wallet
    // refuses to fund ahead otherwise (a 1,000-wei stamp's funding transfer costs more than it
    // carries in this fixture).
    f = await fixture({ defaultStampValueWei: 10n ** 9n })
    wallet = f.alice as unknown as WalletHandle
    installCanonicalDirectory(
      f.alice,
      await f.directoryFor('alice', f.alice, f.bob),
    )
    bobInbox = []
    f.setMailbox(bobInbox)
    // The app's chain facade, answered by the fixture's chain.
    reconcileAttempts = jest
      .spyOn(directMessages, 'reconcileAttempts')
      .mockImplementation(params =>
        f.chain.directMessages.reconcileAttempts(params),
      )
    unattributedAttempts = jest
      .spyOn(directMessages, 'unattributedAttempts')
      .mockImplementation(params =>
        f.chain.directMessages.unattributedAttempts(params),
      )
    fundAhead = jest
      .spyOn(directMessages, 'fundAhead')
      .mockImplementation(params => f.chain.directMessages.fundAhead!(params))
    providerRequests.length = 0
    chainHttpRequests.length = 0
  })
  afterEach(async () => {
    stop?.()
    stop = undefined
    jest.restoreAllMocks()
    await f.close().catch(() => undefined)
  })

  // On main 1715ec7c the tick asks the wallet nothing here (no message points at the payment),
  // so the message stays undelivered until the test times out.
  it('a paid message with no row is delivered by ticks alone, as the same single payment set', async () => {
    const digest = await paidMessageWithNoRow('nobody remembers me')
    expect(f.requests).toHaveLength(1)
    expect(bobInbox).toHaveLength(0)
    const funded = mockFunded.length

    f.setPhase('delivered')
    start()
    await until(() => bobInbox.length > 0, 'the message to reach its recipient')
    // Let the tick that delivered it finish, then a few more.
    const before = asked()
    await until(() => asked() >= before + 3, 'three more ticks')
    stop?.()

    // No message accounted for a payment: the wallet was asked which ones nobody accounts for,
    // and then only what became of the one it reported.
    for (const [params] of unattributedAttempts.mock.calls)
      expect(params.knownDigests).toEqual([])
    for (const [params] of reconcileAttempts.mock.calls)
      expect(params.payloadDigests).toEqual([digest])
    // One payment set, sent again as the identical bytes; delivered once.
    expect(f.requests.length).toBeGreaterThanOrEqual(2)
    for (const request of f.requests)
      expect(Buffer.from(request.body)).toEqual(Buffer.from(f.requests[0].body))
    expect(bobInbox).toHaveLength(1)
    expect(journal().getIntents()).toHaveLength(0)
    expect(
      journal()
        .getAll()
        .filter(a => a.terminal === null),
    ).toHaveLength(0)
    // Asking now changes nothing and sends nothing: the ticks had already finished it.
    const sent = f.requests.length
    await expect(
      f.chain.directMessages.reconcileAttempts({
        wallet: f.alice,
        payloadDigests: [digest],
      }),
    ).resolves.toEqual({ [digest]: 'delivered' })
    expect(f.requests).toHaveLength(sent)
    // What moved on the chain since is the funding of the NEXT message, never a second payment
    // for this one: at most the two accounts one message spends.
    expect(mockFunded.length - funded).toBeLessThanOrEqual(2)
  })

  // Removed: the pin that an unanswered relay request held the tick. The wallet no longer makes
  // a tick wait on another message's request; a tick that names a digest waits only for that
  // message's own step (see packages/wallet/chain/monad-parallel-send.jest.test.ts).

  // The wallet here is not empty: it holds one delivered payment no message accounts for, which
  // it goes on reporting. Paying for and delivering that message is the positive control: all
  // three counters move. After that, with the next message's accounts ready, nothing does.
  it('an idle wallet: twenty ticks make no relay and no node request', async () => {
    await paidMessageWithNoRow('delivered before the wallet idles')
    f.setPhase('delivered')
    const outcomes: string[] = []
    fundAhead.mockImplementation(async params => {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const result = await f.chain.directMessages.fundAhead!(params)
      outcomes.push(result.outcome)
      return result
    })
    start()
    await until(() => bobInbox.length === 1, 'the earlier message to deliver')
    await until(
      () => outcomes.at(-1) === 'ready',
      'the next message to have its accounts',
    )
    let quiet = -1
    await until(() => {
      const still = requests() === quiet
      quiet = requests()
      return still && asked() >= 6
    }, 'the funding to settle')
    expect(providerRequests.length).toBeGreaterThan(0)
    expect(chainHttpRequests.length).toBeGreaterThan(0)
    expect(f.requests.length).toBeGreaterThan(0)

    providerRequests.length = 0
    chainHttpRequests.length = 0
    const relay = f.requests.length
    const ticks = asked()
    await until(() => asked() >= ticks + 20, 'twenty idle ticks')
    stop?.()
    expect(providerRequests).toEqual([])
    expect(chainHttpRequests).toEqual([])
    expect(f.requests).toHaveLength(relay)
  })

  // The reload, on the real wallet: the app starts again while the relay still keeps a paid
  // message, and nothing in the chat store points at it when the tick looks. Before: the first
  // tick re-sent it once and the next look was the idle pause away (here a minute, so the wait
  // below times out). After: it is re-sent on the short pauses until the relay delivers it.
  it('after a reload, a message the relay still keeps is re-sent on the short pauses until it is delivered, never paid again', async () => {
    const digest = await paidMessageWithNoRow('sent just before the reload')
    const funded = mockFunded.length
    // A new session: nothing in memory, a new tick. Its idle pause is the real minute.
    setActivePinia(createPinia())
    stop = startOutgoingReconciliation({
      wallet,
      intervalMs: 10,
      maxIntervalMs: 40,
      idleIntervalMs: 60_000,
    }).stop
    await until(
      () => f.requests.length >= 5,
      'four re-sends on the short pauses',
    )
    expect(bobInbox).toHaveLength(0)
    f.setPhase('delivered')
    await until(() => bobInbox.length === 1, 'the message to be delivered')
    stop?.()

    for (const request of f.requests)
      expect(Buffer.from(request.body)).toEqual(Buffer.from(f.requests[0].body))
    expect(bobInbox).toHaveLength(1)
    expect(journal().getIntents()).toHaveLength(0)
    const sent = f.requests.length
    await expect(
      f.chain.directMessages.reconcileAttempts({
        wallet: f.alice,
        payloadDigests: [digest],
      }),
    ).resolves.toEqual({ [digest]: 'delivered' })
    expect(f.requests).toHaveLength(sent)
    expect(mockFunded.length - funded).toBeLessThanOrEqual(2)
  })
})
