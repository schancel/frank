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

describe('blackjack move authorization', () => {
  let directory: string
  let state: BlackjackBotStateStore
  let mainAccountSigner: {
    buildAndSignTransfer: jest.Mock
    submit: jest.Mock
  }

  beforeEach(async () => {
    jest.clearAllMocks()
    directory = mkdtempSync(join(tmpdir(), 'blackjack-handler-'))
    state = new BlackjackBotStateStore(directory)
    await state.Open()
    await state.setPendingCommitment('initial-seed', sha256Hex('initial-seed'))
    mainAccountSigner = {
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
      state,
      identity: { displayAddress: DEALER } as never,
      networkTag: 'TEST',
      stampValueWei: 1n,
      stampClient: {} as never,
      pool: {} as never,
      mainAccountSigner: mainAccountSigner as never,
      provider: {} as never,
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
})
