import {
  createMessageItemRegistry,
  pluginCapabilitiesNotYetAvailable,
} from '../registry'
import {
  accepterShuffleAndLockDeck,
  ALL_SHOWDOWN_INDICES,
  challengerEncryptInitialDeck,
  challengerStripAndLockDeck,
  compareHandRanks,
  DECK_SIZE,
  decodeMentalPokerPayload,
  decryptLockedCard,
  deriveMentalPokerSecrets,
  encodeMentalPokerPayload,
  evaluateBest7CardHand,
  FLOP_CARD_INDICES,
  foldMentalPokerState,
  FULL_DECK,
  getCardBasePoint,
  initMentalPokerPlugin,
  MENTAL_POKER_PLUGIN_ID,
  mentalPokerPlugin,
  RIVER_CARD_INDICES,
  toMentalPokerApplicationItem,
  TURN_CARD_INDICES,
  verifyLockedCardKey,
  type MentalPokerPayload,
} from './index'

const ALICE_PRIV_KEY =
  '0x1111111111111111111111111111111111111111111111111111111111111111'
const BOB_PRIV_KEY =
  '0x2222222222222222222222222222222222222222222222222222222222222222'
const HAND_ID = 'hand-test-mental-poker-001'

describe('mental-poker-v1 commutative cryptography & state machine (#62)', () => {
  it('deterministically derives shuffle scalar, 52 lock scalars, and a valid 52-card permutation via HKDF-SHA256', () => {
    const secretsA1 = deriveMentalPokerSecrets(ALICE_PRIV_KEY, HAND_ID, 'challenger')
    const secretsA2 = deriveMentalPokerSecrets(ALICE_PRIV_KEY, HAND_ID, 'challenger')
    const secretsB = deriveMentalPokerSecrets(BOB_PRIV_KEY, HAND_ID, 'accepter')

    expect(secretsA1).toEqual(secretsA2)
    expect(secretsA1.shuffleScalar).not.toBe(secretsB.shuffleScalar)
    expect(secretsA1.lockScalars).toHaveLength(DECK_SIZE)
    expect(secretsB.lockScalars).toHaveLength(DECK_SIZE)
    expect([...secretsA1.permutation].sort((a, b) => a - b)).toEqual([...FULL_DECK])
    expect([...secretsB.permutation].sort((a, b) => a - b)).toEqual([...FULL_DECK])
  })

  it('performs 2-party commutative SRA shuffle, lock, and deal over secp256k1', () => {
    const secretsA = deriveMentalPokerSecrets(ALICE_PRIV_KEY, HAND_ID, 'challenger')
    const secretsB = deriveMentalPokerSecrets(BOB_PRIV_KEY, HAND_ID, 'accepter')

    const deckX = challengerEncryptInitialDeck(secretsA)
    expect(deckX).toHaveLength(DECK_SIZE)

    const deckY = accepterShuffleAndLockDeck(deckX, secretsB)
    expect(deckY).toHaveLength(DECK_SIZE)

    const deckZ = challengerStripAndLockDeck(deckY, secretsA)
    expect(deckZ).toHaveLength(DECK_SIZE)

    // Unlock all 52 cards and verify they form an exact permutation of FULL_DECK (0..51)
    const decryptedDeck: number[] = []
    for (let i = 0; i < DECK_SIZE; i += 1) {
      const card = decryptLockedCard(
        deckZ[i],
        secretsA.lockScalars[i],
        secretsB.lockScalars[i],
      )
      expect(card).not.toBeNull()
      expect(
        verifyLockedCardKey(
          deckZ[i],
          secretsA.lockScalars[i],
          secretsB.lockScalars[i],
          card!,
        ),
      ).toBe(true)
      decryptedDeck.push(card!)
    }

    expect([...decryptedDeck].sort((a, b) => a - b)).toEqual([...FULL_DECK])
  })

  it('preserves private hole card secrecy before showdown: Alice decrypts 0,1 only and Bob decrypts 2,3 only', () => {
    const secretsA = deriveMentalPokerSecrets(ALICE_PRIV_KEY, HAND_ID, 'challenger')
    const secretsB = deriveMentalPokerSecrets(BOB_PRIV_KEY, HAND_ID, 'accepter')

    const deckX = challengerEncryptInitialDeck(secretsA)
    const deckY = accepterShuffleAndLockDeck(deckX, secretsB)
    const deckZ = challengerStripAndLockDeck(deckY, secretsA)

    const messages: MentalPokerPayload[] = [
      {
        handId: HAND_ID,
        action: 'challenge',
        stakeWei: '1000000000000000',
        deckX,
      },
      {
        handId: HAND_ID,
        action: 'shuffle_and_lock',
        deckY,
      },
      {
        handId: HAND_ID,
        action: 'lock_and_deal',
        deckZ,
        revealedKeysA: {
          2: secretsA.lockScalars[2],
          3: secretsA.lockScalars[3],
        },
      },
      {
        handId: HAND_ID,
        action: 'unlock_hole_cards',
        revealedKeysB: {
          0: secretsB.lockScalars[0],
          1: secretsB.lockScalars[1],
        },
      },
    ]

    const aliceView = foldMentalPokerState(messages, 'challenger', secretsA)
    const bobView = foldMentalPokerState(messages, 'accepter', secretsB)

    // Both views are on preflop with verified deck and no cheating
    expect(aliceView.street).toBe('preflop')
    expect(bobView.street).toBe('preflop')
    expect(aliceView.deckVerified).toBe(true)
    expect(bobView.deckVerified).toBe(true)
    expect(aliceView.cheatingDetected).toBe(false)
    expect(bobView.cheatingDetected).toBe(false)

    // Alice knows her own hole cards (indices 0, 1) and CANNOT know Bob's hole cards (2, 3)
    expect(aliceView.viewerHoleCards).toHaveLength(2)
    expect(aliceView.viewerHoleCards).toEqual([
      decryptLockedCard(deckZ[0], secretsA.lockScalars[0], secretsB.lockScalars[0]),
      decryptLockedCard(deckZ[1], secretsA.lockScalars[1], secretsB.lockScalars[1]),
    ])
    expect(aliceView.opponentHoleCards).toEqual([])
    expect(aliceView.decryptedByIndex[2]).toBeUndefined()
    expect(aliceView.decryptedByIndex[3]).toBeUndefined()

    // Bob knows his own hole cards (indices 2, 3) and CANNOT know Alice's hole cards (0, 1)
    expect(bobView.viewerHoleCards).toHaveLength(2)
    expect(bobView.viewerHoleCards).toEqual([
      decryptLockedCard(deckZ[2], secretsA.lockScalars[2], secretsB.lockScalars[2]),
      decryptLockedCard(deckZ[3], secretsA.lockScalars[3], secretsB.lockScalars[3]),
    ])
    expect(bobView.opponentHoleCards).toEqual([])
    expect(bobView.decryptedByIndex[0]).toBeUndefined()
    expect(bobView.decryptedByIndex[1]).toBeUndefined()

    // Neither player knows any community cards yet
    expect(aliceView.communityCards).toEqual([])
    expect(bobView.communityCards).toEqual([])
  })

  it('progresses through preflop, flop, turn, river, showdown, and settlement with deterministic hand evaluation', () => {
    const secretsA = deriveMentalPokerSecrets(ALICE_PRIV_KEY, HAND_ID, 'challenger')
    const secretsB = deriveMentalPokerSecrets(BOB_PRIV_KEY, HAND_ID, 'accepter')

    const deckX = challengerEncryptInitialDeck(secretsA)
    const deckY = accepterShuffleAndLockDeck(deckX, secretsB)
    const deckZ = challengerStripAndLockDeck(deckY, secretsA)

    const pickKeys = (
      scalars: readonly string[],
      indices: readonly number[],
    ): Record<number, string> => {
      const out: Record<number, string> = {}
      for (const idx of indices) {
        out[idx] = scalars[idx]
      }
      return out
    }

    const messages: MentalPokerPayload[] = [
      {
        handId: HAND_ID,
        action: 'challenge',
        stakeWei: '1000',
        deckX,
      },
      {
        handId: HAND_ID,
        action: 'shuffle_and_lock',
        deckY,
      },
      {
        handId: HAND_ID,
        action: 'lock_and_deal',
        deckZ,
        revealedKeysA: pickKeys(secretsA.lockScalars, [2, 3]),
      },
      {
        handId: HAND_ID,
        action: 'unlock_hole_cards',
        revealedKeysB: pickKeys(secretsB.lockScalars, [0, 1]),
      },
      // Preflop: Alice raises 500, Bob calls 500 + reveals flop keys, Alice reveals flop keys
      {
        handId: HAND_ID,
        action: 'bet_action',
        actor: 'challenger',
        subAction: 'raise',
        amountWei: '500',
      },
      {
        handId: HAND_ID,
        action: 'bet_action',
        actor: 'accepter',
        subAction: 'call',
        amountWei: '500',
        revealedKeys: pickKeys(secretsB.lockScalars, FLOP_CARD_INDICES),
      },
      {
        handId: HAND_ID,
        action: 'bet_action',
        actor: 'challenger',
        revealedKeys: pickKeys(secretsA.lockScalars, FLOP_CARD_INDICES),
      },
    ]

    const afterFlop = foldMentalPokerState(messages, 'challenger', secretsA)
    expect(afterFlop.street).toBe('flop')
    expect(afterFlop.potWei).toBe(3000n)
    expect(afterFlop.communityCards).toHaveLength(3)

    // Flop: check-check + reveal turn (index 7)
    messages.push(
      {
        handId: HAND_ID,
        action: 'bet_action',
        actor: 'challenger',
        subAction: 'check',
      },
      {
        handId: HAND_ID,
        action: 'bet_action',
        actor: 'accepter',
        subAction: 'check',
        revealedKeys: pickKeys(secretsB.lockScalars, TURN_CARD_INDICES),
      },
      {
        handId: HAND_ID,
        action: 'bet_action',
        actor: 'challenger',
        revealedKeys: pickKeys(secretsA.lockScalars, TURN_CARD_INDICES),
      },
    )

    const afterTurn = foldMentalPokerState(messages, 'challenger', secretsA)
    expect(afterTurn.street).toBe('turn')
    expect(afterTurn.communityCards).toHaveLength(4)

    // Turn: check-check + reveal river (index 8)
    messages.push(
      {
        handId: HAND_ID,
        action: 'bet_action',
        actor: 'challenger',
        subAction: 'check',
      },
      {
        handId: HAND_ID,
        action: 'bet_action',
        actor: 'accepter',
        subAction: 'check',
        revealedKeys: pickKeys(secretsB.lockScalars, RIVER_CARD_INDICES),
      },
      {
        handId: HAND_ID,
        action: 'bet_action',
        actor: 'challenger',
        revealedKeys: pickKeys(secretsA.lockScalars, RIVER_CARD_INDICES),
      },
    )

    const afterRiver = foldMentalPokerState(messages, 'challenger', secretsA)
    expect(afterRiver.street).toBe('river')
    expect(afterRiver.communityCards).toHaveLength(5)

    // River: check-check + reveal own hole card keys for showdown
    messages.push(
      {
        handId: HAND_ID,
        action: 'bet_action',
        actor: 'challenger',
        subAction: 'check',
      },
      {
        handId: HAND_ID,
        action: 'bet_action',
        actor: 'accepter',
        subAction: 'check',
        revealedKeys: pickKeys(secretsB.lockScalars, [2, 3]),
      },
      {
        handId: HAND_ID,
        action: 'bet_action',
        actor: 'challenger',
        revealedKeys: pickKeys(secretsA.lockScalars, [0, 1]),
      },
    )

    const showdownAlice = foldMentalPokerState(messages, 'challenger', secretsA)
    const showdownBob = foldMentalPokerState(messages, 'accepter', secretsB)

    expect(showdownAlice.street).toBe('showdown')
    expect(showdownBob.street).toBe('showdown')
    expect(showdownAlice.cheatingDetected).toBe(false)
    expect(showdownAlice.opponentHoleCards).toHaveLength(2)
    expect(showdownBob.opponentHoleCards).toHaveLength(2)
    expect(showdownAlice.viewerHoleCards).toEqual(showdownBob.opponentHoleCards)
    expect(showdownBob.viewerHoleCards).toEqual(showdownAlice.opponentHoleCards)

    const expectedAliceEval = evaluateBest7CardHand([
      ...showdownAlice.challengerHoleCards,
      ...showdownAlice.communityCards,
    ])
    const expectedBobEval = evaluateBest7CardHand([
      ...showdownAlice.accepterHoleCards,
      ...showdownAlice.communityCards,
    ])
    const expectedCmp = compareHandRanks(expectedAliceEval, expectedBobEval)
    const expectedWinner =
      expectedCmp > 0 ? 'challenger' : expectedCmp < 0 ? 'accepter' : 'split'

    expect(showdownAlice.winner).toBe(expectedWinner)
    expect(showdownBob.winner).toBe(expectedWinner)

    // Settle pot
    messages.push({
      handId: HAND_ID,
      action: 'settle',
      actor: expectedWinner === 'challenger' ? 'accepter' : 'challenger',
      amountWei: '3000',
      winnerRole: expectedWinner,
    })

    const settledState = foldMentalPokerState(messages, 'challenger', secretsA)
    expect(settledState.settled).toBe(true)
    expect(settledState.settledAmountWei).toBe(3000n)
    expect(settledState.street).toBe('complete')
  })

  it('detects cheating when a player sends a forged lock scalar that fails to unlock a valid card', () => {
    const secretsA = deriveMentalPokerSecrets(ALICE_PRIV_KEY, HAND_ID, 'challenger')
    const secretsB = deriveMentalPokerSecrets(BOB_PRIV_KEY, HAND_ID, 'accepter')

    const deckX = challengerEncryptInitialDeck(secretsA)
    const deckY = accepterShuffleAndLockDeck(deckX, secretsB)
    const deckZ = challengerStripAndLockDeck(deckY, secretsA)

    const forgedScalar =
      'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'

    const messages: MentalPokerPayload[] = [
      {
        handId: HAND_ID,
        action: 'challenge',
        stakeWei: '1000',
        deckX,
      },
      {
        handId: HAND_ID,
        action: 'shuffle_and_lock',
        deckY,
      },
      {
        handId: HAND_ID,
        action: 'lock_and_deal',
        deckZ,
        revealedKeysA: {
          2: secretsA.lockScalars[2],
          3: secretsA.lockScalars[3],
        },
      },
      {
        handId: HAND_ID,
        action: 'unlock_hole_cards',
        revealedKeysB: {
          0: forgedScalar, // Bob sends a forged scalar for Alice's hole card 0!
          1: secretsB.lockScalars[1],
        },
      },
    ]

    const aliceState = foldMentalPokerState(messages, 'challenger', secretsA)
    expect(aliceState.cheatingDetected).toBe(true)
    expect(aliceState.cheatingReason).toMatch(/Key verification failed at deck index 0/)
  })

  it('round-trips through canonical CBOR codec and MessageItemRegistry', () => {
    const secretsA = deriveMentalPokerSecrets(ALICE_PRIV_KEY, HAND_ID, 'challenger')
    const deckX = challengerEncryptInitialDeck(secretsA)

    const payload: MentalPokerPayload = {
      schemaVersion: 1,
      handId: HAND_ID,
      action: 'challenge',
      actor: 'challenger',
      stakeWei: '2500000000000000',
      deckX,
    }

    const encoded = encodeMentalPokerPayload(payload)
    const decoded = decodeMentalPokerPayload(encoded)
    expect(decoded).toEqual(payload)

    const registry = createMessageItemRegistry()
    initMentalPokerPlugin(
      registry,
      pluginCapabilitiesNotYetAvailable.forPlugin(MENTAL_POKER_PLUGIN_ID),
    )

    const appItem = toMentalPokerApplicationItem(payload)
    expect(registry.previewText(appItem)).toContain('Mental Poker: Heads-Up Challenge')
    const wireEncoded = registry.encodeItem(appItem)
    expect(wireEncoded.type).toBe(MENTAL_POKER_PLUGIN_ID)
    expect(mentalPokerPlugin.decode(wireEncoded.bytes)).toEqual(payload)
    expect(getCardBasePoint(0)).toMatch(/^(02|03)[0-9a-f]{64}$/)
  })
})
