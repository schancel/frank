/** @jest-environment jsdom */
import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { png } from '../../../utils/image-data-uri.fixtures'
import { blobOfDataUrl } from '../../../utils/chat-binary'
import ChatMessageImage from './ChatMessageImage.vue'
import ChatMessageBlob from './ChatMessageBlob.vue'
const QImg = defineComponent({
  props: { src: String },
  setup: () => () => h('div', { class: 'q-img-stub' }),
})
const QBtn = defineComponent({
  props: { label: String },
  emits: ['click'],
  setup:
    (props, { emit }) =>
    () =>
      h('button', { onClick: () => emit('click') }, props.label),
})
const createObjectURL = jest.fn(() => 'blob:test/picture')
const revokeObjectURL = jest.fn()
const picture = (width = 3, height = 2) => blobOfDataUrl(png(width, height))
const global = {
  stubs: { QImg, QBtn, QIcon: true, QDialog: true, ImageDialog: true },
  mocks: { $t: (key: string) => key },
}
beforeEach(() => {
  jest.clearAllMocks()
  Object.assign(URL, { createObjectURL, revokeObjectURL })
})
it('renders native image bytes at the normal bounded size and releases URLs on replacement and unmount', async () => {
  const first = picture()
  const wrapper = mount(ChatMessageImage, { props: first, global })
  expect(wrapper.find('.q-img-stub').attributes('style')).toMatch(
    /max-width:\s*320px/,
  )
  expect(createObjectURL).toHaveBeenCalledTimes(1)
  expect(createObjectURL.mock.calls[0][0]).toBeInstanceOf(Blob)
  await wrapper.setProps({ data: picture(4, 3).data })
  expect(revokeObjectURL).toHaveBeenCalledWith('blob:test/picture')
  expect(createObjectURL).toHaveBeenCalledTimes(2)
  wrapper.unmount()
  expect(revokeObjectURL).toHaveBeenCalledTimes(2)
})
it.each([
  picture(60000, 60000),
  { ...picture(), mimeType: 'image/jpeg' },
  { ...picture(), data: new Uint8Array(524289) },
  { ...picture(), mimeType: 'image/svg+xml' },
])('refuses unsafe images before allocating any URL: %j', item => {
  const wrapper = mount(ChatMessageImage, { props: item, global })
  expect(wrapper.find('.q-img-stub').exists()).toBe(false)
  expect(createObjectURL).not.toHaveBeenCalled()
  wrapper.unmount()
})
it('offers unknown and active MIME content as an inert download rather than rendering it', async () => {
  const click = jest
    .spyOn(HTMLAnchorElement.prototype, 'click')
    .mockImplementation(() => undefined)
  const item = {
    type: 'blob' as const,
    mimeType: 'text/html',
    data: new TextEncoder().encode('<script>bad()</script>'),
  }
  const wrapper = mount(ChatMessageBlob, { props: { item }, global })
  expect(wrapper.find('.q-img-stub').exists()).toBe(false)
  expect(createObjectURL).not.toHaveBeenCalled()
  await wrapper.get('button').trigger('click')
  expect((createObjectURL.mock.calls[0][0] as Blob).type).toBe(
    'application/octet-stream',
  )
  expect(click).toHaveBeenCalledTimes(1)
  wrapper.unmount()
  expect(revokeObjectURL).toHaveBeenCalledWith('blob:test/picture')
  click.mockRestore()
})
