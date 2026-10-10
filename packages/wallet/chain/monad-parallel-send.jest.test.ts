/**
 * Paid messages are built in parallel and sent as they are built. Real typed wallet, real Level
 * stores, real directory admission, real sealing and signing; the chain RPC and the relay's HTTP
 * surface are the offline stand-ins of `canonical-two-wallets.testutil` (unit seam). The same
 * behaviour on real chain software is `monad-parallel-send.anvil.jest.test.ts`.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { Transaction, hexlify } from 'ethers'
import { toHex } from '@frank/codec'
import { restoreCanonicalRequest } from '@frank/cashweb/relay/canonical-dm-transport'
import type { EvmChainWalletHandle } from '../evm-wallet-handle'
import {
  DirectMessageAlreadyAttemptedError,
  DirectMessageAttemptUnlinkedError,
  DirectMessageStampBelowFeeError,
  isDirectMessageNotAttempted,
} from './active-chain'
import {
  fixture,
  mailboxes,
  mockBalances,
  mockFunded,
  offlineChain,
  providerRequests,
  chainHttpRequests,
  roots,
  type Fixture,
  type InboxRecord,
} from './canonical-two-wallets.testutil'
import {
  installCanonicalDirectory,
  type CanonicalDirectory,
} from './monad-chain'
import { EvmStampPayer, InsufficientStampFundsError } from '../evm-stamp-payer'
import { MonadStampPendingAttemptError } from '../monad-stamp-client'
import {
  CanonicalRecipientUndeliverableError,
  CanonicalSenderUnpublishedError,
  REPLACED_AFTER_MS,
  LevelOutgoingMessageStore,
} from './monad-canonical-dm'

jest.mock('../monad-provider', () =>
  require('./canonical-two-wallets.testutil').offlineProviderModule(),
)
jest.mock('../monad-http', () =>
  require('./canonical-two-wallets.testutil').offlineHttpModule(),
)
jest.mock('@frank/cashweb/relay/monad-mailbox-client', () =>
  require('./canonical-two-wallets.testutil').offlineMailboxModule(),
)
/** Fails the next durable write of a sent-message record, having written it or not. */
const mockMessageWrite: { mode: 'ok' | 'dropped' | 'written-then-reported-failed' } =
  { mode: 'ok' }
jest.mock('../storage/level-durability', () => {
  const actual = jest.requireActual<
    typeof import('../storage/level-durability')
  >('../storage/level-durability')
  return {
    ...actual,
    durablePut: async (
      ...args: Parameters<typeof actual.durablePut>
    ): Promise<void> => {
      const isMessage =
        typeof args[2] === 'string' &&
        args[2].includes('"consumerId":"frank-dm:')
      if (!isMessage || mockMessageWrite.mode === 'ok')
        return actual.durablePut(...args)
      const mode = mockMessageWrite.mode
      mockMessageWrite.mode = 'ok'
      if (mode === 'written-then-reported-failed')
        await actual.durablePut(...args)
      throw new Error(`message write ${mode}`)
    },
  }
})

const STAMP = 1_000n
/** 21,000 gas at the offline chain's fee cap (2 x base fee 1 + tip 1). */
const FEE_RESERVE = 21_000n * 3n
const ID = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`

describe('parallel paid messages', () => {
  jest.setTimeout(120_000)
  let f: Fixture
  let alice: EvmChainWalletHandle
  let directory: CanonicalDirectory
  let bobMailbox: InboxRecord[]
  /** What the relay stand-in is doing with message requests. */
  let relay: {
    inFlight: number
    mostAtOnce: number
    delayMs: number
    bodies: { body: Uint8Array; contentType: string }[]
    /** Set to answer the next message requests yourself: an HTTP status and a JSON body built
     * from the request's own identity. The relay stand-in then stores and broadcasts nothing. */
    answer?: (identity: unknown) => { status: number; body: unknown }
  }

  beforeEach(async () => {
    offlineChain.reset()
    mockBalances.clear()
    mockFunded.length = 0
    mailboxes.clear()
    mockMessageWrite.mode = 'ok'
    REPLACED_AFTER_MS.value = 60_000
    f = await fixture()
    alice = f.alice
    bobMailbox = []
    mailboxes.set(toHex(f.bob.identity.compressedPubKey), bobMailbox)
    f.setMailbox(bobMailbox)
    relay = { inFlight: 0, mostAtOnce: 0, delayMs: 0, bodies: [] }
    const base = await f.directoryFor('alice', f.alice, f.bob)
    directory = {
      ...base,
      fetch: async (url, init) => {
        relay.inFlight++
        relay.mostAtOnce = Math.max(relay.mostAtOnce, relay.inFlight)
        try {
          if (relay.delayMs > 0)
            await new Promise(resolve => setTimeout(resolve, relay.delayMs))
          const request = {
            body: new Uint8Array(init.body!),
            contentType: init.headers['Content-Type'],
          }
          if (relay.answer) {
            const { status, body } = relay.answer(
              restoreCanonicalRequest(request).identity,
            )
            const bytes = new TextEncoder().encode(JSON.stringify(body))
            let read = false
            return {
              status,
              url,
              headers: {
                get: (name: string) =>
                  name.toLowerCase() === 'content-type'
                    ? 'application/json'
                    : null,
              },
              body: {
                getReader: () => ({
                  read: async () =>
                    read
                      ? { done: true }
                      : ((read = true), { done: false, value: bytes }),
                  cancel: async () => undefined,
                  releaseLock: () => undefined,
                }),
              },
            }
          }
          const answer = await base.fetch!(url, init)
          relay.bodies.push(request)
          return answer
        } finally {
          relay.inFlight--
        }
      },
    }
    installCanonicalDirectory(alice, directory)
    installCanonicalDirectory(f.bob, await f.directoryFor('bob', f.bob, f.alice))
    // The main account holds nothing unless a test gives it money: no send can fund inline.
    mockBalances.set((await alice.getReceiveAddress()).raw.toLowerCase(), 0n)
    mockBalances.set(alice.identity.address.raw.toLowerCase(), 0n)
  })
  afterEach(async () => {
    jest.restoreAllMocks()
    await alice.close().catch(() => undefined)
    await f.close().catch(() => undefined)
  })

  /** Gives the wallet `count` more funded single-use accounts, each able to pay one stamp. */
  async function fundAccounts(count: number, valueWei = STAMP + FEE_RESERVE) {
    const before = alice.pool.records().length
    const rows = alice.pool.ensureSize(before + count).slice(before)
    await alice.pool.flush()
    for (const row of rows) mockBalances.set(row.address.toLowerCase(), valueWei)
    return rows
  }
  const send = (n: number, wallet = alice) =>
    f.chain.directMessages.send({
      wallet,
      recipient: f.bob.identity.address,
      items: [{ type: 'text', text: `message ${n}` }],
      stampValue: STAMP,
      messageId: ID(n),
    })
  const tick = (digests: string[] = [], wallet = alice) =>
    f.chain.directMessages.reconcileAttempts({ wallet, payloadDigests: digests })
  const payersOf = (sent: { stampPayments: { txHash: string }[] }[]) =>
    sent.flatMap(result => result.stampPayments.map(p => p.txHash))
  /** Every signed payment the relay was handed, by sender account. */
  const relayPayments = () =>
    relay.bodies.flatMap(request =>
      restoreCanonicalRequest(request).parts.transactions.map(raw =>
        Transaction.from(hexlify(raw)),
      ),
    )
  const statusOf = (index: number) => alice.pool.getRecord(index)?.status
  async function reopen() {
    await alice.close()
    alice = (await f.chain.createWallet(roots(0))) as EvmChainWalletHandle
    installCanonicalDirectory(alice, directory)
  }

  it('twenty sends started together claim twenty different accounts and are in flight together', async () => {
    const rows = await fundAccounts(21)
    // One send on its own, for the time one send takes with a relay that answers in 5 s (long
    // enough that sealing twenty messages on one thread, on a busy machine, fits inside it).
    relay.delayMs = 5_000
    const startOne = Date.now()
    const first = await send(100)
    const oneMs = Date.now() - startOne
    relay.mostAtOnce = 0

    const start = Date.now()
    const sent = await Promise.all(
      Array.from({ length: 20 }, (_, n) => send(n)),
    )
    const twentyMs = Date.now() - start
    // eslint-disable-next-line no-console
    console.log(
      `one send: ${oneMs} ms; twenty together: ${twentyMs} ms; relay requests in flight at once: ${relay.mostAtOnce}`,
    )

    // Twenty messages, each paid by one account, no account used twice.
    const payers = relayPayments().map(tx => tx.from!.toLowerCase())
    expect(payers).toHaveLength(21)
    expect(new Set(payers).size).toBe(21)
    expect(new Set(payers)).toEqual(
      new Set(rows.map(row => row.address.toLowerCase())),
    )
    expect(new Set(sent.map(result => result.payloadDigest)).size).toBe(20)
    expect(bobMailbox).toHaveLength(21)
    // All twenty relay requests were in flight at the same time: nothing queued them.
    expect(relay.mostAtOnce).toBe(20)
    // One after another they would take twenty relay answers (100 s); together, about one.
    expect(twentyMs).toBeLessThan(3 * relay.delayMs)
    expect(mockFunded).toHaveLength(0)

    // The background pass learns "spent" from the chain for every one of them.
    await tick()
    for (const row of rows) expect(statusOf(row.index)).toBe('spent')
    expect(payersOf([first, ...sent])).toHaveLength(21)
  })

  it('a new account whose only money is at its identity address sends a paid message, with no funding transfer', async () => {
    const identity = alice.identity.address.raw.toLowerCase()
    mockBalances.set(identity, 10n ** 17n)
    expect(await alice.getBalance()).toBe(10n ** 17n)
    const sent = await send(1)
    // One payment of the whole stamp, signed by the identity account; nothing else moved.
    expect(sent.stampPayments.map(p => p.valueWei)).toEqual([STAMP])
    expect(sent.preparationTxHashes).toEqual([])
    expect(mockFunded).toHaveLength(0)
    expect(relayPayments().map(tx => tx.from!.toLowerCase())).toEqual([identity])
    expect(bobMailbox).toHaveLength(1)
    await tick()
    expect(
      f.chain.directMessages.paymentsOf?.({
        wallet: alice,
        payloadDigest: sent.payloadDigest,
      }),
    ).toEqual(['spent'])
    expect(mockBalances.get(identity)).toBe(10n ** 17n - STAMP)
  })

  it('with money only in the main account, three sends started together each pay once from it, one nonce after another, and nothing is funded', async () => {
    const main = (await alice.getReceiveAddress()).raw.toLowerCase()
    mockBalances.set(main, 10n ** 17n)
    const sent = await Promise.all([send(1), send(2), send(3)])
    expect(mockFunded).toHaveLength(0)
    const payments = relayPayments()
    expect(payments.map(tx => tx.from!.toLowerCase())).toEqual([main, main, main])
    // The main account is one coin: no two payments were ever signed at the same nonce.
    expect(payments.map(tx => tx.nonce).sort()).toEqual([0, 1, 2])
    expect(payments.every(tx => tx.value === STAMP)).toBe(true)
    expect(bobMailbox).toHaveLength(3)
    await tick()
    for (const result of sent)
      expect(
        f.chain.directMessages.paymentsOf?.({
          wallet: alice,
          payloadDigest: result.payloadDigest,
        }),
      ).toEqual(['spent'])
    expect(mockBalances.get(main)).toBe(10n ** 17n - 3n * STAMP)
  })

  it('funded sub-accounts are used before the main account, and the main account when they run out', async () => {
    const main = (await alice.getReceiveAddress()).raw.toLowerCase()
    mockBalances.set(main, 10n ** 17n)
    const [row] = await fundAccounts(1)
    await Promise.all([send(1), send(2)])
    expect(new Set(relayPayments().map(tx => tx.from!.toLowerCase()))).toEqual(
      new Set([row.address.toLowerCase(), main]),
    )
    expect(mockFunded).toHaveLength(0)
  })

  describe('a paid stamp is never smaller than what the chain charges to move it', () => {
    /** 21,000 gas at the offline chain's gas price of 2. */
    const FLOOR = 42_000n
    beforeEach(async () => {
      offlineChain.gasPrice = 2n
      mockBalances.set(
        (await alice.getReceiveAddress()).raw.toLowerCase(),
        10n ** 17n,
      )
    })

    it('tells a host the floor, from the node\'s gas price', async () => {
      expect(await f.chain.directMessages.minimumStamp!({ wallet: alice })).toBe(
        FLOOR,
      )
    })

    it('refuses an explicit smaller stamp, naming the floor, having done nothing', async () => {
      const refused = await send(1).catch(error => error)
      expect(refused).toBeInstanceOf(DirectMessageStampBelowFeeError)
      expect(refused).toMatchObject({ stampValueWei: STAMP, floorWei: FLOOR })
      expect(isDirectMessageNotAttempted(refused)).toBe(true)
      expect(relay.bodies).toHaveLength(0)
      expect(
        alice.pool.accountClaimedBy((await alice.getReceiveAddress()).raw),
      ).toBeUndefined()
    })

    it('raises the wallet\'s own default stamp to the floor', async () => {
      const sent = await f.chain.directMessages.send({
        wallet: alice,
        recipient: f.bob.identity.address,
        items: [{ type: 'text', text: 'default stamp' }],
      })
      expect(sent.stampValueWei).toBe(FLOOR)
      expect(sent.stampPayments.map(p => p.valueWei)).toEqual([FLOOR])
    })

    it('does not split a stamp into payments smaller than the floor: it is paid in one piece', async () => {
      // Two funded accounts that would pay 50,000 as 30,000 + 20,000.
      await fundAccounts(2, 30_000n + FEE_RESERVE)
      const sent = await f.chain.directMessages.send({
        wallet: alice,
        recipient: f.bob.identity.address,
        items: [{ type: 'text', text: 'one piece' }],
        stampValue: 50_000n,
      })
      expect(sent.stampPayments.map(p => p.valueWei)).toEqual([50_000n])
      expect(relayPayments()[0].from!.toLowerCase()).toBe(
        (await alice.getReceiveAddress()).raw.toLowerCase(),
      )
    })
  })

  it('ten sends with five funded accounts: five are sent, five fail fast, nothing is stuck', async () => {
    const rows = await fundAccounts(5)
    const start = Date.now()
    const settled = await Promise.allSettled(
      Array.from({ length: 10 }, (_, n) => send(n)),
    )
    const elapsed = Date.now() - start
    const sent = settled.filter(s => s.status === 'fulfilled')
    const refused = settled.filter(
      (s): s is PromiseRejectedResult => s.status === 'rejected',
    )
    expect(sent).toHaveLength(5)
    expect(refused).toHaveLength(5)
    for (const { reason } of refused)
      expect(reason).toBeInstanceOf(InsufficientStampFundsError)
    expect(elapsed).toBeLessThan(10_000)
    expect(bobMailbox).toHaveLength(5)
    expect(new Set(relayPayments().map(tx => tx.from)).size).toBe(5)
    // The refused sends hold nothing: no claim, no record, and their IDs can be sent later.
    await tick()
    for (const row of rows) {
      expect(statusOf(row.index)).toBe('spent')
      expect(alice.pool.claimedBy(row.index)).toBeUndefined()
    }
    const refusedIndex = settled.findIndex(s => s.status === 'rejected')
    const [fresh] = await fundAccounts(1)
    await expect(send(refusedIndex)).resolves.toMatchObject({
      stampValueWei: STAMP,
    })
    expect(alice.pool.claimedBy(fresh.index)).toBeDefined()
    expect(bobMailbox).toHaveLength(6)
  })

  it('a message the relay has not answered for does not hold back the next one', async () => {
    const [a, b] = await fundAccounts(2)
    f.setPhase('fail')
    const stuck = await send(1).catch(error => error)
    expect(stuck).toBeInstanceOf(MonadStampPendingAttemptError)
    // Nothing was broadcast by the wallet for a message the relay does not have.
    expect(offlineChain.walletBroadcasts).toHaveLength(0)
    f.setPhase('delivered')
    const second = await send(2)
    expect(bobMailbox).toHaveLength(1)
    await tick()
    // The second is delivered and paid; the first was re-sent by the same pass, the same bytes.
    const paid = new Set([a.index, b.index].map(statusOf))
    expect(paid).toEqual(new Set(['spent']))
    expect(bobMailbox).toHaveLength(2)
    expect(
      await f.chain.directMessages.reconcileAttempts({
        wallet: alice,
        payloadDigests: [stuck.payloadHashes[0], second.payloadDigest],
      }),
    ).toEqual({
      [stuck.payloadHashes[0]]: 'delivered',
      [second.payloadDigest]: 'delivered',
    })
    expect(new Set(relayPayments().map(tx => tx.hash)).size).toBe(2)
  })

  it('the relay never has the message: the wallet broadcasts nothing, keeps the accounts, and broadcasts once a resend is confirmed', async () => {
    const [row] = await fundAccounts(1)
    f.setPhase('fail')
    const stuck = await send(1).catch(error => error)
    const digest: string = stuck.payloadHashes[0]
    for (let pass = 0; pass < 6; pass++) await tick([digest])
    expect(offlineChain.walletBroadcasts).toHaveLength(0)
    expect(statusOf(row.index)).toBe('available')
    expect(alice.pool.claimedBy(row.index)).toBeDefined()
    // A second message cannot be given the claimed account.
    await expect(send(2)).rejects.toBeInstanceOf(InsufficientStampFundsError)
    // The relay comes back and does not broadcast: the wallet's own broadcast pays.
    offlineChain.relayBroadcasts = false
    f.setPhase('delivered')
    for (let pass = 0; pass < 16 && statusOf(row.index) !== 'spent'; pass++)
      await tick([digest])
    expect(offlineChain.walletBroadcasts).toHaveLength(1)
    expect(statusOf(row.index)).toBe('spent')
    expect(alice.pool.claimedBy(row.index)).toBeUndefined()
    expect(bobMailbox).toHaveLength(1)
    // One payment set, the same bytes, however often it was handed over.
    expect(new Set(relayPayments().map(tx => tx.hash)).size).toBe(1)
  })

  it('the relay stored and broadcast but its answer was lost: the coins are spent from the chain and delivery is retried, never re-paid', async () => {
    const [row] = await fundAccounts(1)
    // The relay takes the message, broadcasts, and the answer never arrives.
    const base = directory.fetch!
    let lose = true
    installCanonicalDirectory(alice, {
      ...directory,
      fetch: async (url, init) => {
        const answer = await base(url, init)
        if (lose) throw new Error('connection reset')
        return answer
      },
    })
    const stuck = await send(1).catch(error => error)
    expect(stuck).toBeInstanceOf(MonadStampPendingAttemptError)
    const digest: string = stuck.payloadHashes[0]
    expect(offlineChain.walletBroadcasts).toHaveLength(0)
    await tick([digest])
    // Seen on chain: spent, although the wallet still has no confirmation of delivery.
    expect(statusOf(row.index)).toBe('spent')
    expect((await tick([digest]))[digest]).toBe('live')
    lose = false
    for (let pass = 0; pass < 16; pass++)
      if ((await tick([digest]))[digest] === 'delivered') break
    expect((await tick([digest]))[digest]).toBe('delivered')
    expect(offlineChain.walletBroadcasts).toHaveLength(0)
    expect(new Set(relayPayments().map(tx => tx.hash)).size).toBe(1)
    await expect(send(1)).rejects.toBeInstanceOf(
      DirectMessageAlreadyAttemptedError,
    )
  })

  it('the relay answers delivered and never broadcasts: the sender\'s own broadcast pays', async () => {
    const [row] = await fundAccounts(1)
    offlineChain.relayBroadcasts = false
    const sent = await send(1)
    expect(offlineChain.walletBroadcasts).toHaveLength(1)
    expect(Transaction.from(offlineChain.walletBroadcasts[0]).hash).toBe(
      sent.stampPayments[0].txHash,
    )
    // Delivered is not paid: the account is spent only once the chain shows it.
    expect(statusOf(row.index)).toBe('available')
    await tick()
    expect(statusOf(row.index)).toBe('spent')
  })

  it('neither broadcast lands while the node is down: the same bytes are broadcast again until included', async () => {
    const [row] = await fundAccounts(1)
    offlineChain.relayBroadcasts = false
    offlineChain.nodeDown = true
    // The fee is read before the node goes down for transactions (fee reads still answer).
    const sent = await send(1)
    expect(bobMailbox).toHaveLength(1)
    for (let pass = 0; pass < 8; pass++) await tick()
    expect(statusOf(row.index)).toBe('available')
    expect(alice.pool.claimedBy(row.index)).toBeDefined()
    offlineChain.nodeDown = false
    for (let pass = 0; pass < 40 && statusOf(row.index) !== 'spent'; pass++)
      await tick()
    expect(statusOf(row.index)).toBe('spent')
    expect(new Set(offlineChain.walletBroadcasts).size).toBe(1)
    expect(offlineChain.walletBroadcasts.length).toBeGreaterThan(1)
    expect(offlineChain.mined.has(sent.stampPayments[0].txHash)).toBe(true)
  })

  it('a payment whose nonce was consumed by another transaction: the claim ends as failed and nothing is paid again', async () => {
    REPLACED_AFTER_MS.value = 0
    const [row] = await fundAccounts(1)
    offlineChain.relayBroadcasts = false
    offlineChain.nodeDown = true
    const sent = await send(1)
    offlineChain.nodeDown = false
    // Another transaction from the same account lands first (another device, a sweep).
    const other = await alice.pool
      .getSigner(row.index, alice)
      .signFrozenUnsigned({
        from: row.address.toLowerCase(),
        unsignedSerialized: Transaction.from({
          type: 2,
          chainId: 10143n,
          nonce: 0,
          to: '0x000000000000000000000000000000000000dEaD',
          value: 1n,
          gasLimit: 21_000n,
          maxFeePerGas: 3n,
          maxPriorityFeePerGas: 1n,
        }).unsignedSerialized,
      })
    offlineChain.mine(other.rawTx)
    const requestsBefore = relay.bodies.length
    for (let pass = 0; pass < 4; pass++) await tick()
    expect(statusOf(row.index)).toBe('retired')
    expect(alice.pool.claimedBy(row.index)).toBeUndefined()
    expect(
      f.chain.directMessages.paymentsOf?.({
        wallet: alice,
        payloadDigest: sent.payloadDigest,
      }),
    ).toEqual(['failed'])
    expect(relay.bodies.length).toBe(requestsBefore)
    expect(offlineChain.mined.has(sent.stampPayments[0].txHash)).toBe(false)
  })

  it('an idle wallet makes no request over twenty ticks', async () => {
    await fundAccounts(1)
    await send(1)
    await tick()
    providerRequests.length = 0
    chainHttpRequests.length = 0
    const relayRequests = relay.bodies.length
    for (let pass = 0; pass < 20; pass++) await tick()
    expect(providerRequests).toEqual([])
    expect(chainHttpRequests).toEqual([])
    expect(relay.bodies.length).toBe(relayRequests)
    // The counters do move when there is something to do.
    await fundAccounts(1)
    await send(2)
    expect(relay.bodies.length).toBe(relayRequests + 1)
    expect(providerRequests.length).toBeGreaterThan(0)
  })

  it('a node that lags (nonce consumed, receipt not yet shown) does not make a landed payment failed', async () => {
    const [row] = await fundAccounts(1)
    const sent = await send(1)
    // The node counts the nonce and has no receipt for the payment yet.
    const receipt = jest
      .spyOn(alice.provider, 'getTransactionReceipt')
      .mockResolvedValue(null)
    for (let pass = 0; pass < 8; pass++) await tick()
    expect(
      f.chain.directMessages.paymentsOf?.({
        wallet: alice,
        payloadDigest: sent.payloadDigest,
      }),
    ).toEqual(['pending'])
    expect(alice.pool.claimedBy(row.index)).toBeDefined()
    receipt.mockRestore()
    for (let pass = 0; pass < 9; pass++) await tick()
    expect(statusOf(row.index)).toBe('spent')
  })

  it('the record of a settled payment is written before its coin is released: a failed write keeps the claim', async () => {
    const main = (await alice.getReceiveAddress()).raw.toLowerCase()
    mockBalances.set(main, 10n ** 17n)
    offlineChain.relayBroadcasts = false
    offlineChain.broadcastDown = true
    await send(1)
    offlineChain.broadcastDown = false
    await tick() // broadcasts the payment; it is now in a block
    mockMessageWrite.mode = 'dropped'
    await tick().catch(() => undefined)
    // The chain shows the payment, but the wallet's record of that is not on disk.
    expect(mockMessageWrite.mode).toBe('ok')
    expect(alice.pool.accountClaimedBy(main)).toBeDefined()
    for (let pass = 0; pass < 8; pass++) await tick()
    expect(alice.pool.accountClaimedBy(main)).toBeUndefined()
  })

  it('two stored messages naming one coin do not stop the wallet from opening', async () => {
    const main = (await alice.getReceiveAddress()).raw.toLowerCase()
    mockBalances.set(main, 10n ** 17n)
    offlineChain.relayBroadcasts = false
    offlineChain.broadcastDown = true
    await send(1)
    // A second record on the same coin, as a crash between release and write once left.
    const holder = alice.pool.accountClaimedBy(main)!
    alice.pool.releaseAccountClaim(holder, main)
    await send(2)
    offlineChain.broadcastDown = false
    await reopen()
    expect(alice.pool.accountClaimedBy(main)).toBeDefined()
    for (let pass = 0; pass < 20; pass++) await tick()
    expect(bobMailbox).toHaveLength(2)
  })

  it('a send waiting for the main account asks the chain about the one payment in its way, never the relay', async () => {
    const main = (await alice.getReceiveAddress()).raw.toLowerCase()
    mockBalances.set(main, 10n ** 17n)
    await fundAccounts(1)
    // An unrelated message is undelivered (relay down for it), paid from the funded account.
    f.setPhase('fail')
    await send(1).catch(() => undefined)
    f.setPhase('delivered')
    offlineChain.relayBroadcasts = false
    offlineChain.broadcastDown = true
    await send(2) // paid from main; its payment cannot land while the node is down
    const stages: string[] = []
    const waiting = f.chain.directMessages.send({
      wallet: alice,
      recipient: f.bob.identity.address,
      items: [{ type: 'text', text: 'message 3' }],
      stampValue: STAMP,
      messageId: ID(3),
      onPreparationProgress: progress => stages.push(progress.stage),
    })
    const relayRequests = relay.bodies.length
    providerRequests.length = 0
    await new Promise(resolve => setTimeout(resolve, 2_500))
    // About one look a second at the holder's payment; the undelivered message is not re-sent.
    expect(relay.bodies.length).toBe(relayRequests)
    expect(
      providerRequests.filter(m => m === 'getTransactionReceipt').length,
    ).toBeLessThanOrEqual(4)
    // The host is told, once, that this send is waiting for the previous payment: its own
    // stage, not the "checking accounts" one.
    expect(stages).toEqual(['waiting-for-payment'])
    offlineChain.broadcastDown = false
    await tick()
    await tick()
    await expect(waiting).resolves.toMatchObject({ stampValueWei: STAMP })
    expect(relayPayments().filter(tx => tx.from!.toLowerCase() === main).map(tx => tx.nonce)).toEqual([0, 1])
  })

  it('one account the chain and the wallet disagree about goes out of use; every other send proceeds', async () => {
    REPLACED_AFTER_MS.value = 0
    const [bad, ...good] = await fundAccounts(4)
    const first = await send(1)
    const used = relayPayments()[0].from!.toLowerCase()
    expect([bad, ...good].map(r => r.address.toLowerCase())).toContain(used)
    // Spend one of the remaining accounts behind the wallet's back.
    const victim = [bad, ...good].find(r => r.address.toLowerCase() !== used)!
    const stolen = await alice.pool
      .getSigner(victim.index, alice)
      .signFrozenUnsigned({
        from: victim.address.toLowerCase(),
        unsignedSerialized: Transaction.from({
          type: 2,
          chainId: 10143n,
          nonce: 0,
          to: '0x000000000000000000000000000000000000dEaD',
          value: STAMP,
          gasLimit: 21_000n,
          maxFeePerGas: 3n,
          maxPriorityFeePerGas: 1n,
        }).unsignedSerialized,
      })
    offlineChain.mine(stolen.rawTx)
    offlineChain.relayBroadcasts = false
    const settled = await Promise.allSettled([send(2), send(3), send(4)])
    expect(settled.map(s => s.status)).toEqual([
      'fulfilled',
      'fulfilled',
      'fulfilled',
    ])
    for (let pass = 0; pass < 6; pass++) await tick()
    // The message that drew the bad account is delivered; its payment is recorded as failed.
    const states = [first, ...settled.map(s => (s as PromiseFulfilledResult<typeof first>).value)]
      .map(result =>
        f.chain.directMessages.paymentsOf?.({
          wallet: alice,
          payloadDigest: result.payloadDigest,
        }),
      )
      .flat()
    expect(states.sort()).toEqual(['failed', 'spent', 'spent', 'spent'])
    expect(statusOf(victim.index)).toBe('retired')
    expect(bobMailbox).toHaveLength(4)
  })

  describe.each(['undeliverable', 'sender_unpublished'] as const)(
    'the relay refuses a message for good (%s)',
    reason => {
      it('before storing or broadcasting anything: the message is failed, its coins are free at once, and the wallet goes on, also after a restart', async () => {
        const main = (await alice.getReceiveAddress()).raw.toLowerCase()
        mockBalances.set(main, 10n ** 17n)
        relay.answer = identity => ({
          status: 200,
          body: { version: 1, phase: 'dead', identity, reason },
        })
        // Paid from the main account: the coin a stuck claim would freeze the wallet on.
        const refused = await send(1).catch(error => error)
        expect(refused).toBeInstanceOf(
          reason === 'undeliverable'
            ? CanonicalRecipientUndeliverableError
            : CanonicalSenderUnpublishedError,
        )
        relay.answer = undefined
        expect(alice.pool.accountClaimedBy(main)).toBeUndefined()
        const digest = (
          await f.chain.directMessages.unattributedAttempts({
            wallet: alice,
            knownDigests: [],
          })
        )[0]
        expect(
          f.chain.directMessages.paymentsOf?.({ wallet: alice, payloadDigest: digest }),
        ).toEqual(['unsent'])
        // The next send is paid from the same account, at the same nonce: nothing was spent.
        const next = await send(2)
        expect(relayPayments().map(tx => [tx.from!.toLowerCase(), tx.nonce])).toEqual([
          [main, 0],
        ])
        expect(offlineChain.walletBroadcasts.map(raw => Transaction.from(raw).hash)).toEqual(
          next.stampPayments.map(p => p.txHash),
        )
        await tick()
        await reopen()
        expect(alice.pool.accountClaimedBy(main)).toBeUndefined()
        await expect(send(1)).rejects.toBeInstanceOf(
          DirectMessageAlreadyAttemptedError,
        )
        await send(3)
        expect(bobMailbox).toHaveLength(2)
        // The relay is never asked about the refused message again.
        const requests = relay.bodies.length
        for (let pass = 0; pass < 10; pass++) await tick()
        expect(relay.bodies.length).toBe(requests)
      })
    },
  )

  it.each([400, 413, 422])(
    'the relay refuses the request itself (HTTP %i): failed for good, coins free, never sent again',
    async status => {
      const [row] = await fundAccounts(1)
      relay.answer = () => ({
        status,
        body: { version: 1, error: 'invalid_canonical_submission' },
      })
      let asked = 0
      const answer = relay.answer
      relay.answer = identity => (asked++, answer(identity))
      await expect(send(1)).rejects.toThrow(/It was not sent and nothing was paid/)
      expect(alice.pool.claimedBy(row.index)).toBeUndefined()
      expect(statusOf(row.index)).toBe('available')
      for (let pass = 0; pass < 10; pass++) await tick()
      expect(asked).toBe(1)
      relay.answer = undefined
      // The freed account pays the next message.
      await send(2)
      expect(relayPayments()[0].from!.toLowerCase()).toBe(row.address.toLowerCase())
    },
  )

  it('a dead answer that may follow a broadcast keeps the coins claimed until the chain decides', async () => {
    const [row] = await fundAccounts(1)
    relay.answer = identity => ({
      status: 200,
      body: { version: 1, phase: 'dead', identity, reason: 'expired' },
    })
    await expect(send(1)).rejects.toThrow(/stay claimed until the chain shows/)
    relay.answer = undefined
    for (let pass = 0; pass < 4; pass++) await tick()
    expect(alice.pool.claimedBy(row.index)).toBeDefined()
    expect(statusOf(row.index)).toBe('available')
  })

  it.each([
    ['a 503', { status: 503, body: { version: 1, error: 'canonical_mailbox_unavailable' } }],
    ['a 500 carrying a dead body', { status: 500, body: { version: 1, phase: 'dead', reason: 'undeliverable' } }],
    ['a dead answer with a reason the wallet does not know', { status: 200, body: { version: 1, phase: 'dead', reason: 'made_up' } }],
    ['an older relay\'s "kept" answer', { status: 202, body: { version: 1, phase: 'retained' } }],
  ] as const)(
    '%s is not an answer: the message stays in the resend queue and later sends go through',
    async (_name, answer) => {
      await fundAccounts(2)
      relay.answer = identity => ({
        status: answer.status,
        body: 'phase' in answer.body ? { ...answer.body, identity } : answer.body,
      })
      const stuck = await send(1).catch(error => error)
      expect(stuck).toBeInstanceOf(MonadStampPendingAttemptError)
      const digest: string = stuck.payloadHashes[0]
      expect((await tick([digest]))[digest]).toBe('live')
      relay.answer = undefined
      await send(2)
      expect(bobMailbox).toHaveLength(1)
      for (let pass = 0; pass < 8; pass++) await tick([digest])
      expect((await tick([digest]))[digest]).toBe('delivered')
      expect(bobMailbox).toHaveLength(2)
      expect(new Set(relayPayments().map(tx => tx.hash)).size).toBe(2)
    },
  )

  it('a wallet that still has the old link store says so once at open, names the reset, and touches nothing', async () => {
    const opened = jest.spyOn(LevelOutgoingMessageStore, 'open')
    await reopen()
    const location = opened.mock.calls[0]![0]
    const old = join(location, 'canonical-dm-workflow-links')
    const notices = (warn: jest.SpyInstance) =>
      warn.mock.calls
        .map(call => String(call[0]))
        .filter(text => text.includes('canonical-dm-workflow-links'))
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      // No old state: nothing is said.
      expect(notices(warn)).toEqual([])
      mkdirSync(old)
      writeFileSync(join(old, 'MARKER'), 'left by the old send code')
      await reopen()
      expect(notices(warn)).toHaveLength(1)
      const [notice] = notices(warn)
      expect(notice).toContain(location)
      expect(notice).toMatch(/no longer read/)
      expect(notice).toMatch(/outgoing-messages-v1/)
      expect(notice).toMatch(
        /Development reset: close the wallet and delete the "canonical-dm-workflow-links" store/,
      )
      expect(notice).toMatch(
        /holds no keys; the wallet's keys, roots and funded accounts are untouched/,
      )
      // Named once, not at every open; and nothing was migrated or deleted.
      await reopen()
      expect(notices(warn)).toHaveLength(1)
      expect(readFileSync(join(old, 'MARKER'), 'utf8')).toBe(
        'left by the old send code',
      )
    } finally {
      warn.mockRestore()
      opened.mockRestore()
    }
    // The wallet opens and sends as usual.
    await fundAccounts(1)
    await expect(send(1)).resolves.toMatchObject({ stampValueWei: STAMP })
  })

  it('reopening with a message unresolved makes no request until the host ticks', async () => {
    await fundAccounts(1)
    f.setPhase('fail')
    const stuck = await send(1).catch(error => error)
    const digest: string = stuck.payloadHashes[0]
    f.setPhase('delivered')
    providerRequests.length = 0
    chainHttpRequests.length = 0
    await reopen()
    expect(providerRequests).toEqual([])
    expect(chainHttpRequests).toEqual([])
    expect(relay.bodies).toHaveLength(0)
    // No request, and still the wallet knows what it holds and what it is waiting for.
    expect(
      await f.chain.directMessages.unattributedAttempts({
        wallet: alice,
        knownDigests: [],
      }),
    ).toEqual([digest])
    expect(relay.bodies).toHaveLength(0)
    await tick()
    expect(bobMailbox).toHaveLength(1)
  })

  describe('a crash at each point of a send, then a restart', () => {
    it('after the claim, before signing: nothing is stored, the account is free, and the repeat is the first payment', async () => {
      const [row] = await fundAccounts(1)
      jest
        .spyOn(EvmStampPayer.prototype, 'sign')
        .mockRejectedValueOnce(new Error('crash after claim'))
      await expect(send(1)).rejects.toThrow('crash after claim')
      expect(alice.pool.claimedBy(row.index)).toBeUndefined()
      await reopen()
      const sent = await send(1)
      await tick()
      expect(statusOf(row.index)).toBe('spent')
      expect(new Set(relayPayments().map(tx => tx.hash))).toEqual(
        new Set([sent.stampPayments[0].txHash]),
      )
    })

    it('after signing, the record was not written: no second payment in the session; after a restart the repeat is the first', async () => {
      const [row] = await fundAccounts(1)
      mockMessageWrite.mode = 'dropped'
      await expect(send(1)).rejects.toThrow('message write dropped')
      expect(relay.bodies).toHaveLength(0)
      // Whether the record is on disk is unknown: this ID is refused, the account stays held.
      await expect(send(1)).rejects.toBeInstanceOf(
        DirectMessageAttemptUnlinkedError,
      )
      expect(alice.pool.claimedBy(row.index)).toBeDefined()
      await reopen()
      expect(alice.pool.claimedBy(row.index)).toBeUndefined()
      await send(1)
      await tick()
      expect(statusOf(row.index)).toBe('spent')
      expect(new Set(relayPayments().map(tx => tx.hash)).size).toBe(1)
      expect(bobMailbox).toHaveLength(1)
    })

    it('after the record was written (its write reported an error): the stored message is delivered after a restart, once', async () => {
      const [row] = await fundAccounts(1)
      mockMessageWrite.mode = 'written-then-reported-failed'
      await expect(send(1)).rejects.toThrow(
        'message write written-then-reported-failed',
      )
      expect(relay.bodies).toHaveLength(0)
      await reopen()
      // The stored message holds its account from the moment the wallet opens.
      expect(alice.pool.claimedBy(row.index)).toBeDefined()
      await expect(send(1)).rejects.toBeInstanceOf(
        DirectMessageAlreadyAttemptedError,
      )
      await tick()
      await tick()
      expect(bobMailbox).toHaveLength(1)
      expect(statusOf(row.index)).toBe('spent')
      expect(new Set(relayPayments().map(tx => tx.hash)).size).toBe(1)
    })

    it('after the relay accepted, before the wallet\'s own broadcast: the restart broadcasts the same bytes', async () => {
      const [row] = await fundAccounts(1)
      offlineChain.relayBroadcasts = false
      jest
        .spyOn(EvmStampPayer.prototype, 'broadcast')
        .mockRejectedValueOnce(new Error('crash before broadcast'))
      const sent = await send(1)
      expect(offlineChain.mined.size).toBe(0)
      await reopen()
      expect(alice.pool.claimedBy(row.index)).toBeDefined()
      await tick()
      await tick()
      expect(offlineChain.mined.has(sent.stampPayments[0].txHash)).toBe(true)
      expect(statusOf(row.index)).toBe('spent')
      expect(relay.bodies).toHaveLength(1)
    })

    it('after the wallet\'s own broadcast: the restart finds the payment on chain and sends nothing again', async () => {
      const [row] = await fundAccounts(1)
      offlineChain.relayBroadcasts = false
      await send(1)
      await reopen()
      expect(alice.pool.claimedBy(row.index)).toBeDefined()
      const broadcasts = offlineChain.walletBroadcasts.length
      await tick()
      expect(statusOf(row.index)).toBe('spent')
      expect(alice.pool.claimedBy(row.index)).toBeUndefined()
      expect(offlineChain.walletBroadcasts.length).toBe(broadcasts)
      expect(relay.bodies).toHaveLength(1)
      await expect(send(1)).rejects.toBeInstanceOf(
        DirectMessageAlreadyAttemptedError,
      )
    })
  })
})
