/**
 * @jest-environment jsdom
 */
import { mount } from '@vue/test-utils'

jest.mock('../../../composables/useActiveWallet', () => ({
  useActiveWallet: jest.fn(),
}))
jest.mock('@frank/wallet/chain', () => ({
  activeChain: { toDisplayAmount: (v: bigint) => String(v), unit: 'MON' },
}))
jest.mock('@frank/wallet/message-item-plugins/raffle/draw', () => ({
  verifyRaffleDraw: jest.fn(),
}))
jest.mock('../../../utils/notifications', () => ({ errorNotify: jest.fn() }))

import ChatMessageRaffle, { LEAVE_GUARD_MS } from './ChatMessageRaffle.vue'

// Minimal stand-in for QBtn: keeps label/aria-label/disabled/click observable without Quasar.
const QBtnStub = {
  props: ['label', 'disable'],
  template:
    '<button :disabled="disable" :aria-label="$attrs[\'aria-label\']" @click="$emit(\'click\')">{{ label }}</button>',
}

function mountItem(item: Record<string, unknown>) {
  return mount(ChatMessageRaffle, {
    props: { item: item as never, address: '0xabc' },
    global: { stubs: { 'q-btn': QBtnStub } },
  })
}

describe('ChatMessageRaffle leave button', () => {
  beforeEach(() =>
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
    }),
  )
  afterEach(() => jest.useRealTimers())

  const joined = {
    type: 'raffle',
    action: 'joined',
    raffleId: 'round-xyz',
    entryCount: 1,
    maxEntries: 5,
  }

  it('emits one leave, stays disabled across ticks, re-enables only after the guard', async () => {
    const w = mountItem(joined)
    const btn = () => w.find('button')
    await btn().trigger('click')
    await w.vm.$nextTick()
    expect(w.emitted('sendFollowUp')).toHaveLength(1)
    expect(btn().attributes('disabled')).toBeDefined()
    await btn().trigger('click')
    expect(w.emitted('sendFollowUp')).toHaveLength(1)
    jest.advanceTimersByTime(LEAVE_GUARD_MS)
    await w.vm.$nextTick()
    expect(btn().attributes('disabled')).toBeUndefined()
  })

  it('has an accessible name naming the round and a live region', () => {
    const w = mountItem(joined)
    expect(w.find('button').attributes('aria-label')).toBe(
      'Leave raffle round round-xyz',
    )
    expect(w.find('[aria-live]').exists()).toBe(true)
  })

  it('announces left and error results in live regions', () => {
    const left = mountItem({ ...joined, action: 'left' })
    expect(left.find('[aria-live="polite"]').exists()).toBe(true)
    const err = mountItem({ ...joined, action: 'error', message: 'nope' })
    expect(err.find('[aria-live="assertive"]').text()).toBe('nope')
  })
})
