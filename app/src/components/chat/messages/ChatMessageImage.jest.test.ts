/** @jest-environment jsdom */

import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'

import { png } from '../../../utils/image-data-uri.fixtures'
import ChatMessageImage from './ChatMessageImage.vue'

const QImg = defineComponent({
  props: { src: String },
  setup: () => () => h('div', { class: 'q-img-stub' }),
})

describe('ChatMessageImage', () => {
  it('caps the size of a delivered picture instead of filling the chat column', () => {
    const w = mount(ChatMessageImage, {
      props: { image: png(320, 200) },
      global: {
        stubs: { QImg, QDialog: true, ImageDialog: true },
      },
    })
    const style = w.find('.q-img-stub').attributes('style') ?? ''
    expect(style).toMatch(/max-width:\s*320px/)
    expect(style).toMatch(/max-height:\s*320px/)
  })

  const mountWith = (image: unknown) =>
    mount(ChatMessageImage, {
      props: { image: image as string },
      global: { stubs: { QImg, QDialog: true, ImageDialog: true } },
    })

  it('does not render an image that declares huge dimensions; shows text instead', () => {
    const w = mountWith(png(60000, 60000))
    expect(w.find('.q-img-stub').exists()).toBe(false)
    expect(w.text()).toContain('Image not shown (dimensions too large)')
  })

  it('does not render an over-long image or a remote URL', () => {
    expect(
      mountWith(png(10, 10) + 'A'.repeat(3 * 1024 * 1024))
        .find('.q-img-stub')
        .exists(),
    ).toBe(false)
    expect(
      mountWith('https://tracker.example/p.png').find('.q-img-stub').exists(),
    ).toBe(false)
  })
})
