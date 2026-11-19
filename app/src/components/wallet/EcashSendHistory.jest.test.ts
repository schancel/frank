/** @jest-environment jsdom */

import { mount } from '@vue/test-utils'
import type { EcashSend } from '@frank/wallet/ecash-wallet'
import EcashSendHistory from './EcashSendHistory.vue'
import enUS from '../../i18n/en-us'
import frFR from '../../i18n/fr-fr'

const lookup = (messages: unknown, key: string) =>
  key
    .split('.')
    .reduce<unknown>(
      (o, k) => (o as Record<string, unknown>)?.[k],
      messages,
    ) as string | undefined
const t = (key: string) => lookup(enUS, key) ?? key
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0))

const send = (overrides: Partial<EcashSend>): EcashSend => ({
  operationId: 'op-1',
  recipient: 'ecash:qrecipient',
  valueSats: '15000',
  feeSats: '226',
  txid: 'aa'.repeat(32),
  state: 'sent',
  conflictedTxids: [],
  ...overrides,
})

const mountHistory = (
  sends: readonly EcashSend[],
  retry: (operationId: string) => Promise<void> = jest.fn(),
) =>
  mount(EcashSendHistory, {
    props: {
      chainIdentifier: 'xec-mainnet',
      sends,
      showEmpty: true,
      nativeUnit: 'XEC',
      nativeAmount: (value: string) => (Number(value) / 100).toFixed(2),
      transactionExplorerLink: () => undefined,
      retry,
    },
    global: {
      mocks: { $t: t },
      stubs: {
        QCardSection: { template: '<div><slot /></div>' },
        QList: { template: '<div><slot /></div>' },
        QItem: { template: '<div><slot /></div>' },
        QItemSection: { template: '<div><slot /></div>' },
        QItemLabel: { template: '<div><slot /></div>' },
        QBadge: { template: '<span><slot /></span>' },
        QIcon: true,
        AddressText: {
          props: ['address'],
          template: '<span>{{ address }}</span>',
        },
        QBtn: {
          props: ['label', 'disable'],
          template:
            '<button :disabled="disable" @click="$emit(\'click\')">{{ label }}</button>',
        },
      },
    },
  })

describe('EcashSendHistory', () => {
  it('shows each send with its state, and a conflicted one as not gone through', () => {
    const wrapper = mountHistory([
      send({ operationId: 'a', state: 'confirmed' }),
      send({ operationId: 'b', state: 'conflicted' }),
      send({ operationId: 'c', state: 'pending' }),
    ])
    const rows = wrapper.findAll('[data-testid="ecash-send-row"]')
    // Newest first.
    expect(rows.map(row => row.attributes('data-operation-id'))).toEqual([
      'c',
      'b',
      'a',
    ])
    expect(
      rows.map(row => row.get('[data-testid="ecash-send-status"]').text()),
    ).toEqual(['Pending', "Didn't go through", 'Confirmed'])
    expect(rows[1]!.get('[data-testid="ecash-send-conflicted"]').text()).toBe(
      "Didn't go through: another of your devices spent the same coins. Nothing was paid.",
    )
    expect(rows[1]!.text()).toContain('150 XEC')
    expect(rows[1]!.text()).toContain('ecash:qrecipient')
    // Only the conflicted send offers Retry.
    expect(wrapper.findAll('[data-testid="ecash-send-retry"]')).toHaveLength(1)
  })

  it('retries only on click, once while it runs, and again only on a later click', async () => {
    let finish!: () => void
    const retry = jest.fn(
      () =>
        new Promise<void>(resolve => {
          finish = resolve
        }),
    )
    const wrapper = mountHistory(
      [send({ operationId: 'b', state: 'conflicted' })],
      retry,
    )
    await settle()
    expect(retry).not.toHaveBeenCalled()
    const button = wrapper.get('[data-testid="ecash-send-retry"]')
    await button.trigger('click')
    await button.trigger('click')
    expect(retry).toHaveBeenCalledTimes(1)
    expect(retry).toHaveBeenCalledWith('b')
    expect(button.attributes('disabled')).toBeDefined()
    finish()
    await settle()
    expect(
      wrapper.get('[data-testid="ecash-send-retry"]').attributes('disabled'),
    ).toBeUndefined()
  })

  it('says there is nothing yet when there are no sends', () => {
    const wrapper = mountHistory([])
    expect(wrapper.find('[data-testid="ecash-send-empty"]').exists()).toBe(true)
  })

  it('has every string in French too', () => {
    for (const key of [
      'to',
      'status.pending',
      'status.sent',
      'status.confirmed',
      'status.conflicted',
      'conflicted',
      'retry',
      'retryNote',
      'retryFailed',
    ])
      expect(typeof lookup(frFR, `walletHistory.ecashSend.${key}`)).toBe(
        'string',
      )
  })
})
