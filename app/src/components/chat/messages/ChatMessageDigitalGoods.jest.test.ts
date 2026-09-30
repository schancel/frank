/** @jest-environment jsdom */

import { mount } from '@vue/test-utils'
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
      expect(w.text()).toContain('Alpha -- price unavailable')
      expect(w.text()).toContain('Beta -- 1 MON')
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
