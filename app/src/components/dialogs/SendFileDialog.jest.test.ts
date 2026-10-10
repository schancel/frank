/** @jest-environment jsdom */

import { flushPromises, shallowMount } from '@vue/test-utils'
import SendFileDialog from './SendFileDialog.vue'
import { png } from '../../utils/image-data-uri.fixtures'
import {
  MAX_SENT_CAPTION_LENGTH,
  SENT_IMAGE_LIMITS,
} from '../../utils/image-data-uri'

const t = (key: string, params?: Record<string, unknown>) =>
  params ? `${key}:${Object.values(params).join(',')}` : key

function mountDialog() {
  return shallowMount(SendFileDialog, {
    global: {
      mocks: { $t: t },
      directives: { 'close-popup': {} },
      stubs: {
        QCard: { template: '<div><slot /></div>' },
        QCardSection: { template: '<div><slot /></div>' },
        QCardActions: { template: '<div><slot /></div>' },
        QBtn: {
          props: ['label', 'disable'],
          template: '<button :disabled="disable">{{ label }}</button>',
        },
      },
    },
  })
}
type Dialog = { accept(uri: unknown): void; caption: string }

describe('SendFileDialog', () => {
  it('has nothing to send until a picture is chosen', () => {
    const wrapper = mountDialog()
    expect(
      wrapper.get('[data-testid="send-file-confirm"]').attributes('disabled'),
    ).toBeDefined()
  })

  it('hands a picture a message can carry, and its caption, to the chat page', async () => {
    const wrapper = mountDialog()
    const vm = wrapper.vm as unknown as Dialog
    vm.accept(png(64, 64))
    vm.caption = '  look  '
    await flushPromises()

    const send = wrapper.get('[data-testid="send-file-confirm"]')
    expect(send.attributes('disabled')).toBeUndefined()
    expect(wrapper.find('[data-testid="send-file-refused"]').exists()).toBe(
      false,
    )
    await send.trigger('click')
    expect(wrapper.emitted('send')).toEqual([
      [{ image: png(64, 64), caption: 'look' }],
    ])
  })

  it.each([
    [
      'larger than one message holds',
      `${png(64, 64)}${'A'.repeat(SENT_IMAGE_LIMITS.maxEncodedLength)}`,
      'reasonTooLarge',
    ],
    [
      'with huge declared dimensions',
      png(10_000, 10_000),
      'reasonDimensionsTooLarge',
    ],
    ['that is not an image', 'data:text/plain;base64,AAAA', 'reasonNotInline'],
    ['that could not be read', undefined, 'reasonNotAnImage'],
  ])('refuses a file %s and says why', async (_name, uri, reason) => {
    const wrapper = mountDialog()
    ;(wrapper.vm as unknown as Dialog).accept(uri)
    await flushPromises()

    expect(wrapper.get('[data-testid="send-file-refused"]').text()).toBe(
      `sendFileDialog.cannotSend:chatImage.${reason}`,
    )
    const send = wrapper.get('[data-testid="send-file-confirm"]')
    expect(send.attributes('disabled')).toBeDefined()
    await send.trigger('click')
    expect(wrapper.emitted('send')).toBeUndefined()
  })

  it('keeps picture and caption inside one sealed message', () => {
    // 524,288 bytes is the most a canonical direct message's sealed body may be.
    expect(
      SENT_IMAGE_LIMITS.maxEncodedLength + MAX_SENT_CAPTION_LENGTH * 4,
    ).toBeLessThan(524_288 - 32 * 1024)
  })
})
