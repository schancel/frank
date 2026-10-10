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
  let fundAhead: jest.SpiedFunction<typeof directMessages.fundAhead>
  let stop: (() => void) | undefined

  /** Every request that left the wallet: node RPC, chain HTTP, and payment sets to the relay. */
  const requests = () =>
    providerRequests.length + chainHttpRequests.length + f.requests.length
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
    f = await fixture()
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
    const asked = reconcileAttempts.mock.calls.length
    await until(
      () => reconcileAttempts.mock.calls.length >= asked + 3,
      'three more ticks',
    )
    stop?.()

    // Every question was about no payment in particular.
    for (const [params] of reconcileAttempts.mock.calls)
      expect(params.payloadDigests).toEqual([])
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

  // What a relay that does not answer costs. The tick waits for the wallet's answer, and the
  // wallet waits for the relay (up to the transport's 60 s deadline per unresolved payment), so
  // that tick's funding ahead and re-observation wait too. Ticks never overlap or queue up: the
  // next one is armed only when this one ends. A tick that asks about a message's own payment
  // has always waited like this; the question about no payment in particular waits the same way.
  it('pin: a relay request that is not answered holds that one tick until it ends, then everything goes on', async () => {
    await paidMessageWithNoRow('the relay is slow')
    const reobserve = jest.fn(async () => undefined)
    wallet = Object.assign(Object.create(f.alice), {
      reobserveNativeOperations: reobserve,
    }) as WalletHandle
    reconcileAttempts.mockImplementation(params =>
      f.chain.directMessages.reconcileAttempts({ ...params, wallet: f.alice }),
    )
    fundAhead.mockImplementation(() =>
      f.chain.directMessages.fundAhead!({ wallet: f.alice }),
    )
    const held = f.holdNextRelayRequest()
    start()
    await held.entered
    // Many tick intervals pass; the tick that asked is the only one.
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(reconcileAttempts).toHaveBeenCalledTimes(1)
    expect(fundAhead).not.toHaveBeenCalled()
    expect(reobserve).not.toHaveBeenCalled()
    expect(bobInbox).toHaveLength(0)

    held.release('delivered')
    await until(() => bobInbox.length === 1, 'the held request to deliver')
    await until(
      () => fundAhead.mock.calls.length > 0 && reobserve.mock.calls.length > 1,
      'the tick to go on',
    )
    stop?.()
    for (const request of f.requests)
      expect(Buffer.from(request.body)).toEqual(Buffer.from(f.requests[0].body))
    expect(bobInbox).toHaveLength(1)
  })

  it('an idle wallet: twenty ticks make no relay and no node request', async () => {
    start()
    // Positive control: the first resolved tick funds the next message ahead, and the counters
    // see it. Wait until that has settled and the wallet answers "ready" without a request.
    await until(() => mockFunded.length >= 2, 'the next message to be funded')
    await until(() => {
      const results = fundAhead.mock.results
      return results.length > 0 && requests() > 0
    }, 'funding ahead to be counted')
    let quiet = requests()
    await until(() => {
      const still = requests() === quiet
      quiet = requests()
      return still && reconcileAttempts.mock.calls.length >= 3
    }, 'the funding to settle')
    expect(requests()).toBeGreaterThan(0)

    providerRequests.length = 0
    chainHttpRequests.length = 0
    const relay = f.requests.length
    const ticks = reconcileAttempts.mock.calls.length
    await until(
      () => reconcileAttempts.mock.calls.length >= ticks + 20,
      'twenty idle ticks',
    )
    stop?.()
    expect(providerRequests).toEqual([])
    expect(chainHttpRequests).toEqual([])
    expect(f.requests).toHaveLength(relay)
    expect(relay).toBe(0)
  })
})
