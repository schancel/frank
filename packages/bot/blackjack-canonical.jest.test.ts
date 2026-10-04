/**
 * #780: the canonical dealer's own durable pieces. Real Level stores; the wallet's canonical
 * message client is the file-backed stand-in from `blackjack-canonical.fixture.ts` (the real
 * wallet runs in `blackjack-canonical-hand.jest.test.ts`).
 */
import { spawnSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { computeAddress, getAddress } from 'ethers'

import { sha256Hex } from '@frank/wallet/message-item-plugins/blackjack/deck'
import {
  HydratedBlackjackMove,
  parseBlackjackError,
} from '@frank/wallet/message-item-plugins/blackjack/game'
import type { MessageItem } from '@frank/cashweb/types/messages'

import { BlackjackBotStateStore } from './blackjack-bot-state'
import {
  BLACKJACK_OUTBOX_MAX_ITEM_BYTES,
  BlackjackCanonicalOutbox,
  BlackjackCanonicalStore,
  canonicalDirectoryFor,
  InstalledPeerUnavailableError,
} from './blackjack-canonical'
import {
  fileWallet,
  KILL_POINTS,
  type FakeRelay,
} from './blackjack-canonical.fixture'
import { handleMove } from './blackjack-bot.livecheck'
import {
  sendDirectMessageItems,
  sendDirectMessageText,
} from './qwen-bot-common'

jest.mock('./qwen-bot-common', () => ({
  loadOrCreateIdentity: jest.fn(),
  registerAndLog: jest.fn(),
  requiredEnv: jest.fn(),
  sendDirectMessageItems: jest.fn(async () => undefined),
  sendDirectMessageText: jest.fn(async () => undefined),
  setUpFundedStampClient: jest.fn(),
}))

const PEER = '0x' + 'aa'.repeat(20)
const text = (value: string): MessageItem[] => [{ type: 'text', text: value }]
const count = (events: string[], prefix: string) =>
  events.filter(event => event.startsWith(prefix + ':')).length
const distinct = (events: string[], prefix: string) =>
  new Set(
    events
      .filter(event => event.startsWith(prefix + ':'))
      .map(e => e.split(':')[1]),
  ).size

describe('canonical reply outbox', () => {
  let root: string
  let store: BlackjackCanonicalStore
  const open = async (relay: FakeRelay = 'delivered') => {
    store = new BlackjackCanonicalStore(root)
    await store.Open()
    const wallet = fileWallet(root, { relay })
    const outbox = new BlackjackCanonicalOutbox({
      store,
      messages: wallet.messages,
      wallet: {} as never,
      stampValueWei: 1n,
    })
    return { wallet, outbox }
  }
  const reopen = async (relay: FakeRelay = 'delivered') => {
    await store.Close()
    return open(relay)
  }
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'blackjack-outbox-'))
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
  })
  afterEach(async () => {
    jest.restoreAllMocks()
    await store.Close().catch(() => undefined)
    rmSync(root, { recursive: true, force: true })
  })

  it('delivers saved replies in order, one sealed envelope and one payment set each', async () => {
    const f = await open()
    expect(await f.outbox.enqueue('m1:0', PEER, text('deal'))).toBe('saved')
    expect(await f.outbox.enqueue('m1:1', PEER, text('reveal'))).toBe('saved')
    // The same key never makes a second reply.
    expect(await f.outbox.enqueue('m1:0', PEER, text('other'))).toBe(
      'duplicate',
    )
    expect(await f.outbox.drive()).toBe(2)
    expect(await f.outbox.drive()).toBe(0)
    const events = f.wallet.events()
    expect(
      events.filter(e => e.startsWith('seal:')).map(e => e.slice(70)),
    ).toEqual([JSON.stringify(text('deal')), JSON.stringify(text('reveal'))])
    expect(count(events, 'link')).toBe(2)
    expect(count(events, 'put')).toBe(2)
    expect(store.all().map(row => row.phase)).toEqual([
      'delivered',
      'delivered',
    ])
    // A final row keeps its digest and drops the content.
    expect(store.all().every(row => row.items === undefined)).toBe(true)
    expect(store.digests()).toHaveLength(2)
  })

  it('keeps one payment set across an unknown outcome and holds later replies behind it', async () => {
    let f = await open('fail')
    await f.outbox.enqueue('m1:0', PEER, text('deal'))
    await f.outbox.enqueue('m1:1', PEER, text('reveal'))
    expect(await f.outbox.drive()).toBe(0)
    expect(store.all().map(row => row.phase)).toEqual(['attempt', 'queued'])
    expect(await f.outbox.drive()).toBe(0)
    f = await reopen('retained')
    expect(await f.outbox.drive()).toBe(0)
    // Still exactly one sealed envelope and one payment set; the second reply was never started.
    expect(count(f.wallet.events(), 'seal')).toBe(1)
    expect(distinct(f.wallet.events(), 'put')).toBe(1)
    f = await reopen('delivered')
    expect(await f.outbox.drive()).toBe(2)
    const events = f.wallet.events()
    expect(count(events, 'seal')).toBe(2)
    expect(distinct(events, 'link')).toBe(2)
    expect(count(events, 'delivered')).toBe(2)
  })

  it('never re-seals or re-pays a reply whose payment set the relay ended', async () => {
    let f = await open('dead')
    await f.outbox.enqueue('m1:0', PEER, text('deal'))
    await f.outbox.enqueue('m1:1', PEER, text('reveal'))
    // The send ends without a delivery; the set's end is learned on the next pass.
    expect(await f.outbox.drive()).toBe(0)
    expect(store.all().map(row => row.phase)).toEqual(['attempt', 'queued'])
    f = await reopen('delivered')
    expect(await f.outbox.drive()).toBe(1)
    const events = f.wallet.events()
    expect(store.all().map(row => row.phase)).toEqual(['dead', 'delivered'])
    // The dead reply has exactly its one set; nothing replaced it.
    expect(
      events.filter(e => e.startsWith('seal:') && e.includes('deal')),
    ).toHaveLength(1)
  })

  it('does not seal a second envelope when recording the digest fails after the wallet made its set durable', async () => {
    const f = await open()
    await f.outbox.enqueue('m1:0', PEER, text('deal'))
    const advance = store.advance.bind(store)
    let failed = false
    jest.spyOn(store, 'advance').mockImplementation((seq, phase, digest) => {
      if (phase === 'attempt' && !failed) {
        failed = true
        return Promise.reject(new Error('disk full'))
      }
      return advance(seq, phase, digest)
    })
    expect(await f.outbox.drive()).toBe(0)
    // The wallet holds one durable set; the row does not claim that nothing was started.
    expect(count(f.wallet.events(), 'link')).toBe(1)
    expect(store.all()[0].phase).toBe('sending')
    expect(await f.outbox.drive()).toBe(1)
    await f.outbox.drive()
    const events = f.wallet.events()
    expect(count(events, 'seal')).toBe(1)
    expect(distinct(events, 'link')).toBe(1)
    expect(count(events, 'delivered')).toBe(1)
    expect(store.all()[0]).toMatchObject({
      phase: 'delivered',
      digest: events[1].split(':')[1],
    })
  })

  it('sends once after a failure that left no payment set behind', async () => {
    const f = await open()
    await f.outbox.enqueue('m1:0', PEER, text('deal'))
    const send = f.wallet.messages.send
    f.wallet.messages.send = async () => {
      throw new Error('directory unavailable')
    }
    expect(await f.outbox.drive()).toBe(0)
    expect(store.all()[0].phase).toBe('sending')
    f.wallet.messages.send = send
    expect(await f.outbox.drive()).toBe(1)
    expect(count(f.wallet.events(), 'seal')).toBe(1)
  })

  it('holds everything when the wallet retains more than one payment set no reply accounts for', async () => {
    const f = await open()
    await f.outbox.enqueue('m1:0', PEER, text('deal'))
    await store.advance(0, 'sending')
    f.wallet.messages.unattributedAttempts = async () => [
      'aa'.repeat(32),
      'bb'.repeat(32),
    ]
    const send = jest.spyOn(f.wallet.messages, 'send')
    expect(f.outbox.held()).toBeUndefined()
    expect(await f.outbox.drive()).toBe(0)
    expect(send).not.toHaveBeenCalled()
    expect(store.all()[0].phase).toBe('sending')
    expect(f.outbox.held()).toBe('unaccounted-payment-sets')
    // A wallet that cannot correlate at all is a hold too; a relay that is merely slow is not.
    f.wallet.messages.unattributedAttempts = async () => {
      throw new Error('hold')
    }
    await f.outbox.drive()
    expect(f.outbox.held()).toBe('wallet-correlation-held')
    f.wallet.messages.unattributedAttempts = async () => []
    f.wallet.state.relay = 'retained'
    await f.outbox.drive()
    expect(store.all()[0].phase).toBe('attempt')
    expect(f.outbox.held()).toBeUndefined()
  })

  it('refuses oversize or malformed replies before saving anything, and bad rows on open', async () => {
    const f = await open()
    await expect(
      f.outbox.enqueue(
        'k',
        PEER,
        text('x'.repeat(BLACKJACK_OUTBOX_MAX_ITEM_BYTES)),
      ),
    ).rejects.toThrow('too large')
    await expect(f.outbox.enqueue('k', 'nobody', text('x'))).rejects.toThrow(
      'not an address',
    )
    await expect(f.outbox.enqueue('k', PEER, [])).rejects.toThrow('empty')
    // A reply the closed type-18 writer would refuse (a seed that is not 64 lowercase hex, an
    // extra field) or any other structured kind is refused here, not left to block the queue.
    for (const item of [
      {
        type: 'blackjack-move',
        gameId: 'g',
        action: 'reveal',
        dealerCards: [1, 2],
        serverSeed: 'initial-seed',
        outcome: 'push',
      },
      { type: 'blackjack-move', gameId: 'g', action: 'stand', amount: '1' },
      { type: 'raffle', raffleId: 'r', action: 'announce' },
    ])
      await expect(
        f.outbox.enqueue('k', PEER, [item as never]),
      ).rejects.toThrow()
    expect(store.all()).toEqual([])
    await f.outbox.enqueue('k', PEER, text('x'))
    // A payment set can never be dropped or swapped once recorded.
    await store.advance(0, 'sending')
    await store.advance(0, 'attempt', 'aa'.repeat(32))
    await expect(store.advance(0, 'queued')).rejects.toThrow('cannot go')
    await expect(
      store.advance(0, 'delivered', 'bb'.repeat(32)),
    ).rejects.toThrow('another payment set')
  })

  // Real child termination without Close at each durable barrier, then the Level store and the
  // wallet's history are reopened in this process.
  const killedChild = (kill: string, relay: FakeRelay = 'delivered') =>
    spawnSync(
      process.execPath,
      [
        '--require',
        require.resolve('tsx/cjs'),
        '-e',
        `require(${JSON.stringify(
          join(__dirname, 'blackjack-canonical.fixture.ts'),
        )}).runOutboxChild().catch(error => {
          console.error(String(error && error.message));
          process.exit(2);
        });`,
      ],
      {
        encoding: 'utf8',
        timeout: 30000,
        env: {
          PATH: process.env.PATH,
          TSX_TSCONFIG_PATH: join(__dirname, 'tsconfig.json'),
          BLACKJACK_OUTBOX_ROOT: root,
          BLACKJACK_OUTBOX_KILL: kill,
          BLACKJACK_OUTBOX_RELAY: relay,
        },
      },
    )

  it.each(KILL_POINTS)(
    'SIGKILL after %s converges to one sealed envelope, one payment set and one delivery',
    async kill => {
      const child = killedChild(kill)
      expect({
        status: child.status,
        signal: child.signal,
        stderr: child.stderr,
        finished: child.stdout.includes('CHILD_DELIVERED'),
      }).toEqual({
        status: null,
        signal: 'SIGKILL',
        stderr: '',
        finished: false,
      })
      const f = await open()
      expect(store.all().map(row => row.phase)).toEqual([
        {
          'send-called': 'sending',
          'linked': 'sending',
          'attempt-saved': 'attempt',
          'relay-accepted': 'attempt',
          'delivered-recorded': 'attempt',
          'drive-returned': 'delivered',
        }[kill],
      ])
      // The restarted process saves the same reply again (same key) and drives.
      expect(
        await f.outbox.enqueue('inbound-1:0', PEER, text('REPLY_SENTINEL')),
      ).toBe('duplicate')
      await f.outbox.drive()
      await f.outbox.drive()
      const events = f.wallet.events()
      expect(store.all().map(row => row.phase)).toEqual(['delivered'])
      expect(count(events, 'seal')).toBe(1)
      expect(distinct(events, 'link')).toBe(1)
      expect(distinct(events, 'put')).toBe(1)
      expect(count(events, 'delivered')).toBe(1)
      // The relay sees a second PUT only when the first acceptance was never recorded.
      expect(count(events, 'put')).toBe(kill === 'relay-accepted' ? 2 : 1)
      expect(store.all()[0].digest).toBe(events[1].split(':')[1])
    },
    40000,
  )

  it('SIGKILL with the relay unreachable leaves one set that a restart delivers unchanged', async () => {
    const child = killedChild('none', 'fail')
    expect(child.signal).toBe('SIGKILL')
    expect(child.stdout).toContain('CHILD_DELIVERED 0')
    const f = await open()
    expect(store.all()[0].phase).toBe('attempt')
    expect(await f.outbox.drive()).toBe(1)
    const events = f.wallet.events()
    expect(count(events, 'seal')).toBe(1)
    expect(count(events, 'put')).toBe(1)
  }, 40000)
})

describe('installed directory view for the wallet client', () => {
  // The secp256k1 generator: any valid compressed point.
  const subject =
    '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
  const address = computeAddress('0x' + subject)
  const current = { kind: 'current' } as never
  const view = (peer: unknown) =>
    canonicalDirectoryFor({
      installed: {
        network: 'monad-testnet',
        homeEndpoint: 'https://relay-a.example/',
        selfCurrent: async () => current,
        peerCurrent: async () => peer as never,
      },
      peerSubjects: [subject],
    })

  it('knows only installed ui subjects, by address or subject', async () => {
    const directory = view(current)
    expect(await directory.peerCurrent({ address })).toEqual({
      subject,
      endpoint: 'https://relay-a.example/',
      current,
    })
    expect((await directory.peerCurrent({ subject }))?.subject).toBe(subject)
    expect(
      await directory.peerCurrent({ subject: '03' + '22'.repeat(32) }),
    ).toBeUndefined()
    expect(await directory.peerCurrent({ address: PEER })).toBeUndefined()
  })

  it('fails the read instead of dropping mail when an installed peer is unreadable', async () => {
    await expect(
      view(undefined).peerCurrent({ subject }),
    ).rejects.toBeInstanceOf(InstalledPeerUnavailableError)
  })
})

describe('canonical move authority', () => {
  const DEALER = `0x${'bb'.repeat(20)}`
  // The directory-admitted subject's identity address, and the EVM account that pays for it.
  // Checksummed, as the state store normalizes every address it keeps.
  const ACTOR = getAddress(`0x${'a1'.repeat(20)}`)
  const PAYER = getAddress(`0x${'a2'.repeat(20)}`)
  const OTHER_ACTOR = getAddress(`0x${'c1'.repeat(20)}`)
  const WAGER = `0x${'ab'.repeat(32)}`
  const DOUBLE = `0x${'cd'.repeat(32)}`
  let directory: string
  let state: BlackjackBotStateStore
  let actors: BlackjackCanonicalStore
  let replies: { to: string; items: MessageItem[] }[]
  let mainAccountSigner: Record<string, jest.Mock> & { address: string }

  beforeEach(async () => {
    jest.clearAllMocks()
    jest.spyOn(console, 'log').mockImplementation(() => undefined)
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
    directory = mkdtempSync(join(tmpdir(), 'blackjack-canonical-move-'))
    state = new BlackjackBotStateStore(directory)
    await state.Open()
    await state.setPendingCommitment('initial-seed', sha256Hex('initial-seed'))
    actors = new BlackjackCanonicalStore(directory)
    await actors.Open()
    replies = []
    held = undefined
    mainAccountSigner = {
      address: `0x${'dd'.repeat(20)}`,
      buildAndSignTransfer: jest.fn(async () => ({
        rawTx: '0xsigned',
        txHash: '0xpaid',
        nonce: 1,
      })),
      submit: jest.fn(async () => '0xpaid'),
      submitRaw: jest.fn(async (_raw: string, hash: string) => hash),
      getStatus: jest.fn(async () => 'pending'),
    }
  })
  afterEach(async () => {
    jest.restoreAllMocks()
    await state.Close()
    await actors.Close()
    rmSync(directory, { recursive: true, force: true })
  })

  let held: string | undefined
  const move = (
    action: HydratedBlackjackMove['action'],
    hydrated: Partial<HydratedBlackjackMove>,
    sender = ACTOR,
  ) =>
    handleMove({
      action,
      hydrated: {
        gameId: 'game-a',
        action,
        senderAddress: sender,
        ...hydrated,
      },
      senderAddress: sender,
      minWagerWei: 10n,
      maxWagerWei: 1000n,
      state,
      identity: { displayAddress: DEALER } as never,
      mainAccountSigner: mainAccountSigner as never,
      provider: { getBalance: async () => 10n ** 30n } as never,
      canonical: {
        reply: async items => void replies.push({ to: sender, items }),
        actors,
        held: () => held,
      },
    })
  const bet = (
    overrides: Partial<HydratedBlackjackMove> = {},
    sender = ACTOR,
  ) =>
    move(
      'bet',
      {
        wagerTxHash: WAGER,
        verifiedWager: {
          fromAddress: PAYER,
          toAddress: DEALER,
          valueWei: 100n,
        },
        ...overrides,
      },
      sender,
    )
  const errors = () =>
    replies.flatMap(reply =>
      reply.items.flatMap(item =>
        item.type === 'text' ? [parseBlackjackError(item.text)?.text] : [],
      ),
    )

  it('never touches the legacy transport', async () => {
    await bet()
    await move('stand', {})
    expect(sendDirectMessageItems).not.toHaveBeenCalled()
    expect(sendDirectMessageText).not.toHaveBeenCalled()
  })

  it('binds the game to the authenticated subject and pays only the verified wager sender', async () => {
    await bet()
    const game = state.getGame('game-a')!
    // The payout address is the account that paid, exactly as in legacy mode.
    expect(game.playerAddress).toBe(PAYER)
    expect(game.authority).toBe('verified-wager-sender')
    expect(actors.actor('game-a')).toEqual({ actor: ACTOR, wagerTxHash: WAGER })
    expect(replies[0]).toMatchObject({
      to: ACTOR,
      items: [{ type: 'blackjack-move', action: 'deal', gameId: 'game-a' }],
    })
    // The commitment in the deal is the one that existed before this bet was seen.
    expect(
      (replies[0].items[0] as { serverSeedHash: string }).serverSeedHash,
    ).toBe(sha256Hex('initial-seed'))
    await move('stand', {})
    const reveal = replies
      .flatMap(reply => reply.items)
      .find(item => item.type === 'blackjack-move' && item.action === 'reveal')
    expect(reveal).toMatchObject({ serverSeed: 'initial-seed' })
    const payout = state.getPayout('game-a')
    if (payout) {
      expect(mainAccountSigner.buildAndSignTransfer).toHaveBeenCalledTimes(1)
      expect(mainAccountSigner.buildAndSignTransfer).toHaveBeenCalledWith(
        PAYER,
        payout.amountWei,
      )
    } else expect(mainAccountSigner.buildAndSignTransfer).not.toHaveBeenCalled()
  })

  it('lets only the bound subject act, whoever paid', async () => {
    await bet()
    replies = []
    // Another installed subject, and even the paying account itself, are not the actor.
    for (const sender of [OTHER_ACTOR, PAYER]) {
      await move('hit', {}, sender)
      await move('stand', {}, sender)
    }
    expect(errors()).toEqual(
      Array(4).fill(
        'only the player who funded this wager can act on this game',
      ),
    )
    expect(state.getGame('game-a')).toMatchObject({
      dealtCount: 4,
      revealed: false,
    })
    expect(mainAccountSigner.buildAndSignTransfer).not.toHaveBeenCalled()
  })

  it('cannot move a binding onto an existing game or reuse a claimed wager', async () => {
    await bet()
    replies = []
    // Same game id from another subject: rejected before any binding write; its own transfer
    // is refunded to where it came from.
    await bet(
      {
        wagerTxHash: DOUBLE,
        verifiedWager: {
          fromAddress: OTHER_ACTOR,
          toAddress: DEALER,
          valueWei: 100n,
        },
      },
      OTHER_ACTOR,
    )
    expect(actors.actor('game-a')).toEqual({ actor: ACTOR, wagerTxHash: WAGER })
    expect(state.getRefund(DOUBLE)).toMatchObject({
      playerAddress: OTHER_ACTOR,
    })
    // The same wager under a new game id: no second game, no refund, no payout.
    await bet({ gameId: 'game-b' }, OTHER_ACTOR)
    expect(state.getGame('game-b')).toBeUndefined()
    expect(state.getRefund(WAGER)).toBeUndefined()
    expect(errors().at(-1)).toBe(
      'this wager transaction has already authorized a blackjack game',
    )
    // The stale binding written for game-b names a wager that backs no such game.
    await move('stand', { gameId: 'game-b' }, OTHER_ACTOR)
    expect(errors().at(-1)).toBe('no in-progress hand found for this gameId')
    expect(mainAccountSigner.buildAndSignTransfer).toHaveBeenCalledTimes(1) // the one refund
  })

  it('requires a double to come from the account that paid the original wager', async () => {
    await bet()
    replies = []
    await move('double', {
      doubleWagerTxHash: DOUBLE,
      verifiedDoubleWager: {
        fromAddress: OTHER_ACTOR,
        toAddress: DEALER,
        valueWei: 100n,
      },
    })
    expect(errors()).toEqual([
      'your authenticated identity did not send this double-down wager transaction',
    ])
    expect(state.getGame('game-a')!.doubled).toBe(false)
    await move('double', {
      doubleWagerTxHash: DOUBLE,
      verifiedDoubleWager: {
        fromAddress: PAYER,
        toAddress: DEALER,
        valueWei: 100n,
      },
    })
    const game = state.getGame('game-a')!
    expect(game).toMatchObject({
      doubled: true,
      doubleWagerWei: 100n,
      revealed: true,
    })
  })

  it('takes no new stake while replies are held: a bet or double is refused and refunded', async () => {
    await bet()
    held = 'wallet-correlation-held'
    replies = []
    await bet({
      gameId: 'game-b',
      wagerTxHash: DOUBLE,
      verifiedWager: { fromAddress: PAYER, toAddress: DEALER, valueWei: 100n },
    })
    expect(state.getGame('game-b')).toBeUndefined()
    expect(actors.actor('game-b')).toBeUndefined()
    expect(state.getRefund(DOUBLE)).toMatchObject({
      playerAddress: PAYER,
      amountWei: 100n,
    })
    const third = `0x${'ef'.repeat(32)}`
    await move('double', {
      doubleWagerTxHash: third,
      verifiedDoubleWager: {
        fromAddress: PAYER,
        toAddress: DEALER,
        valueWei: 100n,
      },
    })
    expect(state.getGame('game-a')!.doubled).toBe(false)
    expect(state.getRefund(third)).toMatchObject({ amountWei: 100n })
    expect(errors()).toEqual(
      Array(2).fill(
        'the dealer cannot deliver replies right now Your transfer has been refunded.',
      ),
    )
    // A hand already dealt can still be finished, and is paid.
    await move('stand', {})
    expect(state.getGame('game-a')!.revealed).toBe(true)
    // Once replies flow again, bets are taken again.
    held = undefined
    await bet({
      gameId: 'game-c',
      wagerTxHash: `0x${'12'.repeat(32)}`,
    })
    expect(state.getGame('game-c')).toBeDefined()
  })

  it('refunds a rejected verified transfer once, to the account it came from', async () => {
    await bet({
      verifiedWager: { fromAddress: PAYER, toAddress: DEALER, valueWei: 5n },
    })
    expect(state.getGame('game-a')).toBeUndefined()
    expect(state.getRefund(WAGER)).toMatchObject({
      playerAddress: PAYER,
      amountWei: 5n,
    })
    expect(mainAccountSigner.buildAndSignTransfer).toHaveBeenCalledWith(
      PAYER,
      5n,
    )
    // A replay of the same rejected bet is not refunded again.
    await bet({
      verifiedWager: { fromAddress: PAYER, toAddress: DEALER, valueWei: 5n },
    })
    expect(mainAccountSigner.buildAndSignTransfer).toHaveBeenCalledTimes(1)
    // A transfer that did not pay this dealer is neither a wager nor refundable.
    await bet({
      wagerTxHash: DOUBLE,
      verifiedWager: {
        fromAddress: PAYER,
        toAddress: OTHER_ACTOR,
        valueWei: 100n,
      },
    })
    expect(state.getRefund(DOUBLE)).toBeUndefined()
    expect(errors().at(-1)).toBe(
      'your wager transaction did not pay this dealer',
    )
  })
})
