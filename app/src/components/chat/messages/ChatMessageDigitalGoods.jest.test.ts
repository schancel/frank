/** @jest-environment jsdom */

import { flushPromises, mount } from '@vue/test-utils'
import * as quasar from 'quasar'
import { defineComponent, h } from 'vue'

import enUS from '../../../i18n/en-us'
import { png } from '../../../utils/image-data-uri.fixtures'
import ChatMessageDigitalGoods from './ChatMessageDigitalGoods.vue'

jest.mock('../../../utils/notifications', () => ({ errorNotify: jest.fn() }))
jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
    unit: 'MON',
    toDisplayAmount: (n: bigint) => (Number(n) / 1e18).toString(),
  },
}))

function passthrough(tag: string) {
  return defineComponent({
    props: { modelValue: null, label: null },
    setup(props, { slots }) {
      return () =>
        h(tag, {}, [props.label as string | undefined, slots.default?.()])
    },
  })
}
const quasarStubs: Record<string, any> = Object.fromEntries(
  Object.keys(quasar)
    .filter(n => /^Q[A-Z]/.test(n))
    .map(n => [n, passthrough('div')]),
)
quasarStubs.QBtn = passthrough('button')

// Minimal $t over the real en-us messages: {name} placeholders are substituted.
const $t = (key: string, params: Record<string, unknown> = {}) => {
  const value = key
    .split('.')
    .reduce<any>((o, k) => o?.[k], enUS as Record<string, unknown>)
  return typeof value === 'string'
    ? value.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k]))
    : key
}

const THUMB = png(96, 64)

function render(catalog: any[]) {
  return mount(ChatMessageDigitalGoods, {
    props: {
      address: '0xVendor',
      item: { type: 'digital-goods', action: 'catalog', catalog },
    },
    global: { stubs: quasarStubs, mocks: { $t } },
  })
}

describe('ChatMessageDigitalGoods catalog thumbnails', () => {
  it('shows a thumbnail for each entry that has one', () => {
    const w = render([
      { itemId: 'a', description: 'Alpha', priceWei: '1', thumbnail: THUMB },
      { itemId: 'b', description: 'Beta', priceWei: '1' },
    ])
    const imgs = w.findAll('img.catalog-thumbnail')
    expect(imgs).toHaveLength(1)
    expect(imgs[0].attributes('src')).toBe(THUMB)
    // Decorative: the adjacent description already names the item.
    expect(imgs[0].attributes('alt')).toBe('')
  })

  it.each([
    'https://tracker.example/pixel.png',
    'http://127.0.0.1/x.png',
    'data:text/html;base64,PGh0bWw+',
    'data:image/svg+xml;base64,PHN2Zz4=',
    'javascript:alert(1)',
    png(60000, 60000),
    png(2000, 2000),
    png(10, 10) + 'A'.repeat(70 * 1024),
  ])('never renders a non-data-image thumbnail (%s)', bad => {
    const w = render([
      { itemId: 'a', description: 'Alpha', priceWei: '1', thumbnail: bad },
    ])
    expect(w.find('img').exists()).toBe(false)
    expect(w.text()).toContain('Alpha')
  })

  it('renders a name or description containing HTML as text, never as markup', () => {
    const w = render([
      {
        itemId: 'a',
        description: '<img src=x onerror=alert(1)><b>bold</b>',
        priceWei: '1',
      },
    ])
    expect(w.find('b').exists()).toBe(false)
    expect(w.findAll('img')).toHaveLength(0)
    expect(w.text()).toContain('<img src=x onerror=alert(1)><b>bold</b>')
  })

  it.each(['abc', '-5', '1.5', '', '9'.repeat(200), '0x10'])(
    'shows a placeholder, never throws, for the untrusted price %j',
    bad => {
      const w = render([
        { itemId: 'a', description: 'Alpha', priceWei: bad },
        { itemId: 'b', description: 'Beta', priceWei: '1000000000000000000' },
      ])
      expect(w.text()).toContain('Alpha price unavailable')
      expect(w.text()).toContain('Beta 1 MON')
    },
  )

  it('renders at most 50 entries and says how many are not shown', () => {
    const many = Array.from({ length: 53 }, (_, i) => ({
      itemId: `i${i}`,
      description: `Item ${i}`,
      priceWei: '1',
    }))
    const w = render(many)
    expect(w.findAll('button')).toHaveLength(50)
    expect(w.text()).toContain('3 more items not shown')
    expect(w.text()).not.toContain('Item 50')
  })

  it('a malformed catalog (not an array) renders nothing and does not throw', () => {
    const w = mount(ChatMessageDigitalGoods, {
      props: {
        address: '0x',
        item: { type: 'digital-goods', action: 'catalog', catalog: 'x' } as any,
      },
      global: { stubs: quasarStubs, mocks: { $t } },
    })
    expect(w.findAll('button')).toHaveLength(0)
  })
})

describe('ChatMessageDigitalGoods purchase confirmation (ticket #368)', () => {
  const VENDOR = '0x1234567890abcdef1234567890abcdef1234abcd'
  const CATALOG = [
    { itemId: 'a', description: 'Sunset', priceWei: '50000000000000000' },
    { itemId: 'b', description: 'Forest', priceWei: '100000000000000000' },
  ]
  function renderShop(extra: Record<string, unknown> = {}) {
    return mount(ChatMessageDigitalGoods, {
      props: {
        address: VENDOR,
        item: { type: 'digital-goods', action: 'catalog', catalog: CATALOG },
        ...extra,
      } as any,
      global: { stubs: quasarStubs, mocks: { $t } },
    })
  }
  const buyButtons = (w: any) => w.findAll('[data-testid="goods-buy"]')

  it('one tap on Buy sends and pays nothing; it asks first, naming item, price and recipient', async () => {
    const w = renderShop({ recipientName: 'Picture Shop' })
    await buyButtons(w)[0].trigger('click')

    expect(w.emitted('sendFollowUp')).toBeUndefined()
    const prompt = w.find('[data-testid="goods-confirm"]').text()
    expect(prompt).toContain('Sunset')
    expect(prompt).toContain('0.05 MON')
    expect(prompt).toContain('Picture Shop')
    expect(prompt).toContain('0x1234...abcd')
  })

  it('falls back to the abbreviated address when the vendor has no name', async () => {
    const w = renderShop()
    await buyButtons(w)[0].trigger('click')
    expect(w.find('[data-testid="goods-confirm"]').text()).toContain(
      'Pay 0.05 MON to 0x1234...abcd (0x1234...abcd)',
    )
  })

  it('confirming sends the request once, with the price as the stamp, and closes the prompt', async () => {
    const w = renderShop()
    await buyButtons(w)[1].trigger('click')
    await w.find('[data-testid="goods-confirm-buy"]').trigger('click')
    // The confirmation is gone after one use, so a second tap has nothing to press.
    expect(w.find('[data-testid="goods-confirm-buy"]').exists()).toBe(false)

    expect(w.emitted('sendFollowUp')).toEqual([
      [
        {
          items: [{ type: 'digital-goods', action: 'request', itemId: 'b' }],
          stampValueWei: 100000000000000000n,
          settled: expect.any(Function),
        },
      ],
    ])
    expect(w.find('[data-testid="goods-confirm"]').exists()).toBe(false)
  })

  it('cancelling sends nothing and restores the Buy button', async () => {
    const w = renderShop()
    await buyButtons(w)[0].trigger('click')
    await w.find('[data-testid="goods-confirm-cancel"]').trigger('click')
    expect(w.emitted('sendFollowUp')).toBeUndefined()
    expect(w.find('[data-testid="goods-confirm"]').exists()).toBe(false)
    expect(buyButtons(w)).toHaveLength(2)
  })

  it('confirming one item never buys another', async () => {
    const w = renderShop()
    await buyButtons(w)[0].trigger('click')
    await buyButtons(w)[0].trigger('click') // the remaining Buy is item b
    expect(w.find('[data-testid="goods-confirm"]').text()).toContain('Forest')
    await w.find('[data-testid="goods-confirm-buy"]').trigger('click')
    expect((w.emitted('sendFollowUp') as any)[0][0].items[0].itemId).toBe('b')
  })

  it('cannot be bought when the untrusted price is unreadable', () => {
    const w = mount(ChatMessageDigitalGoods, {
      props: {
        address: VENDOR,
        item: {
          type: 'digital-goods',
          action: 'catalog',
          catalog: [{ itemId: 'x', description: 'Odd', priceWei: '1.5' }],
        },
      } as any,
      global: { stubs: quasarStubs, mocks: { $t } },
    })
    expect(w.find('[data-testid="goods-buy"]').attributes('disable')).toBe(
      'true',
    )
  })

  it('holds a real in-flight guard until the chat reports the purchase message sent', async () => {
    const w = renderShop()
    await buyButtons(w)[0].trigger('click')
    await w.find('[data-testid="goods-confirm-buy"]').trigger('click')
    await flushPromises()

    // The purchase is still being sent: no Buy can start another one.
    expect(buyButtons(w).map(b => b.attributes('disable'))).toEqual([
      'true',
      'true',
    ])
    ;(w.vm as any).onBuy(CATALOG[1])
    await flushPromises()
    expect(w.emitted('sendFollowUp')).toHaveLength(1)

    const payload = (w.emitted('sendFollowUp') as any)[0][0]
    payload.settled(true)
    await flushPromises()
    expect(buyButtons(w).map(b => b.attributes('disable'))).toEqual([
      'false',
      'false',
    ])
  })

  it('frees the guard after a bounded wait if nothing ever reports back', async () => {
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'],
    })
    try {
      const w = renderShop()
      await buyButtons(w)[0].trigger('click')
      await w.find('[data-testid="goods-confirm-buy"]').trigger('click')
      await flushPromises()
      expect((w.vm as any).buyingItemId).toBe('a')
      jest.advanceTimersByTime(120_000)
      await flushPromises()
      expect((w.vm as any).buyingItemId).toBeNull()
    } finally {
      jest.useRealTimers()
    }
  })

  it('labels the confirmation and moves focus into it, then back to Buy on cancel', async () => {
    const w = mount(ChatMessageDigitalGoods, {
      attachTo: document.body,
      props: {
        address: VENDOR,
        item: { type: 'digital-goods', action: 'catalog', catalog: CATALOG },
      } as any,
      global: { stubs: quasarStubs, mocks: { $t } },
    })
    await buyButtons(w)[0].trigger('click')
    await flushPromises()
    const group = w.find('[data-testid="goods-confirm"]')
    expect(group.attributes('aria-label')).toBe('Confirm purchase of Sunset')
    expect(group.attributes('role')).toBe('group')
    expect(document.activeElement).toBe(group.element)

    await w.find('[data-testid="goods-confirm-cancel"]').trigger('click')
    await flushPromises()
    expect(document.activeElement).toBe(buyButtons(w)[0].element)
    w.unmount()
  })
})
