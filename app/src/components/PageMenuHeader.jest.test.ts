/** @jest-environment jsdom */
// The header that gives a main-pane page its navigation control. Below the drawer breakpoint
// the drawer is closed, so a page without it leaves the user with no way to the rest of the app.
import { mount } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'

import PageMenuHeader from './PageMenuHeader.vue'
import { MY_DRAWER_OPEN_KEY } from '../composables/useMyDrawerOpen'
import enUS from '../i18n/en-us'
import frFR from '../i18n/fr-fr'

const slotted = (tag: string) =>
  defineComponent({
    setup:
      (_, { slots }) =>
      () =>
        h(tag, slots.default?.()),
  })
// Like QBtn: a native button that keeps the attributes and listeners put on it.
const QBtn = defineComponent({
  setup:
    (_, { slots }) =>
    () =>
      h('button', slots.default?.()),
})

function mountHeader(locale: typeof enUS | typeof frFR, open?: boolean) {
  return mount(PageMenuHeader, {
    props: { title: 'Wallet' },
    global: {
      components: {
        QHeader: slotted('header'),
        QToolbar: slotted('div'),
        QToolbarTitle: slotted('div'),
        QBtn,
      },
      provide: open === undefined ? {} : { [MY_DRAWER_OPEN_KEY]: ref(open) },
      mocks: {
        $t: (key: string) =>
          key
            .split('.')
            .reduce<unknown>(
              (o, k) => (o as Record<string, unknown>)?.[k],
              locale,
            ) as string,
      },
    },
  })
}

describe('PageMenuHeader', () => {
  it.each([
    [enUS, 'Open navigation menu'],
    [frFR, 'Ouvrir le menu de navigation'],
  ])(
    'is a named button that asks the layout to toggle the drawer',
    async (locale, name) => {
      const wrapper = mountHeader(locale)
      const menu = wrapper.get('[data-testid="page-menu"]')
      expect(menu.element.tagName).toBe('BUTTON')
      expect(menu.attributes('aria-label')).toBe(name)
      expect(wrapper.text()).toContain('Wallet')
      await menu.trigger('click')
      expect(wrapper.emitted('toggleMyDrawerOpen')).toHaveLength(1)
    },
  )

  it('reports the drawer state like the other page headers', () => {
    expect(
      mountHeader(enUS, true)
        .get('[data-testid="page-menu"]')
        .attributes('aria-expanded'),
    ).toBe('true')
    expect(
      mountHeader(enUS, false)
        .get('[data-testid="page-menu"]')
        .attributes('aria-expanded'),
    ).toBe('false')
  })
})
