/** @jest-environment jsdom */
import { mount, flushPromises } from '@vue/test-utils'
import ChatMessageText from './ChatMessageText.vue'
import { png } from '../../../utils/image-data-uri.fixtures'
import { clearMarkdownCache } from '../../../utils/markdown'
import { fetchContactProfile } from '../../../utils/directory-peer'
import { openContactProfile } from '../../../utils/routes'

const mockChain = { parseAddress: (raw: string) => ({ raw }) }
let mockCurrentChain = mockChain
const mockListeners = new Set<() => void>()
jest.mock('@frank/wallet/chain', () => ({
  getActiveChain: () => mockCurrentChain,
  onActiveChainChange: (listener: () => void) => {
    mockListeners.add(listener)
    return () => { mockListeners.delete(listener) }
  },
}))
jest.mock('../../../utils/directory-peer', () => ({ fetchContactProfile: jest.fn() }))
jest.mock('../../../utils/routes', () => ({ openContactProfile: jest.fn() }))

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
    global: { mocks: { $q: { dark: { isActive: false } }, $router: { push: jest.fn() } } },
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


describe('ChatMessageText exact address mentions', () => {
  const address = '0x' + 'a'.repeat(40)
  beforeEach(() => {
    clearMarkdownCache()
    mockCurrentChain = mockChain
    mockListeners.clear()
    jest.clearAllMocks()
    ;(fetchContactProfile as jest.Mock).mockReset().mockResolvedValue(undefined)
  })

  it('shows the full address immediately, then a resolved name, and opens that exact profile', async () => {
    let resolve!: (profile: { name: string }) => void
    ;(fetchContactProfile as jest.Mock).mockReturnValueOnce(new Promise(done => { resolve = done }))
    const wrapper = mountText(`Hello @${address}`, [])
    expect(wrapper.get('a').text()).toBe('@' + address)
    expect(fetchContactProfile).toHaveBeenCalledWith({ raw: address })
    resolve({ name: ' Alice Profile ' })
    await flushPromises()
    expect(wrapper.get('a').text()).toBe('Alice Profile')
    await wrapper.get('a').trigger('click')
    expect(openContactProfile).toHaveBeenCalledWith(expect.anything(), address)
    wrapper.unmount()
    expect(mockListeners.size).toBe(0)
  })

  it('leaves unavailable profiles as full-address links without resolving code or existing links', async () => {
    ;(fetchContactProfile as jest.Mock).mockRejectedValueOnce(new Error('offline'))
    const wrapper = mountText(`@${address} \`@${address}\` [@${address}](https://example.com)`, [])
    await flushPromises()
    expect(fetchContactProfile).toHaveBeenCalledTimes(1)
    expect(wrapper.get(`a[href="/chat/${address}?info=true"]`).text()).toBe('@' + address)
    wrapper.unmount()
    const protectedOnly = mountText(`\`@${address}\` [@${address}](https://example.com)`, [])
    expect(fetchContactProfile).toHaveBeenCalledTimes(1)
    protectedOnly.unmount()
  })

  it('ignores a profile that resolves after the message text changes', async () => {
    let resolve!: (profile: { name: string }) => void
    ;(fetchContactProfile as jest.Mock).mockReturnValueOnce(new Promise(done => { resolve = done }))
    const wrapper = mountText('@' + address, [])
    await wrapper.setProps({ text: 'No mention now' })
    resolve({ name: 'Old Name' })
    await flushPromises()
    expect(wrapper.text()).toBe('No mention now')
    expect(wrapper.find('a').exists()).toBe(false)
    wrapper.unmount()
  })

  it('ignores the old-chain lookup after a chain change and releases its listener', async () => {
    let resolve!: (profile: { name: string }) => void
    ;(fetchContactProfile as jest.Mock).mockReturnValueOnce(new Promise(done => { resolve = done }))
      .mockResolvedValueOnce({ name: 'Current Chain Name' })
    const wrapper = mountText('@' + address, [])
    mockCurrentChain = { parseAddress: (raw: string) => ({ raw }) }
    for (const listener of mockListeners) listener()
    await flushPromises()
    resolve({ name: 'Old Chain Name' })
    await flushPromises()
    expect(wrapper.get('a').text()).toBe('Current Chain Name')
    wrapper.unmount()
    expect(mockListeners.size).toBe(0)
  })

  it('discards profile results after unmounting', async () => {
    let resolve!: (profile: { name: string }) => void
    ;(fetchContactProfile as jest.Mock).mockReturnValueOnce(new Promise(done => { resolve = done }))
    const wrapper = mountText('@' + address, [])
    const vm = wrapper.vm
    wrapper.unmount()
    resolve({ name: 'Late Name' })
    await flushPromises()
    expect(vm.mentionNames).toEqual({})
    expect(mockListeners.size).toBe(0)
  })
})
