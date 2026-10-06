/** @jest-environment jsdom */

import { mount } from '@vue/test-utils'
import * as quasar from 'quasar'
import { defineComponent, h } from 'vue'

import type { ChannelUpdateItem } from '@frank/cashweb/types/messages'
import {
  encodeDiceGamePayload,
  encodePokerGamePayload,
  encodeSwapOfferPayload,
  encodeRafflePayload,
  toHex,
} from '@frank/codec'
import ChatMessageChannel from './ChatMessageChannel.vue'

jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
    unit: 'MON',
    toDisplayAmount: (n: bigint) => (Number(n) / 1e18).toString(),
  },
}))

const quasarStubs: Record<string, any> = Object.fromEntries(
  Object.keys(quasar)
    .filter(n => /^Q[A-Z]/.test(n))
    .map(n => [
      n,
      defineComponent({
        setup:
          (_, { slots }) =>
          () =>
            h('div', slots.default?.()),
      }),
    ]),
)

quasarStubs.QBadge = defineComponent({
  inheritAttrs: false,
  props: { label: null },
  setup:
    (props, { attrs, slots }) =>
    () =>
      h(
        'span',
        attrs,
        props.label ? [props.label as string] : slots.default?.(),
      ),
})

quasarStubs.QIcon = defineComponent({
  inheritAttrs: false,
  props: { name: null },
  setup:
    (props, { attrs }) =>
    () =>
      h('i', { ...attrs, 'data-icon': props.name }),
})

describe('ChatMessageChannel.vue', () => {
  const baseChannelItem: ChannelUpdateItem = {
    type: 'channel-update',
    channelId: '0102030405060708090a0b0c0d0e0f10',
    appId: 'dice',
    sequenceNumber: 42,
    allocations: [
      {
        networkTag: 'monad',
        balances: [
          {
            participant: {
              keyType: 1,
              pubKey:
                '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
            },
            balance: '1000000000000000000',
          },
          {
            participant: {
              keyType: 1,
              pubKey:
                '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5',
            },
            balance: '2000000000000000000',
          },
        ],
      },
    ],
    appState: new Uint8Array(),
    signatures: [
      {
        algorithm: 1,
        signer: {
          keyType: 1,
          pubKey:
            '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
        },
        signature: '30440220...0220...',
      },
    ],
  }

  it('renders channel header with sequence number and allocations', () => {
    const wrapper = mount(ChatMessageChannel, {
      props: {
        item: baseChannelItem,
      },
      global: {
        stubs: quasarStubs,
      },
    })

    expect(wrapper.text()).toContain('Satoshi Dice')
    expect(wrapper.text()).toContain('#42')
    expect(wrapper.text()).toContain('Channel:')
    expect(wrapper.text()).toContain('monad')
    expect(wrapper.text()).toContain('1 MON')
    expect(wrapper.text()).toContain('2 MON')
    expect(wrapper.text()).toContain('1 signature verified')
  })

  it('decodes and renders Satoshi Dice result payload', () => {
    const diceState = encodeDiceGamePayload({
      round: 1n,
      action: 'roll',
      seedCommitment: new Uint8Array(32).fill(1),
      targetRoll: 50,
      wager: 1900000000000000000n,
    })

    const wrapper = mount(ChatMessageChannel, {
      props: {
        item: {
          ...baseChannelItem,
          appId: 'dice',
          appState: diceState,
        },
      },
      global: {
        stubs: quasarStubs,
      },
    })

    expect(wrapper.text()).toContain('Satoshi Dice')
    expect(wrapper.text()).toContain('Round: #1')
    expect(wrapper.text()).toContain('Target: < 50')
    expect(wrapper.text()).toContain('roll')
    expect(wrapper.text()).toContain('Wager: 1.9 MON')
  })

  it('decodes and renders Poker game payload', () => {
    const pokerState = encodePokerGamePayload({
      handId: new Uint8Array(32).fill(3),
      phase: 'flop',
      action: 'Player 1 checks',
      cardCommitments: [
        new Uint8Array(32).fill(10),
        new Uint8Array(32).fill(11),
        new Uint8Array(32).fill(12),
      ],
    })

    const wrapper = mount(ChatMessageChannel, {
      props: {
        item: {
          ...baseChannelItem,
          appId: 'poker',
          appState: toHex(pokerState),
        },
      },
      global: {
        stubs: quasarStubs,
      },
    })

    expect(wrapper.text()).toContain("Texas Hold'em")
    expect(wrapper.text()).toContain('flop')
    expect(wrapper.text()).toContain('Action: Player 1 checks')
    expect(wrapper.text()).toContain('Commitments: 3 cards')
  })

  it('decodes and renders Swap Offer payload', () => {
    const swapState = encodeSwapOfferPayload({
      swapId: new Uint8Array(32).fill(2),
      makerAsset: new Uint8Array([1, 2, 3]),
      makerAmount: 10500000000000000000n,
      takerAsset: new Uint8Array([4, 5, 6]),
      takerAmount: 5000000000000000000n,
      expiration: 1700000000n,
    })

    const wrapper = mount(ChatMessageChannel, {
      props: {
        item: {
          ...baseChannelItem,
          appId: 'swap',
          appState: swapState,
        },
      },
      global: {
        stubs: quasarStubs,
      },
    })

    expect(wrapper.text()).toContain('Atomic Swap')
    expect(wrapper.text()).toContain('Maker Amount: 10.5 MON')
    expect(wrapper.text()).toContain('Taker Amount: 5 MON')
    expect(wrapper.text()).toContain('Expiration: 1700000000')
  })

  it('decodes and renders Raffle payload', () => {
    const raffleState = encodeRafflePayload({
      raffleId: new Uint8Array(32).fill(4),
      ticketPrice: 100000000000000000n,
      ticketsSold: 75n,
    })

    const wrapper = mount(ChatMessageChannel, {
      props: {
        item: {
          ...baseChannelItem,
          appId: 'raffle',
          appState: raffleState,
        },
      },
      global: {
        stubs: quasarStubs,
      },
    })

    expect(wrapper.text()).toContain('Raffle')
    expect(wrapper.text()).toContain('Ticket Price: 0.1 MON')
    expect(wrapper.text()).toContain('Tickets Sold: 75')
  })

  it('renders generic fallback and settlement reference', () => {
    const wrapper = mount(ChatMessageChannel, {
      props: {
        item: {
          ...baseChannelItem,
          appId: 'custom-contract',
          appState: '0x1234567890abcdef',
          settlementRef: '0xabcdef0123456789abcdef0123456789',
        },
      },
      global: {
        stubs: quasarStubs,
      },
    })

    expect(wrapper.text()).toContain('State Channel')
    expect(wrapper.text()).toContain('[Settled]')
    expect(wrapper.text()).toContain('Application State:')
    expect(wrapper.text()).toContain('0x1234567890abcdef')
    expect(wrapper.text()).toContain('ref: 0xabcd...6789')
  })
})
