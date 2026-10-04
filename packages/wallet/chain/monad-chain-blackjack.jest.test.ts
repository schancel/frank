/**
 * Two real typed wallets play complete blackjack hands against each other through the canonical
 * direct-message path: real typed custody, real Level journals, real directory admission, real
 * sealing/opening and real stamp funding. As in `monad-chain-canonical-dm.jest.test.ts` (whose
 * offline fixture this copies), the chain RPC and the relay's HTTP surface are offline stand-ins.
 *
 * Every wager, payout and refund here is the stamp of the message that carries the move.
 */
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { JsonRpcProvider, computeAddress, getBytes } from 'ethers'
import { toHex } from '@frank/codec'
import {
  restoreCanonicalRequest,
  type CanonicalFetch,
} from '@frank/cashweb/relay/canonical-dm-transport'
import { openNodeDirectoryStore } from '../../directory-admission/src/node'
import type { DirectoryStore } from '../../directory-admission/src'
import domainVectors from '../../domain-roots/vectors/domain-roots-v1.json'
import type { MonadRootBundle } from '../monad-wallet-material'
import type { PublicRevisionZeroInput } from '../monad-wallet-handle'
import {
  createMonadChain,
  installCanonicalDirectory,
  prepareMonadRevisionZeroExport,
  type CanonicalDirectory,
  type MonadChainConfig,
  type MonadChainWalletHandle,
} from './monad-chain'
import { InMemoryNativeTransactionAttemptStore } from './chain-wallet'
import { handValue } from '../message-item-plugins/blackjack/deck'
import {
  buildAccept,
  buildChallenge,
  checkWager,
  dealerStep,
  foldHand,
  handEventsOf,
  maxDealerBetWei,
  playerMoves,
  refundBetStep,
  seedFromBytes,
  totalStakeWei,
  type HandEvent,
  type HandItem,
  type HandRole,
  type HandState,
} from '../message-item-plugins/blackjack/hand'

const START_BALANCE = 10n ** 18n
/** What a wallet keeps back for the fees of its own messages. */
const RESERVE = 10n ** 16n
const STAMP = 1_000n
interface InboxRecord {
  delivery: Uint8Array
  context: Uint8Array
  submissionIdentity: string
  timestampMs: number
}

// Offline chain state: only these single-use sender accounts hold funds.
const mockBalances = new Map<string, bigint>()
jest.mock('../monad-provider', () => {
  const actual = jest.requireActual('../monad-provider')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ethers = require('ethers')
  return {
    ...actual,
    createMonadJsonRpcProvider: () => {
      const provider = new ethers.JsonRpcProvider(
        'http://127.0.0.1:1',
        10143n,
        {
          staticNetwork: true,
          cacheTimeout: -1,
        },
      )
      provider._perform = async (request: {
        method: string
        address?: string
      }) => {
        if (request.method === 'getBalance')
          return mockBalances.get(request.address!.toLowerCase()) ?? 0n
        if (request.method === 'getTransactionCount') return 0
        if (request.method === 'estimateGas') return 50_000n
        if (request.method === 'getGasPrice') return 2n
        if (request.method === 'getPriorityFee') return 1n
        if (request.method === 'getBlock')
          return {
            hash: '0x' + '11'.repeat(32),
            parentHash: '0x' + '22'.repeat(32),
            number: '0x1',
            timestamp: '0x64',
            nonce: '0x0000000000000000',
            difficulty: '0x0',
            gasLimit: '0x1c9c380',
            gasUsed: '0x0',
            miner: '0x' + '00'.repeat(20),
            extraData: '0x',
            baseFeePerGas: '0x1',
            transactions: [],
          }
        throw new Error(`unexpected provider call ${request.method}`)
      }
      return provider
    },
  }
})
// Offline chain: a submitted transfer is mined at once and moves its value.
jest.mock('../monad-http', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ethers = require('ethers')
  const mined = new Set<string>()
  return {
    ...jest.requireActual('../monad-http'),
    MonadHttpClient: class {
      async submitRawTransaction(raw: string) {
        const tx = ethers.Transaction.from(raw)
        const to = tx.to.toLowerCase()
        mockBalances.set(to, (mockBalances.get(to) ?? 0n) + tx.value)
        const from = tx.from.toLowerCase()
        mockBalances.set(from, (mockBalances.get(from) ?? 0n) - tx.value)
        mockFunded.push({ from: tx.from.toLowerCase(), to, value: tx.value })
        mined.add(tx.hash)
        return tx.hash
      }
      async getTransactionReceipt(hash: string) {
        return mined.has(hash) ? { status: 'success' } : undefined
      }
      destroy() {
        return undefined
      }
    },
  }
})
const mockFunded: { from: string; to: string; value: bigint }[] = []
jest.mock('@frank/cashweb/relay/monad-mailbox-client', () => ({
  ...jest.requireActual('@frank/cashweb/relay/monad-mailbox-client'),
  fetchCanonicalInboxPage: jest.fn(),
  fetchCanonicalRecoveryPage: jest.fn(async () => ({ records: [] })),
}))
import { fetchCanonicalInboxPage } from '@frank/cashweb/relay/monad-mailbox-client'
const inboxPage = fetchCanonicalInboxPage as jest.MockedFunction<
  typeof fetchCanonicalInboxPage
>

const RELAY = 'https://relay-a.example'
const NOW = { seconds: 100n, nanoseconds: 0 }
function roots(index: number): MonadRootBundle {
  const outputs = domainVectors.vectors[index].outputs
  const root = <
    P extends 'evm-wallet' | 'identity-authentication' | 'messaging-encryption',
  >(
    purpose: P,
  ) => ({
    registry: 'frank-domain-roots-v1' as const,
    purpose,
    bytes: getBytes(`0x${outputs[purpose]}`),
  })
  return {
    evm: root('evm-wallet'),
    authentication: root('identity-authentication'),
    messaging: root('messaging-encryption'),
  }
}

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'chain-blackjack-'))
  const config: MonadChainConfig = {
    networkId: 'monad-testnet',
    rpcChain: 'monad-testnet',
    chainId: 10143,
    nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
    relayBaseUrl: RELAY,
    networkTag: 'MONT',
    stampBurnAddress: '0x000000000000000000000000000000000000dEaD',
    defaultStampValueWei: 1_000n,
    defaultTopicVoteValueWei: 1_000n,
    subAccountPoolSize: 0,
    walletStorageLocation: join(directory, 'wallet'),
  }
  const chain = createMonadChain(config)
  const alice = (await chain.createWallet(roots(0))) as MonadChainWalletHandle,
    bob = (await chain.createWallet(roots(1))) as MonadChainWalletHandle
  // Both players hold spendable money in their own account; stamps are funded from it.
  for (const wallet of [alice, bob])
    mockBalances.set((await wallet.getReceiveAddress()).raw.toLowerCase(), START_BALANCE)
  const tuple = {
    relayId: new Uint8Array(16).fill(1),
    endpoint: RELAY + '/',
    identity: { keyType: 1, keyBytes: getBytes('0x02' + '11'.repeat(32)) },
    expiry: { seconds: 3700n, nanoseconds: 0 },
    unknownFields: new Map(),
  }
  tuple.identity.keyBytes = new Uint8Array(alice.identity.compressedPubKey)
  const input: PublicRevisionZeroInput = {
    networkTag: 'MONT',
    network: 'monad-testnet',
    chainId: 10143n,
    issuedAt: NOW,
    expiresAt: { seconds: 3700n, nanoseconds: 0 },
    now: NOW,
    relayA: { processId: 'relay-a', origin: RELAY, tuple },
    relayB: { processId: 'relay-b', origin: RELAY, tuple },
    subjectBinding: 'A',
  }
  const stores: DirectoryStore[] = []
  // Each wallet admits both subjects through its own independent public store.
  const admit = async (owner: string, wallet: MonadChainWalletHandle) => {
    const exported = prepareMonadRevisionZeroExport(wallet, input)
    const store = await openNodeDirectoryStore({
      location: join(directory, `directory-${owner}-${toHex(exported.t1)}`),
      anchor: {
        network: 'monad-testnet',
        subject: { keyType: 1, keyBytes: exported.auth.compressedPoint },
        revisionZero: exported.t1,
      },
      mode: { kind: 'new' },
    })
    stores.push(store)
    await store.enroll(
      [{ statement: exported.statement, attestation: exported.attestation }],
      { now: NOW, relay: tuple },
    )
    return {
      subject: toHex(exported.auth.compressedPoint),
      current: () => store.current({ now: NOW, relay: tuple }),
    }
  }
  const requests: { body: Uint8Array; contentType: string }[] = []
  /** The mailbox the relay stores the next delivered message in. */
  let deliverTo: InboxRecord[] | undefined
  let clock = 1_000
  let phase: 'delivered' | 'retained' | 'fail' = 'delivered'
  const fetch: CanonicalFetch = async (url, init) => {
    if (url !== RELAY + '/message/monad/cbor' || init.method !== 'PUT')
      throw new Error(`unexpected relay request ${init.method} ${url}`)
    if (phase === 'fail') throw new Error('relay unreachable')
    const body = new Uint8Array(init.body!)
    requests.push({ body, contentType: init.headers['Content-Type'] })
    const restored = restoreCanonicalRequest({
      body,
      contentType: init.headers['Content-Type'],
    })
    if (phase === 'delivered' && deliverTo)
      deliverTo.push({
        delivery: restored.parts.delivery,
        context: restored.parts.context,
        submissionIdentity: restored.identity.submission_identity,
        timestampMs: ++clock,
      })
    const identity = restoreCanonicalRequest({
      body,
      contentType: init.headers['Content-Type'],
    }).identity
    const answer = new TextEncoder().encode(
      JSON.stringify(
        phase === 'delivered'
          ? {
              version: 1,
              phase,
              identity,
              mailbox_committed_at_ms: 1234,
            }
          : { version: 1, phase, identity },
      ),
    )
    let read = false
    return {
      status: phase === 'delivered' ? 200 : 202,
      url,
      headers: {
        get: name =>
          name.toLowerCase() === 'content-type' ? 'application/json' : null,
      },
      body: {
        getReader: () => ({
          read: async () =>
            read
              ? { done: true }
              : ((read = true), { done: false, value: answer }),
          cancel: async () => undefined,
          releaseLock: () => undefined,
        }),
      },
    }
  }
  const directoryFor = async (
    owner: string,
    self: MonadChainWalletHandle,
    peer: MonadChainWalletHandle,
  ): Promise<CanonicalDirectory> => {
    const own = await admit(owner, self),
      other = await admit(owner, peer)
    return {
      network: 'monad-testnet',
      homeEndpoint: RELAY + '/',
      selfCurrent: own.current,
      peerCurrent: async wanted => {
        const subject =
          'subject' in wanted
            ? wanted.subject
            : computeAddress('0x' + other.subject).toLowerCase() ===
              wanted.address.toLowerCase()
            ? other.subject
            : undefined
        return subject === other.subject
          ? { subject, endpoint: RELAY + '/', current: await other.current() }
          : undefined
      },
      fetch,
    }
  }
  return {
    chain,
    alice,
    bob,
    requests,
    setPhase: (next: typeof phase) => (phase = next),
    setMailbox: (next: InboxRecord[] | undefined) => (deliverTo = next),
    directoryFor,
    close: async () => {
      await alice.close()
      await bob.close()
      for (const store of stores) await store.close()
      rmSync(directory, { recursive: true, force: true })
    },
  }
}

// Cards: the scripted hands below fix the deck so that each outcome is certain. Everything else
// is real, including the commitment check on reveal. With no script the real derivation runs
// (see the unscripted hand), and `hand.jest.test.ts` covers the derivation itself.
let mockScriptedDeck: number[] | undefined
jest.mock('../message-item-plugins/blackjack/deck', () => {
  const actual = jest.requireActual('../message-item-plugins/blackjack/deck')
  return {
    ...actual,
    deriveDeck: (...args: [string, string, number]) =>
      mockScriptedDeck ?? actual.deriveDeck(...args),
  }
})
/** A full deck that starts with the given cards. Rank is `card % 13`: 0 ace, 9..12 tens. */
function deckStarting(...first: number[]): number[] {
  return [...first, ...Array.from({ length: 52 }, (_, i) => i).filter(c => !first.includes(c))]
}

type Fixture = Awaited<ReturnType<typeof fixture>>
const mailboxes = new Map<string, InboxRecord[]>()

/** One wallet at the table. It knows only what it sent and what its mailbox delivered. */
class Seat {
  readonly events: HandEvent[] = []
  readonly seeds = new Map<string, string>()
  readonly mailbox: InboxRecord[] = []
  private readonly seen = new Set<string>()
  peer!: Seat
  since = 0
  /** Every stamp this wallet paid, in order. */
  readonly paid: bigint[] = []
  /** Money this wallet received as stamps, per payload digest, as its own wallet verified it. */
  readonly received = new Map<string, bigint>()
  constructor(
    private readonly f: Fixture,
    readonly wallet: MonadChainWalletHandle,
  ) {
    mailboxes.set(toHex(wallet.identity.compressedPubKey), this.mailbox)
  }
  get address(): string {
    return this.wallet.identity.address.raw
  }
  balance(): Promise<bigint> {
    return this.wallet.getBalance()
  }
  private record(event: HandEvent) {
    if (this.seen.has(event.digest)) return
    this.seen.add(event.digest)
    this.events.push(event)
  }
  async send(item: HandItem, stampWei = STAMP) {
    this.f.setMailbox(this.peer.mailbox)
    const sent = await this.f.chain.directMessages.send({
      wallet: this.wallet,
      recipient: this.peer.wallet.identity.address,
      items: [item],
      stampValue: stampWei,
    })
    this.f.setMailbox(undefined)
    this.paid.push(sent.stampPayments.reduce((sum, p) => sum + p.valueWei, 0n))
    for (const event of handEventsOf({
      items: [item],
      senderAddress: this.address,
      recipientAddress: this.peer.address,
      stampValueWei: sent.stampValueWei,
      payloadDigest: sent.payloadDigest,
    }))
      this.record(event)
    return sent
  }
  async poll() {
    const messages = await this.f.chain.directMessages.fetchSince({
      wallet: this.wallet,
      sinceMs: this.since,
    })
    for (const message of messages) {
      this.since = Math.max(this.since, message.receivedTime)
      this.received.set(message.payloadDigest, message.stampValueWei)
      for (const event of handEventsOf({
        items: message.items,
        senderAddress: message.senderAddress.raw,
        recipientAddress: message.recipientAddress.raw,
        stampValueWei: message.stampValueWei,
        payloadDigest: message.payloadDigest,
      }))
        this.record(event)
    }
  }
  hand(gameId: string): HandState | undefined {
    return foldHand(this.events.filter(e => e.item.gameId === gameId)).state
  }
  totalReceived(): bigint {
    return [...this.received.values()].reduce((a, b) => a + b, 0n)
  }
}

type Move = 'hit' | 'stand' | 'double'
let games = 0
let seedCounter = 0
const freshSeed = () =>
  seedFromBytes(new Uint8Array(32).fill(0).map((_, i) => (i === 0 ? ++seedCounter : i * 7) & 255))

/** Opens a hand: challenge (and accept, when the challenger plays). */
async function challenge(
  challenger: Seat,
  role: HandRole,
  maxBetWei: bigint,
): Promise<{ gameId: string; dealer: Seat; player: Seat }> {
  const gameId = `game-${++games}`
  const challenged = challenger.peer
  const dealer = role === 'dealer' ? challenger : challenged
  const player = role === 'dealer' ? challenged : challenger
  const seed = freshSeed()
  dealer.seeds.set(gameId, seed)
  const built = buildChallenge({
    gameId,
    role,
    maxBetWei,
    spendableWei: await challenger.balance(),
    reserveWei: RESERVE,
    seed: role === 'dealer' ? seed : undefined,
  })
  if ('error' in built) throw new Error(built.error)
  await challenger.send(built.item)
  await challenged.poll()
  if (role === 'player') {
    const accept = buildAccept({
      state: dealer.hand(gameId)!,
      spendableWei: await dealer.balance(),
      reserveWei: RESERVE,
      seed,
    })
    if ('error' in accept) throw new Error(accept.error)
    await dealer.send(accept.item)
    await player.poll()
  }
  return { gameId, dealer, player }
}

/** The dealer sends everything it must; returns how many messages that was. */
async function dealerActs(dealer: Seat, gameId: string): Promise<number> {
  let sent = 0
  for (;;) {
    const step = dealerStep(dealer.hand(gameId), dealer.seeds.get(gameId)!)
    if (!step) return sent
    await dealer.send(step.item, step.payWei ?? STAMP)
    await dealer.peer.poll()
    sent++
  }
}

/** Plays one hand to the end with the player's strategy; both sides must agree on the result. */
async function playHand(
  challenger: Seat,
  role: HandRole,
  wagerWei: bigint,
  strategy: (state: HandState) => Move,
): Promise<HandState> {
  const { gameId, dealer, player } = await challenge(challenger, role, wagerWei)
  expect(
    checkWager(player.hand(gameId)!, wagerWei, await player.balance(), RESERVE),
  ).toBeUndefined()
  await player.send({ type: 'blackjack-hand', gameId, action: 'bet' }, wagerWei)
  await dealer.poll()
  for (;;) {
    await dealerActs(dealer, gameId)
    const state = player.hand(gameId)!
    const moves = playerMoves(state)
    if (moves.length === 0) break
    const move = strategy(state)
    await player.send(
      { type: 'blackjack-hand', gameId, action: move },
      move === 'double' ? state.wagerWei : STAMP,
    )
    await dealer.poll()
  }
  const final = player.hand(gameId)!
  expect(dealer.hand(gameId)).toEqual(final)
  return final
}

describe('two typed wallets play blackjack through stamped messages', () => {
  jest.setTimeout(600_000)
  let f: Fixture
  let alice: Seat
  let bob: Seat
  beforeEach(async () => {
    jest.clearAllMocks()
    mockBalances.clear()
    mockFunded.length = 0
    mailboxes.clear()
    f = await fixture()
    installCanonicalDirectory(f.alice, await f.directoryFor('alice', f.alice, f.bob))
    installCanonicalDirectory(f.bob, await f.directoryFor('bob', f.bob, f.alice))
    alice = new Seat(f, f.alice)
    bob = new Seat(f, f.bob)
    alice.peer = bob
    bob.peer = alice
    inboxPage.mockImplementation(async auth => ({
      records: (mailboxes.get(auth.subject) ?? []).filter(
        record => record.timestampMs > (auth.sinceMs ?? 0),
      ),
    }))
  })
  afterEach(() => f.close())


  const WAGER = 40_000n
  // Deal order: player, dealer (up), player, dealer (hole), then draws.
  const scripts: {
    name: string
    deck: number[]
    moves: Move[]
    outcome: string
    owed: bigint
  }[] = [
    { name: 'win', deck: deckStarting(9, 35, 22, 6), moves: ['stand'], outcome: 'player_win', owed: WAGER * 2n },
    { name: 'loss', deck: deckStarting(9, 35, 6, 22), moves: ['stand'], outcome: 'dealer_win', owed: 0n },
    { name: 'push', deck: deckStarting(9, 22, 7, 20), moves: ['stand'], outcome: 'push', owed: WAGER },
    { name: 'blackjack', deck: deckStarting(0, 35, 12, 6), moves: [], outcome: 'player_blackjack', owed: (WAGER * 5n) / 2n },
    { name: 'double', deck: deckStarting(4, 9, 5, 19, 22), moves: ['double'], outcome: 'player_win', owed: WAGER * 4n },
    { name: 'bust', deck: deckStarting(9, 22, 5, 19, 35), moves: ['hit'], outcome: 'dealer_win', owed: 0n },
  ]

  describe.each(['dealer', 'player'] as const)('the challenger is the %s', role => {
    it.each(scripts)('$name: the dealer pays exactly what is owed', async script => {
      mockScriptedDeck = script.deck
      const moves = [...script.moves]
      const final = await playHand(alice, role, WAGER, () => moves.shift()!)
      const dealer = role === 'dealer' ? alice : bob
      const player = dealer.peer
      expect(moves).toEqual([])
      expect(final).toMatchObject({
        phase: 'resolved',
        outcome: script.outcome,
        dealer: dealer.address,
        player: player.address,
        wagerWei: WAGER,
        doubled: script.name === 'double',
        owedWei: script.owed,
      })
      expect(handValue(final.playerCards).bust).toBe(script.name === 'bust')
      // The money the player put in is the bet's stamp (and the double's), as the dealer's own
      // wallet verified it on receipt.
      expect(dealer.received.get(final.betDigest!)).toBe(WAGER)
      expect([...dealer.received.values()].filter(v => v === WAGER)).toHaveLength(
        script.name === 'double' ? 2 : 1,
      )
      expect(totalStakeWei(final)).toBe(script.name === 'double' ? WAGER * 2n : WAGER)
      // The payout is the stamp of the dealer's last message, as the player's wallet verified it.
      const reveal = player.events[player.events.length - 1]
      expect(reveal.item.action).toBe('reveal')
      expect(player.received.get(reveal.digest)).toBe(script.owed > 0n ? script.owed : STAMP)
      expect(final.paidWei).toBe(script.owed > 0n ? script.owed : STAMP)
      expect(dealer.paid[dealer.paid.length - 1]).toBe(script.owed > 0n ? script.owed : STAMP)
      // Nothing else the dealer sent carried more than an ordinary stamp.
      expect(dealer.paid.slice(0, -1).every(v => v === STAMP)).toBe(true)
      // Spendable balances only went down: what a wallet receives as stamps is not spendable.
      expect(await player.balance()).toBeLessThan(START_BALANCE - totalStakeWei(final))
      expect(await dealer.balance()).toBeLessThan(START_BALANCE - script.owed)
    })
  })

  it('plays an unscripted hand with the real deck derivation, verified on reveal', async () => {
    mockScriptedDeck = undefined
    const final = await playHand(bob, 'dealer', WAGER, state =>
      handValue(state.playerCards).total < 17 ? 'hit' : 'stand',
    )
    expect(final.phase).toBe('resolved')
    expect(final.paidWei).toBe(final.owedWei! > 0n ? final.owedWei : STAMP)
  })

  it('refunds a bet above the max bet with a reply whose stamp equals it, then plays on', async () => {
    mockScriptedDeck = deckStarting(9, 35, 22, 6)
    const { gameId, dealer, player } = await challenge(alice, 'dealer', WAGER)
    await player.send({ type: 'blackjack-hand', gameId, action: 'bet' }, WAGER + 1n)
    await dealer.poll()
    expect(dealer.hand(gameId)).toMatchObject({ phase: 'open', wagerWei: 0n })
    expect(await dealerActs(dealer, gameId)).toBe(1)
    expect(dealer.paid[dealer.paid.length - 1]).toBe(WAGER + 1n)
    const refund = player.events[player.events.length - 1]
    expect(refund.item.action).toBe('refund')
    expect(player.received.get(refund.digest)).toBe(WAGER + 1n)
    expect(player.hand(gameId)).toEqual(dealer.hand(gameId))
    expect(player.hand(gameId)?.rejected).toMatchObject([
      { stampWei: WAGER + 1n, refundedWei: WAGER + 1n },
    ])
    // Nothing more is owed; the hand is still open for a proper bet.
    expect(await dealerActs(dealer, gameId)).toBe(0)
    await player.send({ type: 'blackjack-hand', gameId, action: 'bet' }, WAGER)
    await dealer.poll()
    expect(await dealerActs(dealer, gameId)).toBe(1)
    expect(dealer.hand(gameId)?.phase).toBe('player_turn')
  })

  it('moves no money for a replayed, an out-of-turn or a tampered message', async () => {
    mockScriptedDeck = deckStarting(9, 35, 22, 6)
    const { gameId, dealer, player } = await challenge(alice, 'dealer', WAGER)
    // Out of turn: the player stands before betting. The dealer has nothing to send.
    await player.send({ type: 'blackjack-hand', gameId, action: 'stand' })
    await dealer.poll()
    expect(dealer.hand(gameId)?.phase).toBe('open')
    expect(await dealerActs(dealer, gameId)).toBe(0)

    await player.send({ type: 'blackjack-hand', gameId, action: 'bet' }, WAGER)
    await dealer.poll()
    expect(await dealerActs(dealer, gameId)).toBe(1)
    const afterDeal = dealer.hand(gameId)
    const dealerPaid = dealer.paid.length

    // Replay: the relay delivers the bet a second time. One wager, one hand, no refund.
    // (The whole mailbox, in fact: every earlier message arrives again.)
    dealer.since = 0
    await dealer.poll()
    expect(dealer.hand(gameId)).toEqual(afterDeal)
    expect(await dealerActs(dealer, gameId)).toBe(0)

    // Out of turn: the dealer's own move types sent by the player change nothing.
    await player.send({ type: 'blackjack-hand', gameId, action: 'card', playerCards: [9, 22, 0] })
    await player.send({
      type: 'blackjack-hand',
      gameId,
      action: 'reveal',
      dealerCards: [35, 6],
      seed: 'a'.repeat(64),
      outcome: 'player_blackjack',
    })
    await dealer.poll()
    expect(dealer.hand(gameId)).toEqual(afterDeal)
    expect(await dealerActs(dealer, gameId)).toBe(0)
    expect(dealer.paid).toHaveLength(dealerPaid)

    // Tampered: the dealer claims it won. The player's hand does not settle on it.
    await player.send({ type: 'blackjack-hand', gameId, action: 'stand' })
    await dealer.poll()
    const honest = dealerStep(dealer.hand(gameId), dealer.seeds.get(gameId)!)!
    expect(honest.payWei).toBe(WAGER * 2n)
    const playerBefore = player.hand(gameId)
    await dealer.send({ ...honest.item, outcome: 'dealer_win' } as HandItem)
    await player.poll()
    expect(player.hand(gameId)).toEqual(playerBefore)
    expect(player.hand(gameId)?.phase).toBe('dealer_turn')
    // The honest reveal still settles it, once.
    expect(await dealerActs(dealer, gameId)).toBe(1)
    expect(player.hand(gameId)).toMatchObject({
      phase: 'resolved',
      owedWei: WAGER * 2n,
      paidWei: WAGER * 2n,
    })
    expect(await dealerActs(dealer, gameId)).toBe(0)
  })

  it('limits the max bet by what each side can actually spend', async () => {
    mockScriptedDeck = deckStarting(9, 35, 22, 6)
    const spend = async (seat: Seat, balance: bigint) =>
      mockBalances.set((await seat.wallet.getReceiveAddress()).raw.toLowerCase(), balance)
    // A dealer with 4 units above the reserve may offer at most 1 unit.
    await spend(alice, RESERVE + 400_000n)
    const asDealer = (maxBetWei: bigint, spendableWei: bigint) =>
      buildChallenge({
        gameId: 'limits',
        role: 'dealer',
        maxBetWei,
        spendableWei,
        reserveWei: RESERVE,
        seed: freshSeed(),
      })
    expect(await alice.balance()).toBe(RESERVE + 400_000n)
    expect(asDealer(100_001n, await alice.balance())).toEqual({ error: 'above-own-limit' })
    expect('item' in asDealer(100_000n, await alice.balance())).toBe(true)
    // A challenging player may name at most what it can send.
    const asPlayer = (maxBetWei: bigint, spendableWei: bigint) =>
      buildChallenge({ gameId: 'limits', role: 'player', maxBetWei, spendableWei, reserveWei: RESERVE })
    expect(asPlayer(400_001n, await alice.balance())).toEqual({ error: 'above-own-limit' })
    expect('item' in asPlayer(400_000n, await alice.balance())).toBe(true)

    // Alice challenges as player for 400000; Bob can only cover 50000 and accepts at that.
    await spend(bob, RESERVE + 1_200_000n)
    const bobCap = maxDealerBetWei(await bob.balance(), RESERVE)
    expect(bobCap).toBe(300_000n)
    const { gameId, dealer, player } = await challenge(alice, 'player', 400_000n)
    const accepted = dealer.hand(gameId)!
    expect(accepted.phase).toBe('open')
    expect(accepted.maxBetWei).toBe(bobCap)
    expect(player.hand(gameId)).toEqual(accepted)
    // The player's own check refuses more than the dealer's figure...
    expect(
      checkWager(accepted, accepted.maxBetWei + 1n, await player.balance(), RESERVE),
    ).toBe('above-max-bet')
    // ...and a player that sends it anyway is refunded, not dealt.
    await player.send({ type: 'blackjack-hand', gameId, action: 'bet' }, accepted.maxBetWei + 1n)
    await dealer.poll()
    expect(dealer.hand(gameId)?.phase).toBe('open')
    const step = dealerStep(dealer.hand(gameId), dealer.seeds.get(gameId)!)!
    expect(step).toMatchObject({ item: { action: 'refund' }, payWei: accepted.maxBetWei + 1n })
  })

  it('lets the dealer return the bet instead of dealing', async () => {
    const { gameId, dealer, player } = await challenge(bob, 'player', WAGER)
    await player.send({ type: 'blackjack-hand', gameId, action: 'bet' }, WAGER)
    await dealer.poll()
    const step = refundBetStep(dealer.hand(gameId))!
    await dealer.send(step.item, step.payWei)
    await player.poll()
    expect(player.hand(gameId)).toMatchObject({ phase: 'refunded', refundedWei: WAGER })
    expect(player.hand(gameId)).toEqual(dealer.hand(gameId))
    expect(await dealerActs(dealer, gameId)).toBe(0)
  })
})
