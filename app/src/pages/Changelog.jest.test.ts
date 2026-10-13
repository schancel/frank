/** @jest-environment jsdom */

import { mount } from '@vue/test-utils'
import Changelog from './Changelog.vue'

describe('Changelog layout and rendering', () => {
  function mountChangelog() {
    return mount(Changelog, {
      global: {
        mocks: {
          $t: (key: string) => key,
        },
        stubs: {
          QHeader: { template: '<header><slot /></header>' },
          QToolbar: { template: '<div><slot /></div>' },
          QToolbarTitle: { template: '<h1><slot /></h1>' },
          QBtn: {
            props: ['icon', 'ariaLabel'],
            emits: ['click'],
            template:
              '<button :aria-label="ariaLabel" @click="$emit(\'click\')"><slot /></button>',
          },
          QPageContainer: {
            template:
              '<main class="col full-height overflow-hidden"><slot /></main>',
          },
          QPage: {
            props: ['styleFn'],
            template: '<section><slot /></section>',
          },
          QScrollArea: {
            template: '<div class="scroll-area-stub"><slot /></div>',
          },
          QPageSticky: { template: '<div><slot /></div>' },
        },
      },
    })
  }

  it('renders root container with flex full-height classes to prevent collapse', () => {
    const wrapper = mountChangelog()
    expect(wrapper.classes()).toContain('column')
    expect(wrapper.classes()).toContain('full-height')
    expect(wrapper.classes()).toContain('overflow-hidden')
  })

  it('renders changelog content including recent versions', () => {
    const wrapper = mountChangelog()
    expect(wrapper.text()).toContain('Changelog')
    expect(wrapper.text()).toContain('v0.3.0')
  })

  it('emits toggleMyDrawerOpen when the navigation button is clicked', async () => {
    const wrapper = mountChangelog()
    const navBtn = wrapper.find('button')
    expect(navBtn.exists()).toBe(true)
    await navBtn.trigger('click')
    expect(wrapper.emitted('toggleMyDrawerOpen')).toHaveLength(1)
  })

  it('provides viewport pageStyle function', () => {
    const wrapper = mountChangelog()
    const vm = wrapper.vm as any
    expect(typeof vm.pageStyle).toBe('function')
    const style = vm.pageStyle(50, 800)
    expect(style.height).toBe('750px')
    expect(style.minHeight).toBe('750px')
    expect(style.maxHeight).toBe('750px')
    expect(style.overflowY).toBe('auto')
  })
})
