/** @jest-environment jsdom */
import { mount } from '@vue/test-utils'
import ChatMessageText from './ChatMessageText.vue'
import { png } from '../../../utils/image-data-uri.fixtures'
import { clearMarkdownCache } from '../../../utils/markdown'

jest.mock('quasar', () => ({
  colors: { getPaletteColor: (name: string) => `mock-color(${name})` },
}))

const picture = { id: '1', name: '', dataUrl: png(2, 2), sizeBytes: 1 }
// As large as a real picture: its bytes must not be repeated per reference.
const large = {
  id: '1',
  name: '',
  dataUrl: `data:image/png;base64,${'A'.repeat(250_000)}`,
  sizeBytes: 1,
}

function mountText(text: string, attachments = [picture]) {
  return mount(ChatMessageText, {
    props: { text, attachments },
    global: { mocks: { $q: { dark: { isActive: false } } } },
  })
}

describe('ChatMessageText pictures', () => {
  const createObjectURL = jest.fn()
  const revokeObjectURL = jest.fn()
  beforeEach(() => {
    clearMarkdownCache()
    let made = 0
    createObjectURL.mockReset().mockImplementation(() => `blob:test/${++made}`)
    revokeObjectURL.mockReset()
    Object.assign(URL, { createObjectURL, revokeObjectURL })
  })

  it('a picture referenced 1,000 times is one object URL and HTML the size of the text', () => {
    const text = Array.from({ length: 1000 }, () => '![p](attachment:1)').join(
      ' ',
    )
    const wrapper = mountText(text, [large])
    const images = wrapper.findAll('img')
    expect(images).toHaveLength(1000)
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(new Set(images.map(i => i.attributes('src')))).toEqual(
      new Set(['blob:test/1']),
    )
    // A quarter of a megabyte of picture, a thousand references: still a few tens of KB.
    expect(wrapper.html().length).toBeLessThan(100_000)
    expect(wrapper.html()).not.toContain('data:')
  })

  it('hands the picture itself to the image dialog on a click, and frees the URL on unmount', async () => {
    const wrapper = mountText('look ![p](attachment:1)')
    await wrapper.get('img').trigger('click')
    expect(wrapper.emitted('imageClick')).toEqual([[picture.dataUrl]])
    wrapper.unmount()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test/1')
  })

  it('shows nothing for a reference to a picture the message does not carry', () => {
    const wrapper = mountText('![p](attachment:2) ![q](https://evil.example/x)')
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.text()).toContain('![p](attachment:2)')
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('keeps showing the picture after the text changes', async () => {
    const wrapper = mountText('![p](attachment:1)')
    await wrapper.setProps({ text: 'edited ![p](attachment:1)' })
    expect(wrapper.get('img').attributes('src')).toBe('blob:test/1')
    expect(createObjectURL).toHaveBeenCalledTimes(1)
  })
})
