/** @jest-environment jsdom */
// The dealer's welcome bubble and the after-result "Play again" (#395): mounted with the REAL bet
// control, so the safety the toolbar picker had (explicit confirm, balance check, wager record
// BEFORE broadcast, receipt wait, one transfer per submit) is proven where the bet is now placed:
// inside the message bubble.
import { flushPromises, mount } from '@vue/test-utils'
import { createApp, defineComponent, h, reactive, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import type { LevelDB } from 'level'

import {
  formatBlackjackError,
  playOutDealer,
} from '@frank/wallet/message-item-plugins/blackjack/game'
import {
  deriveDeck,
  sha256Hex,
} from '@frank/wallet/message-item-plugins/blackjack/deck'
import enUS from '../../../i18n/en-us'
import frFR from '../../../i18n/fr-fr'
import { createStoragePlugin } from '../../../boot/pinia'
import { useUnsentWagersStore } from '../../../stores/unsent-wagers'
import ChatMessageBlackjack from './ChatMessageBlackjack.vue'
import BlackjackBetControl from '../BlackjackBetControl.vue'

const DEALER = '0x1234567890abcdef1234567890abcdef1234abcd'
const PLAYER = '0xPlayer'
const HASH = `0x${'ab'.repeat(32)}`
const store: { chats: Record<string, { messages: any[] }> } = reactive({
  chats: {},
}) as any
const balance = ref<bigint | null>(5n * 10n ** 18n)

jest.mock('../../../stores/chats', () => ({ useChatStore: () => store }))
jest.mock('../../../stores/contacts', () => ({
  useContactStore: () => ({
    getContact: () => ({ profile: { name: 'Blackjack Dealer' } }),
  }),
}))
jest.mock('../../../composables/useBalance', () => ({
  useBalance: () => ({ balance }),
}))
let mockProvider: {
  getTransaction: jest.Mock
  getTransactionReceipt: jest.Mock
}
jest.mock('../../../utils/clients', () => ({
  useMonadWallet: () => ({ provider: mockProvider }),
}))
const mockGetWallet = jest.fn()
jest.mock('../../../composables/useActiveWallet', () => ({
  useActiveWallet: () => mockGetWallet(),
}))
jest.mock('../../../utils/notifications', () => ({ errorNotify: jest.fn() }))
jest.mock('../../../utils/own-address', () => ({
  getOwnCanonicalAddress: async () =>
    '0xAAAA00000000000000000000000000000000BBBB',
}))
const mockSend = jest.fn()
const mockStatus = jest.fn()
jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
    unit: 'MON',
    defaultStampValue: 10n ** 16n,
    toDisplayAmount: (n: bigint) => {
      const s = n.toString().padStart(19, '0')
      return `${s.slice(0, -18)}.${s.slice(-18)}`.replace(/\.?0+$/, '')
    },
    fromDisplayAmount: (s: string) => {
      const [whole, frac = ''] = s.split('.')
      if (frac.length > 18) throw new Error('too many decimals')
      return BigInt((whole || '0') + frac.padEnd(18, '0'))
    },
    formatAddress: (a: { raw: string }) => a.raw,
    nativeTransfers: {
      send: (args: unknown) => mockSend(args),
      getTransactionStatus: (args: unknown) => mockStatus(args),
    },
  },
}))

function t(
  messages: unknown,
  key: string,
  params: Record<string, string> = {},
) {
  const value = key
    .split('.')
    .reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], messages)
  return typeof value === 'string'
    ? value.replace(/\{(\w+)\}/g, (_, k: string) => params[k] ?? `{${k}}`)
    : key
}

// Minimal real-element stand-ins for the Quasar controls (Quasar renders nothing under Jest).
const QInput = defineComponent({
  props: {
    modelValue: { type: String, default: '' },
    label: { type: String, default: '' },
    hint: { type: String, default: '' },
    errorMessage: { type: String, default: '' },
    error: { type: Boolean, default: false },
    disable: { type: Boolean, default: false },
    inputAttrs: { type: Object, default: () => ({}) },
  },
  emits: ['update:modelValue'],
  setup(props, { emit }) {
    return () =>
      h('div', [
        h('label', props.label),
        h('input', {
          value: props.modelValue,
          disabled: props.disable,
          ...props.inputAttrs,
          onInput: (e: Event) =>
            emit('update:modelValue', (e.target as HTMLInputElement).value),
        }),
        h('div', { class: 'hint' }, props.hint),
        props.error ? h('div', { role: 'alert' }, props.errorMessage) : null,
      ])
  },
})
const QCheckbox = defineComponent({
  inheritAttrs: false,
  props: {
    modelValue: { type: Boolean, default: false },
    label: { type: String, default: '' },
    disable: { type: Boolean, default: false },
  },
  emits: ['update:modelValue'],
  setup(props, { emit, attrs }) {
    return () =>
      h('label', [
        h('input', {
          ...attrs,
          type: 'checkbox',
          checked: props.modelValue,
          disabled: props.disable,
          onChange: (e: Event) =>
            emit('update:modelValue', (e.target as HTMLInputElement).checked),
        }),
        props.label,
      ])
  },
})
const QBtn = defineComponent({
  inheritAttrs: false,
  props: {
    label: { type: String, default: '' },
    disable: { type: Boolean, default: false },
    loading: { type: Boolean, default: false },
    type: { type: String, default: 'button' },
  },
  setup(props, { attrs }) {
    return () =>
      h(
        'button',
        {
          ...attrs,
          'type': props.type,
          'disabled': props.disable,
          'aria-busy': props.loading ? 'true' : 'false',
        },
        props.label,
      )
  },
})

let storageData: Record<string, string>
function fakeStorage(): LevelDB {
  return {
    put: (k: string, v: string) => ((storageData[k] = v), Promise.resolve()),
    get: (k: string) =>
      k in storageData
        ? Promise.resolve(storageData[k])
        : Promise.reject(new Error('not found')),
  } as unknown as LevelDB
}
function installPinia() {
  const pinia = createPinia()
  pinia.use(
    createStoragePlugin(
      fakeStorage(),
      Promise.resolve({ networkName: 'n', version: 1 }),
    ),
  )
  createApp({}).use(pinia)
  setActivePinia(pinia)
  return pinia
}
const stored = () =>
  JSON.parse(storageData.unsentWagers ?? '{"wagers":[]}').wagers

let ts = 0
const msg = (outbound: boolean, item: any, extra: object = {}) => ({
  outbound,
  status: 'ok',
  receivedTime: ++ts,
  serverTime: ts,
  outpoints: [],
  senderAddress: outbound ? PLAYER : DEALER,
  items: [item],
  ...extra,
})
const welcomeItem = (over: Record<string, unknown> = {}) => ({
  type: 'blackjack-move',
  gameId: 'welcome',
  action: 'welcome',
  minWagerWei: '50000000000000000', // 0.05
  maxWagerWei: '200000000000000000', // 0.2
  feeHintWei: '60000000000000000',
  rules: 'A natural pays 3:2. The dealer draws to 17.',
  ...over,
})
const welcome = (over: Record<string, unknown> = {}) =>
  msg(false, welcomeItem(over))

// A resolved, fair hand (the dealer's reveal is the latest item) for "Play again".
const SEED = 'welcome-test-seed'
function resolvedHand(gameId = 'g1') {
  const deck = deriveDeck(SEED, HASH, 0)
  // Player: deck[0], deck[2]; dealer: deck[1], deck[3] (+ draws to 17). Use a real reveal that the
  // fairness check accepts by replaying the dealer's rules.
  const playerCards = [deck[0], deck[2]]
  const { dealerCards, outcome } = playOutDealer(deck, playerCards, 4)
  return [
    msg(true, {
      type: 'blackjack-move',
      gameId,
      action: 'bet',
      wagerTxHash: HASH,
    }),
    msg(false, {
      type: 'blackjack-move',
      gameId,
      action: 'deal',
      serverSeedHash: sha256Hex(SEED),
      playerCards,
      dealerUpCard: deck[1],
    }),
    msg(true, {
      type: 'blackjack-move',
      gameId,
      action: 'stand',
    }),
    msg(false, {
      type: 'blackjack-move',
      gameId,
      action: 'reveal',
      dealerCards,
      serverSeed: SEED,
      outcome,
    }),
  ]
}

const mounted: Array<{ unmount: () => void }> = []
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount()
})

async function mountBubble(
  messages: any[],
  index: number,
  opts: {
    submit?: jest.Mock | null
    messages?: unknown
    stampWei?: bigint | null
  } = {},
) {
  store.chats[DEALER] = { messages }
  const submit =
    opts.submit === null
      ? null
      : opts.submit ?? jest.fn().mockResolvedValue(undefined)
  const wrapper = mount(ChatMessageBlackjack, {
    attachTo: document.body,
    props: { item: messages[index].items[0], address: DEALER },
    global: {
      plugins: [installPinia()],
      components: { QInput, QBtn, QCheckbox },
      provide: {
        blackjackChat: submit
          ? { submit, stampWei: () => opts.stampWei ?? null }
          : null,
      },
      mocks: {
        $t: (key: string, params?: Record<string, string>) =>
          t(opts.messages ?? enUS, key, params),
      },
    },
  })
  mounted.push(wrapper)
  await flushPromises()
  return { wrapper, submit }
}

type Wrapper = Awaited<ReturnType<typeof mountBubble>>['wrapper']
const control = (w: Wrapper) => w.findComponent(BlackjackBetControl)
const amount = (w: Wrapper) => w.find('input:not([type="checkbox"])')
const confirmBox = (w: Wrapper) => w.find('input[type="checkbox"]')
const submitButton = (w: Wrapper) =>
  w.find('[data-testid="blackjack-bet-submit"]')

beforeEach(() => {
  ts = 0
  balance.value = 5n * 10n ** 18n
  storageData = {}
  store.chats = {}
  mockProvider = {
    getTransaction: jest.fn(async () => ({
      from: PLAYER,
      to: DEALER,
      value: 10n ** 17n,
    })),
    getTransactionReceipt: jest.fn(async () => ({ status: 1 })),
  }
  mockGetWallet.mockReset().mockResolvedValue({
    wallet: true,
    identity: {
      address: { raw: '0xAAAA00000000000000000000000000000000BBBB' },
    },
  })
  mockStatus.mockReset().mockResolvedValue('confirmed')
  mockSend.mockReset().mockImplementation(async (args: any) => {
    await args.onSigned?.({ txHash: HASH })
    return { txHash: HASH }
  })
})

describe('the dealer welcome bubble', () => {
  it('shows the title, the limits from the item (in MON, never wei) and the rules, with an inline bet control naming the dealer', async () => {
    const { wrapper } = await mountBubble([welcome()], 0)
    expect(wrapper.find('[data-testid="blackjack-welcome-title"]').text()).toBe(
      'Blackjack table',
    )
    expect(
      wrapper.find('[data-testid="blackjack-welcome-limits"]').text(),
    ).toBe('Table limits: 0.05 to 0.2 MON')
    expect(wrapper.find('[data-testid="blackjack-welcome-rules"]').text()).toBe(
      'A natural pays 3:2. The dealer draws to 17.',
    )
    expect(wrapper.text()).not.toMatch(/\d{9,}/)
    expect(control(wrapper).exists()).toBe(true)
    expect(wrapper.find('.hint').text()).toBe('Table limits: 0.05 to 0.2 MON')
    expect(wrapper.text()).toContain(
      'transfer of MON to Blackjack Dealer (0x1234...abcd)',
    )
  })

  it('does not claim a hand, a bet or "Loading hand"', async () => {
    const { wrapper } = await mountBubble([welcome()], 0)
    expect(wrapper.text()).not.toContain('Loading hand')
    expect(wrapper.text()).not.toContain('Your hand')
    expect(wrapper.find('[data-testid="blackjack-bet-line"]').exists()).toBe(
      false,
    )
  })

  it('disables the bet until the player explicitly confirms the recipient and amount', async () => {
    const { wrapper, submit } = await mountBubble([welcome()], 0)
    expect(submitButton(wrapper).attributes('disabled')).toBeDefined()
    await wrapper.find('form').trigger('submit') // Enter in the amount box
    await submitButton(wrapper).trigger('click')
    await flushPromises()
    expect(mockSend).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
    await confirmBox(wrapper).setValue(true)
    expect(wrapper.text()).toContain(
      'I understand 0.1 MON will be sent to Blackjack Dealer (0x1234...abcd)',
    )
    expect(submitButton(wrapper).attributes('disabled')).toBeUndefined()
  })

  it('validates against the limits of the item, not 0.01 to 1 MON', async () => {
    const { wrapper } = await mountBubble([welcome()], 0)
    await amount(wrapper).setValue('0.02') // fine at the fallback, below this table
    expect(wrapper.find('[role="alert"]').text()).toBe(
      'Bet is below the table minimum (0.05 MON)',
    )
    await amount(wrapper).setValue('0.5') // fine at the fallback, above this table
    expect(wrapper.find('[role="alert"]').text()).toBe(
      'Bet is above the table maximum (0.2 MON)',
    )
    await confirmBox(wrapper).setValue(true)
    expect(submitButton(wrapper).attributes('disabled')).toBeDefined()
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('places the bet through the durable path: record persisted BEFORE broadcast, one transfer, one bet item, same wager and gameId', async () => {
    const pinia = installPinia()
    await useUnsentWagersStore().restored
    let storedAtBroadcast: unknown[] = []
    mockSend.mockImplementation(async (args: any) => {
      await args.onSigned({ txHash: HASH })
      storedAtBroadcast = stored() // what storage holds the instant bytes would be sent
      return { txHash: HASH }
    })
    const submit = jest.fn(async () => undefined)
    store.chats[DEALER] = { messages: [welcome()] }
    const wrapper = mount(ChatMessageBlackjack, {
      attachTo: document.body,
      props: {
        item: store.chats[DEALER].messages[0].items[0],
        address: DEALER,
      },
      global: {
        plugins: [pinia],
        components: { QInput, QBtn, QCheckbox },
        provide: { blackjackChat: { submit, stampWei: () => null } },
        mocks: { $t: (k: string, p?: Record<string, string>) => t(enUS, k, p) },
      },
    })
    mounted.push(wrapper)
    await flushPromises()
    await amount(wrapper).setValue('0.1')
    await confirmBox(wrapper).setValue(true)
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(mockSend).toHaveBeenCalledTimes(1)
    expect(storedAtBroadcast).toHaveLength(1)
    expect(storedAtBroadcast[0]).toMatchObject({
      wagerTxHash: HASH,
      dealerAddress: DEALER,
      amountWei: (10n ** 17n).toString(),
      state: 'signed',
    })
    expect(submit).toHaveBeenCalledTimes(1)
    const payload = (submit.mock.calls[0] as any[])[0]
    expect(payload.address).toBe(DEALER)
    expect(payload.items).toHaveLength(1)
    expect(payload.items[0]).toMatchObject({
      type: 'blackjack-move',
      action: 'bet',
      wagerTxHash: HASH,
    })
    // The record names the SAME gameId as the bet item, and stays (state sent) until the dealer replies.
    expect(stored()[0].gameId).toBe(payload.items[0].gameId)
    expect(stored()[0].state).toBe('sent')
  })

  it('does not double-submit: repeated submits while pending create one transfer and one bet', async () => {
    let release: () => void = () => undefined
    const submit = jest.fn(
      () =>
        new Promise<void>(resolve => {
          release = resolve
        }),
    )
    const { wrapper } = await mountBubble([welcome()], 0, { submit })
    await confirmBox(wrapper).setValue(true)
    await wrapper.find('form').trigger('submit')
    await wrapper.find('form').trigger('submit')
    await submitButton(wrapper).trigger('click')
    await flushPromises()
    release()
    await flushPromises()
    expect(mockSend).toHaveBeenCalledTimes(1)
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it('a delivery failure keeps the wager record (state paid) so the chat banner can retry the SAME wager', async () => {
    const submit = jest.fn().mockRejectedValue(new Error('relay down'))
    const { wrapper } = await mountBubble([welcome()], 0, { submit })
    await confirmBox(wrapper).setValue(true)
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(mockSend).toHaveBeenCalledTimes(1)
    expect(stored()).toHaveLength(1)
    expect(stored()[0]).toMatchObject({ wagerTxHash: HASH, state: 'paid' })
    expect(wrapper.text()).toContain('Wager paid, bet not delivered')
    // No second transfer was built, and the (unsent) record blocks a new wager.
    await confirmBox(wrapper).setValue(true)
    expect(submitButton(wrapper).attributes('disabled')).toBeDefined()
    expect(mockSend).toHaveBeenCalledTimes(1)
  })

  it('an insufficient balance is refused before any value leaves the wallet, with the faucet hint', async () => {
    balance.value = 10n ** 16n
    const { wrapper, submit } = await mountBubble([welcome()], 0)
    expect(wrapper.find('[role="alert"]').text()).toContain(
      'Not enough balance',
    )
    expect(
      wrapper.find('[data-testid="blackjack-bet-faucet-hint"]').text(),
    ).toBe(t(enUS, 'blackjackBet.faucetHint'))
    await confirmBox(wrapper).setValue(true)
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(mockSend).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
  })

  it('the dealer fee hint raises the balance a bet needs', async () => {
    // bet 0.1 + max(stamp 0.01 + reserve 0.05, hint 0.06) = 0.16: 0.155 is not enough.
    balance.value = 155n * 10n ** 15n
    const { wrapper } = await mountBubble([welcome()], 0)
    expect(wrapper.find('[role="alert"]').text()).toContain('0.16')
    balance.value = 165n * 10n ** 15n
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })

  it('counts the stamp the chat is configured to pay', async () => {
    // bet 0.1 + (stamp 0.5 + reserve 0.05) = 0.65
    balance.value = 6n * 10n ** 17n
    const { wrapper } = await mountBubble([welcome()], 0, {
      stampWei: 5n * 10n ** 17n,
    })
    expect(wrapper.find('[role="alert"]').text()).toContain('0.65')
  })

  it('offers no bet control when the chat cannot deliver a bet (no chat context): nothing can be paid', async () => {
    const { wrapper } = await mountBubble([welcome()], 0, { submit: null })
    expect(control(wrapper).exists()).toBe(false)
    expect(
      wrapper.find('[data-testid="blackjack-welcome-title"]').exists(),
    ).toBe(true)
  })

  it('the latest welcome wins: an older welcome bubble is read-only and shows what it said; the control uses the newest limits', async () => {
    const older = welcome()
    const newer = welcome({
      minWagerWei: '100000000000000000', // 0.1
      maxWagerWei: '300000000000000000', // 0.3
    })
    const messages = [older, newer]
    const first = await mountBubble(messages, 0)
    expect(control(first.wrapper).exists()).toBe(false)
    expect(
      first.wrapper.find('[data-testid="blackjack-welcome-limits"]').text(),
    ).toBe('Table limits: 0.05 to 0.2 MON')

    const second = await mountBubble(messages, 1)
    expect(control(second.wrapper).exists()).toBe(true)
    expect(second.wrapper.find('.hint').text()).toBe(
      'Table limits: 0.1 to 0.3 MON',
    )
    await amount(second.wrapper).setValue('0.05') // valid under the OLD welcome
    expect(second.wrapper.find('[role="alert"]').text()).toBe(
      'Bet is below the table minimum (0.1 MON)',
    )
  })

  it('a malformed welcome is not trusted: the bubble falls back to the documented 0.01 to 1 MON limits', async () => {
    const bad = welcome({ minWagerWei: 'lots', maxWagerWei: '-5' })
    const { wrapper } = await mountBubble([bad], 0)
    expect(wrapper.find('.hint').text()).toBe('Table limits: 0.01 to 1 MON')
    expect(
      wrapper.find('[data-testid="blackjack-welcome-limits"]').text(),
    ).toBe('Table limits: 0.01 to 1 MON')
    expect(
      wrapper.find('[data-testid="blackjack-welcome-rules"]').exists(),
    ).toBe(false)
  })

  it('a welcome we sent ourselves never sets the limits', async () => {
    const forged = msg(
      true,
      welcomeItem({ minWagerWei: '1', maxWagerWei: '2' }),
    )
    const real = welcome()
    const { wrapper } = await mountBubble([forged, real], 1)
    expect(wrapper.find('.hint').text()).toBe('Table limits: 0.05 to 0.2 MON')
  })

  it('after the player bets, the welcome is history: the control moves on with the hand', async () => {
    const messages = [
      welcome(),
      msg(true, {
        type: 'blackjack-move',
        gameId: 'bj-1',
        action: 'bet',
        wagerTxHash: HASH,
      }),
    ]
    const { wrapper } = await mountBubble(messages, 0)
    expect(control(wrapper).exists()).toBe(false)
  })

  it('renders in French with no untranslated keys', async () => {
    const { wrapper } = await mountBubble([welcome()], 0, { messages: frFR })
    expect(wrapper.find('[data-testid="blackjack-welcome-title"]').text()).toBe(
      'Table de blackjack',
    )
    expect(wrapper.text()).not.toMatch(/blackjack(Bet|Welcome)\./)
    expect(
      wrapper.find('[data-testid="blackjack-welcome-limits"]').text(),
    ).toBe('Limites de la table : 0.05 à 0.2 MON')
  })
})

describe('Play again after a resolved hand', () => {
  it('shows the same durable bet control under the result, with its own heading and the fallback limits when no welcome exists', async () => {
    const hand = resolvedHand()
    const { wrapper } = await mountBubble(hand, hand.length - 1)
    expect(wrapper.text()).toContain('Verified fair')
    const again = wrapper.find('[data-testid="blackjack-play-again"]')
    expect(again.exists()).toBe(true)
    expect(again.find('.text-subtitle2').text()).toBe('Play again')
    expect(wrapper.find('.hint').text()).toBe('Table limits: 0.01 to 1 MON')
    // The old hard-coded in-bubble form and its "Deal me in" action are gone.
    expect(wrapper.text()).not.toContain('Deal me in (')
    expect(wrapper.findAll('button').map(b => b.text())).not.toContain(
      'Deal me in (0.1 MON)',
    )
  })

  it("uses the limits of the dealer's latest welcome", async () => {
    const hand = resolvedHand()
    const messages = [welcome({ maxWagerWei: '300000000000000000' }), ...hand]
    const { wrapper } = await mountBubble(messages, messages.length - 1)
    expect(wrapper.find('.hint').text()).toBe('Table limits: 0.05 to 0.3 MON')
  })

  it('requires the explicit confirmation and pays through the durable path (record before broadcast, one transfer, one bet)', async () => {
    const hand = resolvedHand()
    let storedAtBroadcast: unknown[] = []
    const pinia = installPinia()
    await useUnsentWagersStore().restored
    mockSend.mockImplementation(async (args: any) => {
      await args.onSigned({ txHash: HASH })
      storedAtBroadcast = stored()
      return { txHash: HASH }
    })
    const submit = jest.fn(async () => undefined)
    store.chats[DEALER] = { messages: hand }
    const wrapper = mount(ChatMessageBlackjack, {
      attachTo: document.body,
      props: { item: hand[hand.length - 1].items[0], address: DEALER },
      global: {
        plugins: [pinia],
        components: { QInput, QBtn, QCheckbox },
        provide: { blackjackChat: { submit, stampWei: () => null } },
        mocks: { $t: (k: string, p?: Record<string, string>) => t(enUS, k, p) },
      },
    })
    mounted.push(wrapper)
    await flushPromises()
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(mockSend).not.toHaveBeenCalled() // not confirmed
    await confirmBox(wrapper).setValue(true)
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(mockSend).toHaveBeenCalledTimes(1)
    expect(storedAtBroadcast).toHaveLength(1)
    expect(submit).toHaveBeenCalledTimes(1)
    expect((submit.mock.calls[0] as any[])[0].items[0]).toMatchObject({
      action: 'bet',
      wagerTxHash: HASH,
    })
  })

  it('is offered only under the newest hand: an older resolved hand is history once a later hand exists', async () => {
    const first = resolvedHand('g1')
    const second = [
      msg(true, {
        type: 'blackjack-move',
        gameId: 'g2',
        action: 'bet',
        wagerTxHash: `0x${'cd'.repeat(32)}`,
      }),
    ]
    const messages = [...first, ...second]
    const { wrapper } = await mountBubble(messages, first.length - 1)
    expect(wrapper.find('[data-testid="blackjack-play-again"]').exists()).toBe(
      false,
    )
  })

  it('is not offered while a hand is in progress (only hit/stand/double are)', async () => {
    const hand = resolvedHand().slice(0, 2) // bet + deal
    const { wrapper } = await mountBubble(hand, 1)
    expect(wrapper.find('[data-testid="blackjack-play-again"]').exists()).toBe(
      false,
    )
    expect(wrapper.findAll('button').map(b => b.text())).toEqual(
      expect.arrayContaining(['Hit', 'Stand']),
    )
  })

  it('offers no bet control without a chat context', async () => {
    const hand = resolvedHand()
    const { wrapper } = await mountBubble(hand, hand.length - 1, {
      submit: null,
    })
    expect(wrapper.find('[data-testid="blackjack-play-again"]').exists()).toBe(
      false,
    )
  })

  it('a dealer error text for the game does not disturb the control', async () => {
    const hand = resolvedHand()
    const messages = [
      ...hand,
      msg(false, { type: 'text', text: formatBlackjackError('g1', 'oops') }),
    ]
    const { wrapper } = await mountBubble(messages, hand.length - 1)
    expect(wrapper.find('[data-testid="blackjack-play-again"]').exists()).toBe(
      true,
    )
  })
})
