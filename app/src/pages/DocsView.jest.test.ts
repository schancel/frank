/** @jest-environment jsdom */

import { mount } from '@vue/test-utils'
import DocsView from './DocsView.vue'
import enUS from 'src/i18n/en-us'

type Messages = Record<string, unknown>

function translator(messages: Messages) {
  return (key: string, values: Record<string, string> = {}): string => {
    const value = key
      .split('.')
      .reduce<unknown>((o, k) => (o as Messages | undefined)?.[k], messages)
    if (typeof value !== 'string') return key
    return value.replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? '')
  }
}

describe('DocsView', () => {
  function mountDocsView() {
    return mount(DocsView, {
      global: {
        mocks: { $t: translator(enUS) },
        stubs: {
          QHeader: { template: '<header><slot /></header>' },
          QToolbar: { template: '<div><slot /></div>' },
          QToolbarTitle: { template: '<h1><slot /></h1>' },
          QBtn: {
            template:
              '<a :href="$attrs.href" :target="$attrs.target" @click="$emit(\'click\')"><slot />{{ $attrs.label }}</a>',
          },
          QPageContainer: { template: '<main><slot /></main>' },
          QPage: { template: '<section><slot /></section>' },
        },
      },
    })
  }

  it('renders the documentation iframe pointing to /docs/', () => {
    const wrapper = mountDocsView()
    const iframe = wrapper.find('iframe.docs-iframe')
    expect(iframe.exists()).toBe(true)
    expect(iframe.attributes('src')).toBe('/docs/')
    expect(iframe.attributes('title')).toBe('Frank Documentation')
  })

  it('provides an open-in-tab link pointing to /docs/', () => {
    const wrapper = mountDocsView()
    const openBtn = wrapper
      .findAll('a')
      .find(btn => btn.attributes('href') === '/docs/')
    expect(openBtn).toBeDefined()
    expect(openBtn?.attributes('target')).toBe('_blank')
    expect(openBtn?.text()).toContain('Open in Tab')
  })

  it('emits toggleMyDrawerOpen when the menu button is clicked', async () => {
    const wrapper = mountDocsView()
    const buttons = wrapper.findAll('a')
    const menuBtn = buttons[0]
    await menuBtn.trigger('click')
    expect(wrapper.emitted('toggleMyDrawerOpen')).toBeTruthy()
  })
})
