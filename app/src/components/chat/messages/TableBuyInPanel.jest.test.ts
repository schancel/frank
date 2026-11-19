/** @jest-environment jsdom */
/**
 * The poker and liar's dice cards' buy-in, as a player sees it: joining locks the buy-in through
 * the wallet binding (`src/games/table-buy-in-session`, replaced here by a recording session:
 * the chain side is exercised for real in `packages/bot/src/bots/table-join.anvil.jest.test.ts`),
 * then sends the structured join naming the lock; pending and failed states are shown as such;
 * the refund is offered for an open lock of this account from its deadline on, including a lock
 * only the account's notes to self name.
 */
import { flushPromises, mount } from '@vue/test-utils'
import * as quasar from 'quasar'
import { defineComponent, h, reactive, ref } from 'vue'

import type {
  LiarsDiceItem,
  PokerItem,
  TableHtlcRecordItem,
} from '@frank/cashweb/types/messages'
import { TableEscrowError } from '@frank/wallet/table-escrow'
import enUS from '../../../i18n/en-us'
import ChatMessagePoker from './ChatMessagePoker.vue'
import ChatMessageLiarsDice from './ChatMessageLiarsDice.vue'

const t = (key: string, params: Record<string, unknown> = {}) => {
  const text = key.split('.').reduce<any>((o, k) => o?.[k], enUS) as string
  return String(text ?? key).replace(/\{(\w+)\}/g, (_, name) =>
    String(params[name]),
  )
}

const OWN = '0x' + 'aa'.repeat(20)
const BOT = '0x' + 'b0'.repeat(20)
const MAIN = '0x' + 'cc'.repeat(20)
const LOCK = '0x' + 'dd'.repeat(32)
const OTHER_LOCK = '0x' + 'ee'.repeat(32)
const TABLE = '0f'.repeat(16)
const SIGNATURE = '0x' + '11'.repeat(65)
const NOW = 1_800_000_000
const escrow = {
  arbiter: '0x' + '99'.repeat(20),
  hashLock: '0x' + '77'.repeat(32),
  expiresAt: NOW + 86_400,
}

const store: { activeConversation: { messages: any[] } } = reactive({
  activeConversation: { messages: [] },
})
jest.mock('../../../stores/chats', () => ({ useChatStore: () => store }))
jest.mock('../../../utils/own-address', () => ({
  useReactiveOwnCanonicalAddress: () => ref(OWN),
}))
const noted: TableHtlcRecordItem[] = []
jest.mock('../../../stores/table-locks', () => ({
  useTableLockStore: () => ({
    locksAt: (chain: string, game: string, tableId: string) =>
      noted
        .filter(
          r =>
            r.chainIdentifier === chain &&
            r.game === game &&
            r.tableId === tableId,
        )
        .map(r => ({ ...r, lockId: r.lockIds[0] })),
  }),
}))
jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
    chainIdentifier: 'monad-testnet',
    unit: 'MON',
    toDisplayAmount: (n: bigint) => (Number(n) / 1e18).toString(),
    fromDisplayAmount: (s: string) => BigInt(Math.round(Number(s) * 1e18)),
  },
}))

/** The chain as the session reads it: lock states by id, and the head's time. */
const chainLocks = new Map<
  string,
  {
    state: 'open' | 'withdrawn' | 'refunded'
    expiresAt: number
    refundAddress?: string
  }
>()
let head = NOW
const session = {
  chainIdentifier: 'monad-testnet',
  contract: '0x' + '42'.repeat(20),
  account: MAIN,
  lockIdFor: jest.fn(() => LOCK),
  readLock: jest.fn(async (lockId: string) => {
    const lock = chainLocks.get(lockId)
    return lock
      ? {
          lockId,
          state: lock.state,
          expiresAt: BigInt(lock.expiresAt),
          refundAddress: lock.refundAddress ?? MAIN,
        }
      : null
  }),
  headTime: jest.fn(async () => head),
  join: jest.fn(),
  refund: jest.fn(),
  isCurrent: () => true,
}
jest.mock('../../../games/table-buy-in-session', () => ({
  openTableBuyInSession: async () => session,
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
quasarStubs.QBtn = defineComponent({
  inheritAttrs: false,
  props: { label: null, disable: null, loading: null },
  setup:
    (props, { attrs, slots }) =>
    () =>
      h(
        'button',
        { ...attrs, disabled: !!props.disable },
        props.label ? [props.label as string] : slots.default?.(),
      ),
})

const pokerTable = (over: Partial<PokerItem> = {}): PokerItem => ({
  type: 'poker',
  tableId: TABLE,
  action: 'create',
  buyInWei: (10n ** 17n).toString(),
  smallBlind: 10,
  bigBlind: 20,
  pot: 0,
  players: [],
  escrow,
  ...over,
})
const diceTable = (over: Partial<LiarsDiceItem> = {}): LiarsDiceItem => ({
  type: 'liars-dice',
  tableId: TABLE,
  action: 'create',
  buyInWei: (10n ** 17n).toString(),
  players: [],
  roundNumber: 0,
  escrow,
  ...over,
})

function mountCard(component: any, item: PokerItem | LiarsDiceItem) {
  return mount(component, {
    props: { item, address: BOT },
    global: { stubs: quasarStubs, mocks: { $t: t } },
  })
}
type Emitted = {
  items: any[]
  stampValueWei: bigint
  settled: (sent: boolean) => void
}
const emitted = (wrapper: any) =>
  (wrapper.emitted('sendFollowUp') ?? []).map((e: unknown[]) => e[0] as Emitted)
const status = (wrapper: any) =>
  wrapper.find('[data-testid="table-buy-in-status"]').text()

beforeEach(() => {
  chainLocks.clear()
  noted.length = 0
  head = NOW
  store.activeConversation.messages = []
  jest.clearAllMocks()
})

describe('joining a table from its card', () => {
  it('poker: locks the buy-in, then sends the structured join naming the lock, paying nothing', async () => {
    session.join.mockImplementation(async ({ onProgress }) => {
      onProgress?.({ stage: 'locking' })
      onProgress?.({ stage: 'lock-sent', txHash: '0x' + '12'.repeat(32) })
      chainLocks.set(LOCK, { state: 'open', expiresAt: escrow.expiresAt })
      return {
        lockId: LOCK,
        account: MAIN,
        signature: SIGNATURE,
        txHash: '0x' + '12'.repeat(32),
      }
    })
    const wrapper = mountCard(ChatMessagePoker, pokerTable())
    await flushPromises()
    const join = wrapper.find('[data-testid="table-join-btn"]')
    expect(join.text()).toBe('Sit at the table (locks 0.1 MON)')
    await join.trigger('click')
    await flushPromises()
    expect(session.join).toHaveBeenCalledWith(
      expect.objectContaining({
        game: 'poker',
        tableId: TABLE,
        table: {
          arbiter: escrow.arbiter,
          hashLock: escrow.hashLock,
          buyInWei: 10n ** 17n,
          expiresAt: BigInt(escrow.expiresAt),
        },
      }),
    )
    const [sent] = emitted(wrapper)
    expect(sent.stampValueWei).toBe(0n)
    expect(sent.items).toEqual([
      {
        type: 'poker',
        tableId: TABLE,
        action: 'join',
        smallBlind: 10,
        bigBlind: 20,
        pot: 0,
        buyInLock: { lockId: LOCK, account: MAIN, signature: SIGNATURE },
      },
    ])
    // While the message is on its way the lock is shown, not a seat.
    expect(wrapper.find('[data-testid="table-buy-in-lock"]').text()).toContain(
      'locked on chain',
    )
    sent.settled(true)
    await flushPromises()
    expect(status(wrapper)).toContain('Join sent')
  })

  it("liar's dice: the join names the lock; a seated player is offered the start once two sit", async () => {
    session.join.mockResolvedValue({
      lockId: LOCK,
      account: MAIN,
      signature: SIGNATURE,
    })
    const wrapper = mountCard(ChatMessageLiarsDice, diceTable())
    await flushPromises()
    await wrapper.find('[data-testid="table-join-btn"]').trigger('click')
    await flushPromises()
    expect(emitted(wrapper)[0].items).toEqual([
      {
        type: 'liars-dice',
        tableId: TABLE,
        action: 'join',
        buyInLock: { lockId: LOCK, account: MAIN, signature: SIGNATURE },
      },
    ])
    const seated = mountCard(
      ChatMessageLiarsDice,
      diceTable({ action: 'join', players: [OWN, '0x' + 'ab'.repeat(20)] }),
    )
    await flushPromises()
    expect(seated.find('[data-testid="table-join-btn"]').exists()).toBe(false)
    await seated.find('[data-testid="start-game-btn"]').trigger('click')
    expect(emitted(seated)[0]).toEqual({
      items: [{ type: 'text', text: '/start' }],
      stampValueWei: 0n,
    })
  })

  it('a lock that landed while its join was not sent stays refundable, and joining again reuses it', async () => {
    session.join.mockImplementation(async () => {
      chainLocks.set(LOCK, { state: 'open', expiresAt: escrow.expiresAt })
      return { lockId: LOCK, account: MAIN, signature: SIGNATURE }
    })
    const wrapper = mountCard(ChatMessagePoker, pokerTable())
    await flushPromises()
    await wrapper.find('[data-testid="table-join-btn"]').trigger('click')
    await flushPromises()
    emitted(wrapper)[0].settled(false)
    await flushPromises()
    expect(status(wrapper)).toContain('the join message was not sent')
    const again = wrapper.find('[data-testid="table-join-btn"]')
    expect(again.text()).toBe('Send the join again')
    await again.trigger('click')
    await flushPromises()
    // The same headless join: it finds the lock open and sends nothing new on chain.
    expect(session.join).toHaveBeenCalledTimes(2)
    expect(emitted(wrapper)).toHaveLength(2)
    // After the deadline, the refund is there whatever the bot did with the join.
    head = escrow.expiresAt
    wrapper.unmount()
    const later = mountCard(
      ChatMessagePoker,
      pokerTable({ action: 'action', street: 'flop' }),
    )
    await flushPromises()
    expect(later.find('[data-testid="table-refund-btn"]').exists()).toBe(true)
  })

  it('a lock not in a block yet is pending, never joined; checking again continues it', async () => {
    session.join.mockRejectedValueOnce(
      new TableEscrowError('lock-pending', 'not yet', '0x' + '34'.repeat(32)),
    )
    const wrapper = mountCard(ChatMessagePoker, pokerTable())
    await flushPromises()
    await wrapper.find('[data-testid="table-join-btn"]').trigger('click')
    await flushPromises()
    expect(status(wrapper)).toContain('not in a block yet')
    expect(emitted(wrapper)).toHaveLength(0)
    const check = wrapper.find('[data-testid="table-join-btn"]')
    expect(check.text()).toBe('Check the buy-in lock again')
    session.join.mockResolvedValueOnce({
      lockId: LOCK,
      account: MAIN,
      signature: SIGNATURE,
    })
    await check.trigger('click')
    await flushPromises()
    expect(emitted(wrapper)).toHaveLength(1)
  })

  it('says so when the wallet cannot pay the buy-in, and sends nothing', async () => {
    session.join.mockRejectedValueOnce(
      new TableEscrowError('insufficient-funds', 'no'),
    )
    const wrapper = mountCard(ChatMessagePoker, pokerTable())
    await flushPromises()
    await wrapper.find('[data-testid="table-join-btn"]').trigger('click')
    await flushPromises()
    expect(status(wrapper)).toBe(enUS.tableBuyIn.errors['insufficient-funds'])
    expect(emitted(wrapper)).toHaveLength(0)
  })

  it('only the newest card of a table offers the buy-in', async () => {
    const first = pokerTable()
    const newer = pokerTable({ action: 'join' })
    store.activeConversation.messages = [
      { outbound: false, senderAddress: BOT, items: [first] },
      { outbound: false, senderAddress: BOT, items: [newer] },
    ]
    const old = mountCard(ChatMessagePoker, first)
    const fresh = mountCard(ChatMessagePoker, newer)
    await flushPromises()
    expect(old.find('[data-testid="table-buy-in"]').exists()).toBe(false)
    expect(fresh.find('[data-testid="table-buy-in"]').exists()).toBe(true)
  })
})

describe('refunding a buy-in after the deadline', () => {
  it('is not offered before the deadline', async () => {
    chainLocks.set(LOCK, { state: 'open', expiresAt: escrow.expiresAt })
    const wrapper = mountCard(
      ChatMessagePoker,
      pokerTable({ action: 'action', street: 'flop' }),
    )
    await flushPromises()
    expect(wrapper.find('[data-testid="table-refund-btn"]').exists()).toBe(
      false,
    )
  })

  it('refunds an unseated lock from the deadline on and shows it refunded', async () => {
    chainLocks.set(LOCK, { state: 'open', expiresAt: escrow.expiresAt })
    head = escrow.expiresAt + 1
    session.refund.mockImplementation(async () => {
      chainLocks.set(LOCK, { state: 'refunded', expiresAt: escrow.expiresAt })
      return { txHash: '0x' + '56'.repeat(32) }
    })
    const wrapper = mountCard(
      ChatMessageLiarsDice,
      diceTable({ action: 'round_start', roundNumber: 1 }),
    )
    await flushPromises()
    await wrapper.find('[data-testid="table-refund-btn"]').trigger('click')
    await flushPromises()
    expect(session.refund).toHaveBeenCalledWith(
      expect.objectContaining({
        game: 'liars-dice',
        tableId: TABLE,
        lockId: LOCK,
      }),
    )
    expect(wrapper.find('[data-testid="table-refund-btn"]').exists()).toBe(
      false,
    )
    expect(wrapper.find('[data-testid="table-buy-in-lock"]').text()).toBe(
      enUS.tableBuyIn.lockRefunded,
    )
  })

  it("offers the refund for a lock only the account's note to self names (another device's)", async () => {
    noted.push({
      type: 'table-htlc-record',
      chainIdentifier: 'monad-testnet',
      action: 'lock',
      game: 'poker',
      tableId: TABLE,
      lockIds: [OTHER_LOCK],
      txHash: '0x' + '78'.repeat(32),
      timestamp: 1,
    })
    chainLocks.set(OTHER_LOCK, { state: 'open', expiresAt: escrow.expiresAt })
    head = escrow.expiresAt
    session.refund.mockResolvedValue({ txHash: '0x' + '9a'.repeat(32) })
    const wrapper = mountCard(
      ChatMessagePoker,
      pokerTable({ action: 'settle', street: 'settled' }),
    )
    await flushPromises()
    await wrapper.find('[data-testid="table-refund-btn"]').trigger('click')
    await flushPromises()
    expect(session.refund).toHaveBeenCalledWith(
      expect.objectContaining({ lockId: OTHER_LOCK }),
    )
  })

  it("never offers a lock that refunds to someone else's account", async () => {
    chainLocks.set(LOCK, {
      state: 'open',
      expiresAt: escrow.expiresAt,
      refundAddress: '0x' + '01'.repeat(20),
    })
    head = escrow.expiresAt + 1
    const wrapper = mountCard(
      ChatMessagePoker,
      pokerTable({ action: 'action', street: 'flop' }),
    )
    await flushPromises()
    expect(wrapper.find('[data-testid="table-refund-btn"]').exists()).toBe(
      false,
    )
  })
})
