/** @jest-environment jsdom */

import { describe, expect, it, jest } from '@jest/globals'
import { mount } from '@vue/test-utils'
import { cardLabel } from '@frank/wallet/message-item-plugins/blackjack/deck'
import {
  FLOP_CARD_INDICES,
  foldMentalPokerState,
  RIVER_CARD_INDICES,
  TURN_CARD_INDICES,
} from '@frank/wallet/message-item-plugins/mental-poker'

jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
    unit: 'MONT',
    toDisplayAmount: (wei: bigint) => wei.toString(),
  },
}))

import {
  automaticMentalPokerSteps,
  buildMentalPokerAccept,
  buildMentalPokerBetAction,
  buildMentalPokerChallenge,
  buildMentalPokerCheck,
  buildMentalPokerLockAndDeal,
  buildMentalPokerRaise,
  buildMentalPokerUnlockHoleCards,
  type P2pMentalPokerChatMessage,
} from '../../../utils/p2p-mental-poker'
import ChatMessageMentalPoker from './ChatMessageMentalPoker.vue'

const ALICE_KEY =
  '0x1111111111111111111111111111111111111111111111111111111111111111'
const BOB_KEY =
  '0x2222222222222222222222222222222222222222222222222222222222222222'
const HAND_ID = 'mp-ui-test-hand-1'

const quasarStubs = {
  'q-icon': { template: '<i />' },
  'q-badge': { template: '<span><slot /></span>' },
  'q-btn': {
    props: ['label', 'disable'],
    template:
      '<button :disabled="disable" @click="$emit(\'click\')">{{ label }}<slot /></button>',
  },
}

describe('ChatMessageMentalPoker.vue & p2p-mental-poker (#62)', () => {
  it('renders challenge for Accepter with Accept & Shuffle button and emits shuffle_and_lock on click', async () => {
    const challenge = buildMentalPokerChallenge({
      handId: HAND_ID,
      stakeWei: 1000n,
      own: '0xAlice',
      peer: '0xBob',
      privateKeyHex: ALICE_KEY,
    })

    const bobMessages: P2pMentalPokerChatMessage[] = [
      {
        outbound: false,
        status: 'confirmed',
        items: [challenge.item],
        stampValueWei: 1000n,
      },
    ]

    const wrapper = mount(ChatMessageMentalPoker, {
      props: {
        item: challenge.item,
        messages: bobMessages,
        outbound: false,
        ownAddress: '0xBob',
        peerAddress: '0xAlice',
        privateKeyHex: BOB_KEY,
      },
      global: { stubs: quasarStubs },
    })

    expect(wrapper.get('[data-testid="mp-deck-status"]').text()).toContain(
      '52 cards double-locked on secp256k1',
    )
    expect(wrapper.get('[data-testid="mp-opponent-hidden"]').text()).toBe(
      "['??', '??']",
    )

    const acceptBtn = wrapper.get('[data-testid="mp-accept-btn"]')
    expect(acceptBtn.text()).toBe('Accept & Shuffle')

    await acceptBtn.trigger('click')
    const emitted = wrapper.emitted('accept')
    expect(emitted).toBeTruthy()
    const acceptStep = emitted![0][0] as ReturnType<
      typeof buildMentalPokerAccept
    >
    expect(acceptStep.payload.action).toBe('shuffle_and_lock')
    expect(acceptStep.payload.deckY).toHaveLength(52)
  })

  it('auto-advances lock_and_deal and unlock_hole_cards and displays private hole cards with Check/Call/Fold buttons', async () => {
    const challenge = buildMentalPokerChallenge({
      handId: HAND_ID,
      stakeWei: 1000n,
      own: '0xAlice',
      peer: '0xBob',
      privateKeyHex: ALICE_KEY,
    })

    const accept = buildMentalPokerAccept({
      handId: HAND_ID,
      deckX: challenge.payload.deckX!,
      stakeWei: 1000n,
      own: '0xBob',
      peer: '0xAlice',
      privateKeyHex: BOB_KEY,
    })

    // Alice sees challenge (outbound) + accept (inbound) -> auto step should produce lock_and_deal
    const aliceAutoSteps = automaticMentalPokerSteps(
      [
        { outbound: true, status: 'confirmed', items: [challenge.item] },
        { outbound: false, status: 'confirmed', items: [accept.item] },
      ],
      '0xAlice',
      '0xBob',
      ALICE_KEY,
    )
    expect(aliceAutoSteps).toHaveLength(1)
    expect(aliceAutoSteps[0].payload.action).toBe('lock_and_deal')

    const lockAndDeal = buildMentalPokerLockAndDeal({
      handId: HAND_ID,
      deckY: accept.payload.deckY!,
      own: '0xAlice',
      peer: '0xBob',
      privateKeyHex: ALICE_KEY,
    })

    // Bob sees lock_and_deal -> auto step should produce unlock_hole_cards
    const bobAutoSteps = automaticMentalPokerSteps(
      [
        { outbound: false, status: 'confirmed', items: [challenge.item] },
        { outbound: true, status: 'confirmed', items: [accept.item] },
        { outbound: false, status: 'confirmed', items: [lockAndDeal.item] },
      ],
      '0xBob',
      '0xAlice',
      BOB_KEY,
    )
    expect(bobAutoSteps).toHaveLength(1)
    expect(bobAutoSteps[0].payload.action).toBe('unlock_hole_cards')

    const unlockHole = buildMentalPokerUnlockHoleCards({
      handId: HAND_ID,
      own: '0xBob',
      peer: '0xAlice',
      privateKeyHex: BOB_KEY,
    })

    const alicePreflopMessages: P2pMentalPokerChatMessage[] = [
      { outbound: true, status: 'confirmed', items: [challenge.item] },
      { outbound: false, status: 'confirmed', items: [accept.item] },
      { outbound: true, status: 'confirmed', items: [lockAndDeal.item] },
      { outbound: false, status: 'confirmed', items: [unlockHole.item] },
    ]

    const aliceWrapper = mount(ChatMessageMentalPoker, {
      props: {
        item: unlockHole.item,
        messages: alicePreflopMessages,
        outbound: false,
        ownAddress: '0xAlice',
        peerAddress: '0xBob',
        privateKeyHex: ALICE_KEY,
      },
      global: { stubs: quasarStubs },
    })

    expect(aliceWrapper.get('[data-testid="mp-street-badge"]').text()).toBe(
      'Pre-Flop',
    )
    // Alice sees her 2 decrypted hole cards, while Bob's remain hidden
    const aliceState = foldMentalPokerState(
      [
        challenge.payload,
        accept.payload,
        lockAndDeal.payload,
        unlockHole.payload,
      ],
      'challenger',
      challenge.secrets,
    )
    expect(aliceState.viewerHoleCards).toHaveLength(2)
    const aliceCard0 = cardLabel(aliceState.viewerHoleCards[0])
    expect(
      aliceWrapper.get('[data-testid="mp-viewer-hole-section"]').text(),
    ).toContain(aliceCard0)
    expect(aliceWrapper.get('[data-testid="mp-opponent-hidden"]').text()).toBe(
      "['??', '??']",
    )

    // Alice has Check and Fold buttons on her turn
    const checkBtn = aliceWrapper.get('[data-testid="mp-check-btn"]')
    const foldBtn = aliceWrapper.get('[data-testid="mp-fold-btn"]')
    expect(checkBtn.text()).toBe('Check')
    expect(foldBtn.text()).toBe('Fold')

    await checkBtn.trigger('click')
    expect(aliceWrapper.emitted('check')).toBeTruthy()

    // When Alice raises, Bob sees Call and Fold buttons
    const aliceRaise = buildMentalPokerRaise({
      handId: HAND_ID,
      role: 'challenger',
      amountWei: 500n,
      own: '0xAlice',
      peer: '0xBob',
      privateKeyHex: ALICE_KEY,
    })

    const bobFacingRaiseMessages: P2pMentalPokerChatMessage[] = [
      { outbound: false, status: 'confirmed', items: [challenge.item] },
      { outbound: true, status: 'confirmed', items: [accept.item] },
      { outbound: false, status: 'confirmed', items: [lockAndDeal.item] },
      { outbound: true, status: 'confirmed', items: [unlockHole.item] },
      { outbound: false, status: 'confirmed', items: [aliceRaise.item] },
    ]

    const bobWrapper = mount(ChatMessageMentalPoker, {
      props: {
        item: aliceRaise.item,
        messages: bobFacingRaiseMessages,
        outbound: false,
        ownAddress: '0xBob',
        peerAddress: '0xAlice',
        privateKeyHex: BOB_KEY,
      },
      global: { stubs: quasarStubs },
    })

    const callBtn = bobWrapper.get('[data-testid="mp-call-btn"]')
    expect(callBtn.text()).toContain('Call (500 MONT)')
    await callBtn.trigger('click')
    expect(bobWrapper.emitted('call')).toBeTruthy()
  })

  it('renders showdown verification badge, revealed opponent cards, and Reveal & Pay button', async () => {
    const challenge = buildMentalPokerChallenge({
      handId: HAND_ID,
      stakeWei: 1000n,
      privateKeyHex: ALICE_KEY,
    })
    const accept = buildMentalPokerAccept({
      handId: HAND_ID,
      deckX: challenge.payload.deckX!,
      stakeWei: 1000n,
      privateKeyHex: BOB_KEY,
    })
    const lockAndDeal = buildMentalPokerLockAndDeal({
      handId: HAND_ID,
      deckY: accept.payload.deckY!,
      privateKeyHex: ALICE_KEY,
    })
    const unlockHole = buildMentalPokerUnlockHoleCards({
      handId: HAND_ID,
      privateKeyHex: BOB_KEY,
    })

    const allBoardAndHoleIndices = [
      ...FLOP_CARD_INDICES,
      ...TURN_CARD_INDICES,
      ...RIVER_CARD_INDICES,
      0,
      1,
      2,
      3,
    ]
    const revealA = buildMentalPokerBetAction({
      handId: HAND_ID,
      role: 'challenger',
      revealIndices: allBoardAndHoleIndices,
      privateKeyHex: ALICE_KEY,
    })
    const revealB = buildMentalPokerBetAction({
      handId: HAND_ID,
      role: 'accepter',
      revealIndices: allBoardAndHoleIndices,
      privateKeyHex: BOB_KEY,
    })

    const payloads = [
      challenge.payload,
      accept.payload,
      lockAndDeal.payload,
      unlockHole.payload,
      revealA.payload,
      revealB.payload,
    ]

    const showdownStateAlice = foldMentalPokerState(
      payloads,
      'challenger',
      challenge.secrets,
    )
    const showdownStateBob = foldMentalPokerState(
      payloads,
      'accepter',
      accept.secrets,
    )

    expect(showdownStateAlice.street).toBe('showdown')
    expect(showdownStateAlice.communityCards).toHaveLength(5)
    expect(showdownStateAlice.opponentHoleCards).toHaveLength(2)

    const loserState =
      showdownStateAlice.winner === 'challenger'
        ? showdownStateBob
        : showdownStateAlice

    const wrapper = mount(ChatMessageMentalPoker, {
      props: {
        state: loserState,
        privateKeyHex:
          loserState.viewerRole === 'challenger' ? ALICE_KEY : BOB_KEY,
      },
      global: { stubs: quasarStubs },
    })

    expect(wrapper.get('[data-testid="mp-street-badge"]').text()).toBe(
      'Showdown',
    )
    expect(
      wrapper.get('[data-testid="mp-verification-badge"]').text(),
    ).toContain('Provably Fair • 52 cards double-locked on secp256k1')
    expect(wrapper.find('[data-testid="mp-opponent-hidden"]').exists()).toBe(
      false,
    )

    const settleBtn = wrapper.get('[data-testid="mp-settle-btn"]')
    expect(settleBtn.text()).toBe('Reveal & Pay')
    await settleBtn.trigger('click')
    expect(wrapper.emitted('settle')).toBeTruthy()
  })
})
