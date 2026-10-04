/**
 * #780: a whole blackjack hand between a typed UI account and the canonical dealer, through the
 * real typed wallets, real Level journals, real directory admission, real type-18 encoding and
 * real sealing/opening. The fixture is copied from
 * `packages/wallet/chain/monad-chain-canonical-dm.jest.test.ts` (same offline chain RPC and relay
 * stand-ins); the relay stand-in here also files each accepted delivery into its recipient's
 * inbox. This proves composition, authority and exactly-once behaviour, not chain finality.
 *
 * The UI side is the app's own path: `chain.directMessages.send`/`fetchSince` and the shared
 * blackjack plugin reducer and fairness check the app renders with.
 */
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getAddress, getBytes } from 'ethers'
import { parseFrame, toHex } from '@frank/codec'
import {
  restoreCanonicalRequest,
  type CanonicalFetch,
} from '@frank/cashweb/relay/canonical-dm-transport'
import type { CanonicalInboxRecord } from '@frank/cashweb/relay/monad-mailbox-client'
import type {
  BlackjackMoveItem,
  Message,
  MessageItem,
} from '@frank/cashweb/types/messages'
import { openNodeDirectoryStore } from '@frank/directory-admission/node'
import type { DirectoryStore } from '@frank/directory-admission'
import domainVectors from '../domain-roots/vectors/domain-roots-v1.json'
import type { MonadRootBundle } from '@frank/wallet/monad-wallet-material'
import type { PublicRevisionZeroInput } from '@frank/wallet/monad-wallet-handle'
import {
  createMonadChain,
  installCanonicalDirectory,
  prepareMonadRevisionZeroExport,
  type CanonicalDirectory,
  type MonadChainConfig,
  type MonadChainWalletHandle,
} from '@frank/wallet/chain/monad-chain'
import { InMemoryNativeTransactionAttemptStore } from '@frank/wallet/chain/chain-wallet'
import { getMessageItemPlugin } from '@frank/wallet/message-item-plugins'
import '@frank/wallet/message-item-plugins/blackjack/plugin'
import {
  deriveDeck,
  handValue,
  sha256Hex,
} from '@frank/wallet/message-item-plugins/blackjack/deck'
import {
  BlackjackGameState,
  blackjackPayoutWei,
  dealInitialCards,
  HydratedBlackjackMove,
  parseBlackjackError,
  parseBlackjackWelcome,
  playOutDealer,
  reduceBlackjackState,
  verifyRevealedHand,
} from '@frank/wallet/message-item-plugins/blackjack/game'

import { BlackjackBotStateStore } from './blackjack-bot-state'
import {
  BlackjackCanonicalOutbox,
  BlackjackCanonicalStore,
  canonicalDirectoryFor,
  fetchCanonicalInbound,
  type CanonicalBlackjackInbound,
} from './blackjack-canonical'
import { welcomeItems } from './blackjack-greeter'
import {
  processCanonicalMessage,
  recoverCanonicalReplies,
  runBlackjackLoop,
} from './blackjack-bot.livecheck'

// Offline chain state: balances the stand-in RPC reports.
const mockBalances = new Map<string, bigint>()
jest.mock('@frank/wallet/monad-provider', () => {
  const actual = jest.requireActual('@frank/wallet/monad-provider')
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
jest.mock('@frank/wallet/monad-http', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ethers = require('ethers')
  const mined = new Set<string>()
  return {
    ...jest.requireActual('@frank/wallet/monad-http'),
    MonadHttpClient: class {
      async submitRawTransaction(raw: string) {
        const tx = ethers.Transaction.from(raw)
        const to = tx.to.toLowerCase()
        mockBalances.set(to, (mockBalances.get(to) ?? 0n) + tx.value)
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
const STAMP = 1_000n
const WAGER_WEI = 10n ** 17n
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

type Relayed = CanonicalInboxRecord & { digest: string; sender: string }

async function fixture(directory: string) {
  const config: MonadChainConfig = {
    networkId: 'monad-testnet',
    rpcChain: 'monad-testnet',
    chainId: 10143,
    nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
    relayBaseUrl: RELAY,
    networkTag: 'MONT',
    stampBurnAddress: '0x000000000000000000000000000000000000dEaD',
    defaultStampValueWei: STAMP,
    defaultTopicVoteValueWei: 1_000n,
    subAccountPoolSize: 0,
    walletStorageLocation: join(directory, 'wallet'),
  }
  const chain = createMonadChain(config)
  const ui = (await chain.createWallet(roots(0))) as MonadChainWalletHandle,
    bot = (await chain.createWallet(roots(1))) as MonadChainWalletHandle
  const uiAccount = (await ui.getReceiveAddress()).raw,
    botAccount = (await bot.getReceiveAddress()).raw
  // Both typed accounts hold funds for their own stamps.
  mockBalances.set(uiAccount.toLowerCase(), 10n ** 18n)
  mockBalances.set(botAccount.toLowerCase(), 10n ** 18n)
  const tuple = {
    relayId: new Uint8Array(16).fill(1),
    endpoint: RELAY + '/',
    identity: {
      keyType: 1,
      keyBytes: new Uint8Array(ui.identity.compressedPubKey),
    },
    expiry: { seconds: 3700n, nanoseconds: 0 },
    unknownFields: new Map(),
  }
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

  // The relay stand-in: accepts a PUT, files the delivery in the recipient's inbox once.
  const relay = {
    mode: 'delivered' as 'delivered' | 'fail',
    puts: [] as { digest: string; sender: string; body: string }[],
    inbox: new Map<string, Relayed[]>(),
    clock: 5_000,
  }
  const fetch: CanonicalFetch = async (url, init) => {
    if (url !== RELAY + '/message/monad/cbor' || init.method !== 'PUT')
      throw new Error(`unexpected relay request ${init.method} ${url}`)
    if (relay.mode === 'fail') throw new Error('relay unreachable')
    const body = new Uint8Array(init.body!)
    const request = restoreCanonicalRequest({
      body,
      contentType: init.headers['Content-Type'],
    })
    const delivery = parseFrame(request.parts.delivery)
    if (delivery.kind !== 'parsed' || delivery.typed?.type !== 1)
      throw new Error('type1 delivery expected')
    const payload = delivery.typed.payloadFrame.typed
    if (payload?.type !== 5) throw new Error('type5 payload expected')
    const digest = request.identity.payload_hash
    const sender = toHex(payload.sender.keyBytes)
    relay.puts.push({ digest, sender, body: toHex(body) })
    const recipient = toHex(payload.recipient.keyBytes)
    const box = relay.inbox.get(recipient) ?? []
    relay.inbox.set(recipient, box)
    if (!box.some(record => record.digest === digest))
      box.push({
        delivery: request.parts.delivery,
        context: request.parts.context,
        submissionIdentity: request.identity.submission_identity,
        timestampMs: relay.clock++,
        digest,
        sender,
      })
    const answer = new TextEncoder().encode(
      JSON.stringify({
        version: 1,
        phase: 'delivered',
        identity: request.identity,
        mailbox_committed_at_ms: 1234,
      }),
    )
    let read = false
    return {
      status: 200,
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
  inboxPage.mockImplementation(async auth => ({
    records: (relay.inbox.get(auth.subject) ?? []).filter(
      record => record.timestampMs >= (auth.sinceMs ?? 0),
    ),
  }))

  const uiOwn = await admit('ui', ui),
    uiPeer = await admit('ui', bot)
  const uiDirectory: CanonicalDirectory = {
    network: 'monad-testnet',
    homeEndpoint: RELAY + '/',
    selfCurrent: uiOwn.current,
    peerCurrent: async wanted =>
      (
        'subject' in wanted
          ? wanted.subject === uiPeer.subject
          : wanted.address.toLowerCase() ===
            bot.identity.address.raw.toLowerCase()
      )
        ? {
            subject: uiPeer.subject,
            endpoint: RELAY + '/',
            current: await uiPeer.current(),
          }
        : undefined,
    fetch,
  }
  installCanonicalDirectory(ui, uiDirectory)
  const botOwn = await admit('bot', bot),
    botPeer = await admit('bot', ui)
  const botView = { peerReadable: true }
  // The dealer's wallet sees the installed directory only through the production adapter.
  const botDirectory = (peerSubjects: string[]) =>
    canonicalDirectoryFor({
      installed: {
        network: 'monad-testnet',
        homeEndpoint: RELAY + '/',
        selfCurrent: botOwn.current,
        peerCurrent: async subject =>
          subject === botPeer.subject && botView.peerReadable
            ? botPeer.current()
            : undefined,
      },
      peerSubjects,
      fetch,
    })
  installCanonicalDirectory(bot, botDirectory([botPeer.subject]))
  return {
    chain,
    ui,
    bot,
    uiAccount,
    uiSubject: botPeer.subject,
    botSubject: botOwn.subject,
    relay,
    botView,
    botDirectory,
    close: async () => {
      await ui.close()
      await bot.close()
      for (const store of stores) await store.close()
    },
  }
}

/** A seed (64 lowercase hex, as type 18 requires) whose deck satisfies `wanted`. */
function seedFor(wagerTxHash: string, wanted: (deck: number[]) => boolean) {
  for (let i = 0; i < 5000; i++) {
    const seed = sha256Hex(`seed-${i}`)
    if (wanted(deriveDeck(seed, wagerTxHash, 0))) return seed
  }
  throw new Error('no seed found')
}

describe('#780 typed blackjack over the canonical path', () => {
  jest.setTimeout(120_000)
  let root: string
  let f: Awaited<ReturnType<typeof fixture>>
  let state: BlackjackBotStateStore
  let store: BlackjackCanonicalStore
  let outbox: BlackjackCanonicalOutbox
  let clock: number
  const transfers = new Map<
    string,
    { from: string; to: string; value: bigint }
  >()
  const wagerProvider = {
    getTransaction: async (hash: string) => transfers.get(hash) ?? null,
    getTransactionReceipt: async (hash: string) =>
      transfers.has(hash) ? { status: 1 } : null,
    getBalance: async () => 10n ** 30n,
  }
  // The bankroll: signs once per call, journaled bytes are what gets broadcast.
  const bankroll = {
    address: getAddress('0x' + 'dd'.repeat(20)),
    signed: [] as { to: string; value: bigint; txHash: string }[],
    broadcast: [] as string[],
    failBroadcast: false,
    async buildAndSignTransfer(to: string, value: bigint) {
      const txHash =
        '0x' + (bankroll.signed.length + 1).toString(16).padStart(64, '0')
      bankroll.signed.push({ to, value, txHash })
      return {
        rawTx: '0xraw' + txHash.slice(2),
        txHash,
        nonce: bankroll.signed.length,
      }
    },
    async submit(signed: { txHash: string }) {
      bankroll.broadcast.push(signed.txHash)
      return signed.txHash
    },
    async submitRaw(_raw: string, txHash: string) {
      if (bankroll.failBroadcast) throw new Error('rpc unreachable')
      bankroll.broadcast.push(txHash)
      return txHash
    },
    async getStatus(txHash: string) {
      return bankroll.broadcast.includes(txHash) ? 'confirmed' : 'pending'
    },
  }

  const openBot = async () => {
    state = new BlackjackBotStateStore(join(root, 'bot'))
    await state.Open()
    store = new BlackjackCanonicalStore(join(root, 'bot'))
    await store.Open()
    outbox = new BlackjackCanonicalOutbox({
      store,
      messages: f.chain.directMessages,
      wallet: f.bot,
      stampValueWei: STAMP,
    })
  }
  const closeBot = async () => {
    await state.Close()
    await store.Close()
  }
  /** Runs the production poll loop until it has nothing left to do (or `hands` resolved). */
  const botRuns = (hands = 1000) =>
    runBlackjackLoop<CanonicalBlackjackInbound>({
      state,
      mainAccountSigner: bankroll as never,
      pollIntervalMs: 1,
      maxHands: hands,
      idleTimeoutMs: 3,
      drainTimeoutMs: 20,
      now: () => clock,
      sleep: async ms => void (clock += ms),
      fetchMessages: since =>
        fetchCanonicalInbound(f.chain.directMessages, f.bot, since),
      tick: () => outbox.drive(),
      processMessage: message =>
        processCanonicalMessage({
          message,
          identity: f.bot.identity,
          wagerProvider: wagerProvider as never,
          store,
          outbox,
          minWagerWei: 10n ** 16n,
          maxWagerWei: 10n ** 18n,
          state,
          mainAccountSigner: bankroll as never,
          provider: wagerProvider as never,
        }),
    })

  const dealer = () => f.bot.identity.address
  const uiSends = (items: MessageItem[]) =>
    f.chain.directMessages.send({ wallet: f.ui, recipient: dealer(), items })
  /** A confirmed wager transfer from the UI's EVM account to the dealer's chat address. */
  const wager = (
    hash: string,
    overrides: Partial<{ from: string; to: string; value: bigint }> = {},
  ) => {
    transfers.set(hash, {
      from: f.uiAccount,
      to: dealer().raw,
      value: WAGER_WEI,
      ...overrides,
    })
    return hash
  }
  const move = (
    gameId: string,
    action: 'bet' | 'hit' | 'stand' | 'double',
    extra: Partial<BlackjackMoveItem> = {},
  ): MessageItem[] => [
    { type: 'blackjack-move', gameId, action, ...extra } as BlackjackMoveItem,
  ]
  /** Everything the dealer has sent the UI, in relay order, as the app would receive it. */
  const uiReceives = async () =>
    (
      await f.chain.directMessages.fetchSince({ wallet: f.ui, sinceMs: 0 })
    ).flatMap(message => {
      expect(message.senderAddress.raw).toBe(dealer().raw)
      return message.items
    })
  /** The app's own fold: the UI's sent moves and the dealer's replies through the shared plugin. */
  const uiGame = async (sent: MessageItem[], gameId: string) => {
    const plugin = getMessageItemPlugin('blackjack-move')!
    let game: BlackjackGameState | undefined
    const feed = async (items: MessageItem[], senderAddress: string) => {
      for (const [index, item] of items.entries()) {
        if (item.type !== 'blackjack-move' || item.gameId !== gameId) continue
        const hydrated = (await plugin.hydrate(item, {
          message: { senderAddress } as unknown as Message,
          index,
          provider: wagerProvider as never,
        })) as HydratedBlackjackMove
        game = reduceBlackjackState(game, hydrated)
      }
    }
    // Requests and replies alternate; for one game the order below is the chat order.
    const replies = (await uiReceives()).filter(
      item => item.type === 'blackjack-move' && item.gameId === gameId,
    )
    for (const [index, request] of sent.entries()) {
      await feed([request], f.ui.identity.address.raw)
      if (replies[index]) await feed([replies[index]], dealer().raw)
    }
    await feed(replies.slice(sent.length), dealer().raw)
    return game!
  }
  const botSets = () =>
    new Set(
      f.relay.puts.filter(p => p.sender === f.botSubject).map(p => p.digest),
    )

  beforeEach(async () => {
    jest.clearAllMocks()
    if (!process.env.DEBUG_780) {
      jest.spyOn(console, 'log').mockImplementation(() => undefined)
      jest.spyOn(console, 'warn').mockImplementation(() => undefined)
      jest.spyOn(console, 'error').mockImplementation(() => undefined)
    }
    mockBalances.clear()
    transfers.clear()
    bankroll.signed = []
    bankroll.broadcast = []
    bankroll.failBroadcast = false
    clock = 1_000
    root = mkdtempSync(join(tmpdir(), 'blackjack-canonical-hand-'))
    f = await fixture(root)
    await openBot()
    // As at startup: a commitment exists before any bet can be seen.
    await state.setPendingCommitment(
      sha256Hex('startup'),
      sha256Hex(sha256Hex('startup')),
    )
  })
  afterEach(async () => {
    jest.restoreAllMocks()
    await closeBot()
    await f.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('plays welcome, bet, deal, hit, stand, reveal and payout, and the reveal verifies', async () => {
    const hash = '0x' + 'a1'.repeat(32)
    // Player draws one card without busting, stands, and wins.
    const seed = seedFor(hash, deck => {
      const initial = dealInitialCards(deck)
      const hand = [...initial.playerCards, deck[4]]
      return (
        !handValue(initial.playerCards).blackjack &&
        !handValue(hand).bust &&
        playOutDealer(deck, hand, 5).outcome === 'player_win'
      )
    })
    await state.setPendingCommitment(seed, sha256Hex(seed))

    // Welcome: one sealed type-18 welcome plus its text line, exactly as the legacy greeter.
    await outbox.enqueue(
      `welcome:${f.uiSubject}`,
      f.ui.identity.address.raw,
      welcomeItems({
        minWagerWei: 10n ** 16n,
        maxWagerWei: 10n ** 18n,
        stampValueWei: STAMP,
      }),
    )
    await botRuns()
    const welcome = await uiReceives()
    expect(welcome.map(item => item.type)).toEqual(['blackjack-move', 'text'])
    expect(
      parseBlackjackWelcome(welcome[0] as BlackjackMoveItem),
    ).toMatchObject({
      minWagerWei: 10n ** 16n,
      maxWagerWei: 10n ** 18n,
    })

    const sent = [...move('g1', 'bet', { wagerTxHash: wager(hash) })]
    await uiSends(sent)
    await botRuns()
    // The commitment reaches the player before the player acts, and no seed with it.
    const deal = (await uiReceives()).at(-1) as BlackjackMoveItem
    expect(deal).toMatchObject({
      action: 'deal',
      gameId: 'g1',
      serverSeedHash: sha256Hex(seed),
    })
    expect(deal.serverSeed).toBeUndefined()
    expect(state.getGame('g1')).toMatchObject({
      authority: 'verified-wager-sender',
      playerAddress: getAddress(f.uiAccount),
      wagerWei: WAGER_WEI,
      revealed: false,
    })
    expect(store.actor('g1')?.actor).toBe(getAddress(f.ui.identity.address.raw))
    expect(bankroll.signed).toEqual([])

    sent.push(...move('g1', 'hit'))
    await uiSends(sent.at(-1)! && move('g1', 'hit'))
    await botRuns()
    sent.push(...move('g1', 'stand'))
    await uiSends(move('g1', 'stand'))
    const run = await botRuns(1)
    expect(run).toMatchObject({ handsResolved: 1, exitCode: 0 })
    await botRuns()

    const game = await uiGame(sent, 'g1')
    expect(game).toMatchObject({
      phase: 'resolved',
      outcome: 'player_win',
      serverSeed: seed,
    })
    expect(game.playerCards).toHaveLength(3)
    expect(verifyRevealedHand(game)).toEqual({ valid: true })
    // A wrong seed or a changed card fails the same check.
    expect(
      verifyRevealedHand({ ...game, serverSeed: sha256Hex('other') }).valid,
    ).toBe(false)
    expect(
      verifyRevealedHand({
        ...game,
        dealerCards: [...game.dealerCards].reverse(),
      }).valid,
    ).toBe(false)

    // The payout the app expects is exactly what the bankroll paid, once, to the paying account.
    expect(blackjackPayoutWei(game)).toBe(2n * WAGER_WEI)
    expect(bankroll.signed).toEqual([
      {
        to: getAddress(f.uiAccount),
        value: 2n * WAGER_WEI,
        txHash: expect.any(String),
      },
    ])
    expect(state.getPayout('g1')).toMatchObject({
      status: 'confirmed',
      amountWei: 2n * WAGER_WEI,
    })
    // welcome, deal, hit, reveal: four dealer messages, four payment sets, each sent once.
    expect(botSets().size).toBe(4)
    expect(f.relay.puts.filter(p => p.sender === f.botSubject)).toHaveLength(4)
    expect(store.all().map(row => row.phase)).toEqual(
      Array(4).fill('delivered'),
    )
    // Nothing a relay could read names the game.
    expect(
      f.relay.puts.some(p => Buffer.from(p.body, 'hex').includes('g1')),
    ).toBe(false)
  })

  it('doubles down on a second verified transfer and pays on the combined stake', async () => {
    const hash = '0x' + 'b1'.repeat(32)
    const second = '0x' + 'b2'.repeat(32)
    const seed = seedFor(hash, deck => {
      const initial = dealInitialCards(deck)
      const hand = [...initial.playerCards, deck[4]]
      return (
        !handValue(initial.playerCards).blackjack &&
        playOutDealer(deck, hand, 5).outcome === 'player_win'
      )
    })
    await state.setPendingCommitment(seed, sha256Hex(seed))
    const sent = move('g2', 'bet', { wagerTxHash: wager(hash) })
    await uiSends(sent)
    await botRuns()
    const double = move('g2', 'double', { doubleWagerTxHash: wager(second) })
    sent.push(...double)
    await uiSends(double)
    await botRuns(1)
    await botRuns()
    const game = await uiGame(sent, 'g2')
    expect(game).toMatchObject({
      phase: 'resolved',
      doubled: true,
      outcome: 'player_win',
    })
    expect(verifyRevealedHand(game)).toEqual({ valid: true })
    expect(blackjackPayoutWei(game)).toBe(4n * WAGER_WEI)
    expect(bankroll.signed.map(({ to, value }) => ({ to, value }))).toEqual([
      { to: getAddress(f.uiAccount), value: 4n * WAGER_WEI },
    ])
  })

  it('takes no action and pays nothing for a tampered, replayed or uninstalled-sender bet', async () => {
    const hash = wager('0x' + 'c1'.repeat(32))
    await uiSends(move('g3', 'bet', { wagerTxHash: hash }))
    const inbox = f.relay.inbox.get(f.botSubject)!
    const original = inbox[0]

    // 1. The exact envelope, but the relay context was changed: it never opens.
    const context = new Uint8Array(original.context)
    context[context.length - 1] ^= 1
    inbox[0] = { ...original, context }
    await botRuns()
    expect(state.getGame('g3')).toBeUndefined()

    // 2. The exact envelope, but its sender is not an installed peer: quarantined, never opened.
    inbox[0] = { ...original, timestampMs: f.relay.clock++ }
    installCanonicalDirectory(f.bot, f.botDirectory([]))
    await botRuns()
    expect(state.getGame('g3')).toBeUndefined()

    // 3. An installed peer that is momentarily unreadable: nothing is consumed or dropped.
    inbox[0] = { ...original, timestampMs: f.relay.clock++ }
    installCanonicalDirectory(f.bot, f.botDirectory([f.uiSubject]))
    f.botView.peerReadable = false
    await botRuns()
    expect(state.getGame('g3')).toBeUndefined()
    expect(store.all()).toEqual([])
    expect(bankroll.signed).toEqual([])
    expect(botSets().size).toBe(0)

    // 4. Readable again: the same mail is read and the bet is accepted once.
    f.botView.peerReadable = true
    await botRuns()
    expect(state.getGame('g3')).toMatchObject({
      revealed: false,
      dealtCount: 4,
    })
    expect(botSets().size).toBe(1)

    // 5. The relay shows the same delivery again, later: the same digest is never handled twice.
    inbox.push({ ...original, timestampMs: f.relay.clock++ })
    await botRuns()
    expect(botSets().size).toBe(1)

    // 6. A new, genuine envelope naming the same wager for another game: refused, no refund.
    await uiSends(move('g3-again', 'bet', { wagerTxHash: hash }))
    await botRuns()
    expect(state.getGame('g3-again')).toBeUndefined()
    expect(state.getRefund(hash)).toBeUndefined()
    const last = (await uiReceives()).at(-1)!
    expect(last.type === 'text' && parseBlackjackError(last.text)).toEqual({
      gameId: 'g3-again',
      text: 'this wager transaction has already authorized a blackjack game',
    })
    // A wager that did not pay this dealer is neither accepted nor refunded.
    await uiSends(
      move('g3-elsewhere', 'bet', {
        wagerTxHash: wager('0x' + 'c2'.repeat(32), { to: f.uiAccount }),
      }),
    )
    await botRuns()
    expect(state.getGame('g3-elsewhere')).toBeUndefined()
    expect(bankroll.signed).toEqual([])
    expect(state.getGame('g3')).toMatchObject({
      revealed: false,
      dealtCount: 4,
    })
  })

  it('after stores are reopened mid-hand, no reply is re-sealed and the payout is signed once', async () => {
    const hash = wager('0x' + 'd1'.repeat(32))
    const seed = seedFor(hash, deck => {
      const initial = dealInitialCards(deck)
      return (
        !handValue(initial.playerCards).blackjack &&
        playOutDealer(deck, [...initial.playerCards], 4).outcome ===
          'player_win'
      )
    })
    await state.setPendingCommitment(seed, sha256Hex(seed))
    const sent = move('g4', 'bet', { wagerTxHash: hash })
    await uiSends(sent)
    // The relay is unreachable while the dealer answers: the deal has one journaled payment set.
    f.relay.mode = 'fail'
    await botRuns()
    expect(store.all().map(row => row.phase)).toEqual(['attempt'])
    expect(botSets().size).toBe(0)

    await closeBot()
    await openBot()
    f.relay.mode = 'delivered'
    await botRuns()
    expect(store.all().map(row => row.phase)).toEqual(['delivered'])
    expect(botSets().size).toBe(1)

    // The stand resolves the hand while neither the relay nor the bankroll's RPC is reachable.
    sent.push(...move('g4', 'stand'))
    await uiSends(move('g4', 'stand'))
    f.relay.mode = 'fail'
    bankroll.failBroadcast = true
    await botRuns(1)
    expect(state.getPayout('g4')).toMatchObject({ status: 'submitting' })
    expect(bankroll.signed).toHaveLength(1)

    // Restart, and replay the whole inbox from the beginning as well.
    await closeBot()
    await openBot()
    await state.setSince(0)
    f.relay.mode = 'delivered'
    bankroll.failBroadcast = false
    await botRuns()
    await closeBot()
    await openBot()
    await state.setSince(0)
    await botRuns()

    expect(bankroll.signed).toHaveLength(1)
    expect(bankroll.broadcast).toEqual([bankroll.signed[0].txHash])
    expect(state.getPayout('g4')).toMatchObject({
      status: 'confirmed',
      amountWei: 2n * WAGER_WEI,
    })
    // deal and reveal: two payment sets in total, and every PUT of a set carried the same bytes.
    expect(botSets().size).toBe(2)
    const bodies = new Map<string, Set<string>>()
    for (const put of f.relay.puts.filter(p => p.sender === f.botSubject))
      bodies.set(
        put.digest,
        (bodies.get(put.digest) ?? new Set()).add(put.body),
      )
    expect([...bodies.values()].every(set => set.size === 1)).toBe(true)
    const replies = (await uiReceives()).filter(
      item => item.type === 'blackjack-move',
    )
    expect(replies.map(item => (item as BlackjackMoveItem).action)).toEqual([
      'deal',
      'reveal',
    ])
    const game = await uiGame(sent, 'g4')
    expect(verifyRevealedHand(game)).toEqual({ valid: true })
  })
  // The windows between a durable game write and the reply that announces it. The "crash" is
  // the reply save failing at that exact point, then every bot store closed and reopened; the
  // wallets, journals, sealing and relay stand-in are the real ones used above. (A SIGKILLed
  // child cannot carry this file's jest module stand-ins for the chain RPC, so real process
  // death is covered only for the outbox, in blackjack-canonical.jest.test.ts.)
  const losing = (prefix: string) => {
    const enqueue = outbox.enqueue.bind(outbox)
    jest
      .spyOn(outbox, 'enqueue')
      .mockImplementation((key, recipient, items) =>
        key.startsWith(prefix)
          ? Promise.reject(new Error('killed here'))
          : enqueue(key, recipient, items),
      )
  }
  const restart = async () => {
    await closeBot()
    await openBot()
    return recoverCanonicalReplies({
      state,
      store,
      outbox,
      identity: f.bot.identity,
      mainAccountSigner: bankroll as never,
      provider: wagerProvider as never,
    })
  }
  const standingWin = (hash: string) =>
    seedFor(hash, deck => {
      const initial = dealInitialCards(deck)
      return (
        !handValue(initial.playerCards).blackjack &&
        playOutDealer(deck, [...initial.playerCards], 4).outcome ===
          'player_win'
      )
    })

  it('re-saves a deal lost after the wager was claimed, and the hand can be finished', async () => {
    const hash = wager('0x' + 'e1'.repeat(32))
    const seed = standingWin(hash)
    await state.setPendingCommitment(seed, sha256Hex(seed))
    const sent = move('g5', 'bet', { wagerTxHash: hash })
    await uiSends(sent)
    losing('deal:')
    await botRuns()
    // The wager is claimed and the game exists, but nothing was saved for the player.
    expect(state.getGame('g5')).toMatchObject({
      revealed: false,
      dealtCount: 4,
    })
    expect(store.all()).toEqual([])
    expect(await uiReceives()).toEqual([])

    expect(await restart()).toBe(1)
    await botRuns()
    expect((await uiReceives()).at(-1)).toMatchObject({
      action: 'deal',
      gameId: 'g5',
      serverSeedHash: sha256Hex(seed),
    })
    // Another restart finds nothing to repair and sends nothing more.
    expect(await restart()).toBe(0)
    await botRuns()
    expect(botSets().size).toBe(1)

    sent.push(...move('g5', 'stand'))
    await uiSends(move('g5', 'stand'))
    await botRuns(1)
    await botRuns()
    const game = await uiGame(sent, 'g5')
    expect(verifyRevealedHand(game)).toEqual({ valid: true })
    expect(bankroll.signed).toHaveLength(1)
    expect(botSets().size).toBe(2)
  })

  it('re-saves a reveal lost after the hand was resolved and paid, without paying again', async () => {
    const hash = wager('0x' + 'e2'.repeat(32))
    const seed = seedFor(hash, deck => {
      const initial = dealInitialCards(deck)
      const hand = [...initial.playerCards, deck[4]]
      return (
        !handValue(initial.playerCards).blackjack &&
        !handValue(hand).bust &&
        playOutDealer(deck, hand, 5).outcome === 'player_win'
      )
    })
    await state.setPendingCommitment(seed, sha256Hex(seed))
    const sent = move('g6', 'bet', { wagerTxHash: hash })
    await uiSends(sent)
    await botRuns()
    sent.push(...move('g6', 'hit'), ...move('g6', 'stand'))
    await uiSends(move('g6', 'hit'))
    await botRuns()
    await uiSends(move('g6', 'stand'))
    losing('reveal:')
    await botRuns(1)
    expect(state.getGame('g6')).toMatchObject({ revealed: true })
    expect(bankroll.signed).toHaveLength(1)
    expect(
      (await uiReceives()).some(
        item => item.type === 'blackjack-move' && item.action === 'reveal',
      ),
    ).toBe(false)

    expect(await restart()).toBe(1)
    await botRuns()
    expect(await restart()).toBe(0)
    await botRuns()
    const game = await uiGame(sent, 'g6')
    expect(game).toMatchObject({ phase: 'resolved', serverSeed: seed })
    expect(game.playerCards).toHaveLength(3)
    expect(verifyRevealedHand(game)).toEqual({ valid: true })
    expect(bankroll.signed).toHaveLength(1)
    expect(state.getPayout('g6')).toMatchObject({ status: 'confirmed' })
    // deal, hit, reveal.
    expect(botSets().size).toBe(3)
  })

  it('finishes a doubled hand whose card and reveal were lost with the process', async () => {
    const hash = wager('0x' + 'e3'.repeat(32))
    const second = wager('0x' + 'e4'.repeat(32))
    const seed = seedFor(hash, deck => {
      const initial = dealInitialCards(deck)
      return (
        !handValue(initial.playerCards).blackjack &&
        playOutDealer(deck, [...initial.playerCards, deck[4]], 5).outcome ===
          'player_win'
      )
    })
    await state.setPendingCommitment(seed, sha256Hex(seed))
    const sent = move('g7', 'bet', { wagerTxHash: hash })
    await uiSends(sent)
    await botRuns()
    const double = move('g7', 'double', { doubleWagerTxHash: second })
    sent.push(...double)
    await uiSends(double)
    losing('double:')
    await botRuns()
    // Both transfers are claimed; nothing was said and nothing resolved.
    expect(state.getGame('g7')).toMatchObject({
      doubled: true,
      revealed: false,
    })
    expect(bankroll.signed).toEqual([])

    expect(await restart()).toBe(2)
    await botRuns()
    await botRuns()
    expect(await restart()).toBe(0)
    const game = await uiGame(sent, 'g7')
    expect(game).toMatchObject({ phase: 'resolved', doubled: true })
    expect(verifyRevealedHand(game)).toEqual({ valid: true })
    expect(bankroll.signed.map(({ to, value }) => ({ to, value }))).toEqual([
      { to: getAddress(f.uiAccount), value: 4n * WAGER_WEI },
    ])
    expect(state.getPayout('g7')).toMatchObject({ status: 'confirmed' })
  })
})
