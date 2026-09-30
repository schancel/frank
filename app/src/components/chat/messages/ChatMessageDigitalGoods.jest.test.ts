/** @jest-environment jsdom */

import { mount } from '@vue/test-utils'
import * as quasar from 'quasar'
import { defineComponent, h } from 'vue'

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

const THUMB = 'data:image/png;base64,iVBORw0KGgo='

function render(catalog: any[]) {
  return mount(ChatMessageDigitalGoods, {
    props: {
      address: '0xVendor',
      item: { type: 'digital-goods', action: 'catalog', catalog },
    },
    global: { stubs: quasarStubs },
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
    expect(imgs[0].attributes('alt')).toBe('Alpha')
  })

  it.each([
    'https://tracker.example/pixel.png',
    'http://127.0.0.1/x.png',
    'data:text/html;base64,PGh0bWw+',
    'data:image/svg+xml;base64,PHN2Zz4=',
    'javascript:alert(1)',
  ])('never renders a non-data-image thumbnail (%s)', bad => {
    const w = render([
      { itemId: 'a', description: 'Alpha', priceWei: '1', thumbnail: bad },
    ])
    expect(w.find('img').exists()).toBe(false)
    expect(w.text()).toContain('Alpha')
  })
})
