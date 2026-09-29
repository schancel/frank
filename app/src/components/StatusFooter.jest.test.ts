/** @jest-environment jsdom */

import { shallowMount } from '@vue/test-utils'

import StatusFooter from './StatusFooter.vue'

describe('StatusFooter', () => {
  it('renders the real Vue component', () => {
    const wrapper = shallowMount(StatusFooter, {
      global: {
        mocks: {
          $indexer: { connected: true },
        },
        stubs: {
          QFooter: { template: '<footer><slot /></footer>' },
          QBar: { template: '<div><slot /></div>' },
          QSpace: { template: '<span />' },
          QBtn: { template: '<button />' },
        },
      },
    })

    expect(wrapper.exists()).toBe(true)
  })
})
