/** @jest-environment jsdom */

import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'

import ChatMessageImage from './ChatMessageImage.vue'

const QImg = defineComponent({
  props: { src: String },
  setup: () => () => h('div', { class: 'q-img-stub' }),
})

describe('ChatMessageImage', () => {
  it('caps the size of a delivered picture instead of filling the chat column', () => {
    const w = mount(ChatMessageImage, {
      props: { image: 'data:image/png;base64,AAAA' },
      global: {
        stubs: { QImg, QDialog: true, ImageDialog: true },
      },
    })
    const style = w.find('.q-img-stub').attributes('style') ?? ''
    expect(style).toMatch(/max-width:\s*320px/)
    expect(style).toMatch(/max-height:\s*320px/)
  })
})
