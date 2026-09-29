import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import level from 'level'

import { getAddress } from 'ethers'

import {
  buildEnvelope,
  parseEnvelope,
  tryDecryptEnvelope,
} from '@frank/cashweb/relay/monad-message-envelope'
import { BlackjackMoveItem } from '@frank/cashweb/types/messages'
import {
  deriveDeck,
  handValue,
  sha256Hex,
} from '@frank/wallet/message-item-plugins/blackjack/deck'
import {
  dealInitialCards,
  HydratedBlackjackMove,
  resolveOutcome,
} from '@frank/wallet/message-item-plugins/blackjack/game'
import {
  deserializeMessageItems,
  serializeMessageItems,
} from '@frank/wallet/chain/monad-chain'
import { MonadIdentity } from '@frank/wallet/monad-identity'
import { getMessageItemPlugin } from '@frank/wallet/message-item-plugins'
import {
  sendDirectMessageItems,
  sendDirectMessageText,
} from './qwen-bot-common'
import {
  BlackjackBotStateStore,
  MAX_BLACKJACK_GAME_ID_BYTES,
} from './blackjack-bot-state'
import {
  handleMove,
  hydrateMoveWithValidatedGameId,
  retryPendingRefunds,
} from './blackjack-bot.livecheck'

jest.mock('./qwen-bot-common', () => ({
  loadOrCreateIdentity: jest.fn(),
  registerAndLog: jest.fn(),
  requiredEnv: jest.fn(),
  sendDirectMessageItems: jest.fn(async () => undefined),
  sendDirectMessageText: jest.fn(async () => undefined),
  setUpFundedStampClient: jest.fn(),
}))

const DEALER = `0x${'bb'.repeat(20)}`
const PLAYER = `0x${'aa'.repeat(20)}`
const ATTACKER = `0x${'cc'.repeat(20)}`
const WAGER_HASH = `0x${'AB'.repeat(32)}`
const DOUBLE_HASH = `0x${'CD'.repeat(32)}`
const OTHER_HASH = `0x${'EF'.repeat(32)}`

describe('blackjack move authorization', () => {
  let directory: string
  let state: BlackjackBotStateStore
  let mainAccountSigner: {
    address: string
    buildAndSignTransfer: jest.Mock
    submit: jest.Mock
  }
  let getBalance: jest.Mock

  beforeEach(async () => {
    jest.clearAllMocks()
    directory = mkdtempSync(join(tmpdir(), 'blackjack-handler-'))
    state = new BlackjackBotStateStore(directory)
    await state.Open()
    await state.setPendingCommitment('initial-seed', sha256Hex('initial-seed'))
    getBalance = jest.fn(async () => 10n ** 30n)
    mainAccountSigner = {
      address: `0x${'dd'.repeat(20)}`,
      buildAndSignTransfer: jest.fn(async () => 'signed-payout'),
      submit: jest.fn(async () => '0xpayout'),
    }
  })

  afterEach(async () => {
    await state.Close()
    rmSync(directory, { recursive: true, force: true })
  })

  function hydrated(
    action: HydratedBlackjackMove['action'],
    overrides: Partial<HydratedBlackjackMove> = {},
  ): HydratedBlackjackMove {
    return {
      gameId: 'game-a',
      action,
      senderAddress: PLAYER,
      ...overrides,
    }
  }

  async function move(
    action: HydratedBlackjackMove['action'],
    moveHydrated: HydratedBlackjackMove,
    senderAddress = PLAYER,
  ) {
    await handleMove({
      action,
      hydrated: moveHydrated,
      senderAddress,
      senderPubKey: Buffer.alloc(33, 1),
      minWagerWei: 10n,
      maxWagerWei: 1000n,
      state,
      identity: { displayAddress: DEALER } as never,
      networkTag: 'TEST',
      stampValueWei: 1n,
      stampClient: {} as never,
      pool: {} as never,
      mainAccountSigner: mainAccountSigner as never,
      provider: { getBalance } as never,
    })
  }

  async function bet(overrides: Partial<HydratedBlackjackMove> = {}) {
    await move(
      'bet',
      hydrated('bet', {
        wagerTxHash: WAGER_HASH,
        verifiedWager: {
          fromAddress: PLAYER,
          toAddress: DEALER,
          valueWei: 100n,
        },
        ...overrides,
      }),
    )
  }

  it('rejects a wager whose on-chain sender is not the authenticated player', async () => {
    const pendingBefore = state.getPendingCommitment()
    await bet({
      verifiedWager: {
        fromAddress: ATTACKER,
        toAddress: DEALER,
        valueWei: 100n,
      },
    })

    expect(state.getGame('game-a')).toBeUndefined()
    expect(state.getPendingCommitment()).toEqual(pendingBefore)
    expect(sendDirectMessageItems).not.toHaveBeenCalled()
    expect(mainAccountSigner.submit).not.toHaveBeenCalled()
    expect(sendDirectMessageText).toHaveBeenCalledTimes(1)
  })

  it('carries a legitimate envelope sender through hydration into wager authority', async () => {
    // The v2 AEAD authenticates `from`; this pins that authenticated principal through wager
    // hydration and into the persisted blackjack authority.
    const playerIdentity = MonadIdentity.generate()
    const dealerIdentity = MonadIdentity.generate()
    const rawMove: BlackjackMoveItem = {
      type: 'blackjack-move',
      gameId: 'envelope-game',
      action: 'bet',
      wagerTxHash: WAGER_HASH,
    }
    const envelope = parseEnvelope(
      buildEnvelope({
        fromAddress: playerIdentity.displayAddress,
        fromPrivateKey: playerIdentity.toBitcorePrivateKey(),
        toAddress: dealerIdentity.displayAddress,
        toPubKey: dealerIdentity.compressedPubKey,
        plaintext: serializeMessageItems([rawMove]),
        networkTag: 'TEST',
      }),
    )!
    const decrypted = tryDecryptEnvelope({
      envelope,
      myPrivateKey: dealerIdentity.toBitcorePrivateKey(),
      senderPubKey: playerIdentity.compressedPubKey,
    })
    expect(decrypted).toBeDefined()
    const replayed = deserializeMessageItems(decrypted!)[0] as BlackjackMoveItem
    const plugin = getMessageItemPlugin('blackjack-move')!
    const provider = {
      getTransaction: jest.fn(async () => ({
        from: playerIdentity.displayAddress,
        to: dealerIdentity.displayAddress,
        value: 100n,
      })),
      getTransactionReceipt: jest.fn(async () => ({ status: 1 })),
      getBalance: jest.fn(async () => 10n ** 30n),
    }
    const moveHydrated = await hydrateMoveWithValidatedGameId(
      replayed,
      (validated) =>
        plugin.hydrate(validated, {
          message: { senderAddress: envelope.from } as never,
          index: 0,
          provider: provider as never,
        }) as Promise<HydratedBlackjackMove>,
    )

    await handleMove({
      action: 'bet',
      hydrated: moveHydrated,
      senderAddress: envelope.from,
      senderPubKey: playerIdentity.compressedPubKey,
      minWagerWei: 10n,
      state,
      identity: dealerIdentity,
      networkTag: 'TEST',
      stampValueWei: 1n,
      stampClient: {} as never,
      pool: {} as never,
      mainAccountSigner: mainAccountSigner as never,
      provider: provider as never,
    })

    expect(state.getGame('envelope-game')?.playerAddress).toBe(
      playerIdentity.displayAddress,
    )
    expect(provider.getTransaction).toHaveBeenCalledWith(WAGER_HASH)
  })

  it.each([
    ['object', {}],
    ['empty', ''],
    ['oversized', 'x'.repeat(MAX_BLACKJACK_GAME_ID_BYTES + 1)],
    ['lone high surrogate', '\ud800'],
    ['lone low surrogate', '\udc00'],
  ])(
    'rejects a %s gameId before wager hydration',
    async (_label, invalidGameId) => {
      const hydrate = jest.fn()
      await expect(
        hydrateMoveWithValidatedGameId(
          {
            type: 'blackjack-move',
            gameId: invalidGameId,
            action: 'bet',
            wagerTxHash: WAGER_HASH,
          } as never,
          hydrate,
        ),
      ).rejects.toThrow('gameId')
      expect(hydrate).not.toHaveBeenCalled()
      expect(state.getPendingCommitment()?.serverSeed).toBe('initial-seed')
    },
  )

  it('rejects replaying one wager under a different game and player', async () => {
    await bet()
    const pendingAfterFirstBet = state.getPendingCommitment()
    jest.clearAllMocks()

    await move(
      'bet',
      hydrated('bet', {
        gameId: 'game-b',
        senderAddress: ATTACKER,
        wagerTxHash: WAGER_HASH.toLowerCase(),
        verifiedWager: {
          fromAddress: ATTACKER,
          toAddress: DEALER,
          valueWei: 500n,
        },
      }),
      ATTACKER,
    )

    expect(state.getGame('game-b')).toBeUndefined()
    expect(state.getPendingCommitment()).toEqual(pendingAfterFirstBet)
    expect(sendDirectMessageItems).not.toHaveBeenCalled()
    expect(mainAccountSigner.submit).not.toHaveBeenCalled()
    expect(sendDirectMessageText).toHaveBeenCalledTimes(1)
  })

  it.each(['hit', 'stand'] as const)(
    'rejects a non-owner %s without changing game or payout state',
    async (action) => {
      await bet()
      const before = state.getGame('game-a')
      jest.clearAllMocks()

      await move(action, hydrated(action), ATTACKER)

      expect(state.getGame('game-a')).toEqual(before)
      expect(sendDirectMessageItems).not.toHaveBeenCalled()
      expect(mainAccountSigner.submit).not.toHaveBeenCalled()
      expect(sendDirectMessageText).toHaveBeenCalledTimes(1)
    },
  )

  it('keeps legacy authority inert across restart for hit, stand, and payout', async () => {
    const wagerTxHash = WAGER_HASH.toLowerCase()
    await state.Close()
    const raw = level(join(directory, 'blackjack-bot-state'))
    await raw.batch([
      {
        type: 'put',
        key: 'game:game-a',
        value: JSON.stringify({
          authority: 'legacy-unverified',
          serverSeed: 'initial-seed',
          serverSeedHash: sha256Hex('initial-seed'),
          wagerTxHash,
          wagerWei: '100',
          playerAddress: getAddress(PLAYER),
          dealtCount: 4,
          revealed: false,
        }),
      },
      {
        type: 'put',
        key: `wager-claim:${wagerTxHash}`,
        value: JSON.stringify({ gameId: 'game-a' }),
      },
    ])
    await raw.close()

    state = new BlackjackBotStateStore(directory)
    await state.Open()
    expect(state.getGame('game-a')).toMatchObject({
      authority: 'legacy-unverified',
      revealed: true,
    })
    await state.Close()
    state = new BlackjackBotStateStore(directory)
    await state.Open()
    const before = state.getGame('game-a')
    jest.clearAllMocks()

    await move('hit', hydrated('hit'))
    await move('stand', hydrated('stand'))

    expect(state.getGame('game-a')).toEqual(before)
    expect(sendDirectMessageItems).not.toHaveBeenCalled()
    expect(mainAccountSigner.buildAndSignTransfer).not.toHaveBeenCalled()
    expect(mainAccountSigner.submit).not.toHaveBeenCalled()
    expect(sendDirectMessageText).toHaveBeenCalledTimes(2)
  })

  it('rejects even an impossible active legacy record before hit or stand', async () => {
    const impossibleLegacyRecord = {
      authority: 'legacy-unverified' as const,
      serverSeed: 'initial-seed',
      serverSeedHash: sha256Hex('initial-seed'),
      wagerTxHash: WAGER_HASH.toLowerCase(),
      wagerWei: 100n,
      playerAddress: getAddress(PLAYER),
      dealtCount: 4,
      revealed: false,
    }
    jest.spyOn(state, 'getGame').mockReturnValue(impossibleLegacyRecord)
    const setGame = jest.spyOn(state, 'setGame')

    await move('hit', hydrated('hit'))
    await move('stand', hydrated('stand'))

    expect(setGame).not.toHaveBeenCalled()
    expect(sendDirectMessageItems).not.toHaveBeenCalled()
    expect(mainAccountSigner.buildAndSignTransfer).not.toHaveBeenCalled()
    expect(mainAccountSigner.submit).not.toHaveBeenCalled()
    expect(sendDirectMessageText).toHaveBeenCalledTimes(2)
  })

  it.each(['deal', 'reveal'] as const)(
    'rejects the bot-only %s action from a client without state mutation',
    async (action) => {
      await bet()
      const before = state.getGame('game-a')
      jest.clearAllMocks()

      await move(action, hydrated(action))

      expect(state.getGame('game-a')).toEqual(before)
      expect(sendDirectMessageItems).not.toHaveBeenCalled()
      expect(mainAccountSigner.submit).not.toHaveBeenCalled()
      expect(sendDirectMessageText).toHaveBeenCalledTimes(1)
    },
  )

  it('normalizes authority once and deals from the pre-wager commitment', async () => {
    await bet({
      wagerTxHash: `0x${WAGER_HASH.slice(2).toUpperCase()}`,
      verifiedWager: {
        fromAddress: getAddress(PLAYER),
        toAddress: getAddress(DEALER),
        valueWei: 100n,
      },
    })

    const record = state.getGame('game-a')
    expect(record).toMatchObject({
      playerAddress: getAddress(PLAYER),
      wagerTxHash: WAGER_HASH.toLowerCase(),
      serverSeed: 'initial-seed',
      serverSeedHash: sha256Hex('initial-seed'),
      wagerWei: 100n,
    })
    const expectedInitial = dealInitialCards(
      deriveDeck('initial-seed', WAGER_HASH.toLowerCase(), 0),
    )
    expect(sendDirectMessageItems).toHaveBeenCalledWith(
      expect.objectContaining({
        toAddress: getAddress(PLAYER),
        items: [
          expect.objectContaining({
            action: 'deal',
            playerCards: expectedInitial.playerCards,
            dealerUpCard: expectedInitial.dealerCards[0],
            serverSeedHash: sha256Hex('initial-seed'),
          }),
        ],
      }),
    )
    expect(state.getPendingCommitment()?.serverSeed).not.toBe('initial-seed')
  })

  it('pays only the persisted original authority and wager amount', async () => {
    let winningSeed = ''
    for (let i = 0; i < 1000; i++) {
      const candidate = `winning-seed-${i}`
      const deck = deriveDeck(candidate, WAGER_HASH.toLowerCase(), 0)
      const initial = dealInitialCards(deck)
      let dealerCards = initial.dealerCards
      let dealtCount = 4
      while (handValue(dealerCards).total < 17) {
        dealerCards = [...dealerCards, deck[dealtCount++]]
      }
      const outcome = resolveOutcome(
        handValue(initial.playerCards),
        handValue(dealerCards),
      )
      if (outcome === 'player_win') {
        winningSeed = candidate
        break
      }
    }
    expect(winningSeed).not.toBe('')
    await state.setPendingCommitment(winningSeed, sha256Hex(winningSeed))
    await bet()
    await state.Close()
    state = new BlackjackBotStateStore(directory)
    await state.Open()
    jest.clearAllMocks()

    await move('stand', hydrated('stand'), `0x${PLAYER.slice(2).toUpperCase()}`)

    expect(mainAccountSigner.buildAndSignTransfer).toHaveBeenCalledWith(
      getAddress(PLAYER),
      200n,
    )
    expect(mainAccountSigner.submit).toHaveBeenCalledWith('signed-payout')
    expect(sendDirectMessageItems).toHaveBeenCalledWith(
      expect.objectContaining({ toAddress: getAddress(PLAYER) }),
    )
  })

  // ---- seed search helpers ---------------------------------------------------------------
  type Sim = { playerCards: number[]; outcome?: string; bust: boolean }
  function findSeed(
    prefix: string,
    predicate: (deck: number[]) => boolean,
  ): string {
    for (let i = 0; i < 5000; i++) {
      const candidate = `${prefix}-${i}`
      if (predicate(deriveDeck(candidate, WAGER_HASH.toLowerCase(), 0))) return candidate
    }
    throw new Error('no seed found')
  }
  function simulateDouble(deck: number[]): Sim {
    const initial = dealInitialCards(deck)
    const playerCards = [...initial.playerCards, deck[4]]
    const pv = handValue(playerCards)
    if (pv.bust) return { playerCards, bust: true, outcome: 'dealer_win' }
    let dealerCards = initial.dealerCards
    let n = 5
    while (handValue(dealerCards).total < 17) dealerCards = [...dealerCards, deck[n++]]
    return { playerCards, bust: false, outcome: resolveOutcome(pv, handValue(dealerCards)) }
  }
  const notNatural = (deck: number[]) =>
    !handValue(dealInitialCards(deck).playerCards).blackjack
  async function seedAndBet(seed: string) {
    await state.setPendingCommitment(seed, sha256Hex(seed))
    await bet()
    jest.clearAllMocks()
  }
  const validDouble = (overrides: Partial<HydratedBlackjackMove> = {}) =>
    hydrated('double', {
      doubleWagerTxHash: DOUBLE_HASH,
      verifiedDoubleWager: { fromAddress: PLAYER, toAddress: DEALER, valueWei: 100n },
      ...overrides,
    })

  // ---- double: rejection cases (each also refunds the verified transfer once) -------------
  it('rejects a double whose second wager does not match, and refunds that transfer', async () => {
    await bet()
    const before = state.getGame('game-a')
    jest.clearAllMocks()

    await move(
      'double',
      validDouble({
        verifiedDoubleWager: { fromAddress: PLAYER, toAddress: DEALER, valueWei: 50n },
      }),
    )

    expect(state.getGame('game-a')).toEqual(before)
    expect(sendDirectMessageItems).not.toHaveBeenCalled()
    expect(mainAccountSigner.buildAndSignTransfer).toHaveBeenCalledTimes(1)
    expect(mainAccountSigner.buildAndSignTransfer).toHaveBeenCalledWith(getAddress(PLAYER), 50n)
    expect(sendDirectMessageText).toHaveBeenCalledTimes(1)
  })

  it('rejects a double after a NON-busting hit (dealtCount guard) and refunds it', async () => {
    // A seed whose first hit does not bust, so only the dealtCount check can reject the double.
    const seed = findSeed(
      'hit-seed',
      (deck) => notNatural(deck) && !handValue([...dealInitialCards(deck).playerCards, deck[4]]).bust,
    )
    await seedAndBet(seed)
    await move('hit', hydrated('hit'))
    const afterHit = state.getGame('game-a')
    expect(afterHit).toMatchObject({ dealtCount: 5, revealed: false, doubled: false })
    jest.clearAllMocks()
    // The handler must reject on its own; the store's guard is only defense in depth.
    const claimSpy = jest.spyOn(state, 'claimDoubleWagerAndUpdateGame')

    await move('double', validDouble())
    expect(claimSpy).not.toHaveBeenCalled()

    expect(state.getGame('game-a')).toEqual(afterHit)
    expect(state.getGame('game-a')?.doubled).toBe(false)
    expect(sendDirectMessageItems).not.toHaveBeenCalled()
    expect(mainAccountSigner.buildAndSignTransfer).toHaveBeenCalledTimes(1)
    expect(state.getRefund(DOUBLE_HASH)?.status).toBe('sent')
  })

  it('rejects a second double-down on an already-doubled hand (doubled guard)', async () => {
    // Force a doubled-but-unresolved record (crash between accepting and revealing).
    await bet()
    const rec = state.getGame('game-a')!
    await state.claimDoubleWagerAndUpdateGame({
      gameId: 'game-a',
      doubleWagerTxHash: DOUBLE_HASH,
      record: { ...rec, dealtCount: 5, doubled: true, doubleWagerWei: 100n },
    })
    const before = state.getGame('game-a')
    jest.clearAllMocks()
    const claimSpy = jest.spyOn(state, 'claimDoubleWagerAndUpdateGame')
    // The `doubled` check runs before the dealtCount check, so pin it by message.
    await move('double', validDouble({ doubleWagerTxHash: OTHER_HASH }))
    expect(claimSpy).not.toHaveBeenCalled()
    expect(sendDirectMessageText).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('already been doubled') }),
    )
    expect(state.getGame('game-a')).toEqual(before)
    expect(sendDirectMessageItems).not.toHaveBeenCalled()
    expect(state.getRefund(OTHER_HASH)?.status).toBe('sent')
  })

  it('rejects a double from the wrong sender and does not refund it to a third party', async () => {
    await bet()
    const before = state.getGame('game-a')
    jest.clearAllMocks()
    await move(
      'double',
      validDouble({
        verifiedDoubleWager: { fromAddress: ATTACKER, toAddress: DEALER, valueWei: 100n },
      }),
    )
    expect(state.getGame('game-a')).toEqual(before)
    expect(mainAccountSigner.buildAndSignTransfer).not.toHaveBeenCalled()
    expect(sendDirectMessageText).toHaveBeenCalledTimes(1)
    expect(state.getRefund(DOUBLE_HASH)).toBeUndefined()
  })

  it('rejects a double whose transfer paid someone other than the dealer (no refund)', async () => {
    await bet()
    const before = state.getGame('game-a')
    jest.clearAllMocks()
    await move(
      'double',
      validDouble({
        verifiedDoubleWager: { fromAddress: PLAYER, toAddress: ATTACKER, valueWei: 100n },
      }),
    )
    expect(state.getGame('game-a')).toEqual(before)
    expect(mainAccountSigner.buildAndSignTransfer).not.toHaveBeenCalled()
    expect(sendDirectMessageText).toHaveBeenCalledTimes(1)
  })

  it('rejects an unverified double transfer (no claim, no refund)', async () => {
    await bet()
    const before = state.getGame('game-a')
    jest.clearAllMocks()
    await move('double', validDouble({ verifiedDoubleWager: undefined }))
    expect(sendDirectMessageText).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('could not verify') }),
    )
    expect(state.getGame('game-a')).toEqual(before)
    expect(mainAccountSigner.buildAndSignTransfer).not.toHaveBeenCalled()
    expect(sendDirectMessageItems).not.toHaveBeenCalled()
    expect(sendDirectMessageText).toHaveBeenCalledTimes(1)
    expect(state.getRefund(DOUBLE_HASH)).toBeUndefined()
  })

  // ---- double: claim keyspace (blocking economic defect) ------------------------------------
  it('rejects a double that reuses the game\'s OWN wager hash and never refunds it', async () => {
    await bet()
    const before = state.getGame('game-a')
    jest.clearAllMocks()
    const claimSpy = jest.spyOn(state, 'claimDoubleWagerAndUpdateGame')
    await move('double', validDouble({ doubleWagerTxHash: WAGER_HASH }))
    expect(claimSpy).not.toHaveBeenCalled()
    expect(state.getGame('game-a')).toEqual(before)
    expect(before?.doubled).toBe(false)
    expect(sendDirectMessageItems).not.toHaveBeenCalled()
    expect(mainAccountSigner.buildAndSignTransfer).not.toHaveBeenCalled()
    expect(sendDirectMessageText).toHaveBeenCalledTimes(1)
  })

  it('claims a genuinely new double transfer, so a second game cannot reuse it', async () => {
    const seed = findSeed('claim-seed', notNatural)
    await seedAndBet(seed)
    await move('double', validDouble())
    expect(state.getGame('game-a')).toMatchObject({ doubled: true, revealed: true })

    // Second game with its own stake tries to reuse the first game's double transfer.
    let seed2 = ''
    for (let i = 0; i < 5000 && !seed2; i++) {
      const c = `second-seed-${i}`
      if (notNatural(deriveDeck(c, OTHER_HASH.toLowerCase(), 0))) seed2 = c
    }
    await state.setPendingCommitment(seed2, sha256Hex(seed2))
    await move(
      'bet',
      hydrated('bet', {
        gameId: 'game-b',
        wagerTxHash: OTHER_HASH,
        verifiedWager: { fromAddress: PLAYER, toAddress: DEALER, valueWei: 100n },
      }),
    )
    expect(state.getGame('game-b')).toMatchObject({ revealed: false, doubled: false })
    jest.clearAllMocks()
    await move('double', validDouble({ gameId: 'game-b' }))
    expect(state.getGame('game-b')?.doubled).toBe(false)
    expect(sendDirectMessageItems).not.toHaveBeenCalled()
    expect(mainAccountSigner.buildAndSignTransfer).not.toHaveBeenCalled()
  })

  it('cannot reuse a double transfer hash as a later bet wager', async () => {
    const seed = findSeed('claim-seed2', notNatural)
    await seedAndBet(seed)
    await move('double', validDouble())
    jest.clearAllMocks()
    await state.setPendingCommitment('third-seed', sha256Hex('third-seed'))
    await move(
      'bet',
      hydrated('bet', {
        gameId: 'game-c',
        wagerTxHash: DOUBLE_HASH,
        verifiedWager: { fromAddress: PLAYER, toAddress: DEALER, valueWei: 100n },
      }),
    )
    expect(state.getGame('game-c')).toBeUndefined()
    expect(mainAccountSigner.buildAndSignTransfer).not.toHaveBeenCalled()
  })

  it('refuses to reuse the same double hash after a restart', async () => {
    const seed = findSeed('claim-seed3', notNatural)
    await seedAndBet(seed)
    await move('double', validDouble())
    await state.Close()
    state = new BlackjackBotStateStore(directory)
    await state.Open()
    await state.setPendingCommitment('another', sha256Hex('another'))
    jest.clearAllMocks()
    await move(
      'bet',
      hydrated('bet', {
        gameId: 'game-d',
        wagerTxHash: DOUBLE_HASH,
        verifiedWager: { fromAddress: PLAYER, toAddress: DEALER, valueWei: 100n },
      }),
    )
    expect(state.getGame('game-d')).toBeUndefined()
  })

  // ---- double: settlement -------------------------------------------------------------------
  async function settleDouble(prefix: string, want: (sim: Sim) => boolean) {
    const seed = findSeed(prefix, (deck) => notNatural(deck) && want(simulateDouble(deck)))
    await seedAndBet(seed)
    await move('double', validDouble())
    expect(state.getGame('game-a')).toMatchObject({
      doubled: true,
      doubleWagerWei: 100n,
      revealed: true,
    })
    expect(state.getGame('game-a')!.dealtCount).toBeGreaterThanOrEqual(5)
  }

  it('doubled win pays 2x the combined stake', async () => {
    await settleDouble('dwin', (s) => s.outcome === 'player_win')
    expect(mainAccountSigner.buildAndSignTransfer).toHaveBeenCalledWith(getAddress(PLAYER), 400n)
    expect(mainAccountSigner.submit).toHaveBeenCalledWith('signed-payout')
    expect(sendDirectMessageItems).toHaveBeenCalledWith(
      expect.objectContaining({ items: [expect.objectContaining({ action: 'double' })] }),
    )
  })

  it('doubled loss pays nothing', async () => {
    await settleDouble('dloss', (s) => !s.bust && s.outcome === 'dealer_win')
    expect(mainAccountSigner.buildAndSignTransfer).not.toHaveBeenCalled()
    expect(sendDirectMessageItems).toHaveBeenCalledWith(
      expect.objectContaining({ items: [expect.objectContaining({ outcome: 'dealer_win' })] }),
    )
  })

  it('doubled push returns the combined stake', async () => {
    await settleDouble('dpush', (s) => s.outcome === 'push')
    expect(mainAccountSigner.buildAndSignTransfer).toHaveBeenCalledWith(getAddress(PLAYER), 200n)
  })

  it('doubled bust pays nothing and still reveals', async () => {
    await settleDouble('dbust', (s) => s.bust)
    expect(mainAccountSigner.buildAndSignTransfer).not.toHaveBeenCalled()
    expect(sendDirectMessageItems).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [expect.objectContaining({ action: 'reveal', outcome: 'dealer_win' })],
      }),
    )
  })

  // ---- hit/stand on a doubled record --------------------------------------------------------
  async function crashedDoubledGame() {
    const seed = findSeed('crash', notNatural)
    await seedAndBet(seed)
    const rec = state.getGame('game-a')!
    await state.claimDoubleWagerAndUpdateGame({
      gameId: 'game-a',
      doubleWagerTxHash: DOUBLE_HASH,
      record: { ...rec, dealtCount: 5, doubled: true, doubleWagerWei: 100n },
    })
    jest.clearAllMocks()
    return state.getGame('game-a')
  }

  it('rejects hit on a doubled, unresolved hand', async () => {
    const before = await crashedDoubledGame()
    await move('hit', hydrated('hit'))
    expect(state.getGame('game-a')).toEqual(before)
    expect(sendDirectMessageItems).not.toHaveBeenCalled()
    expect(sendDirectMessageText).toHaveBeenCalledTimes(1)
  })

  it('resolves (only) a doubled, unresolved hand on stand, on the combined stake', async () => {
    await crashedDoubledGame()
    await move('stand', hydrated('stand'))
    expect(state.getGame('game-a')).toMatchObject({ doubled: true, revealed: true })
    expect(sendDirectMessageItems).toHaveBeenCalledWith(
      expect.objectContaining({ items: [expect.objectContaining({ action: 'reveal' })] }),
    )
  })

  // ---- bet: limits, refunds, bankroll -------------------------------------------------------
  it('refunds a below-minimum bet exactly once and never creates a game', async () => {
    const wager = { fromAddress: PLAYER, toAddress: DEALER, valueWei: 5n }
    await bet({ verifiedWager: wager })
    expect(state.getGame('game-a')).toBeUndefined()
    expect(mainAccountSigner.buildAndSignTransfer).toHaveBeenCalledTimes(1)
    expect(mainAccountSigner.buildAndSignTransfer).toHaveBeenCalledWith(getAddress(PLAYER), 5n)
    expect(mainAccountSigner.submit).toHaveBeenCalledTimes(1)

    // Replaying the same rejected bet (even under a new gameId) never refunds again.
    await bet({ verifiedWager: wager })
    await bet({ gameId: 'game-z', verifiedWager: wager })
    expect(mainAccountSigner.buildAndSignTransfer).toHaveBeenCalledTimes(1)
    expect(mainAccountSigner.submit).toHaveBeenCalledTimes(1)
  })

  it('a refunded hash can never later back a game', async () => {
    await bet({ verifiedWager: { fromAddress: PLAYER, toAddress: DEALER, valueWei: 5n } })
    // Same hash, now claiming a valid amount (would be a free stake after the refund).
    await bet({ verifiedWager: { fromAddress: PLAYER, toAddress: DEALER, valueWei: 100n } })
    expect(state.getGame('game-a')).toBeUndefined()
    expect(mainAccountSigner.submit).toHaveBeenCalledTimes(1)
  })

  it('refuses an above-maximum bet and refunds it', async () => {
    await bet({ verifiedWager: { fromAddress: PLAYER, toAddress: DEALER, valueWei: 1001n } })
    expect(state.getGame('game-a')).toBeUndefined()
    expect(mainAccountSigner.buildAndSignTransfer).toHaveBeenCalledWith(getAddress(PLAYER), 1001n)
  })

  it('does not refund a transfer that was not from the authenticated player', async () => {
    await bet({ verifiedWager: { fromAddress: ATTACKER, toAddress: DEALER, valueWei: 5n } })
    expect(mainAccountSigner.buildAndSignTransfer).not.toHaveBeenCalled()
  })

  it('leaves a pending refund (no crash, no double refund) when the bankroll cannot sign', async () => {
    mainAccountSigner.buildAndSignTransfer.mockRejectedValueOnce(new Error('insufficient funds'))
    await bet({ verifiedWager: { fromAddress: PLAYER, toAddress: DEALER, valueWei: 5n } })
    expect(state.getRefund(WAGER_HASH)).toMatchObject({ status: 'pending', amountWei: 5n })
    expect(mainAccountSigner.submit).not.toHaveBeenCalled()

    // Survives restart, and the retry pays exactly once.
    await state.Close()
    state = new BlackjackBotStateStore(directory)
    await state.Open()
    expect(state.getPendingRefunds()).toHaveLength(1)
    await retryPendingRefunds(state, mainAccountSigner as never)
    await retryPendingRefunds(state, mainAccountSigner as never)
    expect(mainAccountSigner.submit).toHaveBeenCalledTimes(1)
    expect(state.getRefund(WAGER_HASH)?.status).toBe('sent')
  })

  it('never retries a refund whose broadcast may have happened', async () => {
    mainAccountSigner.submit.mockRejectedValueOnce(new Error('rpc timeout'))
    await bet({ verifiedWager: { fromAddress: PLAYER, toAddress: DEALER, valueWei: 5n } })
    expect(state.getRefund(WAGER_HASH)?.status).toBe('submitting')
    await retryPendingRefunds(state, mainAccountSigner as never)
    expect(mainAccountSigner.submit).toHaveBeenCalledTimes(1)
  })

  it('refuses a bet the bankroll cannot cover and refunds the stake', async () => {
    getBalance.mockResolvedValue(249n) // worst case for 100 wei is 250
    await bet()
    expect(state.getGame('game-a')).toBeUndefined()
    expect(mainAccountSigner.buildAndSignTransfer).toHaveBeenCalledWith(getAddress(PLAYER), 100n)
    expect(sendDirectMessageItems).not.toHaveBeenCalled()
  })

  it('accepts a bet exactly at the bankroll limit, counting open games', async () => {
    getBalance.mockResolvedValue(250n)
    await bet()
    expect(state.getGame('game-a')).toBeDefined()
  })

  it('refuses a double the bankroll cannot cover and refunds the double transfer', async () => {
    const seed = findSeed('bank', notNatural)
    await seedAndBet(seed)
    getBalance.mockResolvedValue(399n) // doubled worst case is 400
    const before = state.getGame('game-a')
    await move('double', validDouble())
    expect(state.getGame('game-a')).toEqual(before)
    expect(mainAccountSigner.buildAndSignTransfer).toHaveBeenCalledWith(getAddress(PLAYER), 100n)
    expect(state.getRefund(DOUBLE_HASH)?.status).toBe('sent')
  })
})
