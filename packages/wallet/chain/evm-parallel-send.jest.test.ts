/**
 * Paid messages are built in parallel and sent as they are built. Real typed wallet, real Level
 * stores, real directory admission, real sealing and signing; the chain RPC and the relay's HTTP
 * surface are the offline stand-ins of `canonical-two-wallets.testutil` (unit seam). The same
 * behaviour on real chain software is `monad-parallel-send.anvil.jest.test.ts`.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { SigningKey, Transaction, hexlify, getBytes } from 'ethers'
import { toHex } from '@frank/codec'
import {
  CANONICAL_TERMINAL_REASONS,
  restoreCanonicalRequest,
} from '@frank/cashweb/relay/canonical-dm-transport'
import type { EvmChainWalletHandle } from '../evm-wallet-handle'
import { evmWalletInternals } from '../evm-wallet'
import {
  DirectMessageAlreadyAttemptedError,
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
} from './evm-chain'
import { InsufficientStampFundsError } from '../evm-stamp-payer'
import {
  MonadStampPendingAttemptError,
} from '../evm-stamp-client'
import {
  REFUSED_BEFORE_EXPOSURE,
  LevelOutgoingMessageStore,
} from './canonical-dm'

jest.mock('../evm-provider', () =>
  require('./canonical-two-wallets.testutil').offlineProviderModule(),
)
jest.mock('../evm-http', () =>
  require('./canonical-two-wallets.testutil').offlineHttpModule(),
)
jest.mock('@frank/cashweb/relay/mailbox-client', () =>
  require('./canonical-two-wallets.testutil').offlineMailboxModule(),
)
/** Fails the next durable write of a sent-message record, having written it or not.
 * `written`: every sent-message record written to disk, in order. */
const mockMessageWrite: {
  mode: 'ok' | 'dropped' | 'written-then-reported-failed'
  written: string[]
} = { mode: 'ok', written: [] }
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
      if (!isMessage) return actual.durablePut(...args)
      if (mockMessageWrite.mode === 'ok') {
        await actual.durablePut(...args)
        mockMessageWrite.written.push(args[2] as string)
        return
      }
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
     * from the request's own identity (and its signed payments). The relay stand-in then stores
     * and broadcasts nothing. Returning undefined lets the request through. */
    answer?: (
      identity: unknown,
      payments: Transaction[],
    ) => { status: number; body: unknown } | undefined
  }

  beforeEach(async () => {
    offlineChain.reset()
    mockBalances.clear()
    mockFunded.length = 0
    mailboxes.clear()
    mockMessageWrite.mode = 'ok'
    mockMessageWrite.written = []
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
          const restored = restoreCanonicalRequest(request)
          const answered = relay.answer?.(
            restored.identity,
            restored.parts.transactions.map(raw =>
              Transaction.from(hexlify(raw)),
            ),
          )
          if (answered) {
            const { status, body } = answered
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
  // Inject interruptions after the signed graph is durable, before submission.
  const send = (n: number, wallet = alice, onAttemptCreated?: () => void) =>
    f.chain.directMessages.send({
      wallet,
      recipient: f.bob.identity.address,
      items: [{ type: 'text', text: `message ${n}` }],
      stampValue: STAMP,
      messageId: ID(n),
      onAttemptCreated,
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
  const graphBytes = () => alice.getNativeOperations!().flatMap(row => row.members.map(member => member.signed!.rawTransaction))
  const constructOnly = (operationId: string) => alice.constructTransactionSet!({ operationId, amountAtomic: STAMP, kdf: () => getBytes(f.bob.identity.address.raw) })
  async function reopen() {
    await alice.close()
    alice = (await f.chain.createWallet(roots(0))) as EvmChainWalletHandle
    installCanonicalDirectory(alice, directory)
  }

  it.each([
    400,
    413,
    422,
    409,
    'undeliverable',
    'stale_nonce',
    'insufficient_total',
    'sender_unpublished',
    'expired',
  ] as const)(
    'a later refusal (%s) after lost acceptance and restart retains the original signed payment',
    async refusal => {
      const [coin] = await fundAccounts(1)
      offlineChain.relayBroadcasts = false
      // Wallet submission precedes relay delivery; keep its exact bytes ambiguous.
      offlineChain.broadcastDown = true
      const handed: { body: Uint8Array; contentType: string }[] = []
      const base = directory.fetch!
      directory = {
        ...directory,
        fetch: (url, init) => {
          handed.push({
            body: new Uint8Array(init.body!),
            contentType: init.headers['Content-Type'],
          })
          return base(url, init)
        },
      }
      const fetch = directory.fetch!
      installCanonicalDirectory(alice, {
        ...directory,
        fetch: async (url, init) => {
          await fetch(url, init)
          throw new Error('lost accepted response')
        },
      })
      const pending = await send(1).catch(error => error)
      expect(pending).toBeInstanceOf(MonadStampPendingAttemptError)
      expect(isDirectMessageNotAttempted(pending)).toBe(false)
      const digest = pending.payloadHashes[0]
      expect(bobMailbox).toHaveLength(1)
      const original = relayPayments()[0]
      expect(offlineChain.walletBroadcasts).toEqual([original.serialized])
      const operationId = alice.getNativeOperations!().find(row =>
        row.members.some(member => member.signed?.transactionHash === original.hash),
      )!.operationId
      await reopen()
      relay.answer = identity =>
        typeof refusal === 'string'
          ? {
              status: 200,
              body: { version: 1, phase: 'dead', identity, reason: refusal },
            }
          : {
              status: refusal,
              body: {
                version: 1,
                error:
                  refusal === 409
                    ? 'canonical_directory_predecessor_missing'
                    : 'invalid_canonical_submission',
              },
            }
      expect((await tick([digest]))[digest]).toBe('live')
      expect(alice.transactionSetPreparer!.isSourceReserved(coin.address)).toBe(true)
      expect(
        f.chain.directMessages.paymentsOf?.({
          wallet: alice,
          payloadDigest: digest,
        }),
      ).toEqual(['pending'])
      await reopen()
      expect(alice.transactionSetPreparer!.isSourceReserved(coin.address)).toBe(true)
      offlineChain.broadcastDown = false
      offlineChain.mine(original.serialized)
      await tick([digest])
      expect(
        f.chain.directMessages.paymentsOf?.({
          wallet: alice,
          payloadDigest: digest,
        }),
      ).toEqual(['spent'])
      expect(alice.transactionSetPreparer!.isSourceReserved(coin.address)).toBe(false)
      relay.answer = undefined
      await Promise.all([tick([digest]), tick([digest])])
      for (let pass = 0; pass < 6; pass++) await tick([digest])
      expect((await tick([digest]))[digest]).toBe('delivered')
      expect(
        new Set(bobMailbox.map(message => toHex(message.delivery))).size,
      ).toBe(1)
      expect(new Set(relayPayments().map(payment => payment.hash))).toEqual(
        new Set([original.hash]),
      )
      const operation = alice.getNativeOperations!().find(row => row.operationId === operationId)!
      expect(operation.members.map(member => member.signed!.rawTransaction)).toEqual([original.serialized])
      expect(new Set(offlineChain.walletBroadcasts)).toEqual(new Set([original.serialized]))
      for (const request of handed) expect(request).toEqual(handed[0])
      await expect(send(1)).rejects.toBeInstanceOf(
        DirectMessageAlreadyAttemptedError,
      )
    },
  )

  it('a host interruption after durable construction preserves its keys and original graph across restart', async () => {
    const [coin] = await fundAccounts(1)
    const refusal = new Error('host interrupted before exposure')
    await expect(send(1, alice, () => { throw refusal })).rejects.toBe(refusal)
    expect(relay.bodies).toHaveLength(0)
    expect(offlineChain.walletBroadcasts).toHaveLength(0)
    const original = alice.getNativeOperations!().flatMap(row => row.members.map(member => member.signed!.rawTransaction))
    expect(original).toHaveLength(1)
    expect(alice.transactionSetPreparer!.isSourceReserved(coin.address)).toBe(true)
    await reopen()
    expect(alice.pool.getRecord(coin.index)?.address).toBe(coin.address)
    expect(alice.transactionSetPreparer!.isSourceReserved(coin.address)).toBe(true)
    await expect(send(1)).rejects.toBeInstanceOf(DirectMessageAlreadyAttemptedError)
    await tick()
    expect(relayPayments().map(payment => payment.serialized)).toEqual(original)
    expect(bobMailbox).toHaveLength(1)
  })

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
    const operations = alice.getNativeOperations!().filter(row => row.kind === 'transaction-set')
    expect(operations).toHaveLength(21)
    for (const operation of operations) {
      expect(operation.members.every(member => member.observation.state === 'included-success')).toBe(true)
      expect(operation.members.every(member => member.transactionSet?.inventoryApplied)).toBe(true)
    }
    for (const row of rows) expect(alice.transactionSetPreparer!.isSourceReserved(row.address)).toBe(false)
    expect(payersOf([first, ...sent])).toHaveLength(21)
  })

  // Seen in Chrome on testnet: the balance shown was not what sends drew on.
  it('the balance is the sum of every coin a send can draw on (main, profile address, funded sending accounts), its parts add up to it, and a send is paid out of it', async () => {
    const main = (await alice.getReceiveAddress()).raw.toLowerCase()
    const identity = alice.identity.address.raw.toLowerCase()
    mockBalances.set(main, 500_000n)
    mockBalances.set(identity, 300_000n)
    const rows = await fundAccounts(2)
    const funded = 2n * (STAMP + FEE_RESERVE)
    const parts = await alice.getBalanceParts!()
    expect(parts).toEqual({
      main: 500_000n,
      profile: 300_000n,
      received: 0n,
      receivedCount: 0,
      sending: funded,
    })
    expect(await alice.getBalance()).toBe(800_000n + funded)
    // A message is paid from a funded sending account: the balance falls by what left it.
    const sent = await send(1)
    await tick()
    const spent = relayPayments().find(
      tx => tx.hash === sent.stampPayments[0].txHash,
    )!
    expect(rows.map(row => row.address.toLowerCase())).toContain(
      spent.from!.toLowerCase(),
    )
    const after = await alice.getBalanceParts!()
    // The next nonce owns the residual. This fixture's node does not deduct gas fees.
    expect(after.sending).toBe(funded - STAMP)
    expect(after.main + after.profile).toBe(800_000n)
    expect(await alice.getBalance()).toBe(800_000n + funded - STAMP)
  })

  it('a new account whose only money is at its identity address sends a paid message, with no funding transfer', async () => {
    const identity = alice.identity.address.raw.toLowerCase()
    mockBalances.set(identity, 10n ** 17n)
    expect(await alice.getBalance()).toBe(10n ** 17n)
    const sent = await send(1)
    // One recipient payment; all additional signed movements stay wallet-owned.
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
    const operation = alice.getNativeOperations!().find(row => row.members.some(member =>
      member.signed?.transactionHash === sent.stampPayments[0].txHash,
    ))!
    const owned = operation.members.filter(member => member.transactionSet?.role !== 'payment')
    expect(owned.length).toBeGreaterThan(0)
    const destinations = new Set([identity, ...owned.map(member => Transaction.from(member.signed!.rawTransaction).to!.toLowerCase())])
    expect([...destinations].reduce((sum, address) => sum + (mockBalances.get(address) ?? 0n), 0n)).toBe(10n ** 17n - STAMP)
    expect(new Set(offlineChain.walletBroadcasts)).toEqual(new Set(operation.members.map(member => member.signed!.rawTransaction)))
  })

  it('three concurrent sends with only one root input reserve it once and reject the other two without a global wait', async () => {
    const main = (await alice.getReceiveAddress()).raw.toLowerCase()
    mockBalances.set(main, 10n ** 17n)
    offlineChain.broadcastDown = true
    offlineChain.relayBroadcasts = false
    const attempts = await Promise.allSettled([send(1), send(2), send(3)])
    const successful = attempts.filter(result => result.status === 'fulfilled')
    const refused = attempts.filter(result => result.status === 'rejected')
    expect(successful).toHaveLength(1)
    expect(refused).toHaveLength(2)
    for (const result of refused) expect(result.reason).toBeInstanceOf(InsufficientStampFundsError)
    const operations = alice.getNativeOperations!().filter(row => row.kind === 'transaction-set')
    expect(operations).toHaveLength(1)
    const original = operations[0].members.map(member => member.signed!.rawTransaction)
    expect(alice.transactionSetPreparer!.isSourceReserved(main)).toBe(true)
    expect(new Set(operations[0].members.map(member => `${member.source.address}:${Transaction.from(member.signed!.rawTransaction).nonce}`)).size).toBe(original.length)
    expect(mockFunded).toHaveLength(0)
    // Finish the one authorized graph without creating a second signature at any nonce.
    offlineChain.broadcastDown = false
    const sent = successful[0]!
    if (sent.status !== 'fulfilled') throw new Error('Expected successful construction')
    await alice.transactionSetSubmission!.sendTransaction(alice.transactionSetPreparer!.getTransactionSet(operations[0].preparationId!.slice('evm-transaction-set:'.length)))
    expect(alice.getNativeOperations!().find(row => row.operationId === operations[0].operationId)!.members.map(member => member.signed!.rawTransaction)).toEqual(original)
    expect(alice.transactionSetPreparer!.isSourceReserved(main)).toBe(false)
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
      // Keep assertion failures serializable when Jest reports from a worker process.
      expect(sent.stampPayments.map(p => p.valueWei.toString())).toEqual(['50000'])
      expect(relayPayments()[0].from!.toLowerCase()).toBe(
        (await alice.getReceiveAddress()).raw.toLowerCase(),
      )
    })
  })

  it('ten sends with five inputs yield five payments and five insufficient intents that resume once more inputs arrive', async () => {
    await fundAccounts(5)
    const attempts = await Promise.allSettled(Array.from({ length: 10 }, (_, index) => send(index)))
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(5)
    expect(attempts.filter(result => result.status === 'rejected')).toHaveLength(5)
    for (const result of attempts) if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(InsufficientStampFundsError)
    expect(graphBytes()).toHaveLength(5)
    expect(bobMailbox).toHaveLength(5)
    const identities = await Promise.all(Array.from({ length: 10 }, (_, index) => f.chain.directMessages.attemptOf!({ wallet: alice, messageId: ID(index) })))
    expect(identities.every(attempt => attempt?.paid === true)).toBe(true)
    const original = graphBytes()
    await fundAccounts(5)
    await tick()
    expect(bobMailbox).toHaveLength(10)
    expect(graphBytes()).toHaveLength(10)
    expect(graphBytes().filter(raw => original.includes(raw))).toEqual(original)
    expect(new Set(relayPayments().map(tx => `${tx.from}:${tx.nonce}`)).size).toBe(10)
    for (let index = 0; index < 10; index++) expect(await f.chain.directMessages.attemptOf!({ wallet: alice, messageId: ID(index) })).toEqual(identities[index])
  })

  it('a message the relay has not answered for does not hold back the next one', async () => {
    const [a, b] = await fundAccounts(2)
    f.setPhase('fail')
    const stuck = await send(1).catch(error => error)
    expect(stuck).toBeInstanceOf(MonadStampPendingAttemptError)
    // Financial submission can settle while delivery remains unknown.
    expect(offlineChain.walletBroadcasts).toHaveLength(1)
    const original = offlineChain.walletBroadcasts[0]
    f.setPhase('delivered')
    const second = await send(2)
    expect(bobMailbox).toHaveLength(1)
    await tick()
    // The second is delivered and paid; the first was re-sent by the same pass, the same bytes.
    for (const row of [a, b]) expect(alice.transactionSetPreparer!.isSourceReserved(row.address)).toBe(false)
    expect(alice.getNativeOperations!().flatMap(row => row.members).every(member => member.observation.state === 'included-success')).toBe(true)
    expect(offlineChain.walletBroadcasts.filter(raw => raw === original)).toHaveLength(1)
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

  it('wallet payment can settle while the relay is unavailable and recovery delivers the original message without repaying', async () => {
    const [coin] = await fundAccounts(1)
    f.setPhase('fail')
    offlineChain.broadcastDown = true
    offlineChain.relayBroadcasts = false
    const pending = await send(1).catch(error => error)
    expect(pending).toBeInstanceOf(MonadStampPendingAttemptError)
    const digest = pending.payloadHashes[0]
    const original = graphBytes()
    expect(alice.transactionSetPreparer!.isSourceReserved(coin.address)).toBe(true)
    await expect(constructOnly('unrelated-while-held')).rejects.toThrow('Insufficient available EVM coins')
    offlineChain.broadcastDown = false
    for (let pass = 0; pass < 8; pass++) await tick([digest])
    expect(offlineChain.mined.has(Transaction.from(original[0]).hash!)).toBe(true)
    expect(bobMailbox).toHaveLength(0)
    expect(alice.transactionSetPreparer!.isSourceReserved(coin.address)).toBe(false)
    f.setPhase('delivered')
    for (let pass = 0; pass < 16 && bobMailbox.length === 0; pass++) await tick([digest])
    expect(bobMailbox).toHaveLength(1)
    expect(new Set(relayPayments().map(tx => tx.serialized))).toEqual(new Set(original))
    expect(new Set(offlineChain.walletBroadcasts)).toEqual(new Set(original))
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
    expect(offlineChain.walletBroadcasts).toHaveLength(1)
    await tick([digest])
    // Seen on chain: spent, although the wallet still has no confirmation of delivery.
    expect(alice.transactionSetPreparer!.isSourceReserved(row.address)).toBe(false)
    expect((await tick([digest]))[digest]).toBe('live')
    lose = false
    for (let pass = 0; pass < 16; pass++)
      if ((await tick([digest]))[digest] === 'delivered') break
    expect((await tick([digest]))[digest]).toBe('delivered')
    expect(offlineChain.walletBroadcasts).toHaveLength(1)
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
    // The synchronous fixture has already included this exact transaction.
    expect(offlineChain.mined.has(sent.stampPayments[0].txHash)).toBe(true)
    await tick()
    expect(alice.transactionSetPreparer!.isSourceReserved(row.address)).toBe(false)
  })

  it('neither broadcast lands while the node is down: the same bytes are broadcast again until included', async () => {
    const [row] = await fundAccounts(1)
    offlineChain.relayBroadcasts = false
    // Nonce admission succeeds before signing. Fail the node after original signed bytes
    // are durable but before either party can broadcast them.
    await expect(send(1, alice, () => { offlineChain.nodeDown = true })).rejects.toThrow('node unreachable')
    const attempt = await f.chain.directMessages.attemptOf!({ wallet: alice, messageId: ID(1) })
    const original = alice.getNativeOperations!().flatMap(row => row.members.map(member => member.signed!.rawTransaction))
    expect(original).toHaveLength(1)
    const sent = { payloadDigest: attempt!.payloadDigest, stampPayments: [{ txHash: Transaction.from(original[0]).hash! }] }
    expect(bobMailbox).toHaveLength(1)
    for (let pass = 0; pass < 8; pass++) await tick().catch(error => { expect(error.message).toBe('node unreachable') })
    expect(alice.transactionSetPreparer!.isSourceReserved(row.address)).toBe(true)
    offlineChain.nodeDown = false
    for (let pass = 0; pass < 40 && alice.transactionSetPreparer!.isSourceReserved(row.address); pass++)
      await tick()
    expect(alice.transactionSetPreparer!.isSourceReserved(row.address)).toBe(false)
    expect(new Set(offlineChain.walletBroadcasts).size).toBe(1)
    expect(offlineChain.walletBroadcasts.length).toBeGreaterThan(0)
    expect(new Set(offlineChain.walletBroadcasts)).toEqual(new Set(original))
    expect(offlineChain.mined.has(sent.stampPayments[0].txHash)).toBe(true)
  })

  it('a payment whose nonce was consumed by another transaction: the claim ends as failed and nothing is paid again', async () => {
    const [row] = await fundAccounts(1)
    offlineChain.relayBroadcasts = false
    await expect(send(1, alice, () => { offlineChain.nodeDown = true })).rejects.toThrow('node unreachable')
    const attempt = await f.chain.directMessages.attemptOf!({ wallet: alice, messageId: ID(1) })
    const original = alice.getNativeOperations!().flatMap(row => row.members.map(member => member.signed!.rawTransaction))
    expect(original).toHaveLength(1)
    const sent = { payloadDigest: attempt!.payloadDigest, stampPayments: [{ txHash: Transaction.from(original[0]).hash! }] }
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
    expect(alice.transactionSetPreparer!.isSourceReserved(row.address)).toBe(false)
    expect(alice.getNativeOperations!().flatMap(operation => operation.members.map(member => member.signed!.rawTransaction))).toEqual(original)
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
    offlineChain.broadcastDown = true
    offlineChain.relayBroadcasts = false
    const sent = await send(1)
    offlineChain.broadcastDown = false
    offlineChain.mine(relayPayments()[0].serialized)
    // The node counts the nonce and has no receipt for the payment yet, but it knows the
    // transaction by its hash: read directly, that is "in the node, not in a block", never
    // "replaced". (Only a transaction the node does not know at all, at a consumed nonce, has
    // failed; no timer decides.)
    const receipt = jest
      .spyOn(alice.provider, 'getTransactionReceipt')
      .mockResolvedValue(null)
    const known = jest
      .spyOn(alice.provider, 'getTransaction')
      .mockResolvedValue({ hash: 'known' } as never)
    for (let pass = 0; pass < 8; pass++) await tick()
    expect(
      f.chain.directMessages.paymentsOf?.({
        wallet: alice,
        payloadDigest: sent.payloadDigest,
      }),
    ).toEqual(['pending'])
    expect(alice.transactionSetPreparer!.isSourceReserved(row.address)).toBe(true)
    receipt.mockRestore()
    known.mockRestore()
    for (let pass = 0; pass < 9; pass++) await tick()
    expect(alice.transactionSetPreparer!.isSourceReserved(row.address)).toBe(false)
  })

  it('a failed message projection write cannot undo durable journal settlement or authorize another payment', async () => {
    const [coin] = await fundAccounts(1)
    offlineChain.relayBroadcasts = false
    offlineChain.broadcastDown = true
    await send(1)
    const original = graphBytes()
    offlineChain.mine(original[0])
    mockMessageWrite.mode = 'dropped'
    await tick().catch(() => undefined)
    expect(mockMessageWrite.mode).toBe('ok')
    const member = alice.getNativeOperations!()[0].members[0]
    expect(member.observation.state).toBe('included-success')
    expect(member.transactionSet!.inventoryApplied).toBe(true)
    await reopen()
    await tick()
    expect(graphBytes()).toEqual(original)
    expect(alice.transactionSetPreparer!.isSourceReserved(coin.address)).toBe(false)
  })

  it('a pending root graph keeps its input and provisional change private across restart until settlement', async () => {
    const main = (await alice.getReceiveAddress()).raw.toLowerCase()
    mockBalances.set(main, 10n ** 17n)
    offlineChain.relayBroadcasts = false
    offlineChain.broadcastDown = true
    const first = await send(1)
    const original = graphBytes()
    await expect(constructOnly('blocked-before-restart')).rejects.toThrow('Insufficient available EVM coins')
    await reopen()
    expect(alice.transactionSetPreparer!.isSourceReserved(main)).toBe(true)
    await expect(constructOnly('blocked-after-restart')).rejects.toThrow('Insufficient available EVM coins')
    expect(graphBytes()).toEqual(original)
    offlineChain.broadcastDown = false
    await tick([first.payloadDigest])
    expect(alice.transactionSetPreparer!.isSourceReserved(main)).toBe(false)
    const next = await send(2)
    expect(next.payloadDigest).not.toBe(first.payloadDigest)
    const slots = graphBytes().map(raw => { const tx = Transaction.from(raw); return `${tx.from}:${tx.nonce}` })
    expect(new Set(slots).size).toBe(slots.length)
  })

  it('a blocked root construction fails without polling or relaying the earlier message', async () => {
    const main = (await alice.getReceiveAddress()).raw.toLowerCase()
    mockBalances.set(main, 10n ** 17n)
    offlineChain.relayBroadcasts = false
    offlineChain.broadcastDown = true
    await send(1)
    const original = graphBytes()
    const relayCount = relay.bodies.length
    providerRequests.length = 0
    await expect(constructOnly('blocked-root')).rejects.toThrow('Insufficient available EVM coins')
    expect(relay.bodies).toHaveLength(relayCount)
    expect(providerRequests.filter(method => method === 'getTransactionReceipt')).toEqual([])
    expect(graphBytes()).toEqual(original)
    expect(alice.transactionSetPreparer!.isSourceReserved(main)).toBe(true)
  })

  it('five constructions contending for a pending root fail independently without a global polling queue', async () => {
    const main = (await alice.getReceiveAddress()).raw.toLowerCase()
    mockBalances.set(main, 10n ** 17n)
    offlineChain.relayBroadcasts = false
    offlineChain.broadcastDown = true
    await send(1)
    const original = graphBytes()
    providerRequests.length = 0
    const outcomes = await Promise.allSettled(Array.from({ length: 5 }, (_, index) => constructOnly(`blocked-${index}`)))
    expect(outcomes.every(result => result.status === 'rejected')).toBe(true)
    for (const result of outcomes) if (result.status === 'rejected') expect(result.reason.message).toBe('Insufficient available EVM coins')
    expect(providerRequests.filter(method => method === 'getTransactionReceipt')).toEqual([])
    expect(graphBytes()).toEqual(original)
    expect(alice.transactionSetPreparer!.isSourceReserved(main)).toBe(true)
  })

  it('an unavailable chain leaves a durable paid attempt recoverable while an unrelated free message can send', async () => {
    await fundAccounts(1)
    offlineChain.relayBroadcasts = false
    await expect(send(1, alice, () => { offlineChain.nodeDown = true })).rejects.toThrow('node unreachable')
    const original = graphBytes()
    expect(original).toHaveLength(1)
    await expect(f.chain.directMessages.send({ wallet: alice, recipient: f.bob.identity.address, items: [{ type: 'text', text: 'independent free message' }], stampValue: 0n, messageId: ID(2) })).resolves.toMatchObject({ stampValueWei: 0n })
    offlineChain.nodeDown = false
    await tick()
    expect(graphBytes()).toEqual(original)
    expect(new Set(offlineChain.walletBroadcasts)).toEqual(new Set(original))
    expect(bobMailbox).toHaveLength(2)
  })

  it('an account consumed after its payment is signed goes out of use; every other send proceeds', async () => {
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
    offlineChain.relayBroadcasts = false
    // Before selection, a consumed nonce is a legitimate successor coin. Consume it only
    // after this message signs nonce zero, preserving the failed-original-payment race.
    const raced = await send(2, alice, () => { offlineChain.mine(stolen.rawTx) }).catch(error => error)
    expect(raced).toBeInstanceOf(MonadStampPendingAttemptError)
    const settled = await Promise.allSettled([Promise.resolve(raced), send(3), send(4)])
    const original = graphBytes().map(raw => Transaction.from(raw)).filter(tx => tx.from!.toLowerCase() === victim.address.toLowerCase())
    expect(original).toHaveLength(1)
    expect(original[0].nonce).toBe(0)
    expect(offlineChain.mined.has(original[0].hash!)).toBe(false)
    expect(settled.map(s => s.status)).toEqual([
      'fulfilled',
      'fulfilled',
      'fulfilled',
    ])
    for (let pass = 0; pass < 6; pass++) await tick()
    // The message that drew the bad account is delivered; its payment is recorded as failed.
    const failedAttempt = await f.chain.directMessages.attemptOf!({ wallet: alice, messageId: ID(2) })
    const states = [first, { payloadDigest: failedAttempt!.payloadDigest }, ...settled.slice(1).map(s => (s as PromiseFulfilledResult<typeof first>).value)]
      .map(result =>
        f.chain.directMessages.paymentsOf?.({
          wallet: alice,
          payloadDigest: result.payloadDigest,
        }),
      )
      .flat()
    expect(states.sort()).toEqual(['failed', 'spent', 'spent', 'spent'])
    expect(alice.transactionSetPreparer!.isSourceReserved(victim.address)).toBe(false)
    expect(bobMailbox).toHaveLength(3)
  })

  it.each([
    400,
    413,
    422,
    409,
    'sender_unpublished',
    'expired',
  ] as const)(
    'even the first relay refusal (%s) retains signed bytes and claims across restart',
    async refusal => {
      const [held, other] = await fundAccounts(2)
      offlineChain.broadcastDown = true
      offlineChain.relayBroadcasts = false
      relay.answer = identity =>
        typeof refusal === 'string'
          ? {
              status: 200,
              body: { version: 1, phase: 'dead', identity, reason: refusal },
            }
          : {
              status: refusal,
              body: {
                version: 1,
                error:
                  refusal === 409
                    ? 'canonical_directory_predecessor_missing'
                    : 'invalid_canonical_submission',
              },
            }
      const pending = await send(1).catch(error => error)
      expect(pending).toBeInstanceOf(MonadStampPendingAttemptError)
      const digest = pending.payloadHashes[0]
      expect(alice.transactionSetPreparer!.isSourceReserved(held.address)).toBe(true)
      await reopen()
      expect(alice.transactionSetPreparer!.isSourceReserved(held.address)).toBe(true)
      const original = alice.getNativeOperations!().flatMap(row => row.members).map(member => member.signed!.rawTransaction)
      expect(original).toHaveLength(1)
      relay.answer = undefined
      offlineChain.broadcastDown = false
      const next = await send(2)
      expect(relayPayments()[0].from!.toLowerCase()).toBe(
        other.address.toLowerCase(),
      )
      for (let pass = 0; pass < 8; pass++) await tick([digest])
      expect((await tick([digest]))[digest]).toBe('delivered')
      expect(
        f.chain.directMessages.paymentsOf?.({
          wallet: alice,
          payloadDigest: digest,
        }),
      ).toEqual(['spent'])
      expect(new Set(relayPayments().map(payment => payment.hash)).size).toBe(2)
      expect(new Set(offlineChain.walletBroadcasts)).toEqual(new Set([...original, ...relayPayments().map(payment => payment.serialized)]))
      expect(alice.getNativeOperations!().flatMap(row => row.members).filter(member => member.signed!.rawTransaction === original[0])).toHaveLength(1)
      expect(
        relayPayments().some(
          payment => payment.hash === next.stampPayments[0].txHash,
        ),
      ).toBe(true)
      await expect(send(1)).rejects.toBeInstanceOf(
        DirectMessageAlreadyAttemptedError,
      )
    },
  )

  /** Spends `coin` outside the list (another device of the account): its nonce is used. */
  function spendElsewhere(coin: { index: number; address: string }) {
    const tx = Transaction.from({
      type: 2,
      chainId: 10143n,
      nonce: 0,
      to: '0x' + '42'.repeat(20),
      value: STAMP,
      gasLimit: 21_000n,
      maxFeePerGas: 3n,
      maxPriorityFeePerGas: 1n,
    })
    tx.signature = new SigningKey(alice.pool.privateKeyOf(coin.index)).sign(
      tx.unsignedHash,
    )
    expect(tx.from!.toLowerCase()).toBe(coin.address.toLowerCase())
    offlineChain.mine(tx.serialized)
  }
  /** The relay refuses the next `times` message requests before storing or broadcasting. */
  function refuseBeforeExposure(reason: string, times = Infinity) {
    let left = times
    relay.answer = identity => {
      if (--left <= 0) relay.answer = undefined
      return {
        status: 200,
        body: { version: 1, phase: 'dead', identity, reason },
      }
    }
  }

  /** The relay's own check before it stores anything (#1732): a payment whose nonce another
   * transaction already used, and that the node does not know, makes the message dead. */
  function precheckLikeTheRelay() {
    relay.answer = (identity, payments) =>
      payments.some(
        tx =>
          !offlineChain.mined.has(tx.hash!) &&
          [...offlineChain.mined.values()].filter(
            from => from === tx.from!.toLowerCase(),
          ).length > tx.nonce,
      )
        ? {
            status: 200,
            body: { version: 1, phase: 'dead', identity, reason: 'stale_nonce' },
          }
        : undefined
  }

  it('refresh discovers an externally consumed input before signing and selects another owned coin', async () => {
    const [held, other] = await fundAccounts(2)
    await evmWalletInternals(alice).coinListSync!.refresh()
    spendElsewhere(held)
    precheckLikeTheRelay()
    const sent = await send(1)
    expect(relayPayments().map(payment => payment.from!.toLowerCase())).toEqual([other.address.toLowerCase()])
    expect(alice.getNativeOperations!().flatMap(row => row.members).every(member => member.source.address !== held.address.toLowerCase())).toBe(true)
    expect(offlineChain.walletBroadcasts.map(raw => Transaction.from(raw).from!.toLowerCase())).not.toContain(held.address.toLowerCase())
    expect(f.chain.directMessages.paymentsOf!({ wallet: alice, payloadDigest: sent.payloadDigest })).toEqual(['spent'])
  })

  it('refresh discovers the only input was consumed and refuses before producing any signed graph', async () => {
    const [held] = await fundAccounts(1)
    await evmWalletInternals(alice).coinListSync!.refresh()
    spendElsewhere(held)
    precheckLikeTheRelay()
    await expect(send(1)).rejects.toBeInstanceOf(InsufficientStampFundsError)
    expect(alice.transactionSetPreparer!.isSourceReserved(held.address)).toBe(false)
    expect(alice.getNativeOperations!()).toHaveLength(0)
    expect(offlineChain.walletBroadcasts).toHaveLength(0)
    expect(relay.bodies).toHaveLength(0)
  })

  it('repeated first refusals retain the original graph instead of replanning against unrelated inputs', async () => {
    const [held, ...others] = await fundAccounts(4)
    offlineChain.broadcastDown = true
    offlineChain.relayBroadcasts = false
    refuseBeforeExposure('stale_nonce')
    const refused = await send(1).catch(error => error)
    expect(refused).toBeInstanceOf(MonadStampPendingAttemptError)
    const original = alice.getNativeOperations!().flatMap(row => row.members.map(member => member.signed!.rawTransaction))
    for (let pass = 0; pass < 4; pass++) await tick()
    expect(original).toHaveLength(1)
    expect(alice.getNativeOperations!().flatMap(row => row.members.map(member => member.signed!.rawTransaction))).toEqual(original)
    expect(alice.transactionSetPreparer!.isSourceReserved(held.address)).toBe(true)
    for (const coin of others) expect(alice.transactionSetPreparer!.isSourceReserved(coin.address)).toBe(false)
    await reopen()
    expect(alice.transactionSetPreparer!.isSourceReserved(held.address)).toBe(true)
    relay.answer = undefined
    offlineChain.broadcastDown = false
    await send(2)
    expect(relayPayments()[0].from!.toLowerCase()).not.toBe(held.address.toLowerCase())
  })

  it('the refusals taken as before exposure are exactly those the relay answers before it stores anything', () => {
    const source = readFileSync(
      join(
        __dirname,
        '../../../backend/cashweb/cashweb-registry/src/http/monad_message_cbor.rs',
      ),
      'utf8',
    )
    const handler = source.slice(source.indexOf('async fn handle_put'))
    const beforeStore = handler.slice(0, handler.indexOf('owner.claim('))
    expect(beforeStore).toContain('"undeliverable"')
    expect(beforeStore).toContain('precheck_payments(')
    for (const reason of ['stale_nonce', 'insufficient_total'])
      expect(source).toContain(`=> "${reason}"`)
    expect([...REFUSED_BEFORE_EXPOSURE].sort()).toEqual(
      ['insufficient_total', 'stale_nonce', 'undeliverable'],
    )
    for (const reason of REFUSED_BEFORE_EXPOSURE)
      expect(CANONICAL_TERMINAL_REASONS).toContain(reason)
  })

  it('through a forwarding relay, even a first refusal keeps the signed payment and its coin', async () => {
    const [held] = await fundAccounts(1)
    offlineChain.broadcastDown = true
    offlineChain.relayBroadcasts = false
    installCanonicalDirectory(alice, {
      ...directory,
      isHomeRelay: async () => false,
      forwarding: async () => true,
    })
    refuseBeforeExposure('undeliverable')
    const pending = await send(1).catch(error => error)
    expect(pending).toBeInstanceOf(MonadStampPendingAttemptError)
    expect(alice.transactionSetPreparer!.isSourceReserved(held.address)).toBe(true)
    expect(
      f.chain.directMessages.paymentsOf?.({
        wallet: alice,
        payloadDigest: pending.payloadHashes[0],
      }),
    ).toEqual(['pending'])
  })

  it('an undeliverable first refusal retains exposed signed bytes across restart without authorizing another payment', async () => {
    const [held] = await fundAccounts(1)
    offlineChain.broadcastDown = true
    offlineChain.relayBroadcasts = false
    refuseBeforeExposure('undeliverable')
    await expect(send(1)).rejects.toBeInstanceOf(MonadStampPendingAttemptError)
    const original = alice.getNativeOperations!().flatMap(row => row.members.map(member => member.signed!.rawTransaction))
    expect(original).toHaveLength(1)
    expect(alice.transactionSetPreparer!.isSourceReserved(held.address)).toBe(true)
    await reopen()
    expect(alice.transactionSetPreparer!.isSourceReserved(held.address)).toBe(true)
    expect(alice.getNativeOperations!().flatMap(row => row.members.map(member => member.signed!.rawTransaction))).toEqual(original)
    await expect(send(1)).rejects.toBeInstanceOf(DirectMessageAlreadyAttemptedError)
  })

  it('a stored unsubmitted message resumes the same graph before relay refusal and keeps its ambiguous reservation', async () => {
    const [held] = await fundAccounts(1)
    offlineChain.broadcastDown = true
    offlineChain.relayBroadcasts = false
    const stopped = await f.chain.directMessages
      .send({
        wallet: alice,
        recipient: f.bob.identity.address,
        items: [{ type: 'text', text: 'message 1' }],
        stampValue: STAMP,
        messageId: ID(1),
        onAttemptCreated: () => {
          throw new Error('cut off before the relay')
        },
      })
      .catch(error => error)
    expect(stopped).toBeInstanceOf(Error)
    expect(relay.bodies).toHaveLength(0)
    expect(alice.transactionSetPreparer!.isSourceReserved(held.address)).toBe(true)
    // Across a restart: the record says nothing of it left the wallet.
    await reopen()
    expect(alice.transactionSetPreparer!.isSourceReserved(held.address)).toBe(true)
    refuseBeforeExposure('insufficient_total')
    await tick()
    expect(alice.transactionSetPreparer!.isSourceReserved(held.address)).toBe(true)
    expect(new Set(offlineChain.walletBroadcasts).size).toBe(1)
  })

  it('a refusal on a resend after a submission whose answer was lost keeps the coin held', async () => {
    const [held] = await fundAccounts(1)
    offlineChain.broadcastDown = true
    offlineChain.relayBroadcasts = false
    installCanonicalDirectory(alice, {
      ...directory,
      fetch: async () => {
        throw new Error('answer lost')
      },
    })
    const first = await send(1).catch(error => error)
    expect(first).toBeInstanceOf(MonadStampPendingAttemptError)
    installCanonicalDirectory(alice, directory)
    refuseBeforeExposure('insufficient_total')
    await tick([first.payloadHashes[0]])
    await reopen()
    await tick([first.payloadHashes[0]])
    expect(alice.transactionSetPreparer!.isSourceReserved(held.address)).toBe(true)
    expect(
      f.chain.directMessages.paymentsOf?.({
        wallet: alice,
        payloadDigest: first.payloadHashes[0],
      }),
    ).toEqual(['pending'])
  })

  it('a refused root-paid attempt keeps its reservation while the next send fails without a global wait', async () => {
    const main = (await alice.getReceiveAddress()).raw.toLowerCase()
    mockBalances.set(main, 10n ** 17n)
    offlineChain.broadcastDown = true
    offlineChain.relayBroadcasts = false
    refuseBeforeExposure('insufficient_total')
    const first = await send(1).catch(error => error)
    expect(first).toBeInstanceOf(MonadStampPendingAttemptError)
    const original = graphBytes()
    await expect(send(2)).rejects.toBeInstanceOf(InsufficientStampFundsError)
    expect(alice.transactionSetPreparer!.isSourceReserved(main)).toBe(true)
    expect(graphBytes()).toEqual(original)
    expect(f.chain.directMessages.paymentsOf!({ wallet: alice, payloadDigest: first.payloadHashes[0] })).toEqual(['pending'])
  })

  it('a host binding in progress keeps its signed graph private while another input sends independently', async () => {
    const [held, other] = await fundAccounts(2)
    let entered!: () => void
    const inBinding = new Promise<void>(resolve => { entered = resolve })
    let bind!: () => void
    const bound = new Promise<void>(resolve => { bind = resolve })
    const first = f.chain.directMessages.send({ wallet: alice, recipient: f.bob.identity.address, items: [{ type: 'text', text: 'message 1' }], stampValue: STAMP, messageId: ID(1), onEnvelopeDurable: async () => { entered(); await bound } })
    await inBinding
    try {
      expect(offlineChain.walletBroadcasts).toEqual([])
      expect(relay.bodies).toEqual([])
      expect(alice.transactionSetPreparer!.isSourceReserved(held.address)).toBe(true)
      await send(2)
      expect(relayPayments().map(tx => tx.from!.toLowerCase())).toEqual([other.address.toLowerCase()])
      expect(alice.transactionSetPreparer!.isSourceReserved(held.address)).toBe(true)
    } finally { bind() }
    await expect(first).resolves.toMatchObject({ stampValueWei: STAMP })
    expect(new Set(relayPayments().map(tx => tx.from!.toLowerCase()))).toEqual(new Set([held.address.toLowerCase(), other.address.toLowerCase()]))
  })

  it('an unresolved holder cannot block newly available inputs from funding an independent message', async () => {
    const [held] = await fundAccounts(1)
    offlineChain.broadcastDown = true
    offlineChain.relayBroadcasts = false
    refuseBeforeExposure('insufficient_total')
    const pending = await send(1).catch(error => error)
    expect(pending).toBeInstanceOf(MonadStampPendingAttemptError)
    const original = graphBytes()
    const [available] = await fundAccounts(1)
    relay.answer = undefined
    const second = await send(2)
    expect(relayPayments()[0].from!.toLowerCase()).toBe(available.address.toLowerCase())
    expect(alice.transactionSetPreparer!.isSourceReserved(held.address)).toBe(true)
    // Settle only the independent graph; the first remains ambiguous and unchanged.
    offlineChain.mine(relayPayments()[0].serialized)
    const operation = alice.getNativeOperations!().find(row => row.members.some(member => member.signed!.transactionHash === second.stampPayments[0].txHash))!
    await alice.transactionSetLifecycle!.observe(operation.preparationId!.slice('evm-transaction-set:'.length), alice.provider)
    expect(alice.transactionSetPreparer!.isSourceReserved(held.address)).toBe(true)
    expect(alice.transactionSetPreparer!.isSourceReserved(available.address)).toBe(false)
    expect(graphBytes().filter(raw => original.includes(raw))).toEqual(original)
  })

  it('the unexposed mark is off the record on disk before the bytes reach the relay', async () => {
    await fundAccounts(1)
    const onDisk: (string | undefined)[] = []
    const base = directory.fetch!
    installCanonicalDirectory(alice, {
      ...directory,
      fetch: (url, init) => {
        onDisk.push(mockMessageWrite.written.at(-1))
        return base(url, init)
      },
    })
    await send(1)
    // The record was written with the mark, then without it, before the one request.
    expect(mockMessageWrite.written.some(row => row.includes('"unexposed":true'))).toBe(true)
    expect(onDisk).toHaveLength(1)
    expect(onDisk[0]).toBeDefined()
    expect(onDisk[0]).not.toContain('"unexposed"')
    expect(onDisk[0]).toContain('"request"')
  })

  it('a later non-refusal answer clears the recorded refusal, without releasing the original financial reservation', async () => {
    const main = (await alice.getReceiveAddress()).raw.toLowerCase()
    mockBalances.set(main, 10n ** 18n)
    offlineChain.broadcastDown = true
    offlineChain.relayBroadcasts = false
    installCanonicalDirectory(alice, {
      ...directory,
      fetch: async () => {
        throw new Error('answer lost')
      },
    })
    const first = await send(1).catch(error => error)
    const digest = first.payloadHashes[0]
    installCanonicalDirectory(alice, directory)
    relay.answer = identity => ({
      status: 200,
      body: { version: 1, phase: 'dead', identity, reason: 'insufficient_total' },
    })
    await tick([digest])
    expect(mockMessageWrite.written.at(-1)).toContain('"reason":"insufficient_total"')
    relay.answer = identity => ({
      status: 202,
      body: { version: 1, phase: 'retained', identity },
    })
    for (let pass = 0; pass < 4; pass++) await tick([digest])
    expect(mockMessageWrite.written.at(-1)).not.toContain('"reason"')
    // Delivery state does not release financially ambiguous signed inputs.
    const original = graphBytes()
    await expect(constructOnly('after-retained-answer')).rejects.toThrow('Insufficient available EVM coins')
    expect(alice.transactionSetPreparer!.isSourceReserved(main)).toBe(true)
    expect(graphBytes()).toEqual(original)
  })

  it('a shallow revert stays pending; a confirmed revert never authorizes a fresh payment, including after restart', async () => {
    const [coin] = await fundAccounts(1)
    offlineChain.revertNext = true
    const sent = await send(1)
    const original = relayPayments()[0]
    expect(offlineChain.reverted.has(original.hash!)).toBe(true)
    await tick()
    expect(f.chain.directMessages.paymentsOf!({ wallet: alice, payloadDigest: sent.payloadDigest })).toEqual(['pending'])
    expect(alice.transactionSetPreparer!.isSourceReserved(coin.address)).toBe(true)
    jest.spyOn(alice.provider, 'getBlockNumber').mockResolvedValue(3)
    await tick()
    expect(f.chain.directMessages.paymentsOf!({ wallet: alice, payloadDigest: sent.payloadDigest })).toEqual(['reverted'])
    await reopen()
    for (let pass = 0; pass < 4; pass++) await tick()
    expect(alice.getNativeOperations!().flatMap(row => row.members.map(member => member.signed!.rawTransaction))).toEqual([original.serialized])
    expect(new Set(offlineChain.walletBroadcasts)).toEqual(new Set([original.serialized]))
    expect(mockBalances.get(original.to!.toLowerCase()) ?? 0n).toBe(0n)
  })

  it('reconciling a confirmed revert does not sign a retry or release another operation reservation', async () => {
    const [first, other] = await fundAccounts(2)
    offlineChain.revertNext = true
    const reverted = await send(1)
    offlineChain.broadcastDown = true
    offlineChain.relayBroadcasts = false
    await send(2)
    expect(alice.transactionSetPreparer!.isSourceReserved(other.address)).toBe(true)
    const original = alice.getNativeOperations!().flatMap(row => row.members.map(member => member.signed!.rawTransaction))
    const construct = jest.spyOn(alice.transactionSetPreparer!, 'constructTransactionSet')
    jest.spyOn(alice.provider, 'getBlockNumber').mockResolvedValue(3)
    await tick([reverted.payloadDigest])
    expect(construct).not.toHaveBeenCalled()
    expect(alice.transactionSetPreparer!.isSourceReserved(first.address)).toBe(false)
    expect(alice.transactionSetPreparer!.isSourceReserved(other.address)).toBe(true)
    expect(alice.getNativeOperations!().flatMap(row => row.members.map(member => member.signed!.rawTransaction))).toEqual(original)
  })

  it('a payment superseded by an external nonce spend is never repeated on another account', async () => {
    const [coin] = await fundAccounts(2)
    offlineChain.relayBroadcasts = false
    offlineChain.broadcastDown = true
    const sent = await send(1)
    const original = relayPayments()[0]
    spendElsewhere(coin)
    offlineChain.broadcastDown = false
    for (let pass = 0; pass < 4; pass++) await tick()
    expect(f.chain.directMessages.paymentsOf!({ wallet: alice, payloadDigest: sent.payloadDigest })).toEqual(['failed'])
    expect(alice.getNativeOperations!().flatMap(row => row.members.map(member => member.signed!.rawTransaction))).toEqual([original.serialized])
    expect(offlineChain.mined.has(original.hash!)).toBe(false)
    expect(mockBalances.get(original.to!.toLowerCase()) ?? 0n).toBe(0n)
  })

  it('a repeatedly refused transaction retries the same signed bytes when the node recovers', async () => {
    const [coin] = await fundAccounts(1)
    offlineChain.relayBroadcasts = false
    offlineChain.refuseNext = true
    const sent = await send(1)
    const original = relayPayments()[0]
    expect(offlineChain.refused.has(original.hash!)).toBe(true)
    for (let pass = 0; pass < 4; pass++) await tick()
    expect(alice.transactionSetPreparer!.isSourceReserved(coin.address)).toBe(true)
    expect(new Set(offlineChain.walletBroadcasts)).toEqual(new Set([original.serialized]))
    offlineChain.refused.clear()
    for (let pass = 0; pass < 8 && !offlineChain.mined.has(original.hash!); pass++) await tick()
    expect(offlineChain.mined.has(original.hash!)).toBe(true)
    expect(f.chain.directMessages.paymentsOf!({ wallet: alice, payloadDigest: sent.payloadDigest })).toEqual(['spent'])
    expect(mockBalances.get(original.to!.toLowerCase())).toBe(STAMP)
    await reopen()
    await tick()
    expect(alice.getNativeOperations!().flatMap(row => row.members.map(member => member.signed!.rawTransaction))).toEqual([original.serialized])
  })

  it('restart after node refusal retains one original transaction and never offers a replacement signature', async () => {
    const [coin] = await fundAccounts(1)
    offlineChain.relayBroadcasts = false
    offlineChain.refuseNext = true
    const sent = await send(1)
    const original = relayPayments()[0]
    await tick()
    await reopen()
    expect(alice.transactionSetPreparer!.isSourceReserved(coin.address)).toBe(true)
    expect(alice.getNativeOperations!().flatMap(row => row.members.map(member => member.signed!.rawTransaction))).toEqual([original.serialized])
    offlineChain.refused.clear()
    await tick()
    expect(f.chain.directMessages.paymentsOf!({ wallet: alice, payloadDigest: sent.payloadDigest })).toEqual(['spent'])
    expect(new Set(offlineChain.walletBroadcasts)).toEqual(new Set([original.serialized]))
    expect(offlineChain.mined.size).toBe(1)
    expect(alice.transactionSetPreparer!.isSourceReserved(coin.address)).toBe(false)
  })

  it('an expired relay answer keeps the original unresolved until delivery and chain reconciliation', async () => {
    const [row] = await fundAccounts(1)
    offlineChain.broadcastDown = true
    offlineChain.relayBroadcasts = false
    relay.answer = identity => ({
      status: 200,
      body: { version: 1, phase: 'dead', identity, reason: 'expired' },
    })
    const pending = await send(1).catch(error => error)
    expect(pending).toBeInstanceOf(MonadStampPendingAttemptError)
    const digest = pending.payloadHashes[0]
    for (let i = 0; i < 4; i++) await tick([digest])
    expect(alice.transactionSetPreparer!.isSourceReserved(row.address)).toBe(true)
    const original = [...new Set(offlineChain.walletBroadcasts)]
    expect(original).toHaveLength(1)
    offlineChain.broadcastDown = false
    relay.answer = undefined
    // Existing retry backoff schedules the next submission at pass eight.
    for (let pass = 0; pass < 4; pass++) await tick([digest])
    expect((await tick([digest]))[digest]).toBe('delivered')
    expect(alice.transactionSetPreparer!.isSourceReserved(row.address)).toBe(false)
    expect(new Set(offlineChain.walletBroadcasts)).toEqual(new Set(original))
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

  it('a sub-account\'s leftover coin (its next nonce) pays a stamp while a native send runs: never one nonce signed twice', async () => {
    const [sub] = await fundAccounts(1)
    const main = (await alice.getReceiveAddress()).raw.toLowerCase()
    mockBalances.set(main, 10n ** 17n)
    const first = await send(1) // from the sub-account at nonce 0; the relay broadcasts it
    expect(relayPayments()[0].from!.toLowerCase()).toBe(sub.address.toLowerCase())
    for (let pass = 0; pass < 3; pass++) await tick([first.payloadDigest])
    // The fixture refunds the fee reserve; a small deposit makes its successor spendable.
    mockBalances.set(sub.address.toLowerCase(), mockBalances.get(sub.address.toLowerCase())! + STAMP)
    await evmWalletInternals(alice).coinListSync!.refreshAccounts([sub.address])
    const list = evmWalletInternals(alice).coinList!
    const successor = list.latestOf(sub.address)!
    expect(successor.state).toBe('unspent')
    expect(successor.nonce).toBeGreaterThan(0)
    const [native, message] = await Promise.allSettled([
      alice.sendNative({ recipient: { raw: '0x' + '77'.repeat(20) }, value: 5n }),
      send(2),
    ])
    expect(native.status).toBe('fulfilled')
    expect(message.status).toBe('fulfilled')
    const signed = [
      ...relayPayments().map(tx => tx.serialized),
      ...offlineChain.walletBroadcasts,
    ].map(raw => Transaction.from(raw))
    const slots = new Map<string, Set<string>>()
    for (const tx of signed) {
      const slot = `${tx.from!.toLowerCase()}:${tx.nonce}`
      slots.set(slot, (slots.get(slot) ?? new Set()).add(tx.hash!))
    }
    for (const [slot, hashes] of slots) expect([slot, hashes.size]).toEqual([slot, 1])
    // Either independent operation can reserve the successor; it is signed only once.
    expect(signed.some(tx => tx.from!.toLowerCase() === sub.address.toLowerCase() && tx.nonce === successor.nonce)).toBe(true)
  })

  it('a pending quiet-window graph keeps its inputs reserved against both native sends and messages', async () => {
    await alice.close()
    await f.close()
    offlineChain.reset()
    mockBalances.clear()
    mailboxes.clear()
    let head = 1
    const reserve = 10n ** 18n
    f = await fixture({ spendSpacingBlocks: 3, reserveBalanceWei: reserve, transactionSetPolicy: () => ({
      sourceOrder: ['stealth', 'stamp', 'change', 'deterministic', 'root', 'identity'],
      gasPriceWei: 3n, paymentGasLimit: () => 21_000n, changeGasLimit: 21_000n,
      paymentFeeIsExact: true, dustWei: 21_000n, radix: 2, jitterBps: 1_500,
      maxChangeOutputs: 20, head, spendRule: { belowWei: reserve, waitBlocks: 3 },
    }) })
    alice = f.alice
    bobMailbox = []
    mailboxes.set(toHex(f.bob.identity.compressedPubKey), bobMailbox)
    f.setMailbox(bobMailbox)
    installCanonicalDirectory(alice, await f.directoryFor('alice', f.alice, f.bob))
    const main = (await alice.getReceiveAddress()).raw.toLowerCase()
    mockBalances.set(main, 10n ** 17n)
    mockBalances.set(alice.identity.address.raw.toLowerCase(), 0n)
    const sent = await send(1)
    const original = graphBytes()
    expect(alice.transactionSetPreparer!.isSourceReserved(main)).toBe(true)
    expect(alice.getNativeOperations!()[0].members.some(member => member.transactionSet?.predecessorWaitBlocks === 3)).toBe(true)
    await expect(constructOnly('quiet-window-message')).rejects.toThrow('Insufficient available EVM coins')
    await expect(alice.sendNative({ recipient: { raw: '0x' + '77'.repeat(20) }, value: 5n })).rejects.toThrow()
    expect(graphBytes()).toEqual(original)
    expect(alice.transactionSetPreparer!.isSourceReserved(main)).toBe(true)
    head = 5
    for (let pass = 0; pass < 32 && alice.transactionSetPreparer!.isSourceReserved(main); pass++) await tick([sent.payloadDigest])
    expect(alice.transactionSetPreparer!.isSourceReserved(main)).toBe(false)
    expect(graphBytes()).toEqual(original)
  })

  it('an unpaid named message whose answer was lost is repeated as the very same request, byte for byte', async () => {
    // The relay recognises a repeat by the request's exact bytes. On the real relay the same
    // envelope under a new multipart boundary was answered 409, never `delivered`.
    const unpaid = () =>
      f.chain.directMessages.send({
        wallet: alice,
        recipient: f.bob.identity.address,
        items: [{ type: 'text', text: 'free' }],
        stampValue: 0n,
        messageId: ID(77),
      })
    // Every request the wallet hands over, answered or not.
    const handed: { body: string; contentType: string }[] = []
    const watch = () =>
      installCanonicalDirectory(alice, {
        ...directory,
        fetch: (url, init) => {
          handed.push({
            body: toHex(new Uint8Array(init.body!)),
            contentType: init.headers['Content-Type'],
          })
          return directory.fetch!(url, init)
        },
      })
    watch()
    f.setPhase('fail')
    await expect(unpaid()).rejects.toThrow()
    f.setPhase('delivered')
    const sent = await unpaid()
    expect(sent.stampPayments).toEqual([])
    expect(handed).toHaveLength(2)
    expect(handed[1]).toEqual(handed[0])
    // And across a restart: the kept envelope carries its boundary.
    f.setPhase('fail')
    const again = () =>
      f.chain.directMessages.send({
        wallet: alice,
        recipient: f.bob.identity.address,
        items: [{ type: 'text', text: 'free again' }],
        stampValue: 0n,
        messageId: ID(78),
      })
    await expect(again()).rejects.toThrow()
    await reopen()
    watch()
    f.setPhase('delivered')
    await again()
    expect(handed).toHaveLength(4)
    expect(handed[3]).toEqual(handed[2])
  })

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
    const signedBytes = () => alice.getNativeOperations!().flatMap(row => row.members.map(member => member.signed!.rawTransaction))
    function failEnvelopeAfterSigning(mode: 'dropped' | 'written-then-reported-failed') {
      const preparer = alice.transactionSetPreparer!
      const construct = preparer.constructTransactionSet.bind(preparer)
      jest.spyOn(preparer, 'constructTransactionSet').mockImplementationOnce(async request => {
        const result = await construct(request)
        mockMessageWrite.mode = mode
        return result
      })
    }

    it('before signing: durable construction intent survives restart and produces only one payment', async () => {
      const [row] = await fundAccounts(1)
      jest.spyOn(alice.transactionSetPreparer!, 'constructTransactionSet').mockRejectedValueOnce(new Error('crash before signing'))
      await expect(send(1)).rejects.toThrow('crash before signing')
      expect(signedBytes()).toEqual([])
      expect(offlineChain.walletBroadcasts).toEqual([])
      expect(relay.bodies).toEqual([])
      expect(alice.transactionSetPreparer!.isSourceReserved(row.address)).toBe(false)
      await reopen()
      await tick()
      expect(signedBytes()).toHaveLength(1)
      expect(new Set(relayPayments().map(tx => tx.serialized))).toEqual(new Set(signedBytes()))
      expect(bobMailbox).toHaveLength(1)
    })

    it('after signing, a dropped envelope write retains the same signed graph across restart without exposure', async () => {
      const [row] = await fundAccounts(1)
      failEnvelopeAfterSigning('dropped')
      await expect(send(1)).rejects.toThrow('message write dropped')
      const original = signedBytes()
      expect(original).toHaveLength(1)
      expect(relay.bodies).toEqual([])
      expect(offlineChain.walletBroadcasts).toEqual([])
      expect(alice.transactionSetPreparer!.isSourceReserved(row.address)).toBe(true)
      await expect(send(1)).rejects.toBeInstanceOf(DirectMessageAlreadyAttemptedError)
      await reopen()
      expect(signedBytes()).toEqual(original)
      expect(alice.transactionSetPreparer!.isSourceReserved(row.address)).toBe(true)
      await tick()
      expect(signedBytes()).toEqual(original)
      expect(new Set(relayPayments().map(tx => tx.serialized))).toEqual(new Set(original))
      expect(bobMailbox).toHaveLength(1)
    })

    it('after the signed envelope write reports failure: restart delivers exactly the stored graph once', async () => {
      const [row] = await fundAccounts(1)
      failEnvelopeAfterSigning('written-then-reported-failed')
      await expect(send(1)).rejects.toThrow('message write written-then-reported-failed')
      const original = signedBytes()
      expect(original).toHaveLength(1)
      expect(relay.bodies).toEqual([])
      expect(offlineChain.walletBroadcasts).toEqual([])
      await reopen()
      expect(alice.transactionSetPreparer!.isSourceReserved(row.address)).toBe(true)
      await expect(send(1)).rejects.toBeInstanceOf(DirectMessageAlreadyAttemptedError)
      await tick()
      await tick()
      expect(signedBytes()).toEqual(original)
      expect(new Set(relayPayments().map(tx => tx.serialized))).toEqual(new Set(original))
      expect(bobMailbox).toHaveLength(1)
    })

    it('host message-ID lookup distinguishes a dropped intent from the durable signed envelope across restart', async () => {
      await fundAccounts(1)
      const attemptOf = (n: number) => f.chain.directMessages.attemptOf!({ wallet: alice, messageId: ID(n) })
      expect(await attemptOf(1)).toBeUndefined()
      mockMessageWrite.mode = 'dropped'
      await expect(send(1)).rejects.toThrow('message write dropped')
      await reopen()
      expect(await attemptOf(1)).toBeUndefined()
      failEnvelopeAfterSigning('written-then-reported-failed')
      await expect(send(1)).rejects.toThrow('written-then-reported-failed')
      const original = signedBytes()
      await reopen()
      const held = await attemptOf(1)
      expect(held).toEqual({ payloadDigest: expect.any(String), paid: true })
      expect(await attemptOf(2)).toBeUndefined()
      expect((await tick([held!.payloadDigest]))[held!.payloadDigest]).toBe('delivered')
      await tick()
      expect(signedBytes()).toEqual(original)
      expect(relay.bodies).toHaveLength(1)
      expect(new Set(relayPayments().map(tx => tx.serialized))).toEqual(new Set(original))
      await expect(send(1)).rejects.toMatchObject({ name: 'DirectMessageAlreadyAttemptedError', payloadDigest: held!.payloadDigest })
    })

    it('relay acceptance with wallet broadcast unavailable: restart broadcasts the original durable bytes', async () => {
      const [row] = await fundAccounts(1)
      offlineChain.relayBroadcasts = false
      offlineChain.broadcastDown = true
      const sent = await send(1)
      const original = signedBytes()
      expect(offlineChain.mined.size).toBe(0)
      await reopen()
      expect(alice.transactionSetPreparer!.isSourceReserved(row.address)).toBe(true)
      offlineChain.broadcastDown = false
      await tick()
      await tick()
      expect(offlineChain.mined.has(sent.stampPayments[0].txHash)).toBe(true)
      expect(signedBytes()).toEqual(original)
      expect(new Set(offlineChain.walletBroadcasts)).toEqual(new Set(original))
      expect(alice.transactionSetPreparer!.isSourceReserved(row.address)).toBe(false)
      expect(relay.bodies).toHaveLength(1)
    })

    it('after wallet broadcast and confirmation: restart neither signs nor broadcasts a second payment', async () => {
      const [row] = await fundAccounts(1)
      offlineChain.relayBroadcasts = false
      await send(1)
      const original = signedBytes()
      const broadcasts = [...offlineChain.walletBroadcasts]
      await reopen()
      await tick()
      expect(signedBytes()).toEqual(original)
      expect(offlineChain.walletBroadcasts).toEqual(broadcasts)
      expect(alice.transactionSetPreparer!.isSourceReserved(row.address)).toBe(false)
      expect(relay.bodies).toHaveLength(1)
      await expect(send(1)).rejects.toBeInstanceOf(DirectMessageAlreadyAttemptedError)
    })
  })
})
